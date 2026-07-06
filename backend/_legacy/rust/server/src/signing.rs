use anyhow::{Context, Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Serialize, de::DeserializeOwned};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub fn create_signed_token<T>(secret: &str, payload: &T) -> Result<String>
where
    T: Serialize,
{
    let payload = serde_json::to_vec(payload).context("failed to encode signed payload")?;
    let payload = URL_SAFE_NO_PAD.encode(payload);
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).context("invalid hmac secret")?;
    mac.update(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{payload}.{signature}"))
}

pub fn read_signed_token<T>(secret: &str, token: &str) -> Result<T>
where
    T: DeserializeOwned,
{
    let (payload, signature) = token
        .split_once('.')
        .ok_or_else(|| anyhow!("invalid signed token format"))?;

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).context("invalid hmac secret")?;
    mac.update(payload.as_bytes());
    let expected = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    if expected != signature {
        return Err(anyhow!("invalid signed token signature"));
    }

    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .context("failed to decode signed token payload")?;
    serde_json::from_slice(&decoded).context("failed to decode signed token json")
}
