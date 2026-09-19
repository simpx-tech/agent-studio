//! Run-owned human input. Only native acknowledgment records successful delivery.
use crate::{protocol::RunEvent, runner::EventSink};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub id: String,
    pub text: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub text: String,
    pub run_id: String,
    pub sequence: usize,
}
struct Run {
    connection: Option<String>,
    ready: bool,
    entries: Vec<(Input, Option<Result<(), String>>)>,
    tx: mpsc::UnboundedSender<Delivery>,
}
#[derive(Clone, Default)]
pub struct Hub(Arc<Mutex<HashMap<String, Run>>>);
pub struct Delivery {
    pub input: Input,
    ack: oneshot::Sender<Result<(), String>>,
}
pub struct Session {
    hub: Hub,
    run_id: String,
    channel: EventSink,
    pub rx: mpsc::UnboundedReceiver<Delivery>,
}
impl Hub {
    pub fn open(&self, run_id: &str, connection: Option<String>, channel: EventSink) -> Session {
        let (tx, rx) = mpsc::unbounded_channel();
        self.0.lock().unwrap().insert(
            run_id.into(),
            Run {
                connection,
                ready: false,
                entries: vec![],
                tx,
            },
        );
        Session {
            hub: self.clone(),
            run_id: run_id.into(),
            channel,
            rx,
        }
    }
    pub async fn send(
        &self,
        run_id: &str,
        connection: Option<&str>,
        input: Input,
    ) -> Result<(), String> {
        if uuid::Uuid::parse_str(&input.id).is_err()
            || input.text.trim().is_empty()
            || input.text.encode_utf16().count() > 30000
            || input.text.contains('\0')
            || input.text.trim_start().starts_with('/')
        {
            return Err("Steering requires plain text, up to 30,000 characters. Queue commands, skills, and images for the next reply.".into());
        }
        let rx = {
            let mut runs = self.0.lock().map_err(|_| "Steering is unavailable")?;
            let run = runs
                .get_mut(run_id)
                .ok_or("This reply has ended. Your steering was not sent.")?;
            if run.connection.as_deref() != connection {
                return Err("This reply belongs to another connection.".into());
            }
            if let Some((previous, result)) = run.entries.iter().find(|(v, _)| v.id == input.id) {
                if previous != &input {
                    return Err("This steering identity was already used.".into());
                }
                return result.clone().unwrap_or_else(|| {
                    Err(
                        "Delivery is still awaiting confirmation. Check the reply before retrying."
                            .into(),
                    )
                });
            }
            if !run.ready {
                return Err("This reply is not ready for steering. Keep the draft and try when the agent is running.".into());
            }
            if run.entries.len() >= 8
                || run
                    .entries
                    .iter()
                    .map(|(v, _)| v.text.encode_utf16().count())
                    .sum::<usize>()
                    + input.text.encode_utf16().count()
                    > 60000
            {
                return Err(
                    "This reply reached its steering limit. Queue a follow-up instead.".into(),
                );
            }
            let (ack, rx) = oneshot::channel();
            run.entries.push((input.clone(), None));
            run.tx
                .send(Delivery { input, ack })
                .map_err(|_| "This reply has ended. Your steering was not sent.")?;
            rx
        };
        rx.await.map_err(|_| "The reply ended before confirming steering. Check its saved history before resending.".to_string())?
    }
}
impl Session {
    pub fn ready(&self, ready: bool) {
        if let Ok(mut runs) = self.hub.0.lock() {
            if let Some(run) = runs.get_mut(&self.run_id) {
                run.ready = ready;
            }
        }
    }
    pub fn delivered(&self, delivery: Delivery, result: Result<(), String>) {
        if let Ok(mut runs) = self.hub.0.lock() {
            if let Some(run) = runs.get_mut(&self.run_id) {
                if let Some(index) = run
                    .entries
                    .iter()
                    .position(|(v, _)| v.id == delivery.input.id)
                {
                    run.entries[index].1 = Some(result.clone());
                    if result.is_ok() {
                        let _ = self.channel.send(RunEvent::Steering {
                            steering: Receipt {
                                id: delivery.input.id,
                                text: delivery.input.text,
                                run_id: self.run_id.clone(),
                                sequence: index + 1,
                            },
                        });
                    }
                }
            }
        }
        let _ = delivery.ack.send(result);
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
    fn input() -> Input {
        Input {
            id: uuid::Uuid::new_v4().to_string(),
            text: "Focus on tests".into(),
        }
    }
    #[tokio::test]
    async fn pins_delivery_to_live_run_and_account_and_records_only_acknowledgment() {
        let hub = Hub::default();
        let (tx, mut events) = mpsc::unbounded_channel();
        let mut session = hub.open(
            "run",
            Some("account".into()),
            EventSink::new(move |e| tx.send(e).map_err(|e| e.to_string())),
        );
        let value = input();
        assert!(hub
            .send("run", Some("account"), value.clone())
            .await
            .is_err());
        session.ready(true);
        assert!(hub.send("run", Some("other"), value.clone()).await.is_err());
        assert!(hub
            .send("stale", Some("account"), value.clone())
            .await
            .is_err());
        let sender = hub.clone();
        let copy = value.clone();
        let task = tokio::spawn(async move { sender.send("run", Some("account"), copy).await });
        let delivery = session.rx.recv().await.unwrap();
        assert!(events.try_recv().is_err());
        assert!(hub
            .send("run", Some("account"), value.clone())
            .await
            .is_err());
        session.delivered(delivery, Ok(()));
        task.await.unwrap().unwrap();
        assert!(matches!(
            events.recv().await.unwrap(),
            RunEvent::Steering { .. }
        ));
        hub.send("run", Some("account"), value.clone())
            .await
            .unwrap();
        assert!(session.rx.try_recv().is_err());
        assert!(events.try_recv().is_err());
        session.ready(false);
        assert!(hub.send("run", Some("account"), input()).await.is_err());
        drop(session);
        assert!(hub.send("run", Some("account"), value).await.is_err());
    }
    #[tokio::test]
    async fn rejection_and_process_loss_are_not_success_and_bad_input_is_rejected() {
        let hub = Hub::default();
        let mut session = hub.open(
            "run",
            None,
            EventSink::new(|_| panic!("No receipt without acknowledgment")),
        );
        session.ready(true);
        for text in ["", " ", "/command", "a\0b"] {
            assert!(hub
                .send(
                    "run",
                    None,
                    Input {
                        text: text.into(),
                        ..input()
                    }
                )
                .await
                .is_err());
        }
        assert!(hub
            .send(
                "run",
                None,
                Input {
                    text: "😀".repeat(15001),
                    ..input()
                }
            )
            .await
            .is_err());
        for reject in [true, false] {
            let sender = hub.clone();
            let task = tokio::spawn(async move { sender.send("run", None, input()).await });
            let delivery = session.rx.recv().await.unwrap();
            if reject {
                session.delivered(delivery, Err("Turn ended".into()));
            } else {
                drop(delivery);
            }
            assert!(task.await.unwrap().is_err());
        }
    }
}
