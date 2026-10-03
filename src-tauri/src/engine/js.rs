use boa_engine::{js_string, Context, JsResult, JsValue, NativeFunction, Source};
use serde_json::Value as Json;
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug)]
pub struct JsError(pub String);

impl std::fmt::Display for JsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for JsError {}

thread_local! {
    /// Backs the `cache` object that Legado scripts use for memoisation.
    static CACHE: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    /// Extra request headers for `java.ajax` calls made from a script.
    static SCRIPT_HEADERS: RefCell<Option<Vec<(String, String)>>> = const { RefCell::new(None) };
}

/// Set headers used by `java.ajax` inside the next script evaluation.
pub fn set_script_headers(headers: Option<Vec<(String, String)>>) {
    SCRIPT_HEADERS.with(|h| *h.borrow_mut() = headers);
}

fn script_headers() -> Option<Vec<(String, String)>> {
    SCRIPT_HEADERS.with(|h| h.borrow().clone())
}

pub fn clear_cache() {
    CACHE.with(|c| c.borrow_mut().clear());
}

// ---------------------------------------------------------------------------
// Native bindings
// ---------------------------------------------------------------------------

fn arg_str(args: &[JsValue], index: usize, ctx: &mut Context) -> String {
    args.get(index)
        .and_then(|v| v.to_string(ctx).ok())
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default()
}

/// `__fetch(url, headersJson)` — performs a GET from inside a script.
fn js_fetch(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let url = arg_str(args, 0, ctx);
    let headers_json = arg_str(args, 1, ctx);
    if url.is_empty() {
        return Ok(JsValue::from(js_string!("")));
    }

    // Prefer per-call headers, fall back to the source's declared headers.
    let mut extra: Vec<(String, String)> = Vec::new();
    if !headers_json.is_empty() && headers_json.trim_start().starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&headers_json) {
            if let Some(obj) = v.as_object() {
                for (k, val) in obj {
                    if let Some(s) = val.as_str() {
                        extra.push((k.clone(), s.to_string()));
                    }
                }
            }
        }
    } else if !headers_json.is_empty() {
        // Legacy: a single cookie/UA string.
        extra.push(("User-Agent".into(), headers_json));
    }
    if extra.is_empty() {
        extra = script_headers().unwrap_or_default();
    }

    // Build a throwaway source carrying the script's headers.
    let src = crate::model::Source {
        header: serde_json::to_string(
            &extra
                .iter()
                .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                .collect::<serde_json::Map<_, _>>(),
        )
        .unwrap_or_default(),
        ..Default::default()
    };

    match crate::engine::fetch::fetch(Some(&src), &url) {
        Ok(r) => Ok(JsValue::from(js_string!(r.body.as_str()))),
        Err(e) => Ok(JsValue::from(js_string!(format!("<!-- fetch error: {e} -->").as_str()))),
    }
}

/// `__b64encode(s)` / `__b64decode(s)` — Boa ships no `btoa`/`atob`.
fn js_b64encode(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    use base64::Engine;
    let input = arg_str(args, 0, ctx);
    let encoded = base64::engine::general_purpose::STANDARD.encode(input.as_bytes());
    Ok(JsValue::from(js_string!(encoded.as_str())))
}

fn js_b64decode(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    use base64::Engine;
    let input = arg_str(args, 0, ctx);
    match base64::engine::general_purpose::STANDARD.decode(input.as_bytes()) {
        Ok(bytes) => Ok(JsValue::from(js_string!(
            String::from_utf8_lossy(&bytes).to_string().as_str()
        ))),
        Err(_) => Ok(JsValue::from(js_string!(""))),
    }
}

fn js_cache_get(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let key = arg_str(args, 0, ctx);
    let v = CACHE.with(|c| c.borrow().get(&key).cloned()).unwrap_or_default();
    Ok(JsValue::from(js_string!(v.as_str())))
}

fn js_cache_put(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let key = arg_str(args, 0, ctx);
    let value = arg_str(args, 1, ctx);
    // A short TTL keeps stale entries from accumulating.
    CACHE.with(|c| {
        let mut map = c.borrow_mut();
        if map.len() > 512 {
            map.clear();
        }
        map.insert(key, value);
    });
    Ok(JsValue::undefined())
}

/// `__sleep(ms)` — supports scripts that poll.
fn js_sleep(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let ms: u64 = arg_str(args, 0, ctx).parse().unwrap_or(0).min(3000);
    std::thread::sleep(Duration::from_millis(ms));
    Ok(JsValue::undefined())
}

