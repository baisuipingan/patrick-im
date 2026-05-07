use crate::protocol::{RoomPeer, ServerToClientMessage};
use crate::state::{ClientSendError, ClientTx};
use crate::utils::{now_ms, sanitize_nickname};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Debug, Clone)]
#[allow(non_snake_case)]
pub struct RoomPeerSession {
    pub connectionId: String,
    pub clientId: String,
    pub nickname: String,
    pub joinedAt: u64,
    pub lastSeenAt: u64,
    pub tx: ClientTx,
}

#[derive(Debug, Default)]
struct RoomRuntime {
    peers: HashMap<String, RoomPeerSession>,
}

#[derive(Debug, Clone)]
pub struct RoomHub {
    rooms: Arc<RwLock<HashMap<String, RoomRuntime>>>,
}

#[derive(Debug, Clone)]
pub struct JoinRoomResult {
    pub connection_id: String,
    pub peers: Vec<RoomPeer>,
    pub joined_peer: RoomPeer,
    pub replaced_tx: Option<ClientTx>,
}

impl RoomHub {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn join_room(
        &self,
        room_id: &str,
        client_id: &str,
        nickname: &str,
        tx: ClientTx,
    ) -> JoinRoomResult {
        let joined_at = now_ms();
        let connection_id = Uuid::new_v4().to_string();
        let fallback_name = client_id.chars().take(4).collect::<String>();
        let sanitized_name = sanitize_nickname(nickname, &fallback_name);

        let (peers, joined_peer, replaced_tx) = {
            let mut rooms = self.rooms.write().await;
            let room = rooms.entry(room_id.to_owned()).or_default();
            let replaced = room.peers.insert(
                client_id.to_owned(),
                RoomPeerSession {
                    connectionId: connection_id.clone(),
                    clientId: client_id.to_owned(),
                    nickname: sanitized_name.clone(),
                    joinedAt: joined_at,
                    lastSeenAt: joined_at,
                    tx,
                },
            );

            let joined_peer = RoomPeer {
                clientId: client_id.to_owned(),
                nickname: sanitized_name,
                joinedAt: joined_at,
            };
            let peers = room
                .peers
                .values()
                .filter(|peer| peer.clientId != client_id)
                .map(|peer| RoomPeer {
                    clientId: peer.clientId.clone(),
                    nickname: peer.nickname.clone(),
                    joinedAt: peer.joinedAt,
                })
                .collect::<Vec<_>>();
            (peers, joined_peer, replaced.map(|session| session.tx))
        };

        JoinRoomResult {
            connection_id,
            peers,
            joined_peer,
            replaced_tx,
        }
    }

    pub async fn is_current_connection(
        &self,
        room_id: &str,
        client_id: &str,
        connection_id: &str,
    ) -> bool {
        let rooms = self.rooms.read().await;
        rooms
            .get(room_id)
            .and_then(|room| room.peers.get(client_id))
            .map(|peer| peer.connectionId == connection_id)
            .unwrap_or(false)
    }

    pub async fn is_client_connected(&self, room_id: &str, client_id: &str) -> bool {
        let rooms = self.rooms.read().await;
        rooms
            .get(room_id)
            .map(|room| room.peers.contains_key(client_id))
            .unwrap_or(false)
    }

    pub async fn display_name_for(&self, room_id: &str, client_id: &str) -> Option<String> {
        let rooms = self.rooms.read().await;
        rooms
            .get(room_id)
            .and_then(|room| room.peers.get(client_id))
            .map(|peer| peer.nickname.clone())
    }

    pub async fn touch(&self, room_id: &str, client_id: &str, connection_id: &str) {
        let mut rooms = self.rooms.write().await;
        let Some(peer) = rooms
            .get_mut(room_id)
            .and_then(|room| room.peers.get_mut(client_id))
        else {
            return;
        };
        if peer.connectionId == connection_id {
            peer.lastSeenAt = now_ms();
        }
    }

