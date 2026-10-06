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

/// How many element handles one evaluation may accumulate. Past this,
/// `java.getElements` hands out nothing further rather than renumbering the
/// handles a rule already holds (see `js_dom_find`).
const MAX_HANDLES: usize = 512;

/// Total markup the handle table may hold. A handle is a slice of the document,
/// so 512 of them could otherwise add up to 512 documents' worth of memory when
/// the matches nest.
const MAX_HANDLE_BYTES: usize = MAX_DOM_BYTES;

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
///
/// ## Why `setContent` needs no sanitiser, and what it does need
///
/// `setContent` is the one place where content that came off an untrusted site
/// flows into something that looks like a page, so the boundary is worth stating
/// rather than assuming:
///
/// * **The destination is not a live DOM.** Only the three functions in this
///   module ever read `PAGE`, and each of them parses `p.html` with the
///   selector module and hands back strings. Nothing renders it, nothing
///   executes it, and there is no path from here to `window`, to the reader's
///   view, or to the native side. So the style of sanitiser that exists to stop
///   `setContent` becoming stored XSS has nothing to defend: a `<script>` a rule
///   writes here is inert text that only our selector ever looks at.
/// * **It is bounded, and the bound is enforced in bytes.** The document is
///   clamped to [`MAX_DOM_BYTES`] on every write and on every bind, and the
///   handle table is capped both by entry count ([`MAX_HANDLES`]) and by the
///   markup it holds ([`MAX_HANDLE_BYTES`]) — because a handle is a slice of the
///   document, and 512 slices of a *nested* document are more than one
///   document's worth of memory. So an attacker-chosen page cannot make the UI
///   process hold an unbounded string.
/// * **It is finite.** The handle table stops at its two caps, and Boa's own
///   loop and recursion limits stop a script that tries to spin. Nothing
///   accumulates across evaluations: a new bind clears the map and the handles.
///
/// What is *not* done, and why: the markup is not sanitised, because sanitising
/// it would only matter at the point where the reader's webview renders it —
/// which is the `ruleContent` template path, a different channel, not this one.
/// Recording that here keeps "no sanitiser" from reading as an oversight.
///
/// Two residuals, stated rather than hidden:
///
/// * The variable map is capped by entry count (256) and the cache by 512, but
///   **not** by bytes: a rule can put 256 values that are each as large as a
///   response body. That is bounded by how many distinct strings a script can
///   build within Boa's iteration limit rather than by anything here, and it is
///   a different channel from `setContent` — noted so the next person does not
///   read "bounded" as covering it.
/// * Parsing is not free, so a rule that calls `java.getElements` in a tight
///   loop re-parses the document each time. That is bounded by Boa's iteration
///   limit rather than by anything here, and it is a cost this design accepts
///   rather than a hole it hides.
#[derive(Default)]
struct PageState {
    html: String,
    /// Legado's `java.put` / `java.get` context map.
    vars: HashMap<String, String>,
    /// Outer markup of each element handed to the script, addressed by index.
    handles: Vec<String>,
    /// Total bytes held in `handles`, so the table is bounded by what it holds
    /// and not only by how many entries it has.
    handle_bytes: usize,
}

fn with_page<R>(f: impl FnOnce(&mut PageState) -> R) -> R {
    PAGE.with(|p| f(&mut p.borrow_mut()))
}

/// Truncate a document to [`MAX_DOM_BYTES`], on a character boundary.
///
/// The cap is spelled in *bytes* and has to count bytes, otherwise a page of
/// three-byte characters buys three times the memory the cap was chosen to
/// allow. Truncating on a boundary rather than at a byte offset keeps the
/// result valid UTF-8 rather than making the caller deal with a panic.
fn clamp_dom(html: &str) -> String {
    if html.len() <= MAX_DOM_BYTES {
        return html.to_string();
    }
    let mut end = MAX_DOM_BYTES;
    while end > 0 && !html.is_char_boundary(end) {
        end -= 1;
    }
    html[..end].to_string()
}

