use serde_json::Value;

fn object<'a>(
    v: &'a Value,
    keys: &[&str],
) -> Result<&'a serde_json::Map<String, Value>, &'static str> {
    let obj = v.as_object().ok_or("Expected configuration object")?;
    if obj.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err("Unknown configuration field; data payloads are not accepted");
    }
    Ok(obj)
}
fn string(v: &Value) -> Result<(), &'static str> {
    if v.as_str().is_some_and(|s| s.len() <= 8192) {
        Ok(())
    } else {
        Err("Invalid configuration string")
    }
}
fn finite(v: &Value) -> Result<(), &'static str> {
    if v.as_f64().is_some_and(f64::is_finite) {
        Ok(())
    } else {
        Err("Invalid numeric setting")
    }
}
fn array(v: &Value, max: usize) -> Result<&Vec<Value>, &'static str> {
    v.as_array()
        .filter(|a| a.len() <= max)
        .ok_or("Configuration list too large")
}
fn required<'a>(v: &'a Value, key: &str) -> Result<&'a Value, &'static str> {
    v.get(key).ok_or("Missing configuration field")
}
fn expression(v: &Value, depth: usize) -> Result<(), &'static str> {
    if depth > 20 {
        return Err("Filter nesting too deep");
    }
    let op = required(v, "op")?
        .as_str()
        .ok_or("Invalid filter operator")?;
    match op {
        "and" | "or" => {
            object(v, &["op", "children"])?;
            for child in array(required(v, "children")?, 200)? {
                expression(child, depth + 1)?;
            }
        }
        "bbox" => {
            object(v, &["op", "west", "east", "south", "north"])?;
            for k in ["west", "east", "south", "north"] {
                finite(required(v, k)?)?;
            }
        }
        "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "null" | "notnull" | "in"
        | "notin" => {
            let o = object(v, &["op", "field", "value", "values"])?;
            string(required(v, "field")?)?;
            if let Some(value) = o.get("value") {
                string(value)?;
            }
            if let Some(values) = o.get("values") {
                for value in array(values, 10000)? {
                    string(value)?;
                }
            }
        }
        // Observation indices identify local rows and are deliberately not shared.
        _ => return Err("Unsupported saved filter operator"),
    }
    Ok(())
}
/// Configuration-only allowlist. Never store arbitrary application/worker state.
/// Errors intentionally omit the submitted values.
pub fn validate(v: &Value) -> Result<(), &'static str> {
    if serde_json::to_vec(v)
        .map_err(|_| "Invalid configuration")?
        .len()
        > 1_048_576
    {
        return Err("Workspace configuration exceeds 1 MiB");
    }
    object(
        v,
        &[
            "schemaVersion",
            "settings",
            "query",
            "analyses",
            "comparisons",
            "relationships",
        ],
    )?;
    if v.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported workspace version");
    }
    let settings = required(v, "settings")?;
    object(settings, &["sources", "background", "map"])?;
    let mut ids = std::collections::HashSet::new();
    for source in array(required(settings, "sources")?, 8)? {
        let o = object(
            source,
            &["id", "name", "enabled", "config", "color", "coloring"],
        )?;
        let id = required(source, "id")?
            .as_str()
            .ok_or("Invalid source ID")?;
        if id.is_empty() || id.len() > 128 || !ids.insert(id) {
            return Err("Invalid or duplicate source ID");
        }
        string(required(source, "name")?)?;
        if required(source, "enabled")?.as_bool().is_none() {
            return Err("Invalid source enabled setting");
        }
        let config = required(source, "config")?;
        let c = object(
            config,
            &[
                "url",
                "layer",
                "version",
                "format",
                "srs",
                "axis",
                "sort",
                "pageSize",
                "limit",
                "timeField",
                "geometryField",
                "type",
                "csvRef",
                "fileName",
                "delimiter",
                "geometryMode",
                "longitudeField",
                "latitudeField",
            ],
        )?;
        for value in c.values() {
            string(value)?;
        }
        if !matches!(
            config.get("type").and_then(Value::as_str),
            Some("csv" | "wfs")
        ) {
            return Err("Invalid source type");
        }
        if let Some(color) = o.get("color") {
            let a = array(color, 3)?;
            if a.len() != 3 {
                return Err("Invalid source colour");
            }
            for v in a {
                finite(v)?;
            }
        }
        if let Some(coloring) = o.get("coloring") {
            let c = object(coloring, &["field", "bins", "low", "high", "categories"])?;
            for k in ["field", "low", "high"] {
                if let Some(v) = c.get(k) {
                    string(v)?;
                }
            }
            if let Some(v) = c.get("bins") {
                finite(v)?;
            }
            if let Some(categories) = c.get("categories") {
                let fields = categories
                    .as_object()
                    .ok_or("Invalid category colour configuration")?;
                for (field, values) in fields {
                    string(&Value::String(field.clone()))?;
                    for color in values
                        .as_object()
                        .ok_or("Invalid category colours")?
                        .values()
                    {
                        string(color)?;
                    }
                }
            }
        }
    }
    let bg = required(settings, "background")?;
    object(bg, &["url", "attribution", "enabled"])?;
    string(required(bg, "url")?)?;
    string(required(bg, "attribution")?)?;
    if required(bg, "enabled")?.as_bool().is_none() {
        return Err("Invalid basemap setting");
    }
    if let Some(map) = settings.get("map") {
        object(map, &["center", "zoom", "pointSize"])?;
        let center = array(required(map, "center")?, 2)?;
        if center.len() != 2 {
            return Err("Invalid map centre");
        }
        for v in center {
            finite(v)?;
        }
        for k in ["zoom", "pointSize"] {
            finite(required(map, k)?)?;
        }
    }
    let query = required(v, "query")?;
    object(query, &["choice", "bounds"])?;
    if !matches!(
        query.get("choice").and_then(Value::as_str),
        Some("all" | "custom" | "1" | "6" | "24" | "168")
    ) {
        return Err("Invalid time choice");
    }
    let bounds = required(query, "bounds")?;
    let b = object(bounds, &["time", "bbox"])?;
    if let Some(time) = b.get("time") {
        object(time, &["start", "end"])?;
        for k in ["start", "end"] {
            string(required(time, k)?)?;
        }
    }
    if let Some(bbox) = b.get("bbox") {
        object(bbox, &["west", "east", "south", "north"])?;
        for k in ["west", "east", "south", "north"] {
            finite(required(bbox, k)?)?;
        }
    }
    let mut seen = std::collections::HashSet::new();
    for analysis in array(required(v, "analyses")?, 8)? {
        object(analysis, &["id", "fields", "expression", "charts"])?;
        let id = required(analysis, "id")?
            .as_str()
            .ok_or("Invalid analysis source")?;
        if !ids.contains(id) || !seen.insert(id) {
            return Err("Invalid analysis source");
        }
        for field in array(required(analysis, "fields")?, 1000)? {
            object(field, &["name", "kind"])?;
            string(required(field, "name")?)?;
            if !matches!(
                field.get("kind").and_then(Value::as_str),
                Some("number" | "string" | "boolean" | "date")
            ) {
                return Err("Invalid column type");
            }
        }
        expression(required(analysis, "expression")?, 0)?;
        for chart in array(required(analysis, "charts")?, 12)? {
            let c = object(
                chart,
                &["id", "type", "x", "y", "bins", "binned", "aggregate"],
            )?;
            for k in ["id", "x", "y"] {
                if let Some(v) = c.get(k) {
                    string(v)?;
                }
            }
            if !matches!(
                chart.get("type").and_then(Value::as_str),
                Some("bar" | "pie" | "time" | "scatter")
            ) {
                return Err("Invalid chart type");
            }
            finite(required(chart, "bins")?)?;
            if let Some(v) = c.get("binned") {
                if v.as_bool().is_none() {
                    return Err("Invalid binning setting");
                }
            }
            if let Some(v) = c.get("aggregate") {
                if !matches!(v.as_str(), Some("count" | "sum" | "mean" | "min" | "max")) {
                    return Err("Invalid aggregation");
                }
            }
        }
    }
    let mut spec_ids = std::collections::HashSet::new();
    if let Some(comparisons) = v.get("comparisons") {
        for comparison in array(comparisons, 12)? {
            object(
                comparison,
                &[
                    "id",
                    "name",
                    "kind",
                    "unit",
                    "bins",
                    "bucketMs",
                    "aggregate",
                    "series",
                ],
            )?;
            let id = required(comparison, "id")?
                .as_str()
                .ok_or("Invalid comparison ID")?;
            if id.is_empty() || !spec_ids.insert(id) {
                return Err("Duplicate comparison/relationship ID");
            }
            for k in ["id", "name", "unit"] {
                string(required(comparison, k)?)?;
            }
            if !matches!(
                required(comparison, "kind")?.as_str(),
                Some("histogram" | "time")
            ) {
                return Err("Invalid comparison type");
            }
            if !matches!(
                required(comparison, "aggregate")?.as_str(),
                Some("count" | "mean" | "sum" | "min" | "max")
            ) {
                return Err("Invalid comparison aggregation");
            }
            let bins = required(comparison, "bins")?
                .as_u64()
                .ok_or("Invalid comparison bins")?;
            if !(2..=128).contains(&bins) {
                return Err("Invalid comparison bins");
            }
            finite(required(comparison, "bucketMs")?)?;
            if comparison["bucketMs"].as_f64().unwrap_or(0.) <= 0. {
                return Err("Invalid time bucket");
            }
            let series = array(required(comparison, "series")?, 8)?;
            if series.len() < 2 {
                return Err("Comparisons require at least two series");
            }
            let mut series_ids = std::collections::HashSet::new();
            for item in series {
                let fields = object(
                    item,
                    &[
                        "id",
                        "sourceId",
                        "label",
                        "x",
                        "y",
                        "unit",
                        "scale",
                        "offset",
                        "converted",
                        "filter",
                    ],
                )?;
                for k in ["id", "sourceId", "label", "x", "unit"] {
                    string(required(item, k)?)?;
                }
                if !series_ids.insert(item["id"].as_str().unwrap_or("")) {
                    return Err("Duplicate comparison series ID");
                }
                if !ids.contains(item["sourceId"].as_str().unwrap_or("")) {
                    return Err("Unknown comparison source");
                }
                if let Some(y) = fields.get("y") {
                    string(y)?;
                }
                finite(required(item, "scale")?)?;
                finite(required(item, "offset")?)?;
                if item["scale"].as_f64() == Some(0.) {
                    return Err("Conversion scale must be nonzero");
                }
                let converted = required(item, "converted")?
                    .as_bool()
                    .ok_or("Invalid conversion flag")?;
                if !converted
                    && (item["unit"] != comparison["unit"]
                        || item["scale"].as_f64() != Some(1.)
                        || item["offset"].as_f64() != Some(0.))
                {
                    return Err("Explicit conversion required for incompatible units");
                }
                expression(required(item, "filter")?, 0)?;
            }
        }
    }
    if let Some(relationships) = v.get("relationships") {
        for relationship in array(relationships, 12)? {
            let fields = object(
                relationship,
                &[
                    "id",
                    "name",
                    "leftSource",
                    "rightSource",
                    "match",
                    "identifier",
                    "time",
                    "spatial",
                ],
            )?;
            let id = required(relationship, "id")?
                .as_str()
                .ok_or("Invalid relationship ID")?;
            if id.is_empty() || !spec_ids.insert(id) {
                return Err("Duplicate comparison/relationship ID");
            }
            for k in ["id", "name", "leftSource", "rightSource"] {
                string(required(relationship, k)?)?;
            }
            let left = relationship["leftSource"].as_str().unwrap_or("");
            let right = relationship["rightSource"].as_str().unwrap_or("");
            if left == right || !ids.contains(left) || !ids.contains(right) {
                return Err("Relationship requires two known sources");
            }
            if !matches!(
                required(relationship, "match")?.as_str(),
                Some("all" | "unique" | "nearest")
            ) {
                return Err("Invalid relationship match rule");
            }
            if !fields.contains_key("identifier")
                && !fields.contains_key("time")
                && !fields.contains_key("spatial")
            {
                return Err("Relationship requires a matching rule");
            }
            for k in ["identifier", "time"] {
                if let Some(rule) = fields.get(k) {
                    object(
                        rule,
                        if k == "time" {
                            &["left", "right", "toleranceMs"]
                        } else {
                            &["left", "right"]
                        },
                    )?;
                    for side in ["left", "right"] {
                        string(required(rule, side)?)?;
                    }
                    if k == "time" {
                        finite(required(rule, "toleranceMs")?)?;
                        if rule["toleranceMs"].as_f64().unwrap_or(-1.) < 0. {
                            return Err("Invalid time tolerance");
                        }
                    }
                }
            }
            if let Some(rule) = fields.get("spatial") {
                object(rule, &["radiusMetres"])?;
                finite(required(rule, "radiusMetres")?)?;
                if rule["radiusMetres"].as_f64().unwrap_or(-1.) < 0. {
                    return Err("Invalid spatial radius");
                }
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> Value {
        serde_json::json!({"schemaVersion":1,"settings":{"sources":[],"background":{"url":"","attribution":"","enabled":false}},"query":{"choice":"all","bounds":{}},"analyses":[]})
    }
    #[test]
    fn accepts_config_and_rejects_data() {
        let v = state();
        assert!(validate(&v).is_ok());
        for key in [
            "csvText", "features", "results", "rows", "metrics", "preview",
        ] {
            let mut v = state();
            v[key] = serde_json::json!("SECRET");
            assert!(validate(&v).is_err());
        }
        let mut v = state();
        v["settings"]["sources"] = serde_json::json!([{"id":"csv1","name":"CSV","enabled":true,"config":{"type":"csv","csvText":"SECRET"}}]);
        assert!(validate(&v).is_err());
    }
    #[test]
    fn comparisons_and_relationships_accept_only_configuration() {
        let mut v = state();
        v["settings"]["sources"] = serde_json::json!([
            {"id":"a","name":"A","enabled":true,"config":{"type":"wfs"}},
            {"id":"b","name":"B","enabled":true,"config":{"type":"wfs"}}
        ]);
        v["comparisons"] = serde_json::json!([{"id":"c","name":"Temperatures","kind":"time","unit":"C","bins":24,"bucketMs":3600000,"aggregate":"mean","series":[
            {"id":"s1","sourceId":"a","label":"A","x":"when","y":"temp","unit":"C","scale":1,"offset":0,"converted":false,"filter":{"op":"and","children":[]}},
            {"id":"s2","sourceId":"b","label":"B","x":"observed","y":"temp_f","unit":"F","scale":0.555555555555,"offset":-17.777777777,"converted":true,"filter":{"op":"and","children":[]}}
        ]}]);
        v["relationships"] = serde_json::json!([{"id":"r","name":"Same asset","leftSource":"a","rightSource":"b","match":"unique","identifier":{"left":"asset","right":"station"},"time":{"left":"when","right":"observed","toleranceMs":1000},"spatial":{"radiusMetres":20}}]);
        assert!(validate(&v).is_ok());
        for key in ["rows", "results", "projection", "members"] {
            let mut bad = v.clone();
            bad["comparisons"][0]["series"][0][key] = serde_json::json!(["SECRET"]);
            assert!(validate(&bad).is_err());
        }
        for key in ["pairs", "preview", "records"] {
            let mut bad = v.clone();
            bad["relationships"][0][key] = serde_json::json!(["SECRET"]);
            assert!(validate(&bad).is_err());
        }
        let mut bad = v.clone();
        bad["comparisons"][0]["series"][1]["converted"] = serde_json::json!(false);
        assert!(validate(&bad).is_err());
        let mut bad = v.clone();
        bad["comparisons"][0]["series"][0]["filter"] = serde_json::json!({"op":"row","index":7});
        assert!(validate(&bad).is_err());
        let mut bad = v.clone();
        bad["relationships"][0]["time"]["toleranceMs"] = serde_json::json!(-1);
        assert!(validate(&bad).is_err());
        let mut bad = v.clone();
        bad["relationships"][0]["rightSource"] = serde_json::json!("unknown");
        assert!(validate(&bad).is_err());
        let mut bad = v.clone();
        bad["comparisons"][0]["series"][1]["id"] = serde_json::json!("s1");
        assert!(validate(&bad).is_err());
    }
    #[test]
    fn rejects_local_observation_indices_and_deep_filters() {
        assert!(expression(&serde_json::json!({"op":"row","index":1}), 0).is_err());
        let mut e = serde_json::json!({"op":"and","children":[]});
        for _ in 0..25 {
            e = serde_json::json!({"op":"and","children":[e]});
        }
        assert!(expression(&e, 0).is_err());
    }
}
