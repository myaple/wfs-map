use poem::{Server, listener::TcpListener};
use wfs_workspaces::{Auth, app, database};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = std::env::var("DATABASE_URL")
        .map_err(|_| "DATABASE_URL must point to PostgreSQL/PostGIS")?;
    let auth = match std::env::var("AUTH_MODE").as_deref() {
        Ok("development") => {
            Auth::Development(std::env::var("DEV_USER").unwrap_or_else(|_| "local-analyst".into()))
        }
        Ok("proxy") | Err(_) => {
            let header = std::env::var("USER_ID_HEADER").unwrap_or_else(|_| "x-user-id".into());
            poem::http::HeaderName::from_bytes(header.as_bytes())
                .map_err(|_| "USER_ID_HEADER must be a valid HTTP header name")?;
            Auth::Proxy(header)
        }
        _ => return Err("AUTH_MODE must be proxy or development".into()),
    };
    let bind = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let assets = std::env::var("ASSET_DIR").unwrap_or_else(|_| "dist".into());
    let pool = database(&url)?;
    println!("WFS workspace configuration service listening on {bind}");
    Server::new(TcpListener::bind(bind))
        .run_with_graceful_shutdown(
            app(pool, auth, &assets),
            async {
                let _ = tokio::signal::ctrl_c().await;
            },
            None,
        )
        .await?;
    Ok(())
}
