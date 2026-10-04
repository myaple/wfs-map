use poem::{Endpoint, EndpointExt, IntoResponse, endpoint::make_sync, web::Json};
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteConfig {
    pub banner_text: String,
    pub banner_background: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use poem::{Route, test::TestClient};
    use serde_json::json;

    #[tokio::test]
    async fn display_config_is_public_literal_and_not_cached() {
        let config = SiteConfig {
            banner_text: "Internal <use> & review".into(),
            banner_background: "#ffdf80".into(),
        };
        let client =
            TestClient::new(Route::new().at("/api/site-config", poem::get(config.endpoint())));
        let response = client.get("/api/site-config").send().await;
        response.assert_status_is_ok();
        response.assert_header("cache-control", "no-store");
        let value: serde_json::Value = response.0.into_body().into_json().await.unwrap();
        assert_eq!(
            value,
            json!({"bannerText": "Internal <use> & review", "bannerBackground": "#ffdf80"})
        );
    }
}

impl SiteConfig {
    pub fn from_env() -> Self {
        Self {
            banner_text: std::env::var("PAGE_BANNER_TEXT").unwrap_or_default(),
            banner_background: std::env::var("PAGE_BANNER_BACKGROUND")
                .unwrap_or_else(|_| "#eaf0f4".into()),
        }
    }

    pub fn endpoint(self) -> impl Endpoint {
        make_sync(move |_| Json(self.clone()).into_response()).after(|result| async move {
            result.map(|mut response| {
                response
                    .headers_mut()
                    .insert("cache-control", "no-store".parse().unwrap());
                response
            })
        })
    }
}
