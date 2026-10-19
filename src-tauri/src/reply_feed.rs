//! What a reply reports to its window, kept so that a window that reloads takes the reply up again
//! (requested 2026-10-19, after a reload of the window stopped three running replies: every page
//! load ended them). A page load only detaches each reply from the document that started it: the
//! reply runs on and keeps what it reports, each event in the place its first report took and at
//! its latest report, and the reloaded window follows it with `follow_run`, which replays those
//! events, forwards the rest as they come and answers with the reply's end.
use crate::protocol::RunEvent;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::sync::watch;

/// How a reply's events reach the window following it.
pub type Window = Arc<dyn Fn(RunEvent) -> Result<(), String> + Send + Sync>;
/// A reply's end, as `run_agent` answers it.
pub type End = Result<String, String>;

/// How long a reply's events stay after its end reached the window that started it, for a reload
/// that comes before that window saved the end.
const KEPT_AFTER_END: Duration = Duration::from_secs(60);

/// The replies this app runs, by run.
#[derive(Default)]
pub struct Feeds(Mutex<HashMap<String, Arc<Feed>>>);

/// A reply a window may follow, as `live_runs` lists it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveRun {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Another device asked for the reply through the relay, whose request the window publishes.
    pub job: bool,
    /// The reply ended while no window followed it.
    pub ended: bool,
}

pub struct Feed {
    run_id: String,
    conversation: Option<String>,
    job: bool,
    state: Mutex<State>,
    end: watch::Sender<Option<End>>,
}

#[derive(Default)]
struct State {
    events: Vec<RunEvent>,
    /// Where each event that a later report replaces took its place.
    places: HashMap<String, usize>,
    window: Option<Window>,
}

/// Where an event goes among those a reply reported.
enum Place {
    /// A later report of the same thing replaces it where its first report was.
    Kept(String),
    /// Each report is kept: records that keep their own revisions.
    Added,
    /// Never replayed: a question's draft shows only while it is written, and a skills change is
    /// a signal of its moment.
    Dropped,
}

