//! A Claude reply whose turn ended while background work it waits for continues leaves its
//! CLI idle, so the conversation's next message does not have to wait for that work. The next
//! reply asks the waiting one for its process: the waiting reply ends at once and hands over
//! the process with the work it still waits for, which the next reply goes on waiting for.
//! Only the idle stretch the requesting window saw qualifies. Once another turn has started,
//! the waiting reply's text may have changed since that window built its history, so the
//! message waits for the reply as before.
use crate::pool::Process;
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};

pub const ENDED: &str = "The reply had already moved on, so your message waits for it to finish.";
pub const BUSY: &str =
    "Claude started working again, so your message waits until it is idle or the reply finishes.";
pub const CHANGED: &str = "Your changed settings need a new CLI process, which would stop the background work. Your message is sent when the reply finishes.";

/// The waiting reply a message continues, as the requesting window saw it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub run_id: String,
    /// The idle stretch it was in. A turn started since then refuses the request.
    pub wait: u64,
}

pub type Offer = oneshot::Receiver<Result<Process, String>>;

pub struct Request {
    pub wait: u64,
    /// The next reply's launch identity. Another one needs a new process, which would end the
    /// work the waiting reply hands over.
    pub fingerprint: String,
    pub reply: oneshot::Sender<Result<Process, String>>,
}

struct Run {
    connection: Option<String>,
    tx: mpsc::UnboundedSender<Request>,
}

#[derive(Clone, Default)]
pub struct Hub(Arc<Mutex<HashMap<String, Run>>>);

pub struct Session {
    hub: Hub,
    run_id: String,
    connection: Option<String>,
    pub rx: mpsc::UnboundedReceiver<Request>,
}

impl Hub {
    pub fn open(&self, run_id: &str, connection: Option<String>) -> Session {
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut runs) = self.0.lock() {
            runs.insert(
                run_id.into(),
                Run {
                    connection: connection.clone(),
                    tx,
                },
            );
        }
        Session {
            hub: self.clone(),
            run_id: run_id.into(),
            connection,
            rx,
        }
    }
}

impl Session {
    /// Ask the reply `target` names for its process on behalf of this run. The offer resolves
    /// with the process once that reply handed it over, or with the reason it refused.
    pub fn request(&self, target: &Target, fingerprint: String) -> Result<Offer, String> {
        let runs = self.hub.0.lock().map_err(|_| ENDED)?;
        let run = runs.get(&target.run_id).ok_or(ENDED)?;
        if run.connection != self.connection {
            return Err("That reply belongs to another account.".into());
        }
        let (reply, offer) = oneshot::channel();
        run.tx
            .send(Request {
                wait: target.wait,
                fingerprint,
                reply,
            })
            .map_err(|_| ENDED)?;
        Ok(offer)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut runs) = self.hub.0.lock() {
            runs.remove(&self.run_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn requests_reach_only_the_named_running_reply_of_the_same_account() {
        let hub = Hub::default();
        let mut waiting = hub.open("waiting", Some("account".into()));
        let next = hub.open("next", Some("account".into()));
        let foreign = hub.open("foreign", Some("other".into()));
        let target = |run_id: &str| Target {
            run_id: run_id.into(),
            wait: 2,
        };
        let refused = |session: &Session, run_id: &str| {
            session
                .request(&target(run_id), "identity".into())
                .err()
                .unwrap()
        };
        assert!(refused(&foreign, "waiting").contains("another account"));
        assert_eq!(refused(&next, "missing"), ENDED);
        let offer = next.request(&target("waiting"), "identity".into()).unwrap();
        let request = waiting.rx.recv().await.unwrap();
        assert_eq!(
            (request.wait, request.fingerprint.as_str()),
            (2, "identity")
        );
        assert!(request.reply.send(Err(BUSY.into())).is_ok());
        assert_eq!(offer.await.unwrap().err().as_deref(), Some(BUSY));
        // A reply that ended takes its channel with it.
        drop(waiting);
        assert_eq!(refused(&next, "waiting"), ENDED);
    }
}
