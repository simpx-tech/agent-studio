//! Calls the window sends twice. Tauri's IPC script posts each call to this process with `fetch`,
//! and when a fetch fails on the way, as every call in flight does when a WebView2 helper process
//! restarts, it sends the same call again through `postMessage`, which the page then uses until it
//! reloads. On 2026-10-11 the second copies of two replies' `run_agent` calls, 13 and 57 minutes
//! into those replies, were refused as second replies to their conversations: both replies showed
//! as failed while their CLIs worked on (docs/DIAGNOSTICS.md). The page names every call in a
//! `studio-call` header (`src/lib/window-answers.ts`), which the copy carries too, and a command
//! that acts runs its work once per name: a copy that arrives while the work runs, or after it
//! ended, receives the same answer.
use std::{
    any::Any,
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    ipc::{CommandArg, CommandItem, InvokeError},
    Manager, Runtime,
};
use tokio::sync::watch;

/// The header the page names each call in.
pub const HEADER: &str = "studio-call";
/// How long a finished call keeps its answer for a copy. Tauri sends the copy as soon as the
/// first try fails, so it comes at once, unless the page stalls.
const KEEP_ANSWER: Duration = Duration::from_secs(10 * 60);
/// How long a finished call is remembered at all, so that a later copy is refused rather than
/// run a second time.
const REMEMBER: Duration = Duration::from_secs(24 * 60 * 60);
/// What a copy receives when its call's answer is gone.
pub const NO_ANSWER: &str = "This request already ran, and its answer could not reach this window.";

/// A finished call's answer: its command's `Result<T, String>`.
type Answer = Arc<dyn Any + Send + Sync>;

enum Entry {
    /// Settles with the answer, or with none when the work stopped without one.
    Running(watch::Receiver<Option<Option<Answer>>>),
    Done {
        at: Instant,
        answer: Option<Answer>,
    },
}

/// The calls this process ran for its window.
#[derive(Clone, Default)]
pub struct Calls(Arc<Mutex<HashMap<String, Entry>>>);

/// A command's call: the page's name for it, and the calls already run.
pub struct Call {
    id: Option<String>,
    calls: Calls,
}

impl<'de, R: Runtime> CommandArg<'de, R> for Call {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let id = command
            .message
            .headers()
            .get(HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|id| valid(id))
            .map(str::to_owned);
        let calls = command
            .message
            .webview()
            .try_state::<Calls>()
            .map(|calls| calls.inner().clone())
            .unwrap_or_default();
        Ok(Self { id, calls })
    }
}

/// A name the page gives: a UUID, or anything as short and plain.
fn valid(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

enum Claim {
    /// The call's first arrival, which does the work and answers its copies.
    First(Settle),
    /// A copy that arrived while the work runs.
    Waiting(watch::Receiver<Option<Option<Answer>>>),
    /// A copy that arrived after the work ended.
    Ended(Option<Answer>),
}

impl Calls {
    fn claim(&self, id: &str, now: Instant) -> Claim {
        let mut calls = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        calls.retain(|_, entry| match entry {
            Entry::Running(_) => true,
            Entry::Done { at, answer } => {
                let age = now.saturating_duration_since(*at);
                if age >= KEEP_ANSWER {
                    *answer = None;
                }
                age < REMEMBER
            }
        });
        match calls.get(id) {
            Some(Entry::Running(settled)) => Claim::Waiting(settled.clone()),
            Some(Entry::Done { answer, .. }) => Claim::Ended(answer.clone()),
            None => {
                let (sender, receiver) = watch::channel(None);
                calls.insert(id.to_owned(), Entry::Running(receiver));
                Claim::First(Settle {
                    calls: self.clone(),
                    id: id.to_owned(),
                    sender: Some(sender),
                })
            }
        }
    }
}

/// Records the first arrival's answer for its copies, or that it ended without one when dropped
/// unanswered.
struct Settle {
    calls: Calls,
    id: String,
    sender: Option<watch::Sender<Option<Option<Answer>>>>,
}

impl Settle {
    fn settle(&mut self, answer: Option<Answer>, at: Instant) {
        let Some(sender) = self.sender.take() else {
            return;
        };
        self.calls
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                self.id.clone(),
                Entry::Done {
                    at,
                    answer: answer.clone(),
                },
            );
        sender.send_replace(Some(answer));
    }
}

impl Drop for Settle {
    fn drop(&mut self) {
        self.settle(None, Instant::now());
    }
}

/// The answer a copy receives.
fn answer_of<T: Clone + 'static>(answer: Option<Answer>) -> Result<T, String> {
    answer
        .and_then(|answer| answer.downcast_ref::<Result<T, String>>().cloned())
        .unwrap_or_else(|| Err(NO_ANSWER.into()))
}

impl Call {
    /// A call the page did not name, as tests make.
    #[cfg(test)]
    pub fn unnamed() -> Self {
        Self {
            id: None,
            calls: Calls::default(),
        }
    }