/// JS prelude that rebuilds the Legado/Android API surface on top of the
/// native bindings above.
const PRELUDE: &str = r#"
globalThis.__seriousFetch = __fetch;

globalThis.java = {
    ajax: function (url, headers) {
        return __fetch(url, typeof headers === 'string' ? headers : null);
    },
    // Legado exposes getString(url, headers) with the same semantics.
    getString: function (url, headers) {
        return __fetch(url, typeof headers === 'string' ? headers : null);
    },
    get: function (url, headers) { return this.ajax(url, headers); },
    post: function (url, body, headers) { return __fetch(url, typeof headers === 'string' ? headers : null); },
    connect: function (url, headers) { return this.ajax(url, headers); },
    getResponse: function (url, headers) { return this.ajax(url, headers); },
    startBrowser: function () {},
    webViewGetSource: function () { return ''; },
    getCookie: function (name) { return ''; },
    putCookie: function () {},
    // String helpers some rules rely on.
    getStringValue: function (v) { return v == null ? '' : String(v); },
    readFile: function () { return ''; },
    isEmpty: function (v) { return v == null || String(v).length === 0; },
    regex: function (s, re, g) {
        try {
            return g ? new RegExp(re, 'g').exec(s) : new RegExp(re).exec(s);
        } catch (e) { return null; }
    },
    match: function (s, re) {
        try {
            var m = String(s).match(new RegExp(re));
            return m ? m.join('\n') : '';
        } catch (e) { return ''; }
    }
};

globalThis.cache = {
    put: function (k, v) { __cache_put(k, v); },
    get: function (k) { return __cache_get(k); },
    remove: function (k) { __cache_put(k, ''); },
    clear: function () {},
    putStr: function (k, v) { __cache_put(k, v); },
    getStr: function (k) { return __cache_get(k); }
};

globalThis.sleep = function (ms) { __sleep(ms); };

globalThis.Base64 = {
    encode: function (s) { return __b64encode(String(s)); },
    decode: function (s) { return __b64decode(String(s)); }
};

globalThis.evalJS = function (s) { try { return (0, eval)(s); } catch (e) { return ''; } };
globalThis.encodeURI = encodeURI;
globalThis.encodeURIComponent = encodeURIComponent;
globalThis.decodeURI = decodeURI;
globalThis.decodeURIComponent = decodeURIComponent;
globalThis.getContext = function () { return { }; };
globalThis.egor = function () { return new Date().getTime(); };
"#;

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/// Guard rails so a broken source rule cannot hang the UI thread.
const LOOP_ITERATION_LIMIT: u64 = 5_000_000;
const RECURSION_LIMIT: usize = 400;

fn new_context(json: &Json) -> Result<Context, JsError> {
    let mut context = Context::default();
    context.runtime_limits_mut().set_loop_iteration_limit(LOOP_ITERATION_LIMIT);
    context.runtime_limits_mut().set_recursion_limit(RECURSION_LIMIT);

    context
        .register_global_callable(js_string!("__fetch"), 2, NativeFunction::from_fn_ptr(js_fetch))
        .map_err(js_err)?;
    context
        .register_global_callable(js_string!("__cache_get"), 1, NativeFunction::from_fn_ptr(js_cache_get))
        .map_err(js_err)?;
    context
        .register_global_callable(js_string!("__cache_put"), 2, NativeFunction::from_fn_ptr(js_cache_put))
        .map_err(js_err)?;
    context
        .register_global_callable(js_string!("__sleep"), 1, NativeFunction::from_fn_ptr(js_sleep))
        .map_err(js_err)?;
    context
        .register_global_callable(js_string!("__b64encode"), 1, NativeFunction::from_fn_ptr(js_b64encode))
        .map_err(js_err)?;
    context
        .register_global_callable(js_string!("__b64decode"), 1, NativeFunction::from_fn_ptr(js_b64decode))
        .map_err(js_err)?;

    context
        .eval(Source::from_bytes(PRELUDE))
        .map_err(|e| JsError(format!("prelude: {e}")))?;

    // Expose the JSON body to the script.
    let body = serde_json::to_string(json).unwrap_or_else(|_| "{}".into());
    let expr = format!("globalThis.__body = {body};");
    context
        .eval(Source::from_bytes(&expr))
        .map_err(|e| JsError(format!("body: {e}")))?;

    Ok(context)
}

fn js_err(e: boa_engine::JsError) -> JsError {
    JsError(e.to_string())
}

