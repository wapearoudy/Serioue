use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;

/// Legado's `##` operator: `text##pattern##replacement`.
///
/// A doubled trailing `##` (i.e. `text##pattern##`) means "replace with empty",
/// which is how sources strip suffixes such as an ISO timestamp.
pub fn apply_regex_op(input: &str) -> String {
    if !input.contains("##") {
        return input.to_string();
    }
    // Split off the replacement, if any.
    let mut parts = input.splitn(3, "##");
    let subject = parts.next().unwrap_or("");
    let Some(pattern) = parts.next() else {
        return input.to_string();
    };
    let replacement = parts.next().unwrap_or("");

    // Legado allows an optional regex flag suffix on the pattern.
    let (pattern, case_insensitive) = match pattern.strip_suffix('!') {
        Some(p) => (p, true),
        None => (pattern, false),
    };
    // Wrap the whole pattern in a non-capturing group. Patterns such as
    // `T|.000.*` are alternations; without grouping the regex engine matches the
    // leftmost alternative (`T`) and the rest of the subject is left untouched.
    let grouped = if pattern.contains('|') {
        format!("(?:{pattern})")
    } else {
        pattern.to_string()
    };
    let mut builder = regex::RegexBuilder::new(&grouped);
    builder.case_insensitive(case_insensitive);
    let Ok(re) = builder.build() else {
        return input.to_string();
    };
    re.replace_all(subject, replacement).into_owned()
}

static TEMPLATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?s)\{\{(.+?)\}\}").unwrap()
});

use once_cell::sync::Lazy;

/// Render a Legado content template against a JSON body.
///
/// Supported inside `{{ }}`:
///   `$.model.title`               JSONPath lookup
///   `$.a##re##repl`               lookup then regex-replace
///   `@js:<code>` / `<js>..</js>`  evaluated in the sandbox
pub fn render_template(template: &str, root: &Value) -> String {
    if !template.contains("{{") {
        return template.to_string();
    }
    TEMPLATE_RE
        .replace_all(template, |caps: &regex::Captures| {
            let whole = caps[1].trim();
            // The `##pattern##replacement` suffix applies to the looked-up
            // value, so split it off before resolving the expression itself.
            let (expr, regex_op) = match whole.find("##") {
                Some(pos) => (&whole[..pos], &whole[pos..]),
                None => (whole, ""),
            };
            let value = lookup_expr(expr.trim(), root);
            if regex_op.is_empty() {
                value
            } else {
                apply_regex_op(&format!("{value}{regex_op}"))
            }
        })
        .into_owned()
}

/// Resolve one `{{ }}` expression.
fn lookup_expr(expr: &str, root: &Value) -> String {
    let expr = expr.trim();
    if expr.is_empty() {
        return String::new();
    }

    // Inline script form: `{{@js:...}}` or `{{<js>..</js>}}`.
    if let Some(code) = expr.strip_prefix("@js:") {
        return crate::engine::js::eval_to_string(code, root);
    }
    if let Some(code) = expr.strip_prefix("<js>").and_then(|s| s.strip_suffix("</js>")) {
        return crate::engine::js::eval_to_string(code, root);
    }
    // Base64/utility shorthands that appear in template rules.
    if expr == "$.now" || expr == "now" {
        return chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    }

    // Try JSONPath first, then treat as a key.
    let path = if expr.starts_with('$') { expr.to_string() } else { format!("$.{expr}") };
    if let Ok(v) = jsonpath_lib::select(root, &path) {
        if let Some(first) = v.first() {
            return value_to_string(first);
        }
        // An empty result is a valid answer.
        return String::new();
    }
    if let Some(v) = root.get(expr) {
        return value_to_string(v);
    }
    // Last resort: a bare key path like `model.title`.
    if !expr.contains('$') {
        if let Ok(v) = jsonpath_lib::select(root, &format!("$.{expr}")) {
            if let Some(first) = v.first() {
                return value_to_string(first);
            }
        }
    }
    String::new()
}

pub fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Strip every `<js>…</js>` block, returning the code and the surrounding text.
static JS_BLOCK: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?s)<js>(.*?)</js>").unwrap());

/// Extract the first inline script from a template, if present.
pub fn extract_js_block(template: &str) -> Option<String> {
    JS_BLOCK.captures(template).map(|c| c[1].trim().to_string())
}

/// Remove inline script blocks, leaving the static template behind.
pub fn strip_js_blocks(template: &str) -> String {
    JS_BLOCK.replace_all(template, "").into_owned()
}

/// Simple `{{key}}` substitution over a flat map (used for `{{page}}` etc.).
pub fn fill_vars(template: &str, vars: &HashMap<&str, &str>) -> String {
    let mut out = template.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
        out = out.replace(&format!("<{k}>"), v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_json_template() {
        let t = "<h3>{{$.model.title}}</h3><span>{{$.model.durationFormat}}</span>";
        let out = render_template(t, &json!({"model":{"title":"Clip","durationFormat":"12:00"}}));
        assert_eq!(out, "<h3>Clip</h3><span>12:00</span>");
    }

    #[test]
    fn regex_operator_strips_suffix() {
        // `##T|.000.*##` is an alternation that removes both the `T` marker and
        // the `.000…` fraction wherever they appear, matching Legado's behaviour.
        let out = apply_regex_op("2024-03-01T12:00:00.000Z##T|.000.*##");
        assert_eq!(out, "2024-03-0112:00:00");
        // A single-branch pattern removes just that branch.
        let out2 = apply_regex_op("hello world##world##");
        assert_eq!(out2, "hello ");
    }

    #[test]
    fn regex_operator_replaces() {
        let out = apply_regex_op("hello world##world##there");
        assert_eq!(out, "hello there");
    }

    #[test]
    fn template_with_regex_inside() {
        let t = "时间：{{$.model.onlineTime##T|.000.*## }}";
        let out = render_template(t, &json!({"model":{"onlineTime":"2024-05-01T10:00:00.000Z"}}));
        assert_eq!(out, "时间：2024-05-0110:00:00");
    }

    #[test]
    fn case_insensitive_flag() {
        assert_eq!(apply_regex_op("ABC##abc!##x"), "x");
    }
}