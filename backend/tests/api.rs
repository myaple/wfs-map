use poem::{http::StatusCode, test::TestClient};
use serde_json::{Value, json};
use wfs_workspaces::{Auth, app, database};
fn state() -> Value {
    json!({"schemaVersion":1,"settings":{"sources":[],"background":{"url":"","attribution":"","enabled":false}},"query":{"choice":"all","bounds":{}},"analyses":[]})
}
// Explicitly run against a disposable PostGIS database (CI does this).
#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL pointing to a disposable PostGIS database"]
async fn ownership_revisions_sharing_and_configuration_only_storage() {
    let pool =
        database(&std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL required")).unwrap();
    let client = TestClient::new(app(
        pool.clone(),
        Auth::Proxy("x-analyst-id".into()),
        "../dist",
    ));
    let alice = format!("test-alice-{}", uuid::Uuid::new_v4());
    let bob = format!("test-bob-{}", uuid::Uuid::new_v4());
    client
        .get("/api/analyses")
        .send()
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
    client
        .get("/api/analyses")
        .header("x-other-user", &alice)
        .send()
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
    let create = client
        .post("/api/analyses")
        .header("x-analyst-id", &alice)
        .header("x-workspace-request", "1")
        .body_json(&json!({"name":"Daily analysis","state":state()}))
        .send()
        .await;
    create.assert_status_is_ok();
    let doc: Value = create.0.into_body().into_json().await.unwrap();
    let id = doc["id"].as_str().unwrap();
    let url = format!("/api/analyses/{id}");
    client
        .get(&url)
        .header("x-analyst-id", &bob)
        .send()
        .await
        .assert_status(StatusCode::NOT_FOUND);
    client
        .delete(&url)
        .header("x-analyst-id", &bob)
        .header("x-workspace-request", "1")
        .send()
        .await
        .assert_status(StatusCode::NOT_FOUND);
    let mut bad = state();
    bad["csvText"] = json!("SENSITIVE ROWS");
    client
        .put(&url)
        .header("x-analyst-id", &alice)
        .header("x-workspace-request", "1")
        .body_json(&json!({"name":"Bad","state":bad,"revision":1}))
        .send()
        .await
        .assert_status(StatusCode::BAD_REQUEST);
    client
        .put(&url)
        .header("x-analyst-id", &alice)
        .body_json(&json!({"name":"Daily","state":state(),"revision":1}))
        .send()
        .await
        .assert_status(StatusCode::FORBIDDEN);
    for expected in [StatusCode::OK, StatusCode::CONFLICT] {
        client
            .put(&url)
            .header("x-analyst-id", &alice)
            .header("x-workspace-request", "1")
            .body_json(&json!({"name":"Updated","state":state(),"revision":1}))
            .send()
            .await
            .assert_status(expected);
    }
    let share = client
        .post(format!("{url}/share"))
        .header("x-analyst-id", &alice)
        .header("x-workspace-request", "1")
        .send()
        .await;
    share.assert_status_is_ok();
    let share: Value = share.0.into_body().into_json().await.unwrap();
    let shared_url = format!("/api/shared/{}", share["token"].as_str().unwrap());
    client
        .get(&shared_url)
        .send()
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
    let shared = client
        .get(&shared_url)
        .header("x-analyst-id", &bob)
        .send()
        .await;
    shared.assert_status_is_ok();
    let shared: Value = shared.0.into_body().into_json().await.unwrap();
    assert_eq!(shared["readOnly"], true);
    assert_eq!(shared["revision"], 2);
    client
        .put(&url)
        .header("x-analyst-id", &bob)
        .header("x-workspace-request", "1")
        .body_json(&json!({"name":"Hijack","state":state(),"revision":2}))
        .send()
        .await
        .assert_status(StatusCode::NOT_FOUND);
    client
        .delete(format!("{url}/share"))
        .header("x-analyst-id", &alice)
        .header("x-workspace-request", "1")
        .send()
        .await
        .assert_status_is_ok();
    client
        .get(&shared_url)
        .header("x-analyst-id", &bob)
        .send()
        .await
        .assert_status(StatusCode::NOT_FOUND);
    let spec = client
        .get("/api/openapi.json")
        .header("x-analyst-id", &alice)
        .send()
        .await;
    spec.assert_status_is_ok();
    let spec: Value = spec.0.into_body().into_json().await.unwrap();
    assert!(spec["paths"]["/analyses"].is_object());
    client
        .delete(&url)
        .header("x-analyst-id", &alice)
        .header("x-workspace-request", "1")
        .send()
        .await
        .assert_status_is_ok();
}
