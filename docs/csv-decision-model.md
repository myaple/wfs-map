# Optional CSV mapping with Clef / SystemOne

When a CSV is selected (or its delimiter changes), the browser can send **only
column names** to `POST /api/csv/infer-fields`. The authenticated Rust API calls
an administrator-configured SystemOne endpoint such as SGLang's
`http://clef:30000/v1/systemone`. Neither CSV rows nor file names are sent to the
backend/model; headers and predictions are not persisted or logged by this app.
The inference service may have its own logging policy.

## Configure the Rust backend

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `DECISION_MODEL_ENDPOINT` | unset | Full HTTP(S) POST URL; unset/empty disables inference. Include `/v1/systemone`. |
| `DECISION_MODEL_NAME` | `Cloudflare/clef` | Exact served model name or alias sent as `model`. |
| `DECISION_MODEL_API_KEY` | unset | Optional bearer token; stays on the backend. |
| `DECISION_MODEL_TIMEOUT_MS` | `6000` | Total budget for both inference calls, 100–30000 ms. |
| `DECISION_MODEL_MIN_PROBABILITY` | `0.55` | Minimum highest-option probability to apply a suggestion, 0–1. |
| `DECISION_MODEL_MIN_MARGIN` | `0.10` | Minimum gap between the highest and second-highest probabilities, 0–1. |

Set these in the server/container environment. Invalid configured values fail
startup with a configuration error. The application does not download or run
model weights; use your existing SGLang server. It makes no model call at startup
and remains usable if that service later fails. HTTPS validates the server's
certificate against the runtime CA bundle. For a private CA, mount a trusted
bundle and set `SSL_CERT_FILE`. Redirects are refused. No arbitrary endpoint or
API key can be supplied by the browser.

For Helm, merge [the decision-model values example](../charts/wfs-map/examples/decision-model.yaml)
with your site values. It uses `app.extraConfig` for non-secret settings and
`extraEnvVars` with `secretKeyRef` for the API key. Create the referenced Secret
in the release namespace. If a NetworkPolicy is enabled, allow the backend to
reach the model service and DNS as well as PostgreSQL.

## Questions and probabilities

The first request shares the complete header list across six typed `choice`
questions: event time, latitude, longitude, semimajor axis, semiminor axis, and
ellipse orientation. Choices use stable `c0`/`c1` identifiers mapped to the exact
original names (including punctuation/Unicode) and a `none` choice for absent,
ambiguous or unsupported fields. Criteria distinguish observation time from
arrival time, latitude from longitude/projected coordinates, semiaxes from full
axes, and ellipse orientation from unrelated heading. Headers are JSON data,
never protocol identifiers or trusted instructions.

If axes are accepted, one second batched request asks for their units **using the
chosen column names**: metres, nautical miles, or unknown/unsupported. This avoids
inferring units for a different candidate axis and spends at most two HTTP calls
per upload; schemas without plausible axes need one. Probabilities are ranked by
the backend, independently of `choice` and `confidence`, with up to three candidates
returned per question. Duplicate column assignments abstain. All option IDs,
probability bounds and distribution totals are validated before accepting output.

These are suggestions based on names, not an accuracy guarantee. A bare
`semi_major` cannot prove its units; `none` retains the existing unit selector.
The app's supported conventions remain ISO 8601 time (UTC), decimal-degree
latitude/longitude, semiaxis lengths in metres/nautical miles, and orientation in
degrees clockwise from north. Other conventions require conversion before import.
No new time, coordinate or orientation-unit controls are introduced.

## Frontend and fallback

Existing local header matching populates the form immediately. Model suggestions
can improve those values while the dialog is open, but never overwrite saved
mappings, saved units, or controls the user edits while a request is pending.
A partial ellipse is not applied because the form requires all three ellipse
fields together. Users review/change all suggestions and save normally; inference
does not trigger an import or enable the map's ellipse display.

Adding a source does not wait for the model. Closing the dialog, changing source
type, replacing the file, or changing the delimiter cancels stale inference.
Reopening an already configured CSV does not re-run inference. Disabled backends
return `{ "available": false, "fields": {} }`; missing Node/local APIs, auth
failures, timeouts, overload, malformed responses and upstream errors keep the
current mappings without failing the CSV upload.

Requests require the same trusted identity and `X-Workspace-Request: 1` header as
other API POSTs. They accept only a `columns` property, bounded to 1–254 unique
nonempty names, 256 UTF-8 bytes each, 8192 bytes total, and 60000 serialized request
bytes per upstream call. Larger schemas retain local/manual detection. Four
inferences per backend instance may run concurrently; extra requests fall back
rather than accumulating an unbounded queue. Responses are capped at 512000 bytes.

## API example

Request:

```json
{ "columns": ["position_east", "position_north", "observed_at"] }
```

An accepted prediction has the original name and its highest probability; `null`
means abstain. Candidate `null` is the explicit unknown option.

```json
{
  "available": true,
  "fields": {
    "longitudeField": {
      "value": "position_east",
      "probability": 0.9,
      "candidates": [
        { "value": "position_east", "probability": 0.9 },
        { "value": null, "probability": 0.06 },
        { "value": "position_north", "probability": 0.03 }
      ]
    }
  }
}
```

Protocol references: [Clef model card](https://huggingface.co/Cloudflare/clef#sglang)
and [SGLang Clef cookbook](https://docs.sglang.io/cookbook/autoregressive/Cloudflare/clef).