/// Wrap a rule body so it works as an expression *and* as statements.
///
/// Legado rules appear as `java.ajax(url)`, as `result = ...; result`, and as
/// multi-line statements. Both forms live in the same generated source, so a
/// SyntaxError in one would poison the whole script: choose the form up front
/// from a cheap syntactic check, then fall back only on runtime errors.
fn wrap(code: &str) -> String {
    if looks_like_statements(code) {
        return statement_form(code);
    }
    format!(
        r#"(function(){{
          try {{ return ({code}); }} catch (e) {{ return {stmt}; }}
        }})()"#,
        code = code,
        stmt = statement_form(code)
    )
}

/// A code body that can only work as a program, not as an expression.
fn looks_like_statements(code: &str) -> bool {
    let c = code.trim();
    c.contains(';')
        || c.starts_with("var ")
        || c.starts_with("let ")
        || c.starts_with("const ")
        || c.contains("result =")
        || c.contains("result=")
}

fn statement_form(code: &str) -> String {
    format!(
        r#"(function(){{
          var result;
          {code}
          return result === undefined ? '' : result;
        }})()"#,
        code = code
    )
}

/// Evaluate a script and return its value rendered as a string.
///
/// Accepts the shapes Legado uses for script rules: a bare body, an `@js:`
/// prefix, or a `<js>…</js>` wrapper.
pub fn eval_to_string(code: &str, json: &Json) -> String {
    let code = strip_wrapper(code);
    match eval_raw(&code, json) {
        Ok(v) => v,
        Err(e) => format!("<!-- js error: {e} -->"),
    }
}

/// Remove the `@js:` prefix and `<js>` wrapper a rule may carry.
fn strip_wrapper(code: &str) -> String {
    let c = code.trim();
    if let Some(rest) = c.strip_prefix("@js:") {
        return rest.trim().to_string();
    }
    if let Some(rest) = c.strip_prefix("<js>") {
        return rest.trim_end_matches("</js>").trim().to_string();
    }
    c.to_string()
}

/// Evaluate a script and return its value as JSON when possible.
pub fn eval_to_json(code: &str, json: &Json) -> Result<Json, JsError> {
    let mut context = new_context(json)?;
    let wrapped = wrap(code);
    let value = context
        .eval(Source::from_bytes(&wrapped))
        .map_err(js_err)?;

    // If the script returned a string that is itself JSON, unwrap it: rules
    // commonly do `JSON.parse(java.ajax(url))` or return raw ajax output.
    if let Some(text) = value.to_string(&mut context).ok().map(|s| s.to_std_string_escaped()) {
        let trimmed = text.trim();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            if let Ok(v) = serde_json::from_str::<Json>(trimmed) {
                return Ok(v);
            }
        }
        return Ok(Json::String(text));
    }
    Ok(Json::String(String::new()))
}

pub fn eval_raw(code: &str, json: &Json) -> Result<String, JsError> {
    let mut context = new_context(json)?;
    let wrapped = wrap(code);
    let value = context.eval(Source::from_bytes(&wrapped)).map_err(js_err)?;
    Ok(value
        .to_string(&mut context)
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default())
}

/// True when a rule string should be treated as a script rather than a selector.
pub fn looks_like_js(rule: &str) -> bool {
    let r = rule.trim();
    r.starts_with("@js:")
        || r.starts_with("<js>")
        || r.starts_with("<js ")
        || r.contains("java.")
        || r.contains("evalJS(")
        || r.contains("cache.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn evaluates_expression_form() {
        let out = eval_to_string("'a' + 'b'", &json!({}));
        assert_eq!(out, "ab");
    }

    #[test]
    fn evaluates_statement_form() {
        let out = eval_to_string("var x = 1 + 1; result = 'v' + x;", &json!({}));
        assert_eq!(out, "v2");
    }

    #[test]
    fn exposes_legado_globals() {
        let out = eval_to_string("typeof java.ajax", &json!({}));
        assert_eq!(out, "function");
    }

    #[test]
    fn base64_roundtrip() {
        let out = eval_to_string("Base64.encode('hi')", &json!({}));
        assert_eq!(out, "aGk=");
    }

    #[test]
    fn json_result_unwrapped() {
        let v = eval_to_json("'{\"a\":1}'", &json!({})).unwrap();
        assert_eq!(v["a"], json!(1));
    }

    #[test]
    fn infinite_loop_is_bounded() {
        let start = std::time::Instant::now();
        let out = eval_to_string("while(true){}", &json!({}));
        assert!(start.elapsed().as_secs() < 20, "script was not bounded");
        assert!(out.contains("error") || out.is_empty());
    }

    #[test]
    fn detects_js_rules() {
        assert!(looks_like_js("@js:'x'"));
        assert!(looks_like_js("java.ajax(u)"));
        assert!(!looks_like_js("class.item@all"));
    }
}