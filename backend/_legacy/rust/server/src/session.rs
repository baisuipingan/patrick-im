use crate::signing::{create_signed_token, read_signed_token};
use anyhow::{Context, Result};
use axum::http::HeaderMap;
use axum::http::header::{COOKIE, SET_COOKIE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

const SESSION_COOKIE_NAME: &str = "patrick_im_rs_session";
const SESSION_TTL_MS: u64 = 1000 * 60 * 60 * 24 * 14;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct SessionPayload {
    pub clientId: String,
    pub nickname: String,
    pub issuedAt: u64,
    pub expiresAt: u64,
}

pub fn get_or_create_session(
    headers: &HeaderMap,
    response_headers: &mut HeaderMap,
    secure: bool,
    secret: &str,
) -> Result<SessionPayload> {
    let now = now_ms();
    let existing = read_session(headers, secret).ok().flatten();
    let session = existing.unwrap_or_else(|| SessionPayload {
        clientId: Uuid::new_v4().to_string(),
        nickname: create_guest_name(),
        issuedAt: now,
        expiresAt: now + SESSION_TTL_MS,
    });

    let refreshed = SessionPayload {
        expiresAt: now + SESSION_TTL_MS,
        ..session
    };

    let cookie = serialize_session_cookie(&refreshed, secure, secret)?;
    response_headers.append(
        SET_COOKIE,
        cookie.parse().context("invalid set-cookie header")?,
    );

    Ok(refreshed)
}

pub fn require_session(headers: &HeaderMap, secret: &str) -> Result<Option<SessionPayload>> {
    read_session(headers, secret)
}

fn read_session(headers: &HeaderMap, secret: &str) -> Result<Option<SessionPayload>> {
    let cookies = parse_cookies(headers.get(COOKIE).and_then(|value| value.to_str().ok()));
    let Some(cookie) = cookies.get(SESSION_COOKIE_NAME) else {
        return Ok(None);
    };
    let session: SessionPayload = read_signed_token(secret, cookie)?;
    if session.expiresAt < now_ms() {
        return Ok(None);
    }
    Ok(Some(session))
}

fn serialize_session_cookie(
    session: &SessionPayload,
    secure: bool,
    secret: &str,
) -> Result<String> {
    let token = create_signed_token(secret, session)?;
    let secure = if secure { "; Secure" } else { "" };
    Ok(format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={};{}",
        SESSION_TTL_MS / 1000,
        secure
    ))
}

fn parse_cookies(raw: Option<&str>) -> HashMap<String, String> {
    raw.unwrap_or_default()
        .split(';')
        .filter_map(|entry| {
            let (key, value) = entry.trim().split_once('=')?;
            Some((key.trim().to_owned(), value.trim().to_owned()))
        })
        .collect()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn create_guest_name() -> String {
    let id = Uuid::new_v4().simple().to_string();
    format!("访客-{}", &id[..4])
}
