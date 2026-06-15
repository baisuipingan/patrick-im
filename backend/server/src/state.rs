use crate::config::AppConfig;
use crate::services::relay_store::RelayStore;
use crate::services::room_hub::RoomHub;
use crate::store::message_store::MessageStore;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};

pub const CLIENT_QUEUE_CAPACITY: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientSendError {
    Closed,
    Backpressure,
}

#[derive(Debug, Clone)]
pub struct ClientTx {
    sender: mpsc::Sender<String>,
    shutdown: watch::Sender<bool>,
}

impl ClientTx {
    pub fn new(sender: mpsc::Sender<String>, shutdown: watch::Sender<bool>) -> Self {
        Self { sender, shutdown }
    }

    pub fn subscribe_shutdown(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    pub fn try_send(&self, message: String) -> Result<(), ClientSendError> {
        match self.sender.try_send(message) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.close();
                Err(ClientSendError::Backpressure)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.close();
                Err(ClientSendError::Closed)
            }
        }
    }

    pub fn close(&self) {
        let _ = self.shutdown.send(true);
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub room_hub: Arc<RoomHub>,
    pub relay_store: Arc<RelayStore>,
    pub message_store: Arc<MessageStore>,
}

impl AppState {
    pub async fn new(config: AppConfig) -> anyhow::Result<Self> {
        let message_store = MessageStore::new(&config).await?;
        Ok(Self {
            relay_store: Arc::new(RelayStore::new(&config).await?),
            room_hub: Arc::new(RoomHub::new()),
            message_store: Arc::new(message_store),
            config,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_tx_marks_shutdown_on_backpressure() {
        let (sender, _receiver) = mpsc::channel(1);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let tx = ClientTx::new(sender, shutdown_tx);

        assert_eq!(tx.try_send("first".to_owned()), Ok(()));
        assert_eq!(
            tx.try_send("second".to_owned()),
            Err(ClientSendError::Backpressure)
        );
        assert!(*shutdown_rx.borrow());
    }

    #[test]
    fn client_tx_marks_shutdown_when_channel_closed() {
        let (sender, receiver) = mpsc::channel(1);
        drop(receiver);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let tx = ClientTx::new(sender, shutdown_tx);

        assert_eq!(
            tx.try_send("payload".to_owned()),
            Err(ClientSendError::Closed)
        );
        assert!(*shutdown_rx.borrow());
    }
}
