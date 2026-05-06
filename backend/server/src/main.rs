use anyhow::Context;
use patrick_im_server::config::AppConfig;
use patrick_im_server::routes;
use patrick_im_server::state::AppState;
use salvo::affix_state;
use salvo::compression::{Compression, CompressionLevel};
use salvo::logging::Logger;
use salvo::prelude::*;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::from_env()?;
    init_tracing(&config)?;

    let state = AppState::new(config.clone()).await?;
    let compression = Compression::new()
        .enable_gzip(CompressionLevel::Default)
        .enable_brotli(CompressionLevel::Default)
        .min_length(1024);
    let router = Router::new()
        .hoop(Logger::new())
        .hoop(compression)
        .hoop(affix_state::inject(state))
        .push(routes::router());

    tracing::info!(
        bind = %config.bind,
        public_base_url = %config.public_base_url,
        "starting patrick-im Rust server skeleton"
    );

    let acceptor = TcpListener::new(config.bind.clone())
        .try_bind()
        .await
        .with_context(|| format!("failed to bind {}", config.bind))?;

    Server::new(acceptor).serve(router).await;
    Ok(())
}

fn init_tracing(config: &AppConfig) -> anyhow::Result<()> {
    let filter = EnvFilter::try_new(&config.log_filter)
        .with_context(|| format!("invalid log filter: {}", config.log_filter))?;

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_thread_ids(true)
        .with_thread_names(true)
        .json()
        .try_init()
        .map_err(|error| anyhow::anyhow!("failed to initialize tracing subscriber: {error}"))
}
