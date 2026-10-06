use boa_engine::{js_string, property::Attribute, Context, JsResult, JsValue, NativeFunction, Source};
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
    /// The markup a script's DOM calls operate on, plus Legado's context map.
    static PAGE: RefCell<PageState> = RefCell::new(PageState::default());
}

/// A cap on the document a script may hold, so a hostile page plus a hostile
/// rule cannot turn into unbounded memory use inside the UI process.
const MAX_DOM_BYTES: usize = 4 * 1024 * 1024;

/// How many element handles one evaluation may accumulate.
const MAX_HANDLES: usize = 512;

/// The script-visible DOM.
///
/// Everything here is the engine's **own copy** of the page. There is no bridge
/// to the application's webview and none is intended: `setContent` rewrites a
/// string in this struct, never a node in the window a reader is looking at.
/// A script can therefore not reach the reader's own UI, its session, or any
/// other source's state — the worst it can do is produce a wrong answer for
/// itself.
///
/// The copy is dropped when the evaluation ends, so nothing a rule writes
/// outlives the call that wrote it.
#[derive(Default)]
struct PageState {
    html: String,
    /// Legado's `java.put` / `java.get` context map.
    vars: HashMap<String, String>,
    /// Outer markup of each element handed to the script, addressed by index.
    handles: Vec<String>,
}

fn with_page<R>(f: impl FnOnce(&mut PageState) -> R) -> R {
    PAGE.with(|p| f(&mut p.borrow_mut()))
}