    /// Runs `work` for this call unless an earlier copy of it already did, and returns its
    /// answer. A copy waits for the work that runs, however long it takes.
    ///
    /// The work and its wait stay on the heap, so the command's own future stays small: a debug
    /// build copies a command's future on the window thread's stack, and one that held a reply
    /// inline twice overflowed it.
    pub fn once<'a, T, F>(
        self,
        work: F,
    ) -> Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>
    where
        T: Clone + Send + Sync + 'static,
        F: Future<Output = Result<T, String>> + Send + 'a,
    {
        let work = Box::pin(work);
        Box::pin(async move {
            let Some(id) = self.id else {
                return work.await;
            };
            match self.calls.claim(&id, Instant::now()) {
                Claim::First(mut settle) => {
                    let answer = work.await;
                    settle.settle(Some(Arc::new(answer.clone())), Instant::now());
                    answer
                }
                Claim::Waiting(mut settled) => {
                    let answer = settled
                        .wait_for(Option::is_some)
                        .await
                        .ok()
                        .and_then(|settled| settled.clone())
                        .flatten();
                    answer_of(answer)
                }
                Claim::Ended(answer) => answer_of(answer),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn named(calls: &Calls, id: &str) -> Call {
        Call {
            id: Some(id.into()),
            calls: calls.clone(),
        }
    }

    #[tokio::test]
    async fn a_copy_that_arrives_while_the_work_runs_gets_its_answer() {
        let calls = Calls::default();
        let runs = Arc::new(AtomicUsize::new(0));
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let work = |runs: Arc<AtomicUsize>| async move {
            runs.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>("complete".to_string())
        };
        let first = tokio::spawn({
            let call = named(&calls, "a");
            let runs = runs.clone();
            async move {
                call.once(async move {
                    let _ = released.await;
                    work(runs).await
                })
                .await
            }
        });
        tokio::task::yield_now().await;
        let copy = tokio::spawn(named(&calls, "a").once(work(runs.clone())));
        tokio::task::yield_now().await;
        assert!(!copy.is_finished(), "the copy waits for the first arrival");
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap(), Ok("complete".into()));
        assert_eq!(copy.await.unwrap(), Ok("complete".into()));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_copy_after_the_work_ended_gets_the_same_answer_and_errors_too() {
        let calls = Calls::default();
        let runs = AtomicUsize::new(0);
        let fail = || async {
            runs.fetch_add(1, Ordering::SeqCst);
            Err::<String, _>("This conversation is busy.".to_string())
        };
        assert_eq!(
            named(&calls, "b").once(fail()).await,
            Err("This conversation is busy.".into())
        );
        assert_eq!(
            named(&calls, "b").once(fail()).await,
            Err("This conversation is busy.".into())
        );
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        // Other names, and calls the page did not name, run their own work.
        assert!(named(&calls, "c").once(fail()).await.is_err());
        assert!(Call::unnamed().once(fail()).await.is_err());
        assert!(Call::unnamed().once(fail()).await.is_err());
        assert_eq!(runs.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn work_that_stops_unanswered_tells_its_copies() {
        let calls = Calls::default();
        let first =
            tokio::spawn(named(&calls, "d").once(std::future::pending::<Result<String, String>>()));
        tokio::task::yield_now().await;
        let copy = tokio::spawn(named(&calls, "d").once(async { Ok("ran twice".to_string()) }));
        tokio::task::yield_now().await;
        first.abort();
        assert_eq!(copy.await.unwrap(), Err(NO_ANSWER.into()));
        assert_eq!(
            named(&calls, "d")
                .once(async { Ok("ran twice".to_string()) })
                .await,
            Err(NO_ANSWER.into())
        );
    }

    #[test]
    fn answers_are_kept_for_a_while_and_calls_for_a_day() {
        let calls = Calls::default();
        let start = Instant::now();
        let Claim::First(mut settle) = calls.claim("e", start) else {
            panic!("the first arrival runs the work");
        };
        settle.settle(Some(Arc::new(Ok::<_, String>(7_u32))), start);
        let Claim::Ended(answer) = calls.claim("e", start + KEEP_ANSWER / 2) else {
            panic!("a copy gets the answer");
        };
        assert_eq!(answer_of::<u32>(answer), Ok(7));
        let Claim::Ended(answer) = calls.claim("e", start + KEEP_ANSWER) else {
            panic!("a later copy is still refused");
        };
        assert_eq!(answer_of::<u32>(answer), Err(NO_ANSWER.into()));
        assert!(matches!(
            calls.claim("e", start + REMEMBER),
            Claim::First(_)
        ));
    }

    #[test]
    fn only_plain_short_names_count() {
        assert!(valid("4f7d0c1e-2b8a-4c3e-9a51-0d6f2b7c9e10"));
        assert!(!valid(""));
        assert!(!valid(&"a".repeat(65)));
        assert!(!valid("a b"));
        assert!(!valid("a/b"));
    }
}