/// Replace what is *inside* an element, keeping the element itself.
///
/// This is the element overload `element.setContent(html)`, which is jsoup's
/// `Element.html(html)`. No rule in the sampled corpus reaches it: all 16
/// `setContent` call sites pass either an element handle (the empty-string path,
/// which re-points the working document at that element) or a whole document.
/// It is therefore defined by the reference rather than by a need, and the
/// fallback below keeps it from destroying markup for an element with no inner
/// content (a void element such as `<img>`).
fn replace_inner(existing: &str, html: &str) -> String {
    let inner = from_element(existing, "innerHtml");
    match existing.find(&inner) {
        Some(at) if !inner.is_empty() => {
            format!("{}{}{}", &existing[..at], html, &existing[at + inner.len()..])
        }
        _ => format!("{existing}{html}"),
    }
}

/// The tag name of an element, read off its own outer markup.
///
/// `Doc::eval("tag")` cannot answer this: with no `@` the token is read as a tag
/// *selector*, so it looks for an element called `<tag>` and finds nothing. The
/// markup is right here, so the name is read from it.
fn element_name(outer: &str) -> String {
    let s = outer.trim_start();
    let s = s.strip_prefix('<').unwrap_or(s);
    let end = s
        .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
        .unwrap_or(s.len());
    s[..end].to_ascii_lowercase()
}

/// Run an extraction rule against an element we already hold.
///
/// The element has to be addressed by its own tag, for the same reason as
/// [`element_name`]: `text` on its own is a tag selector, while `a@text`
/// self-matches the way `java.getString('a@href')` does on a bound element.
fn from_element(outer: &str, extract: &str) -> String {
    let tag = element_name(outer);
    if tag.is_empty() {
        return String::new();
    }
    crate::engine::selector::Doc::parse(outer)
        .eval(&format!("{tag}@{extract}"))
        .into_iter()
        .next()
        .unwrap_or_default()
}

