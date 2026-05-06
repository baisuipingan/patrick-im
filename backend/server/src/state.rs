use crate::config::AppConfig;
use crate::services::relay_store::RelayStore;
use crate::services::room_hub::RoomHub;
use crate::store::message_store::MessageStore;
use std::sync::Arc;
use tokio::sync::mpsc;

pub type ClientTx = mpsc::UnboundedSender<String>;

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
            relay_store: Arc::new(RelayStore::new(&config)),
            room_hub: Arc::new(RoomHub::new()),
            message_store: Arc::new(message_store),
            config,
        })
    }
}
