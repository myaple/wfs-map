pub mod state;
use chrono::{DateTime, Utc};
use diesel::{
    prelude::*,
    r2d2::{ConnectionManager, Pool},
};
use diesel_migrations::{EmbeddedMigrations, MigrationHarness, embed_migrations};
use poem::{
    EndpointExt, Error, Request, Route, endpoint::StaticFilesEndpoint, http::StatusCode,
    middleware::SizeLimit,
};
use poem_openapi::{Object, OpenApi, OpenApiService, param::Path, payload::Json, types::Any};
use serde_json::Value;
use uuid::Uuid;

diesel::table! { analyses (id) { id -> Text, owner -> Text, name -> Text, state -> Jsonb, revision -> Int8, share_token -> Nullable<Text>, updated_at -> Timestamptz, } }
#[derive(Queryable, Selectable)]
#[diesel(table_name=analyses)]
struct Record {
    id: String,
    name: String,
    state: Value,
    revision: i64,
    share_token: Option<String>,
    updated_at: DateTime<Utc>,
}
pub type DbPool = Pool<ConnectionManager<PgConnection>>;
const MIGRATIONS: EmbeddedMigrations = embed_migrations!();
fn error(message: &str, status: StatusCode) -> Error {
    Error::from_string(message, status)
}
fn internal() -> Error {
    error(
        "Workspace database operation failed",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}
pub fn database(url: &str) -> Result<DbPool, Box<dyn std::error::Error + Send + Sync>> {
    let pool = Pool::builder()
        .max_size(8)
        .build(ConnectionManager::<PgConnection>::new(url))?;
    // Serialize startup migrations when several API instances start together.
    let mut conn = pool.get()?;
    diesel::sql_query("SELECT pg_advisory_lock(1464226643)").execute(&mut conn)?;
    let result = conn.run_pending_migrations(MIGRATIONS).map(|_| ());
    diesel::sql_query("SELECT pg_advisory_unlock(1464226643)").execute(&mut conn)?;
    result?;
    drop(conn);
    Ok(pool)
}
#[derive(Clone)]
pub enum Auth {
    Proxy(String),
    Development(String),
}
#[derive(Clone)]
struct Actor(String);
impl Auth {
    fn identify(&self, req: &Request) -> poem::Result<Actor> {
        match self {
            Self::Development(user) => Ok(Actor(user.clone())),
            Self::Proxy(header) => {
                let user = req
                    .headers()
                    .get(header.as_str())
                    .and_then(|v| v.to_str().ok())
                    .filter(|s| !s.trim().is_empty() && s.len() <= 512)
                    .ok_or_else(|| {
                        error(
                            "Trusted user identity header required",
                            StatusCode::UNAUTHORIZED,
                        )
                    })?;
                Ok(Actor(user.to_string()))
            }
        }
    }
}
fn owner(req: &Request) -> String {
    req.extensions()
        .get::<Actor>()
        .expect("Authentication middleware")
        .0
        .clone()
}
fn mutation(req: &Request) -> poem::Result<()> {
    if req
        .headers()
        .get("x-workspace-request")
        .and_then(|v| v.to_str().ok())
        != Some("1")
    {
        return Err(error(
            "Workspace request header required",
            StatusCode::FORBIDDEN,
        ));
    }
    Ok(())
}
#[derive(Object)]
#[oai(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteAnalysis {
    name: String,
    state: Any<Value>,
    revision: Option<i64>,
}
#[derive(Object)]
#[oai(rename_all = "camelCase")]
pub struct Analysis {
    id: String,
    name: String,
    state: Any<Value>,
    revision: i64,
    updated_at: String,
    read_only: bool,
    shared: bool,
}
#[derive(Object)]
#[oai(rename_all = "camelCase")]
pub struct Summary {
    id: String,
    name: String,
    revision: i64,
    updated_at: String,
    shared: bool,
}
#[derive(Object)]
pub struct Identity {
    user: String,
}
#[derive(Object)]
pub struct Share {
    token: String,
}
#[derive(Object)]
pub struct Health {
    ok: bool,
}
fn analysis(r: Record, read_only: bool) -> Analysis {
    Analysis {
        id: r.id,
        name: r.name,
        state: Any(r.state),
        revision: r.revision,
        updated_at: r.updated_at.to_rfc3339(),
        read_only,
        shared: r.share_token.is_some(),
    }
}
fn validate(write: &WriteAnalysis) -> poem::Result<()> {
    if write.name.trim().is_empty() || write.name.chars().count() > 120 {
        return Err(error(
            "Name must contain 1–120 characters",
            StatusCode::BAD_REQUEST,
        ));
    }
    state::validate(&write.state.0).map_err(|e| error(e, StatusCode::BAD_REQUEST))
}
#[derive(Clone)]
struct Api {
    pool: DbPool,
}
impl Api {
    async fn db<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut PgConnection) -> poem::Result<T> + Send + 'static,
    ) -> poem::Result<T> {
        let pool = self.pool.clone();
        tokio::task::spawn_blocking(move || {
            let mut c = pool.get().map_err(|_| internal())?;
            f(&mut c)
        })
        .await
        .map_err(|_| internal())?
    }
}
#[OpenApi]
impl Api {
    /// Identity supplied in the configured trusted header by the authentication gateway.
    #[oai(path = "/me", method = "get")]
    async fn me(&self, req: &Request) -> Json<Identity> {
        Json(Identity { user: owner(req) })
    }
    /// List this user's named analyses. No dataset contents are stored.
    #[oai(path = "/analyses", method = "get")]
    async fn list(&self, req: &Request) -> poem::Result<Json<Vec<Summary>>> {
        let user = owner(req);
        self.db(move |c| {
            let rows = analyses::table
                .filter(analyses::owner.eq(user))
                .order(analyses::updated_at.desc())
                .select(Record::as_select())
                .load(c)
                .map_err(|_| internal())?;
            Ok(Json(
                rows.into_iter()
                    .map(|r| Summary {
                        id: r.id,
                        name: r.name,
                        revision: r.revision,
                        updated_at: r.updated_at.to_rfc3339(),
                        shared: r.share_token.is_some(),
                    })
                    .collect(),
            ))
        })
        .await
    }
    /// Create a configuration-only analysis, including a personal copy of a shared setup.
    #[oai(path = "/analyses", method = "post")]
    async fn create(
        &self,
        req: &Request,
        body: Json<WriteAnalysis>,
    ) -> poem::Result<Json<Analysis>> {
        mutation(req)?;
        validate(&body.0)?;
        let user = owner(req);
        let name = body.0.name.trim().to_string();
        let value = body.0.state.0;
        let id = Uuid::new_v4().to_string();
        self.db(move |c| {
            let r = diesel::insert_into(analyses::table)
                .values((
                    analyses::id.eq(id),
                    analyses::owner.eq(user),
                    analyses::name.eq(name),
                    analyses::state.eq(value),
                ))
                .returning(Record::as_returning())
                .get_result(c)
                .map_err(|_| internal())?;
            Ok(Json(analysis(r, false)))
        })
        .await
    }
    #[oai(path = "/analyses/:id", method = "get")]
    async fn get(&self, req: &Request, id: Path<String>) -> poem::Result<Json<Analysis>> {
        let user = owner(req);
        self.db(move |c| {
            let r = analyses::table
                .filter(analyses::id.eq(id.0))
                .filter(analyses::owner.eq(user))
                .select(Record::as_select())
                .first(c)
                .optional()
                .map_err(|_| internal())?
                .ok_or_else(|| error("Analysis not found", StatusCode::NOT_FOUND))?;
            Ok(Json(analysis(r, false)))
        })
        .await
    }
    /// Compare-and-swap prevents concurrent tabs from overwriting newer saved state.
    #[oai(path = "/analyses/:id", method = "put")]
    async fn update(
        &self,
        req: &Request,
        id: Path<String>,
        body: Json<WriteAnalysis>,
    ) -> poem::Result<Json<Analysis>> {
        mutation(req)?;
        validate(&body.0)?;
        let revision = body
            .0
            .revision
            .filter(|r| *r > 0)
            .ok_or_else(|| error("Saved revision required", StatusCode::BAD_REQUEST))?;
        let user = owner(req);
        let name = body.0.name.trim().to_string();
        let value = body.0.state.0;
        self.db(move |c| {
            let r = diesel::update(
                analyses::table
                    .filter(analyses::id.eq(&id.0))
                    .filter(analyses::owner.eq(&user))
                    .filter(analyses::revision.eq(revision)),
            )
            .set((
                analyses::name.eq(name),
                analyses::state.eq(value),
                analyses::revision.eq(analyses::revision + 1),
                analyses::updated_at.eq(Utc::now()),
            ))
            .returning(Record::as_returning())
            .get_result(c)
            .optional()
            .map_err(|_| internal())?;
            if let Some(r) = r {
                return Ok(Json(analysis(r, false)));
            }
            let exists = analyses::table
                .filter(analyses::id.eq(id.0))
                .filter(analyses::owner.eq(user))
                .count()
                .get_result::<i64>(c)
                .map_err(|_| internal())?
                > 0;
            Err(if exists {
                error(
                    "A newer version was saved in another tab. Reopen the analysis or save a copy.",
                    StatusCode::CONFLICT,
                )
            } else {
                error("Analysis not found", StatusCode::NOT_FOUND)
            })
        })
        .await
    }
    #[oai(path = "/analyses/:id", method = "delete")]
    async fn delete(&self, req: &Request, id: Path<String>) -> poem::Result<Json<Health>> {
        mutation(req)?;
        let user = owner(req);
        self.db(move |c| {
            let n = diesel::delete(
                analyses::table
                    .filter(analyses::id.eq(id.0))
                    .filter(analyses::owner.eq(user)),
            )
            .execute(c)
            .map_err(|_| internal())?;
            if n == 0 {
                return Err(error("Analysis not found", StatusCode::NOT_FOUND));
            }
            Ok(Json(Health { ok: true }))
        })
        .await
    }
    /// Share a live read-only setup with authenticated holders of this unguessable link.
    #[oai(path = "/analyses/:id/share", method = "post")]
    async fn share(&self, req: &Request, id: Path<String>) -> poem::Result<Json<Share>> {
        mutation(req)?;
        let user = owner(req);
        self.db(move |c| {
            use diesel::sql_types::{Nullable, Text};
            let token = Uuid::new_v4().to_string();
            let existing_or_new = diesel::dsl::sql::<Nullable<Text>>("COALESCE(share_token, ")
                .bind::<Text, _>(token)
                .sql(")");
            let r = diesel::update(
                analyses::table
                    .filter(analyses::id.eq(id.0))
                    .filter(analyses::owner.eq(user)),
            )
            .set(analyses::share_token.eq(existing_or_new))
            .returning(Record::as_returning())
            .get_result::<Record>(c)
            .optional()
            .map_err(|_| internal())?
            .ok_or_else(|| error("Analysis not found", StatusCode::NOT_FOUND))?;
            Ok(Json(Share {
                token: r.share_token.expect("Share token set atomically"),
            }))
        })
        .await
    }
    #[oai(path = "/analyses/:id/share", method = "delete")]
    async fn revoke(&self, req: &Request, id: Path<String>) -> poem::Result<Json<Health>> {
        mutation(req)?;
        let user = owner(req);
        self.db(move |c| {
            let n = diesel::update(
                analyses::table
                    .filter(analyses::id.eq(id.0))
                    .filter(analyses::owner.eq(user)),
            )
            .set(analyses::share_token.eq(None::<String>))
            .execute(c)
            .map_err(|_| internal())?;
            if n == 0 {
                return Err(error("Analysis not found", StatusCode::NOT_FOUND));
            }
            Ok(Json(Health { ok: true }))
        })
        .await
    }
    #[oai(path = "/shared/:token", method = "get")]
    async fn shared(&self, token: Path<String>) -> poem::Result<Json<Analysis>> {
        self.db(move |c| {
            let r = analyses::table
                .filter(analyses::share_token.eq(token.0))
                .select(Record::as_select())
                .first(c)
                .optional()
                .map_err(|_| internal())?
                .ok_or_else(|| error("Shared analysis not found", StatusCode::NOT_FOUND))?;
            Ok(Json(analysis(r, true)))
        })
        .await
    }
}
#[poem::handler]
async fn health() -> Json<Health> {
    Json(Health { ok: true })
}
pub fn app(pool: DbPool, auth: Auth, assets: &str) -> Route {
    let api = OpenApiService::new(Api { pool }, "WFS analysis workspaces", "1.0.0").server("/api");
    let spec = api.spec_endpoint();
    let routes = Route::new()
        .at("/openapi.json", spec)
        .nest("/", api)
        .with(SizeLimit::new(1_064_960))
        .before(move |mut req| {
            let auth = auth.clone();
            async move {
                let actor = auth.identify(&req)?;
                req.extensions_mut().insert(actor);
                Ok(req)
            }
        })
        .after(|result| async move {
            result.map(|mut response| {
                response
                    .headers_mut()
                    .insert("cache-control", "no-store".parse().unwrap());
                response
            })
        });
    Route::new()
        .at("/health", poem::get(health))
        .nest("/api", routes)
        .nest(
            "/",
            StaticFilesEndpoint::new(assets).index_file("index.html"),
        )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proxy_auth_uses_only_the_configured_identity_header() {
        let auth = Auth::Proxy("x-analyst-id".into());
        let wrong = Request::builder().header("x-user-id", "other").finish();
        assert!(auth.identify(&wrong).is_err());
        let empty = Request::builder().header("x-analyst-id", "  ").finish();
        assert!(auth.identify(&empty).is_err());
        let req = Request::builder().header("x-analyst-id", "alice").finish();
        assert_eq!(auth.identify(&req).unwrap().0, "alice");
        assert_eq!(
            Auth::Development("local".into()).identify(&req).unwrap().0,
            "local"
        );
    }
}