/// Point the DOM at the markup a rule is looking at, and clear everything the
/// previous script left behind.
///
/// Called around a script evaluation by the caller that has the page. Passing
/// `None` detaches the DOM: with no page bound, `java.getElements` finds
/// nothing rather than operating on a stale document.
pub fn set_page(html: Option<String>) {
    with_page(|p| {
        p.html = clamp_dom(&html.unwrap_or_default());
        p.vars.clear();
        p.handles.clear();
        p.handle_bytes = 0;
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
// All five sources of that family in collection 107 — `阅读难受1`,
// `书源难受2`, `影视难受3`, `软件难受4`, `未测难受6` — call exactly
// `java.getElements` x1, `java.setContent` x2, `java.put` x1, `java.get` x1
// (x5 for 书源难受2), `java.getString` x8..12 and `java.ajax` x1..2 in their
// `rule*` fields, and nothing else from the `java` namespace. Their `.select(` /
// `.length` / `.text()` calls on a handle exist in other collections, not in
// these five.
//
// ## What is implemented here, and what is deliberately not
//
// Implemented, because these rules reach it:
//
//   * `java.getElements(rule)` — CSS/class selector against the bound document.
//     Returns array-like handles carrying `tag() / text() / textNodes() /
//     html() / outerHtml() / attr(name) / setContent(html)` and `length`.
//   * `java.setContent(element | string)` — makes an element the working
//     document, or replaces it wholesale.
//   * `java.put(key, value)` / `java.get(key)` — Legado's context map, scoped to
//     the bound page (see the note above `java.get` in `PRELUDE`).
//   * `java.getString(rule)` — a selector when it is not an address, a download
//     when it is.
//
// Not implemented, with the reason in each case. This is a census of the
// collections under `test-results/`, so it can be re-measured rather than
// believed:
//
//   * `handle.select(rule)` (10 call sites, e.g. `影视难受3`'s
//     `list.select('a')`) — the one element method the wider corpus uses that
//     the handle does not have. It is absent here on purpose: no source in the
//     five-name family calls it, so adding it would be building for a rule we
//     have not read end to end. It is the first thing to add if those video
//     sources are taken up again.
//   * `java.searchBook`, `toast`, `longToast`, `log`, `toURL`, `net`, `head`,
//     `openUrl`, `ruleUrl`, `getWebViewUA`, `getVerificationCode`,
//     `startBrowserAwait`, `ajaxAll`, `util`, `lang`, `apk`, `base64Encode`,
//     `md5Encode16`, `timeFormatUTC` — used by *other* sources in the same
//     collections (13, 12, 8, 9, 4, … call sites). Describing them all would be
//     exactly the "fill in the whole Legado API" this change is trying not to
//     do; each wants its own rule text and its own justification.
//   * `java.getVar` — not a Legado name at all. It exists as an alias; no rule
//     in any sampled collection calls it.
//   * Nothing here writes to the reader's webview. See the boundary note on
//     `PageState`.

/// `__dom_find(rule)` — matches the working document and returns descriptors.
fn js_dom_find(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let rule = arg_str(args, 0, ctx);
    let out = with_page(|p| {
        if p.html.is_empty() || rule.trim().is_empty() {
            return "[]".to_string();
        }
        let doc = crate::engine::selector::Doc::parse(&p.html);
        let mut out = Vec::new();
        for html in doc.eval_outer(&rule) {
            // A handle's index is its slot in the table, and the table is
            // append-only for the life of the bound page — a rule holds the
            // handles it was given while it goes on calling `setContent`.
            // So the cap refuses rather than resets: resetting would leave the
            // rule holding indices that now name *other* elements, which is a
            // wrong answer delivered silently. Both limits refuse, and the
            // second one exists because 512 slices of a nested document are not
            // one document's worth of memory.
            if p.handles.len() >= MAX_HANDLES
                || p.handle_bytes + html.len() > MAX_HANDLE_BYTES
            {
                break;
            }
            let index = p.handles.len();
            p.handle_bytes += html.len();
            p.handles.push(html.clone());
            let tag = element_name(&html);
            let attrs: Vec<Json> = ["href", "title", "alt", "src", "class", "id", "value"]
                .iter()
                .filter_map(|name| {
                    let value = from_element(&html, name);
                    (!value.is_empty()).then(|| {
                        Json::Array(vec![
                            Json::String((*name).to_string()),
                            Json::String(value),
                        ])
                    })
                })
                .collect();
            let mut obj = serde_json::Map::new();
            obj.insert("i".into(), Json::from(index));
            obj.insert("tag".into(), Json::String(tag));
            obj.insert("text".into(), Json::String(from_element(&html, "text")));
            obj.insert("inner".into(), Json::String(from_element(&html, "innerHtml")));
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
/// `index < 0` replaces the document, which is what `setContent(string)` means;
/// an index with no markup re-points the document at that element, which is what
/// `setContent(element)` means; an index *with* markup replaces that element's
/// inner content (the element overload — see [`replace_inner`]).
///
/// What is written is clamped to [`MAX_DOM_BYTES`] and outlives nothing: the
/// document it lands in is dropped when the evaluation ends.
fn js_dom_use(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let index: i64 = arg_str(args, 0, ctx).parse().unwrap_or(-1);
    let html = arg_str(args, 1, ctx);
    with_page(|p| {
        let next: String = if index < 0 {
            html
        } else {
            match p.handles.get(index as usize) {
                Some(existing) if html.is_empty() => existing.clone(),
                Some(existing) => replace_inner(existing, &html),
                None => String::new(),
            }
        };
        // The handle table is deliberately *not* appended to here. Every index a
        // rule can name was handed out by `__dom_find`; pushing an entry per
        // write would (a) renumber the handles the rule is still holding, so
        // that a later `setContent(a)` silently re-points at another element,
        // and (b) let a loop of writes grow the table without bound. Writing
        // only ever replaces the working document.
        p.html = clamp_dom(&next);
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
    get: function (arg, headers) {
        // Legado spells the context map `put` / `get`, and that is what every
        // sampled rule means by it: of the 28 `java.get(...)` calls in the
        // collections under `test-results/`, **all 28 pass a string literal**
        // and read a variable — `'url'` x16, `'title'` x4, `'name'` x2,
        // `'pic'` x2, `'pg'`, `'urltp'`, `` `pwd` ``, `"name"`. Not one passes
        // an address. `阅读难受1` is the pair in the same source:
        // `ruleArticles` ends with `java.put('url', baseUrl)` and `ruleNextPage`
        // opens with `url = String(java.get('url'))`.
        //
        // An address is still honoured, because a rule we have not sampled may
        // use the spelling for a download and there is nothing to gain from
        // breaking it. A variable key can never look like absolute http(s), so
        // the two cannot be confused.
        var a = arg == null ? '' : String(arg);
        if (/^https?:\/\//i.test(a)) {
            return this.ajax(a, headers);
        }
        return __dom_var(a);
    },
    // The context map, under an engine-specific name. Kept because it is
    // already reachable from user-written rules and removing it would help
    // nobody — but no rule in any sampled collection calls it, and `java.get`
    // is the spelling that has to work.
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
// anything is to hand it to `setContent` — either the rule's own
// `java.setContent(handle)`, which re-points the working document at this
// element, or the handle's own `setContent(html)`, which replaces what is
// inside it. Neither one touches the page the reader is looking at.
globalThis.__seriousElement = function (d) {
    return {
        __domIndex: d.i,
        tag: function () { return d.tag; },
        text: function () { return d.text; },
        textNodes: function () { return d.text; },
        // jsoup's distinction: `html()` is what is inside the element,
        // `outerHtml()` is the element itself. Both are read out of the element
        // we already hold, because a bare `text`/`innerHtml` is a tag selector
        // here and matches nothing.
        html: function () { return d.inner; },
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
    let code = strip_wrapper(code);
    let mut context = new_context(json)?;
    let wrapped = wrap(&code);
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

    // ---- `java.put` / `java.get` ------------------------------------------
    //
    // Legado spells the context map `put` / `get`, and that is the spelling the
    // rules use. Measured over every collection JSON in `test-results/`
    // (142 files, collections 77 / 107 / 160): `java.put` appears 28 times,
    // `java.get` 28 times, and **all 28 `java.get` arguments are string
    // literals** — `'url'` x16, `'title'` x4, `'name'` x2, `'pic'` x2, `'pg'`,
    // `'urltp'`, `` `pwd` ``, `"name"` — i.e. every one of them is a key, and
    // not one is a url. `java.getVar` appears **zero** times.
    //
    // The pair is not decorative: `阅读难受1`'s `ruleArticles` ends with
    // `java.put('url', baseUrl)`, and that same source's `ruleNextPage` starts
    // with `url = String(java.get('url'))` to build the next page's address.
    // `ruleTitle` puts `name`, `ruleLink` and `ruleContent` read it back.
    // Both sides evaluate inside one `set_page` binding, so the map has to
    // survive from one rule field to the next.

    /// The one-liner form of the pair above, with the spelling the corpus uses.
    #[test]
    fn put_is_read_back_by_get_not_only_by_get_var() {
        set_page(Some(LANZOU_FOLDER.to_string()));
        let out = eval_to_string(
            "java.put('url', 'https://lanzoux.test/b1?pg=1'); result = java.get('url');",
            &json!({}),
        );
        set_page(None);
        assert_eq!(
            out, "https://lanzoux.test/b1?pg=1",
            "java.get must read what java.put wrote — `getVar` is not a name any sampled rule calls"
        );
    }

    /// `阅读难受1` verbatim: the listing records its page, `ruleNextPage` reads it.
    ///
    /// The two fields are separate evaluations, so this also pins the scope of
    /// the map: it belongs to the bound page, not to one script.
    #[test]
    fn a_rule_field_can_read_a_variable_another_field_put() {
        set_page(Some(LANZOU_FOLDER.to_string()));
        // `ruleArticles`' last line, copied from the rule. The one thing added
        // is `var baseUrl = …`, which the harness has to supply: the engine does
        // not bind `baseUrl` as a global (only `result` and the JSON body), so
        // the whole-JS-block path that would is task t35, not this one. The
        // `java.put` line itself is unmodified.
        eval_to_string(
            "var baseUrl = 'https://wwdn.lanzoue.com/b0d5g0tba?pg=1'; java.put('url', baseUrl);",
            &json!({}),
        );
        // `ruleNextPage`, copied from the rule. The one thing added is
        // `result = url;` at the end: this engine's statement form returns
        // `result`, so a rule that finishes with a bare expression yields ''
        // (measured — recorded in the report as a separate gap). The block that
        // reads the variable is unmodified.
        let out = eval_to_string(
            r#"
            try {
                url = String(java.get('url'));
                url = url.replace(/(pg=)(\d+)/, (mat, $1, $2) => {
                    return $1 + (~~$2 + 1)
                }).replace(url, '');
            } catch (err) {
                url = ""
            }
            result = url;
            "#,
            &json!({}),
        );
        set_page(None);
        assert_eq!(
            out.trim(),
            "https://wwdn.lanzoue.com/b0d5g0tba?pg=2",
            "pagination must advance the page it was handed"
        );
    }

    /// The map belongs to the bound page and is dropped with it, like the DOM.
    #[test]
    fn variables_do_not_outlive_the_page_that_was_bound() {
        set_page(Some(LANZOU_FOLDER.to_string()));
        eval_to_string("java.put('name', '第一本书');", &json!({}));
        assert_eq!(eval_to_string("java.get('name')", &json!({})), "第一本书");
        // Re-binding (what the next listing does) drops it.
        set_page(Some(LANZOU_FOLDER.to_string()));
        assert_eq!(
            eval_to_string("java.get('name')", &json!({})),
            "",
            "a new page must not inherit the previous listing's variables"
        );
        set_page(None);
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

    // ---- handle identity --------------------------------------------------
    //
    // A handle is addressed by its index in a table, and a rule holds handles
    // across other calls: `影视难受3` runs `list = java.getElements(...)[i]` and
    // then reads `list.select('a')`, and the 蓝奏云 family interleaves
    // `setContent(a)` with further reads. So the index a rule was handed has to
    // keep naming the same element. Two shapes have to hold: a second query must
    // not reuse indices the first query handed out, and a write must not move
    // them.

    /// Two elements that are not the first two on the page, so a shifted index
    /// reads a different href rather than the same one by accident.
    const TWO_LISTS: &str = r#"
      <div id="folder">
        <div class="mlink"><a href="https://lanzoux.test/a1">one</a></div>
        <div class="mlink"><a href="https://lanzoux.test/a2">two</a></div>
      </div>
      <div id="other"><a href="https://lanzoux.test/b1">three</a></div>
    "#;

    #[test]
    fn a_second_query_does_not_reissue_indices_the_first_one_handed_out() {
        set_page(Some(TWO_LISTS.to_string()));
        let out = eval_to_string(
            r#"
            var folder = java.getElements('#folder .mlink');
            var other  = java.getElements('#other a');
            java.setContent(other[0]);
            result = java.getString('a@href');
            "#,
            &json!({}),
        );
        set_page(None);
        assert_eq!(
            out, "https://lanzoux.test/b1",
            "`other[0]` must name the element the second query found, not the first query's first handle"
        );
    }

    #[test]
    fn a_write_does_not_renumber_the_handles_a_rule_is_holding() {
        // `setContent` replaces the working document, so the page has to be put
        // back before the second query — which is exactly what the real rule
        // does when it calls `java.setContent(src)` after walking the folder.
        set_page(Some(TWO_LISTS.to_string()));
        let out = eval_to_string(
            r#"
            var src = `
              <div id="folder">
                <div class="mlink"><a href="https://lanzoux.test/a1">one</a></div>
                <div class="mlink"><a href="https://lanzoux.test/a2">two</a></div>
              </div>
              <div id="other"><a href="https://lanzoux.test/b1">three</a></div>
            `;
            var folder = java.getElements('#folder .mlink');
            for (var i = 0; i < 300; i++) { java.setContent(folder[1]); }
            java.setContent(src);
            var other = java.getElements('#other a');
            java.setContent(other[0]);
            result = java.getString('a@href');
            "#,
            &json!({}),
        );
        set_page(None);
        assert_eq!(
            out, "https://lanzoux.test/b1",
            "writing to the page must not consume handle slots"
        );
    }

    /// More matches than the table holds: the cap must refuse, not renumber.
    #[test]
    fn the_handle_table_refuses_past_its_cap_instead_of_resetting() {
        let mut page = String::from("<div id='many'>");
        for i in 0..(MAX_HANDLES + 10) {
            page.push_str(&format!("<a href=\"/x{i}\">t{i}</a>"));
        }
        page.push_str("</div>");

        set_page(Some(page));
        // One evaluation: the find fills the table, and the handle it handed out
        // last must still resolve to the 512th match.
        let out = eval_to_string(
            r#"
            var all = java.getElements('#many a');
            result = all.length + '|' + (function () {
                java.setContent(all[511]);
                return java.getString('a@href');
            })();
            "#,
            &json!({}),
        );
        set_page(None);
        assert_eq!(
            out, "512|/x511",
            "a full table must still resolve the handles it handed out, got {out}"
        );
    }

    /// What the cap says when it has nothing left to give.
    ///
    /// This is the failure path, and it is asserted rather than assumed: a
    /// second query on a page whose table is full hands back an empty list. It
    /// does *not* hand back elements sharing indices with the handles the rule
    /// is already holding, which is the outcome worth refusing.
    #[test]
    fn a_query_past_the_cap_yields_nothing_rather_than_wrong_elements() {
        let mut page = String::from("<div id='many'>");
        for i in 0..(MAX_HANDLES + 10) {
            page.push_str(&format!("<a href=\"/x{i}\">t{i}</a>"));
        }
        page.push_str("</div><div id='other'><a href=\"/b1\">three</a></div>");

        set_page(Some(page));
        let out = eval_to_string(
            r#"
            var many = java.getElements('#many a');
            var other = java.getElements('#other a');
            java.setContent(many[0]);
            result = java.getString('a@href') + '|' + other.length;
            "#,
            &json!({}),
        );
        set_page(None);
        assert_eq!(
            out, "/x0|0",
            "the first query must still resolve, and the second must refuse: {out}"
        );
    }

    /// The table is bounded by what it holds, not only by entry count: 512
    /// slices of a nested document are not one document's worth of memory.
    #[test]
    fn the_handle_table_is_bounded_by_bytes_as_well_as_entries() {
        // Two matches per repetition, each ~10 KB: 512 entries would be ~5 MB,
        // above the byte budget, so the budget has to stop it before the count.
        let text = "三".repeat(3_300); // ~9.9 KB
        let mut page = String::from("<div id='many'>");
        for _ in 0..(MAX_HANDLES / 2 + 20) {
            page.push_str(&format!("<div class='w'><div class='w'>{text}</div></div>"));
        }
        page.push_str("</div>");

        set_page(Some(page));
        let count = eval_to_string("java.getElements('.w').length", &json!({}))
            .parse::<usize>()
            .unwrap();
        let bytes = with_page(|p| p.handle_bytes);
        set_page(None);

        assert!(
            bytes <= MAX_HANDLE_BYTES,
            "{bytes} bytes of handles, budget is {MAX_HANDLE_BYTES}"
        );
        assert!(
            count < MAX_HANDLES,
            "the byte budget should have bitten before the entry cap, got {count} handles"
        );
        assert!(count > 0, "the budget should not refuse everything");
    }

    /// The handle's own accessors.
    ///
    /// These are the whole return value of `java.getElements`, and until this
    /// was checked three of them answered `''` for every element: the old code
    /// asked the selector for `tag` / `text` / `innerHtml` with no `@`, and a
    /// bare token is a *tag selector* here, so it looked for an element called
    /// `<text>` and found none. `.text()` is used 9 times in the collections
    /// under `test-results/` (e.g. 影视 sources reading `list[j].text()`), so an
    /// always-empty answer was a silent wrong value, not an unimplemented one.
    #[test]
    fn a_handle_reads_its_own_tag_text_and_markup() {
        set_page(Some(TWO_LISTS.to_string()));
        let out = eval_to_string(
            r#"
            var link = java.getElements('#other a')[0];
            result = [link.tag(), link.text(), link.attr('href'), link.html()].join('|');
            "#,
            &json!({}),
        );
        set_page(None);
        assert_eq!(out, "a|three|https://lanzoux.test/b1|three", "{out}");
    }

    /// `outerHtml()` is the element; `html()` is what is inside it.
    #[test]
    fn html_and_outer_html_are_not_the_same_reading() {
        set_page(Some(TWO_LISTS.to_string()));
        let out = eval_to_string(
            r#"
            var link = java.getElements('#other a')[0];
            result = link.outerHtml() + '||' + link.html();
            "#,
            &json!({}),
        );
        set_page(None);
        let (outer, inner) = out.split_once("||").expect("both readings");
        assert_eq!(outer, r#"<a href="https://lanzoux.test/b1">three</a>"#, "{out}");
        assert_eq!(inner, "three", "{out}");
    }

    /// The element overload is a replace, not an append.
    #[test]
    fn setting_content_on_an_element_replaces_what_is_inside_it() {
        set_page(Some(TWO_LISTS.to_string()));
        let out = eval_to_string(
            r#"
            var link = java.getElements('#other a')[0];
            link.setContent('<b>改写</b>');
            result = java.getString('b@text') + '|' + java.getString('a@text');
            "#,
            &json!({}),
        );
        set_page(None);
        let (new_text, old_text) = out.split_once('|').expect("both reads should produce a value");
        assert_eq!(new_text, "改写", "the new markup should be inside the element, got {out}");
        assert_ne!(
            old_text, "three",
            "the element's previous content should be gone, not left beside the new markup: {out}"
        );
    }

    /// `MAX_DOM_BYTES` says bytes, so it must count bytes.
    #[test]
    fn the_document_cap_counts_bytes_on_a_character_boundary() {
        assert_eq!(clamp_dom("short"), "short");
        // Three-byte characters: a character-based cap would admit 3x the memory.
        let big = "三".repeat(MAX_DOM_BYTES);
        let clamped = clamp_dom(&big);
        assert!(
            clamped.len() <= MAX_DOM_BYTES,
            "clamped to {} bytes, cap is {MAX_DOM_BYTES}",
            clamped.len()
        );
        assert!(clamped.len() > MAX_DOM_BYTES - 4, "the cap should be reached, not undershot");
        assert!(clamped.chars().all(|c| c == '三'), "truncation split a character");

        set_page(Some(big));
        assert!(
            with_page(|p| p.html.len()) <= MAX_DOM_BYTES,
            "set_page must apply the same byte cap"
        );
        set_page(None);
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