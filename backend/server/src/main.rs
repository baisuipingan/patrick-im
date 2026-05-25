use anyhow::Context;
use axum::Router;
use patrick_im_server::config::AppConfig;
use patrick_im_server::routes;
use patrick_im_server::state::AppState;
use time::macros::format_description;
use tokio::net::TcpListener;
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::time::OffsetTime;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::from_env()?;
    init_tracing(&config)?;

    let state = AppState::new(config.clone()).await?;
    let app = Router::new()
        .merge(routes::router())
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    tracing::info!(
        bind = %config.bind,
        public_base_url = %config.public_base_url,
        "starting patrick-im axum server"
    );

    let listener = TcpListener::bind(&config.bind)
        .await
        .with_context(|| format!("failed to bind {}", config.bind))?;

    axum::serve(listener, app)
        .await
        .context("axum server failed")?;
    Ok(())
}

fn init_tracing(config: &AppConfig) -> anyhow::Result<()> {
    let filter = EnvFilter::try_new(&config.log_filter)
        .with_context(|| format!("invalid log filter: {}", config.log_filter))?;
    let timer = OffsetTime::new(
        time::UtcOffset::from_hms(8, 0, 0)
            .map_err(|error| anyhow::anyhow!("invalid log timezone offset: {error}"))?,
        format_description!("[year]-[month]-[day] [hour]:[minute]:[second]"),
    );

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_timer(timer)
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(false)
        .try_init()
        .map_err(|error| anyhow::anyhow!("failed to initialize tracing subscriber: {error}"))
}