    pub async fn rename_peer(
        &self,
        room_id: &str,
        client_id: &str,
        connection_id: &str,
        nickname: String,
    ) -> Option<RoomPeer> {
        let mut rooms = self.rooms.write().await;
        let room = rooms.get_mut(room_id)?;
        let peer = room.peers.get_mut(client_id)?;
        if peer.connectionId != connection_id {
            return None;
        }
        let next_nickname = sanitize_nickname(&nickname, &peer.nickname);
        if next_nickname == peer.nickname {
            peer.lastSeenAt = now_ms();
            return None;
        }
        peer.nickname = next_nickname;
        peer.lastSeenAt = now_ms();
        Some(RoomPeer {
            clientId: peer.clientId.clone(),
            nickname: peer.nickname.clone(),
            joinedAt: peer.joinedAt,
        })
    }

    pub async fn resolve_signal_target(
        &self,
        room_id: &str,
        client_id: &str,
        connection_id: &str,
        target_id: &str,
    ) -> Option<ClientTx> {
        let rooms = self.rooms.read().await;
        let room = rooms.get(room_id)?;
        let sender = room.peers.get(client_id)?;
        if sender.connectionId != connection_id {
            return None;
        }
        room.peers.get(target_id).map(|peer| peer.tx.clone())
    }

    pub async fn leave_room(&self, room_id: &str, client_id: &str, connection_id: &str) -> bool {
        let mut rooms = self.rooms.write().await;
        let Some(room) = rooms.get_mut(room_id) else {
            return false;
        };

        let existed = room
            .peers
            .get(client_id)
            .map(|peer| peer.connectionId == connection_id)
            .unwrap_or(false);
        if !existed {
            return false;
        }

        room.peers.remove(client_id);
        if room.peers.is_empty() {
            rooms.remove(room_id);
        }
        true
    }

    pub async fn broadcast(
        &self,
        room_id: &str,
        except: Option<&str>,
        only: Option<&[String]>,
        payload: &ServerToClientMessage,
    ) {
        let encoded = match serde_json::to_string(payload) {
            Ok(encoded) => encoded,
            Err(_) => return,
        };

        let targets = {
            let rooms = self.rooms.read().await;
            let Some(room) = rooms.get(room_id) else {
                return;
            };
            room.peers
                .iter()
                .filter(|(client_id, _)| except != Some(client_id.as_str()))
                .filter(|(client_id, _)| {
                    only.map(|list| list.iter().any(|item| item == *client_id))
                        .unwrap_or(true)
                })
                .map(|(_, peer)| peer.tx.clone())
                .collect::<Vec<_>>()
        };

        for target in targets {
            if let Err(error) = target.try_send(encoded.clone()) {
                match error {
                    ClientSendError::Closed => {
                        tracing::debug!(room_id, "dropping closed outbound client queue");
                    }
                    ClientSendError::Backpressure => {
                        tracing::warn!(
                            room_id,
                            "closing slow outbound client due to queue backpressure"
                        );
                    }
                }
            }
        }
    }

    pub fn send_json<T>(&self, tx: &ClientTx, payload: &T) -> Result<(), salvo::http::StatusCode>
    where
        T: Serialize,
    {
        let encoded = serde_json::to_string(payload)
            .map_err(|_| salvo::http::StatusCode::INTERNAL_SERVER_ERROR)?;
        tx.try_send(encoded)
            .map_err(|_| salvo::http::StatusCode::SERVICE_UNAVAILABLE)
    }
}

impl Default for RoomHub {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ServerToClientMessage;
    use tokio::sync::{mpsc, watch};

    fn client(capacity: usize) -> (ClientTx, mpsc::Receiver<String>, watch::Receiver<bool>) {
        let (sender, receiver) = mpsc::channel(capacity);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        (ClientTx::new(sender, shutdown_tx), receiver, shutdown_rx)
    }