/// Point the DOM at the markup a rule is looking at, and clear everything the
/// previous script left behind.
///
/// Called around a script evaluation by the caller that has the page. Passing
/// `None` detaches the DOM: with no page bound, `java.getElements` finds
/// nothing rather than operating on a stale document.
pub fn set_page(html: Option<String>) {
    with_page(|p| {
        p.html = html.unwrap_or_default().chars().take(MAX_DOM_BYTES).collect();
        p.vars.clear();
        p.handles.clear();
    });
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

// ---------------------------------------------------------------------------
// The DOM a script works on
// ---------------------------------------------------------------------------
//
// These three make up the minimum set the blue-cloud (`蓝奏云盘`) family of rules
// actually calls. Sampled from their own rule text rather than from a count:
//
//     java.getElements('#folder .mlink').forEach(a => { java.setContent(a); … })
//     java.getString('.filename@textNodes')
//     java.put('url', baseUrl)      java.get('name')
//
// What is deliberately absent is listed in the module note further down.

/// `__dom_find(rule)` — matches the working document and returns descriptors.
fn js_dom_find(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let rule = arg_str(args, 0, ctx);
    let out = with_page(|p| {
        if p.html.is_empty() || rule.trim().is_empty() {
            return "[]".to_string();
        }
        let doc = crate::engine::selector::Doc::parse(&p.html);
        let mut out = Vec::new();
        // A rule that loops over `getElements` must not be able to grow this
        // without bound.
        if p.handles.len() > MAX_HANDLES {
            p.handles.clear();
        }
        for (i, html) in doc.eval_outer(&rule).into_iter().enumerate() {
            p.handles.push(html.clone());
            let doc2 = crate::engine::selector::Doc::parse(&html);
            let attrs: Vec<Json> = ["href", "title", "alt", "src", "class", "id", "value"]
                .iter()
                .filter_map(|name| {
                    doc2.eval(&format!("@{name}")).into_iter().next().map(|v| {
                        Json::Array(vec![
                            Json::String((*name).to_string()),
                            Json::String(v),
                        ])
                    })
                })
                .collect();
            let tag = doc2.eval("tag").into_iter().next().unwrap_or_default();
            let mut obj = serde_json::Map::new();
            obj.insert("i".into(), Json::from(i));
            obj.insert("tag".into(), Json::String(tag));
            obj.insert(
                "text".into(),
                Json::String(doc2.eval("text").into_iter().next().unwrap_or_default()),
            );
            obj.insert("html".into(), Json::String(html.clone()));
            obj.insert("attrs".into(), Json::Array(attrs));
            out.push(Json::Object(obj));
        }
        serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
    });
    Ok(JsValue::from(js_string!(out)))
}

/// `__dom_extract(rule)` — run an extraction rule against the working document.
///
/// This is the selector half of `java.getString`, which in Legado means "read
/// this out of the page" rather than "download this url".
fn js_dom_extract(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let rule = arg_str(args, 0, ctx);
    let value = with_page(|p| {
        if p.html.is_empty() {
            return String::new();
        }
        let doc = crate::engine::selector::Doc::parse(&p.html);
        let hits = doc.eval(&rule);
        // Legado hands back a list; a rule that matched one thing should read
        // as that thing rather than as a comma-joined list.
        if hits.len() == 1 {
            hits.into_iter().next().unwrap_or_default()
        } else {
            hits.join("\n")
        }
    });
    Ok(JsValue::from(js_string!(value)))
}

/// `__dom_use(index, html)` — make an element (or the whole page) current.
///
/// `index < 0` replaces the document, which is what `setContent(string)` means.
/// Anything written is bounded and lives only for this evaluation.
fn js_dom_use(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let index: i64 = arg_str(args, 0, ctx).parse().unwrap_or(-1);
    let html = arg_str(args, 1, ctx);
    with_page(|p| {
        let next: String = if index < 0 {
            html
        } else {
            match p.handles.get(index as usize) {
                Some(existing) if html.is_empty() => existing.clone(),
                Some(existing) => format!("{existing}{html}"),
                None => String::new(),
            }
        };
        // The handle list is deliberately *not* cleared: a rule that walks a
        // listing holds every element it was handed, and each one must stay
        // addressable after an earlier `setContent`. `set_page` drops them at
        // the end of the evaluation.
        p.handles.push(next.clone());
        p.html = next.chars().take(MAX_DOM_BYTES).collect();
    });
    Ok(JsValue::undefined())
}

/// `__dom_put(key, value)` / `__dom_var(key)` — Legado's context map.
fn js_dom_put(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let key = arg_str(args, 0, ctx);
    let value = arg_str(args, 1, ctx);
    with_page(|p| {
        if p.vars.len() > 256 {
            p.vars.clear();
        }
        p.vars.insert(key, value);
    });
    Ok(JsValue::undefined())
}

fn js_dom_var(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let key = arg_str(args, 0, ctx);
    let value = with_page(|p| p.vars.get(&key).cloned().unwrap_or_default());
    Ok(JsValue::from(js_string!(value)))
}

/// JS prelude that rebuilds the Legado/Android API surface on top of the
/// native bindings above.
const PRELUDE: &str = r#"
globalThis.__seriousFetch = __fetch;

globalThis.java = {
    ajax: function (url, headers) {
        return __fetch(url, typeof headers === 'string' ? headers : null);
    },
    // Legado overloads this name: an http(s) argument is a download, anything
    // else is a rule to read out of the page the rule is looking at.
    getString: function (arg, headers) {
        var a = arg == null ? '' : String(arg);
        if (/^https?:\/\//i.test(a)) {
            return __fetch(a, typeof headers === 'string' ? headers : null);
        }
        return __dom_extract(a);
    },
    get: function (url, headers) { return this.ajax(url, headers); },
    // Legado's context map, not a download. Kept separate from the network
    // `get` above because these rules use both spellings for different things.
    getVar: function (key) { return __dom_var(String(key)); },
    put: function (key, value) {
        __dom_put(String(key), typeof value === 'string' ? value : JSON.stringify(value));
    },
    getElements: function (rule) {
        var found = JSON.parse(__dom_find(String(rule == null ? '' : rule)));
        return found.map(function (d) { return __seriousElement(d); });
    },
    setContent: function (target) {
        if (target && typeof target === 'object' && typeof target.__domIndex === 'number') {
            __dom_use(target.__domIndex, '');
        } else {
            __dom_use(-1, target == null ? '' : String(target));
        }
    },
    post: function (url, body, headers) { return __fetch(url, typeof headers === 'string' ? headers : null); },
    connect: function (url, headers) { return this.ajax(url, headers); },
    getResponse: function (url, headers) { return this.ajax(url, headers); },
    startBrowser: function () {},
    /**
     * Format a millisecond timestamp the way Java's SimpleDateFormat would.
     *
     * Both shapes that appear in real collections pass only a timestamp — no
     * format at all — so the default is the common case, not an edge case:
     * `java.timeFormat(bk.create_time * 1000)` and
     * `java.timeFormat(comments[i].createTime)`. Those rules' endpoints answer
     * with real data, so this one method is the whole difference between a
     * working source and an empty list.
     *
     * Timezone: `SimpleDateFormat(format)` with no TimeZone argument uses
     * `TimeZone.getDefault()`, i.e. the device's own zone. That is Java platform
     * semantics rather than something Legado invented. We have not read Legado's
     * source, so this is an inference with its reason written down — and the
     * practical corroboration is that a UTC implementation would hand every
     * reader in UTC+8 yesterday's date between local midnight and 8am, which is
     * a bug everyone notices rather than nobody mentions.
     *
     * Pattern letters follow SimpleDateFormat, where the *count* of a letter is
     * its minimum width: `M` is `7`, `MM` is `07`. Note that `MM` is the month
     * and `mm` is the minute — swapping them yields a date that looks nearly
     * right, which is exactly why it is pinned by a test.
     *
     * A letter we do not implement (`E`, `a`, and anything else) is passed
     * through as written instead of throwing. Java would raise
     * IllegalArgumentException; here that would take the whole rule down and
     * leave an empty list with nothing on screen to say why. That is a
     * deliberate departure, recorded here so it is not "corrected" later by
     * someone who assumes the strict behaviour was intended.
     */
    timeFormat: function (time, format) {
        var f = format == null ? 'yyyy-MM-dd' : String(format);
        if (f === '') return '';
        var n = typeof time === 'number' ? time : parseInt(time, 10);
        if (typeof n !== 'number' || !isFinite(n)) return '';
        var d = new Date(n);
        if (isNaN(d.getTime())) return '';
        var pad = function (v, width) {
            var s = String(v);
            while (s.length < width) s = '0' + s;
            return s;
        };
        var weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return f.replace(/y+|M+|d+|H+|h+|m+|s+|S+|E+|a+|./g, function (token) {
            switch (token.charAt(0)) {
                case 'y': return pad(d.getFullYear(), token.length);
                case 'M': return pad(d.getMonth() + 1, token.length);
                case 'd': return pad(d.getDate(), token.length);
                case 'H': return pad(d.getHours(), token.length);
                // `h` is Java's 12-hour clock; there is no `K`/`k` here because
                // no rule in the sample uses them.
                case 'h': {
                    var h12 = d.getHours() % 12;
                    return pad(h12 === 0 ? 12 : h12, token.length);
                }
                case 'm': return pad(d.getMinutes(), token.length);
                case 's': return pad(d.getSeconds(), token.length);
                case 'S': return pad(d.getMilliseconds(), token.length);
                case 'E': return token.length >= 4 ? weekdays[d.getDay()] : weekdays[d.getDay()].slice(0, 3);
                case 'a': return d.getHours() < 12 ? 'AM' : 'PM';
                default: return token.charAt(0);
            }
        });
    },
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

// The element handle a rule gets back from `java.getElements`. It is a plain
// data object: reading from it costs nothing, and the only way to change
// anything is to hand it to `setContent`, which rewrites the working copy.
globalThis.__seriousElement = function (d) {
    return {
        __domIndex: d.i,
        tag: function () { return d.tag; },
        text: function () { return d.text; },
        textNodes: function () { return d.text; },
        html: function () { return d.html; },
        outerHtml: function () { return d.html; },
        attr: function (name) {
            for (var i = 0; i < d.attrs.length; i++) {
                if (d.attrs[i][0] === String(name)) { return d.attrs[i][1]; }
            }
            return '';
        },
        setContent: function (html) { __dom_use(d.i, html == null ? '' : String(html)); }
    };
};
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
        .register_global_callable(js_string!("__dom_find"), 1, NativeFunction::from_fn_ptr(js_dom_find))
        .map_err(js_err)?;
    context
        .register_global_callable(js_string!("__dom_extract"), 1, NativeFunction::from_fn_ptr(js_dom_extract))
        .map_err(js_err)?;
    context
        .register_global_callable(js_string!("__dom_use"), 2, NativeFunction::from_fn_ptr(js_dom_use))
        .map_err(js_err)?;
    context
        .register_global_callable(js_string!("__dom_put"), 2, NativeFunction::from_fn_ptr(js_dom_put))
        .map_err(js_err)?;
    context
        .register_global_callable(js_string!("__dom_var"), 1, NativeFunction::from_fn_ptr(js_dom_var))
        .map_err(js_err)?;

    context
        .eval(Source::from_bytes(PRELUDE))
        .map_err(|e| JsError(format!("prelude: {e}")))?;

    // Expose the JSON body to the script.
    let body = serde_json::to_string(json).unwrap_or_else(|_| "{}".into());
    // `result` is how Legado rules name the value the preceding selector picked:
    // `$.address@js:result.replace(/rtmp:\//, "")`. Binding it here rather than
    // only inside the statement form is what makes expression-form rules work;
    // without it `result` is undefined, the call throws, and the source yields
    // items with no link at all.
    let expr = format!("globalThis.__body = {body}; globalThis.result = globalThis.__body;");
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

/// Serialise a script value the way a rule author would expect.
///
/// `JsValue::to_string` is JavaScript's `ToString`, and `ToString` on an array
/// renders every element as `[object Object]` — so a rule that maps items into
/// objects, which is what a `ruleArticles` written as a whole JS block does,
/// came back as that string instead of a list. `JSON.stringify` is what the
/// rule author meant, and it is the only form that survives the round trip.
fn stringify(value: &JsValue, context: &mut Context) -> Option<String> {
    context
        .register_global_property(
            js_string!("__js_result"),
            value.clone(),
            Attribute::empty(),
        )
        .ok()?;
    let rendered = context
        .eval(Source::from_bytes("JSON.stringify(globalThis.__js_result)"))
        .ok()?;
    let text = rendered.to_string(context).ok()?.to_std_string_escaped();
    // `JSON.stringify(undefined)` is the value `undefined`, whose `ToString` is
    // the string "undefined" — not JSON, and not a legitimate result.
    if text == "undefined" {
        return None;
    }
    Some(text)
}

/// Evaluate a script and return its value as JSON when possible.
pub fn eval_to_json(code: &str, json: &Json) -> Result<Json, JsError> {
    let mut context = new_context(json)?;
    let wrapped = wrap(code);
    let value = context
        .eval(Source::from_bytes(&wrapped))
        .map_err(js_err)?;

    // A string may itself be JSON: rules commonly end in
    // `JSON.parse(java.ajax(url))` or `JSON.stringify(items)`, and both hand
    // back a string that has to be unwrapped before it is usable.
    if value.is_string() {
        let text = value
            .to_string(&mut context)
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_default();
        let trimmed = text.trim();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            if let Ok(v) = serde_json::from_str::<Json>(trimmed) {
                return Ok(v);
            }
        }
        return Ok(Json::String(text));
    }

    // Objects and arrays keep their shape only through `JSON.stringify`.
    if let Some(text) = stringify(&value, &mut context) {
        if let Ok(v) = serde_json::from_str::<Json>(&text) {
            return Ok(v);
        }
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

    // ---- the DOM host objects ---------------------------------------------
    //
    // The shapes below are copied from the rules of the 蓝奏云盘 family
    // (`阅读难受1` in collection 107 and its siblings), not invented here:
    //
    //     java.getElements('#folder .mlink').forEach(a => { java.setContent(a); … })
    //     java.getString('.filename@textNodes')
    //     java.put('url', baseUrl); java.get('name')

    /// A page shaped like the folder listing those rules walk.
    const LANZOU_FOLDER: &str = r#"
      <div id="folder">
        <a class="mlink" href="https://lanzoux.test/a1">压缩包.zip</a>
        <a class="mlink" href="https://lanzoux.test/a2">第二个.zip</a>
      </div>
      <span class="user-radio">全部</span>
    "#;

    #[test]
    fn get_elements_reads_the_bound_page() {
        set_page(Some(LANZOU_FOLDER.to_string()));
        let out = eval_to_string("java.getElements('#folder .mlink').length", &json!({}));
        set_page(None);
        assert_eq!(out, "2", "the folder listing should yield both links");
    }

    #[test]
    fn set_content_repoints_the_page_at_an_element() {
        // Exactly the loop the rules run: take each element in turn and read
        // the link out of it.
        set_page(Some(LANZOU_FOLDER.to_string()));
        let out = eval_to_string(
            r#"
            var names = [];
            java.getElements('#folder .mlink').forEach(function (a) {
                java.setContent(a);
                names.push(java.getString('a@href'));
            });
            result = names.join('|');
            "#,
            &json!({}),
        );
        set_page(None);
        assert_eq!(out, "https://lanzoux.test/a1|https://lanzoux.test/a2", "{out}");
    }

    #[test]
    fn get_string_reads_the_page_when_it_is_not_a_url() {
        set_page(Some(LANZOU_FOLDER.to_string()));
        let out = eval_to_string("java.getString('.user-radio@text')", &json!({}));
        set_page(None);
        assert_eq!(out, "全部", "{out}");
    }

    #[test]
    fn put_and_get_carry_a_value_between_statements() {
        set_page(Some(LANZOU_FOLDER.to_string()));
        let out = eval_to_string(
            "java.put('url', 'https://lanzoux.test/x'); result = java.getVar('url');",
            &json!({}),
        );
        set_page(None);
        assert_eq!(out, "https://lanzoux.test/x", "{out}");
    }

    #[test]
    fn the_dom_is_detached_between_evaluations() {
        // A rule must not see the previous rule's page, and must not leave
        // anything behind for the next one. This is the whole safety argument
        // in one test: the document a script writes into is the engine's own
        // copy and is dropped when the evaluation ends.
        set_page(Some(LANZOU_FOLDER.to_string()));
        eval_to_string("java.setContent('<b>改写</b>')", &json!({}));
        set_page(None);
        let out = eval_to_string("java.getElements('#folder .mlink').length", &json!({}));
        assert_eq!(out, "0", "a detached DOM must find nothing, not the last page");
    }

    #[test]
    fn with_no_page_bound_the_dom_calls_are_empty_rather_than_fatal() {
        // A rule that reaches for the DOM before anyone set a page should
        // produce nothing, not crash the reader's view.
        set_page(None);
        assert_eq!(eval_to_string("java.getElements('a').length", &json!({})), "0");
        assert_eq!(eval_to_string("java.getString('a@href')", &json!({})), "");
    }

    #[test]
    fn result_is_the_value_the_selector_extracted() {
        // Legado rules use `result` to mean the value the preceding selector
        // picked. A live source does exactly this:
        //     $.address@js:result.replace(/rtmp:\//, "")
        // Without the binding, `result` is undefined, `.replace` throws, and the
        // source silently yields items with no link at all.
        let address = "rtmp://live.example.com/stream";
        assert_eq!(eval_to_string("result", &json!(address)), address);
        assert_eq!(
            eval_to_string(r#"result.replace(/^rtmp:\/\//, "")"#, &json!(address)),
            "live.example.com/stream"
        );
    }

    #[test]
    fn result_still_works_as_a_statement_target() {
        // Binding `result` must not break the `result = ...; result` form.
        let out = eval_to_string("var x = 1 + 1; result = 'v' + x;", &json!({}));
        assert_eq!(out, "v2");
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