use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
pub struct AppConfig {
    pub bind: String,
    pub log_filter: String,
    pub public_base_url: String,
    pub stun_urls: Vec<String>,
    pub turn_urls: Vec<String>,
    pub turn_username: Option<String>,
    pub turn_credential: Option<String>,
    pub mysql_url: String,
    pub file_store_path: PathBuf,
    pub session_secret: String,
    pub secure_cookies: bool,
    pub recent_message_limit: usize,
}

impl AppConfig {
    pub fn from_env() -> Result<Self> {
        let bind = env_or("PATRICK_IM_BIND", "0.0.0.0:5800");
        let log_filter = env_or("PATRICK_IM_LOG", "info,tower_http=info,axum=info");
        let public_base_url = normalize_base_url(env_required("PATRICK_IM_PUBLIC_BASE_URL")?);
        let stun_urls = split_csv(&env_or(
            "PATRICK_IM_STUN_URLS",
            "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302",
        ));
        let turn_urls = split_csv(&env_or("PATRICK_IM_TURN_URLS", ""));
        let turn_username = env_optional("PATRICK_IM_TURN_USERNAME");
        let turn_credential = env_optional("PATRICK_IM_TURN_CREDENTIAL");
        let mysql_url = env_required("PATRICK_IM_MYSQL_URL")?;
        let file_store_path = PathBuf::from(env_or("PATRICK_IM_FILE_STORE_PATH", "./data/files"));
        let session_secret = env_required("PATRICK_IM_SESSION_SECRET")?;
        let secure_cookies = env_bool_or(
            "PATRICK_IM_SECURE_COOKIES",
            public_base_url.starts_with("https://"),
        );
        let recent_message_limit = env_usize_or("PATRICK_IM_RECENT_MESSAGE_LIMIT", 60);

        Ok(Self {
            bind,
            log_filter,
            public_base_url,
            stun_urls,
            turn_urls,
            turn_username,
            turn_credential,
            mysql_url,
            file_store_path,
            session_secret,
            secure_cookies,
            recent_message_limit,
        })
    }
}

fn env_required(key: &str) -> Result<String> {
    let value = env::var(key).with_context(|| format!("missing required env: {key}"))?;
    if value.trim().is_empty() {
        bail!("env {key} is empty");
    }
    Ok(value)
}

fn env_or(key: &str, fallback: &str) -> String {
    env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

fn env_optional(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.trim().is_empty())
}

fn normalize_base_url(value: String) -> String {
    value.trim().trim_end_matches('/').to_owned()
}

fn split_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn env_usize_or(key: &str, fallback: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_bool_or(key: &str, fallback: bool) -> bool {
    env::var(key)
        .ok()
        .and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
        .unwrap_or(fallback)
}
