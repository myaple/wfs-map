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
            "timeline",
            "localMapBounds",
        ],
    )?;
    if let Some(bbox) = v.get("localMapBounds") {
        object(bbox, &["west", "east", "south", "north"])?;
        for k in ["west", "east", "south", "north"] {
            finite(required(bbox, k)?)?;
        }
        let west = bbox["west"].as_f64().unwrap();
        let east = bbox["east"].as_f64().unwrap();
        let south = bbox["south"].as_f64().unwrap();
        let north = bbox["north"].as_f64().unwrap();
        if !(-180.0..=180.0).contains(&west)
            || !(-180.0..=180.0).contains(&east)
            || !(-90.0..=90.0).contains(&south)
            || !(-90.0..=90.0).contains(&north)
            || south > north
        {
            return Err("Invalid local map bounds");
        }
    }
    if let Some(timeline) = v.get("timeline") {
        object(timeline, &["start", "end"])?;
        finite(required(timeline, "start")?)?;
        finite(required(timeline, "end")?)?;
        let start = timeline["start"].as_f64().unwrap();
        let end = timeline["end"].as_f64().unwrap();
        if start > end {
            return Err("Invalid timeline window");
        }
    }
    if v.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported workspace version");
    }
    let settings = required(v, "settings")?;
    object(settings, &["sources", "background", "map"])?;
    let mut ids = std::collections::HashSet::new();
    for source in array(required(settings, "sources")?, 8)? {
        let o = object(
            source,
            &[
                "id",
                "name",
                "enabled",
                "config",
                "color",
                "coloring",
                "serverFilters",
            ],
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
        if let Some(filters) = o.get("serverFilters") {
            for rule in array(filters, 100)? {
                let r = object(rule, &["field", "kind", "op", "value"])?;
                let field = required(rule, "field")?
                    .as_str()
                    .ok_or("Invalid server filter field")?;
                string(required(rule, "field")?)?;
                if field.trim().is_empty() {
                    return Err("Invalid server filter field");
                }
                let kind = required(rule, "kind")?
                    .as_str()
                    .ok_or("Invalid server filter type")?;
                if !matches!(kind, "string" | "number" | "boolean" | "date") {
                    return Err("Invalid server filter type");
                }
                let op = required(rule, "op")?
                    .as_str()
                    .ok_or("Invalid server filter operator")?;
                if !matches!(
                    op,
                    "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "null" | "notnull"
                ) || (matches!(op, "gt" | "gte" | "lt" | "lte")
                    && !matches!(kind, "number" | "date"))
                    || (op == "contains" && kind != "string")
                {
                    return Err("Invalid server filter operator");
                }
                if let Some(value) = r.get("value") {
                    string(value)?;
                }
                if !matches!(op, "null" | "notnull") {
                    let value = required(rule, "value")?
                        .as_str()
                        .ok_or("Invalid server filter value")?;
                    if (kind == "number" && !value.trim().parse::<f64>().is_ok_and(f64::is_finite))
                        || (kind == "boolean" && !matches!(value, "true" | "false"))
                        || (kind == "date" && chrono::DateTime::parse_from_rfc3339(value).is_err())
                    {
                        return Err("Invalid server filter value");
                    }
                }
            }
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
                "pagingEnd",
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
                "fieldTypes",
            ],
        )?;
        for value in c.values() {
            string(value)?;
        }
        if c
            .get("pagingEnd")
            .is_some_and(|value| !matches!(value.as_str(), Some("empty" | "short")))
        {
            return Err("Invalid WFS paging completion");
        }
        if let Some(types) = c.get("fieldTypes") {
            let types: Value =
                serde_json::from_str(types.as_str().ok_or("Invalid CSV column types")?)
                    .map_err(|_| "Invalid CSV column types")?;
            let types = types.as_object().ok_or("Invalid CSV column types")?;
            for kind in types.values() {
                if !matches!(
                    kind.as_str(),
                    Some("string" | "number" | "boolean" | "date")
                ) {
                    return Err("Invalid CSV column type");
                }
            }
            if let Some(time) = c.get("timeField").and_then(Value::as_str) {
                if types
                    .get(time)
                    .is_some_and(|kind| kind.as_str() != Some("date"))
                {
                    return Err("Invalid CSV time column type");
                }
            }
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
            let c = object(
                coloring,
                &[
                    "field",
                    "bins",
                    "low",
                    "high",
                    "categories",
                    "scale",
                    "scheme",
                ],
            )?;
            for k in ["field", "low", "high"] {
                if let Some(v) = c.get(k) {
                    string(v)?;
                }
            }
            if let Some(v) = c.get("bins") {
                finite(v)?;
            }
            if c.get("scale")
                .is_some_and(|v| !matches!(v.as_str(), Some("linear" | "log10")))
            {
                return Err("Invalid colour bin scale");
            }
            if c.get("scheme").is_some_and(|v| {
                !matches!(
                    v.as_str(),
                    Some("viridis" | "cividis" | "inferno" | "ocean" | "blue-red")
                )
            }) {
                return Err("Invalid colour scheme");
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
                &[
                    "id",
                    "type",
                    "x",
                    "y",
                    "bins",
                    "binned",
                    "aggregate",
                    "xScale",
                    "yScale",
                    "series",
                    "pointSize",
                    "hiddenSources",
                ],
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
            if let Some(series) = c.get("series") {
                let mut sources = std::collections::HashSet::from([id]);
                for mapping in array(series, 7)? {
                    let m = object(mapping, &["sourceId", "x", "y"])?;
                    let source = required(mapping, "sourceId")?
                        .as_str()
                        .ok_or("Invalid chart source")?;
                    if !ids.contains(source) || !sources.insert(source) {
                        return Err("Invalid or duplicate chart source");
                    }
                    string(required(mapping, "x")?)?;
                    if let Some(y) = m.get("y") {
                        string(y)?;
                    }
                }
            }
            if let Some(size) = c.get("pointSize") {
                finite(size)?;
                let size = size.as_f64().unwrap();
                if !(1.0..=12.0).contains(&size) {
                    return Err("Invalid chart point size");
                }
            }
            if let Some(hidden) = c.get("hiddenSources") {
                let mut seen = std::collections::HashSet::new();
                for source in array(hidden, 8)? {
                    let source = source.as_str().ok_or("Invalid hidden chart source")?;
                    let member = source == id
                        || c.get("series")
                            .and_then(Value::as_array)
                            .is_some_and(|series| {
                                series.iter().any(|m| {
                                    m.get("sourceId").and_then(Value::as_str) == Some(source)
                                })
                            });
                    if !member || !seen.insert(source) {
                        return Err("Invalid or duplicate hidden chart source");
                    }
                }
            }
            finite(required(chart, "bins")?)?;
            if let Some(v) = c.get("binned") {
                if v.as_bool().is_none() {
                    return Err("Invalid binning setting");
                }
            }
            for key in ["xScale", "yScale"] {
                if c.get(key)
                    .is_some_and(|v| !matches!(v.as_str(), Some("linear" | "log10")))
                {
                    return Err("Invalid axis scale");
                }
            }
            if let Some(v) = c.get("aggregate") {
                if !matches!(v.as_str(), Some("count" | "sum" | "mean" | "min" | "max")) {
                    return Err("Invalid aggregation");
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
    fn validates_local_map_bounds_without_accepting_payloads() {
        let mut v = state();
        v["localMapBounds"] = serde_json::json!({"west":-5,"east":1,"south":50,"north":55});
        assert!(validate(&v).is_ok());
        for (key, value) in [
            ("west", -181),
            ("east", 181),
            ("south", -91),
            ("north", 91),
            ("south", 56),
        ] {
            let mut bad = v.clone();
            bad["localMapBounds"][key] = value.into();
            assert!(validate(&bad).is_err());
        }
        v["localMapBounds"]["rows"] = serde_json::json!(["payload"]);
        assert!(validate(&v).is_err());
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
    fn validates_wfs_paging_completion_and_accepts_older_configs() {
        let mut v = state();
        v["settings"]["sources"] = serde_json::json!([{"id":"wfs","name":"Live WFS","enabled":true,"config":{"type":"wfs"}}]);
        assert!(validate(&v).is_ok());
        for mode in ["empty", "short"] {
            v["settings"]["sources"][0]["config"]["pagingEnd"] = mode.into();
            assert!(validate(&v).is_ok());
        }
        v["settings"]["sources"][0]["config"]["pagingEnd"] = "other".into();
        assert!(validate(&v).is_err());
    }
    #[test]
    fn chart_series_save_only_known_unique_source_mappings() {
        let mut v = state();
        v["settings"]["sources"] = serde_json::json!([
            {"id":"a","name":"A","enabled":true,"config":{"type":"csv"}},
            {"id":"b","name":"B","enabled":true,"config":{"type":"csv"}}
        ]);
        v["analyses"] = serde_json::json!([{
            "id":"a","fields":[],"expression":{"op":"and","children":[]},
            "charts":[{"id":"c","type":"scatter","x":"x","y":"y","bins":24,
                "series":[{"sourceId":"b","x":"u","y":"v"}]}]
        }]);
        assert!(validate(&v).is_ok());
        for source in ["a", "missing"] {
            let mut bad = v.clone();
            bad["analyses"][0]["charts"][0]["series"][0]["sourceId"] = source.into();
            assert!(validate(&bad).is_err());
        }
        v["analyses"][0]["charts"][0]["series"][0]["rows"] = serde_json::json!([1, 2]);
        assert!(validate(&v).is_err());
    }
    #[test]
    fn validates_chart_presentation_and_timeline() {
        let mut v = state();
        v["settings"]["sources"] = serde_json::json!([
            {"id":"a","name":"A","enabled":true,"config":{"type":"csv"}},
            {"id":"b","name":"B","enabled":true,"config":{"type":"csv"}}
        ]);
        v["timeline"] = serde_json::json!({"start":1000,"end":2000});
        v["analyses"] = serde_json::json!([{"id":"a","fields":[],"expression":{"op":"and","children":[]},"charts":[{"id":"c","type":"scatter","x":"x","y":"y","bins":24,"pointSize":5,"hiddenSources":["b"],"series":[{"sourceId":"b","x":"x","y":"y"}]}]}]);
        assert!(validate(&v).is_ok());
        for size in [0, 13] {
            let mut bad = v.clone();
            bad["analyses"][0]["charts"][0]["pointSize"] = size.into();
            assert!(validate(&bad).is_err());
        }
        for hidden in [
            serde_json::json!(["missing"]),
            serde_json::json!(["b", "b"]),
        ] {
            let mut bad = v.clone();
            bad["analyses"][0]["charts"][0]["hiddenSources"] = hidden;
            assert!(validate(&bad).is_err());
        }
        v["timeline"]["end"] = 0.into();
        assert!(validate(&v).is_err());
    }
    #[test]
    fn validates_colour_schemes() {
        let mut v = state();
        v["settings"]["sources"] = serde_json::json!([{"id":"a","name":"A","enabled":true,"config":{"type":"csv"},"coloring":{"field":"value","bins":8,"low":"#112233","high":"#445566"}}]);
        assert!(validate(&v).is_ok());
        for scheme in ["viridis", "cividis", "inferno", "ocean", "blue-red"] {
            v["settings"]["sources"][0]["coloring"]["scheme"] = scheme.into();
            assert!(validate(&v).is_ok());
        }
        v["settings"]["sources"][0]["coloring"]["scheme"] = "invalid".into();
        assert!(validate(&v).is_err());
    }
    #[test]
    fn validates_colour_bin_scale() {
        let mut v = state();
        v["settings"]["sources"] = serde_json::json!([{"id":"a","name":"A","enabled":true,"config":{"type":"csv"},"coloring":{"field":"value","bins":8,"low":"#112233","high":"#445566","scale":"log10"}}]);
        assert!(validate(&v).is_ok());
        v["settings"]["sources"][0]["coloring"]["scale"] = "invalid".into();
        assert!(validate(&v).is_err());
    }
    #[test]
    fn validates_chart_axis_scales() {
        let mut v = state();
        v["settings"]["sources"] =
            serde_json::json!([{"id":"a","name":"A","enabled":true,"config":{"type":"csv"}}]);
        v["analyses"] = serde_json::json!([{"id":"a","fields":[],"expression":{"op":"and","children":[]},"charts":[{"id":"c","type":"scatter","x":"x","y":"y","bins":24,"xScale":"log10","yScale":"linear"}]}]);
        assert!(validate(&v).is_ok());
        for key in ["xScale", "yScale"] {
            let mut bad = v.clone();
            bad["analyses"][0]["charts"][0][key] = "invalid".into();
            assert!(validate(&bad).is_err());
        }
    }
    #[test]
    fn validates_csv_column_type_overrides() {
        let mut v = state();
        v["settings"]["sources"] = serde_json::json!([{"id":"csv","name":"CSV","enabled":true,"config":{"type":"csv","timeField":"t","fieldTypes":"{\"code\":\"string\",\"t\":\"date\"}"}}]);
        assert!(validate(&v).is_ok());
        for types in ["{", "[]", "{\"code\":\"bogus\"}", "{\"t\":\"string\"}"] {
            v["settings"]["sources"][0]["config"]["fieldTypes"] = types.into();
            assert!(validate(&v).is_err());
        }
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
    #[test]
    fn server_filters_are_bounded_configuration_and_validate_types() {
        let mut v = state();
        v["settings"]["sources"] = serde_json::json!([{"id":"a","name":"A","enabled":true,"config":{"type":"wfs"},"serverFilters":[{"field":"value","kind":"number","op":"gte","value":"10"},{"field":"timestamp","kind":"date","op":"gt","value":"2026-01-01T00:00:00Z"}]}]);
        assert!(validate(&v).is_ok());
        for rule in [
            serde_json::json!({"field":"value","kind":"number","op":"eq","value":"NaN"}),
            serde_json::json!({"field":"active","kind":"boolean","op":"gt","value":"true"}),
            serde_json::json!({"field":"value","kind":"number","op":"contains","value":"1"}),
            serde_json::json!({"field":"timestamp","kind":"date","op":"eq","value":"bad"}),
            serde_json::json!({"field":"value","kind":"number","op":"eq","value":"1","rows":[]}),
        ] {
            v["settings"]["sources"][0]["serverFilters"] = serde_json::json!([rule]);
            assert!(validate(&v).is_err());
        }
        v["settings"]["sources"][0]["serverFilters"] = serde_json::json!(vec![
            serde_json::json!({"field":"value","kind":"number","op":"null"});
            101
        ]);
        assert!(validate(&v).is_err());
    }
}