    #[tokio::test]
    async fn join_room_returns_existing_peers_and_tracks_connection() {
        let hub = RoomHub::new();
        let (alice_tx, _alice_rx, _alice_shutdown) = client(4);
        let (bob_tx, _bob_rx, _bob_shutdown) = client(4);

        let alice = hub.join_room("room-1", "alice", "Alice", alice_tx).await;
        let bob = hub.join_room("room-1", "bob", "Bob", bob_tx).await;

        assert!(alice.peers.is_empty());
        assert!(alice.replaced_tx.is_none());
        assert_eq!(bob.peers.len(), 1);
        assert_eq!(bob.peers[0].clientId, "alice");
        assert!(
            hub.is_current_connection("room-1", "bob", &bob.connection_id)
                .await
        );
        assert!(!hub.is_current_connection("room-1", "bob", "wrong").await);
    }

    #[tokio::test]
    async fn join_room_returns_previous_connection_sender_for_same_client() {
        let hub = RoomHub::new();
        let (first_tx, _first_rx, first_shutdown) = client(4);
        let (second_tx, _second_rx, _second_shutdown) = client(4);

        let first = hub.join_room("room-1", "alice", "Alice", first_tx).await;
        let second = hub.join_room("room-1", "alice", "Alice 2", second_tx).await;

        assert!(first.replaced_tx.is_none());
        let replaced = second.replaced_tx.expect("expected replaced connection");
        replaced.close();
        assert!(*first_shutdown.borrow());
        assert!(
            hub.is_current_connection("room-1", "alice", &second.connection_id)
                .await
        );
    }

    #[tokio::test]
    async fn broadcast_respects_except_and_only_filters() {
        let hub = RoomHub::new();
        let (alice_tx, mut alice_rx, _alice_shutdown) = client(4);
        let (bob_tx, mut bob_rx, _bob_shutdown) = client(4);
        let (carol_tx, mut carol_rx, _carol_shutdown) = client(4);

        hub.join_room("room-1", "alice", "Alice", alice_tx).await;
        hub.join_room("room-1", "bob", "Bob", bob_tx).await;
        hub.join_room("room-1", "carol", "Carol", carol_tx).await;

        hub.broadcast(
            "room-1",
            Some("alice"),
            Some(&["bob".to_owned()]),
            &ServerToClientMessage::PeerLeft {
                clientId: "ghost".to_owned(),
            },
        )
        .await;

        assert!(alice_rx.try_recv().is_err());
        let bob_message = bob_rx.try_recv().expect("bob should receive broadcast");
        let bob_json: serde_json::Value = serde_json::from_str(&bob_message).unwrap();
        assert_eq!(bob_json["type"], "peer-left");
        assert_eq!(bob_json["clientId"], "ghost");
        assert!(carol_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn broadcast_closes_slow_client_when_queue_fills() {
        let hub = RoomHub::new();
        let (slow_tx, _slow_rx, slow_shutdown) = client(1);

        hub.join_room("room-1", "slow", "Slow", slow_tx).await;
        hub.broadcast(
            "room-1",
            None,
            None,
            &ServerToClientMessage::Pong { serverTime: 1 },
        )
        .await;
        hub.broadcast(
            "room-1",
            None,
            None,
            &ServerToClientMessage::Pong { serverTime: 2 },
        )
        .await;

        assert!(*slow_shutdown.borrow());
    }

    #[tokio::test]
    async fn rename_peer_ignores_duplicate_nickname_updates() {
        let hub = RoomHub::new();
        let (tx, _rx, _shutdown) = client(4);
        let joined = hub.join_room("room-1", "alice", "Alice", tx).await;

        let renamed = hub
            .rename_peer("room-1", "alice", &joined.connection_id, "Alice".to_owned())
            .await;

        assert!(renamed.is_none());
        assert_eq!(
            hub.display_name_for("room-1", "alice").await.as_deref(),
            Some("Alice")
        );
    }
}