fn place(event: &RunEvent) -> Place {
    Place::Kept(match event {
        RunEvent::Text { .. } => "text".into(),
        RunEvent::Tool { tool } => format!("tool:{}", tool.id),
        RunEvent::Progress { id, .. } => format!("progress:{id}"),
        RunEvent::Reasoning { id, .. } => format!("reasoning:{id}"),
        RunEvent::Activity { text } => format!("activity:{text}"),
        RunEvent::Usage { .. } => "usage".into(),
        RunEvent::AccountUsage { .. } => "accountusage".into(),
        RunEvent::FileChanges { .. } => "filechanges".into(),
        RunEvent::Plan { .. } => "plan".into(),
        RunEvent::NativeWorkflow { .. } => "nativeworkflow".into(),
        RunEvent::BackgroundWait { .. } => "backgroundwait".into(),
        RunEvent::UsageLimit { .. } => "usagelimit".into(),
        RunEvent::TakeOver => "takeover".into(),
        RunEvent::Question { question, .. } => format!("question:{}", question.id),
        RunEvent::Elicitation { elicitation } => format!("elicitation:{}", elicitation.id),
        RunEvent::Compaction { compaction } => format!("compaction:{}", compaction.id),
        RunEvent::ProposedPlan { proposed_plan } => format!("proposedplan:{}", proposed_plan.id),
        RunEvent::Steering { steering, .. } => format!("steering:{}", steering.id),
        RunEvent::Visualization { .. }
        | RunEvent::Artifact { .. }
        | RunEvent::SentFiles { .. }
        | RunEvent::Screen { .. } => return Place::Added,
        RunEvent::QuestionDraft { .. } | RunEvent::SkillsChanged => return Place::Dropped,
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Feeds {
    /// Starts keeping what the reply `run_id` reports, for `window`, the window that started it.
    pub fn open(
        &self,
        run_id: &str,
        conversation: Option<String>,
        job: bool,
        window: Window,
    ) -> Arc<Feed> {
        let feed = Arc::new(Feed {
            run_id: run_id.into(),
            conversation,
            job,
            state: Mutex::new(State {
                window: Some(window),
                ..State::default()
            }),
            end: watch::Sender::new(None),
        });
        lock(&self.0).insert(run_id.into(), feed.clone());
        feed
    }

    /// The window reloaded: its new document cannot receive what the old one followed, so each
    /// reply keeps its events until the new one follows it.
    pub fn detach_all(&self) {
        for feed in lock(&self.0).values() {
            lock(&feed.state).window = None;
        }
    }

    /// The replies a window may follow: those running, and those that ended while no window
    /// followed them.
    pub fn live(&self) -> Vec<LiveRun> {
        let mut live: Vec<_> = lock(&self.0)
            .values()
            .map(|feed| LiveRun {
                run_id: feed.run_id.clone(),
                conversation_id: feed.conversation.clone(),
                job: feed.job,
                ended: feed.end.borrow().is_some(),
            })
            .collect();
        live.sort_by(|a, b| a.run_id.cmp(&b.run_id));
        live
    }

    pub fn get(&self, run_id: &str) -> Option<Arc<Feed>> {
        lock(&self.0).get(run_id).cloned()
    }

    fn remove(&self, feed: &Arc<Feed>) {
        let mut feeds = lock(&self.0);
        if feeds
            .get(&feed.run_id)
            .is_some_and(|kept| Arc::ptr_eq(kept, feed))
        {
            feeds.remove(&feed.run_id);
        }
    }

    /// Forgets a reply once `window`, which followed it, has its end. A window that reloaded
    /// meanwhile, or that another follower replaced, leaves it for the window that follows now.
    pub fn release(&self, feed: &Arc<Feed>, window: &Window) {
        let current = lock(&feed.state)
            .window
            .as_ref()
            .is_some_and(|following| Arc::ptr_eq(following, window));
        if current {
            self.remove(feed);
        }
    }

    /// The reply ended with `end`. A window following it has its end through its own call, so
    /// its events stay only a while, for a reload before that window saved the end; a reply
    /// no window follows keeps them until one does. Called from the reply's own task.
    pub fn finish(self: &Arc<Self>, feed: &Arc<Feed>, end: End) {
        feed.end.send_replace(Some(end));
        if lock(&feed.state).window.is_none() {
            return;
        }
        let (feeds, feed) = (self.clone(), feed.clone());
        tokio::spawn(async move {
            tokio::time::sleep(KEPT_AFTER_END).await;
            if lock(&feed.state).window.is_some() {
                feeds.remove(&feed);
            }
        });
    }
}

impl Feed {
    /// Sends an event to the window following the reply, keeping it for a window that reloads.
    /// A window that no longer takes events is let go: the reply runs on whatever happens to it.
    pub fn send(&self, event: RunEvent) -> Result<(), String> {
        let mut state = lock(&self.state);
        if let Some(window) = &state.window {
            if window(event.clone()).is_err() {
                state.window = None;
            }
        }
        state.keep(event);
        Ok(())
    }

    /// Follows the reply from `window`: replays what it reported, forwards the rest, and answers
    /// with its end. A later follower takes its place.
    pub async fn follow(&self, window: Window) -> End {
        {
            let mut state = lock(&self.state);
            for event in &state.events {
                if window(event.clone()).is_err() {
                    break;
                }
            }
            state.window = Some(window);
        }
        let mut end = self.end.subscribe();
        let answer = end
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|end| end.clone());
        answer.unwrap_or_else(|| Err("This response stopped without an answer.".into()))
    }

    #[cfg(test)]
    fn kept(&self) -> Vec<RunEvent> {
        lock(&self.state).events.clone()
    }
}

impl State {
    fn keep(&mut self, event: RunEvent) {
        match place(&event) {
            Place::Kept(key) => match self.places.get(&key) {
                Some(&index) => self.events[index] = event,
                None => {
                    self.places.insert(key, self.events.len());
                    self.events.push(event);
                }
            },
            Place::Added => self.events.push(event),
            Place::Dropped => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn recorder() -> (Window, Arc<Mutex<Vec<RunEvent>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = seen.clone();
        let window: Window = Arc::new(move |event| {
            lock(&into).push(event);
            Ok(())
        });
        (window, seen)
    }

    fn text(value: &str) -> RunEvent {
        RunEvent::Text { text: value.into() }
    }

    fn progress(id: &str, revision: u64, text: &str) -> RunEvent {
        RunEvent::Progress {
            id: id.into(),
            revision,
            text: text.into(),
        }
    }

    fn texts(events: &[RunEvent]) -> Vec<String> {
        events
            .iter()
            .map(|event| match event {
                RunEvent::Text { text } => format!("text {text}"),
                RunEvent::Progress { id, text, .. } => format!("{id} {text}"),
                RunEvent::Activity { text } => format!("activity {text}"),
                other => format!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn keeps_each_thing_where_it_was_first_reported_at_its_latest_report() {
        let feeds = Feeds::default();
        let (window, _) = recorder();
        let feed = feeds.open("run", Some("chat".into()), false, window);
        for event in [
            text("He"),
            progress("p1", 0, "Reading"),
            text("Hello"),
            progress("p2", 0, "Writing"),
            progress("p1", 1, "Read the files"),
            RunEvent::Activity {
                text: "Starting".into(),
            },
            RunEvent::Activity {
                text: "Starting".into(),
            },
            RunEvent::SkillsChanged,
            text(""),
        ] {
            feed.send(event).unwrap();
        }
        assert_eq!(
            texts(&feed.kept()),
            [
                "text ",
                "p1 Read the files",
                "p2 Writing",
                "activity Starting"
            ]
        );
    }

    #[tokio::test]
    async fn a_reloaded_window_follows_the_reply_from_its_start() {
        let feeds = Arc::new(Feeds::default());
        let (first, seen_first) = recorder();
        let feed = feeds.open("run", Some("chat".into()), true, first);
        feed.send(progress("p1", 0, "Reading")).unwrap();
        feeds.detach_all();
        // Nothing reaches the document that reloaded, and the reply runs on.
        feed.send(text("Answer")).unwrap();
        assert_eq!(lock(&seen_first).len(), 1);
        assert_eq!(
            feeds.live(),
            [LiveRun {
                run_id: "run".into(),
                conversation_id: Some("chat".into()),
                job: true,
                ended: false,
            }]
        );
        let (second, seen_second) = recorder();
        let follower = {
            let feed = feed.clone();
            tokio::spawn(async move { feed.follow(second).await })
        };
        tokio::task::yield_now().await;
        while lock(&seen_second).len() < 2 {
            tokio::task::yield_now().await;
        }
        feed.send(text("Answer, whole")).unwrap();
        feeds.finish(&feed, Ok("complete".into()));
        assert_eq!(follower.await.unwrap(), Ok("complete".into()));
        assert_eq!(
            texts(&lock(&seen_second)),
            ["p1 Reading", "text Answer", "text Answer, whole"]
        );
    }

    #[tokio::test]
    async fn a_reply_that_ended_unfollowed_waits_for_a_window() {
        let feeds = Arc::new(Feeds::default());
        let (window, _) = recorder();
        let feed = feeds.open("run", None, false, window);
        feed.send(text("Done")).unwrap();
        feeds.detach_all();
        feeds.finish(&feed, Err("The provider failed".into()));
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(feeds.live()[0].ended);
        let (later, seen) = recorder();
        let feed = feeds.get("run").unwrap();
        assert_eq!(
            feed.follow(later.clone()).await,
            Err("The provider failed".into())
        );
        assert_eq!(texts(&lock(&seen)), ["text Done"]);
        feeds.release(&feed, &later);
        assert!(feeds.live().is_empty());
    }

    #[tokio::test]
    async fn a_follower_that_reloaded_leaves_the_reply_to_the_next_one() {
        let feeds = Arc::new(Feeds::default());
        let (window, _) = recorder();
        let feed = feeds.open("run", None, false, window);
        feeds.detach_all();
        let (first, _) = recorder();
        let following = {
            let (feed, first) = (feed.clone(), first.clone());
            tokio::spawn(async move { feed.follow(first).await })
        };
        tokio::task::yield_now().await;
        while lock(&feed.state).window.is_none() {
            tokio::task::yield_now().await;
        }
        feeds.detach_all();
        feeds.finish(&feed, Ok("complete".into()));
        assert_eq!(following.await.unwrap(), Ok("complete".into()));
        feeds.release(&feed, &first);
        assert!(feeds.live()[0].ended, "the next window still takes the end");
        let (second, seen) = recorder();
        feed.send(text("late")).unwrap();
        assert_eq!(feed.follow(second.clone()).await, Ok("complete".into()));
        assert_eq!(texts(&lock(&seen)), ["text late"]);
        feeds.release(&feed, &second);
        assert!(feeds.live().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn an_end_its_window_received_is_kept_only_a_while() {
        let feeds = Arc::new(Feeds::default());
        let (window, _) = recorder();
        let feed = feeds.open("run", None, false, window);
        feeds.finish(&feed, Ok("complete".into()));
        tokio::time::sleep(KEPT_AFTER_END / 2).await;
        assert_eq!(feeds.live().len(), 1, "a reload may still take it");
        tokio::time::sleep(KEPT_AFTER_END).await;
        assert!(feeds.live().is_empty());
    }

    #[test]
    fn a_window_that_fails_is_let_go_and_the_reply_runs_on() {
        let feeds = Feeds::default();
        let failed = Arc::new(AtomicBool::new(false));
        let flag = failed.clone();
        let window: Window = Arc::new(move |_| {
            flag.store(true, Ordering::SeqCst);
            Err("closed".into())
        });
        let feed = feeds.open("run", None, false, window);
        assert!(feed.send(text("a")).is_ok());
        assert!(failed.load(Ordering::SeqCst));
        assert!(lock(&feed.state).window.is_none());
        assert!(feed.send(text("ab")).is_ok());
        assert_eq!(texts(&feed.kept()), ["text ab"]);
    }
}
