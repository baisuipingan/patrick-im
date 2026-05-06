use crate::protocol::{RoomPeer, ServerToClientMessage};
use crate::state::ClientTx;
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

        let (peers, joined_peer) = {
            let mut rooms = self.rooms.write().await;
            let room = rooms.entry(room_id.to_owned()).or_default();
            room.peers.insert(
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
            (peers, joined_peer)
        };

        JoinRoomResult {
            connection_id,
            peers,
            joined_peer,
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
        peer.nickname = sanitize_nickname(&nickname, &peer.nickname);
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
            let _ = target.send(encoded.clone());
        }
    }

    pub fn send_json<T>(&self, tx: &ClientTx, payload: &T) -> Result<(), salvo::http::StatusCode>
    where
        T: Serialize,
    {
        let encoded = serde_json::to_string(payload)
            .map_err(|_| salvo::http::StatusCode::INTERNAL_SERVER_ERROR)?;
        tx.send(encoded)
            .map_err(|_| salvo::http::StatusCode::INTERNAL_SERVER_ERROR)
    }
}

impl Default for RoomHub {
    fn default() -> Self {
        Self::new()
    }
}
