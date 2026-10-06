use once_cell::sync::Lazy;
use regex::Regex;
use scraper::element_ref::ElementRef;
use scraper::{Html, Selector};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

// ---------------------------------------------------------------------------
// Compiled rules
// ---------------------------------------------------------------------------

/// Split `class.video-player@all` into the selector and its `@` steps.
/// A backslash escapes a literal `@`.
fn split_steps(rule: &str) -> (String, Vec<String>) {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut chars = rule.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(&n) = chars.peek() {
                    if n == '@' {
                        cur.push('@');
                        chars.next();
                        continue;
                    }
                }
                cur.push(c);
            }
            '@' => parts.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    parts.push(cur);
    let selector = parts.remove(0);
    (selector, parts)
}

/// Common HTML tag names. A bare token matching one of these is a *selector*
/// (`rule@all@img@alt`), not an attribute name.
const TAGS: &[&str] = &[
    "a", "abbr", "article", "aside", "audio", "b", "body", "br", "button", "canvas", "caption",
    "cite", "code", "col", "dd", "div", "dl", "dt", "em", "embed", "fieldset", "figure", "footer",
    "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "i", "iframe",
    "img", "input", "label", "li", "link", "meta", "nav", "ol", "option", "p", "picture", "pre",
    "script", "section", "select", "small", "source", "span", "strong", "table", "tbody", "td",
    "textarea", "tfoot", "th", "thead", "time", "title", "tr", "ul", "video", "main", "style",
];

fn is_tag_token(tok: &str) -> bool {
    let t = tok.trim().to_lowercase();
    TAGS.contains(&t.as_str())
}

/// One traversal/extraction token.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    All,
    Children,
    Child(usize),
    Next,
    Prev,
    Parent,
    /// Descendant selection, e.g. `img` or `class.x` mid-chain.
    Select(String),
    /// Legado's "the element whose text is this" step, e.g. `text.一键导入`.
    ///
    /// Without this the token falls through to `Attr` and silently matches
    /// nothing, which looks like a dead source rather than an unsupported rule.
    TextMatch(String),
    /// The Nth match of a selector, e.g. `a.0` for the first anchor.
    ///
    /// Common in shared collections — `a.0@href` alone appears in 95 of the
    /// rules in one collection. Read as CSS it is invalid (a class cannot
    /// start with a digit), so it used to match nothing at all.
    Indexed(String, usize),
    /// Attribute extraction (terminal).
    Attr(String),
    Text,
    OwnText,
    Html,
    OuterHtml,
    RemoveHtml,
}

/// Split `a.0` into (`a`, 0).
///
/// Only a purely numeric trailing segment counts, so real class names that
/// merely end in a digit (`div.col2`) are unaffected.
fn split_index(step: &str) -> Option<(&str, usize)> {
    let (base, tail) = step.rsplit_once('.')?;
    let at: usize = tail.parse().ok()?;
    if base.trim().is_empty() {
        return None;
    }
    Some((base, at))
}

fn classify(step: &str) -> Step {
    match step {
        "all" | "each" => Step::All,
        "children" => Step::Children,
        "next" => Step::Next,
        "prev" => Step::Prev,
        "parent" => Step::Parent,
        "Text" | "text" | "textNodes" | "TextNodes" => Step::Text,
        "ownText" | "OwnText" => Step::OwnText,
        "Html" | "html" | "innerHtml" => Step::Html,
        "outerHtml" | "OuterHtml" => Step::OuterHtml,
        "removeHtml" | "RemoveHtml" => Step::RemoveHtml,
        _ => {
            if let Some(n) = step.strip_prefix("child.") {
                return Step::Child(n.parse().unwrap_or(0));
            }
            // XPath mid-chain, e.g. `//text()` or `//a`.
            if looks_like_xpath(step) {
                let (css, wants_text) = xpath_to_css(step);
                return if wants_text { Step::Text } else { Step::Select(css) };
            }
            // A leading `tag.`, `id.` or `class.` is a descendant selection.
            // A trailing `.<number>` selects the Nth match, including after a
            // `tag.`/`id.`/`class.` prefix (`tag.a.1`). Checked before those
            // prefixes, which would otherwise build the invalid selector
            // `tag.a.1` and quietly match nothing.
            if let Some((base, at)) = split_index(step) {
                return Step::Indexed(base.to_string(), at);
            }
            if step.starts_with("tag.") || step.starts_with("id.") || step.starts_with("class.") {
                return Step::Select(step.to_string());
            }
            // `text.<value>` locates an element by its visible text. It must be
            // checked before the attribute fallback, or it is read as an
            // attribute name and silently matches nothing.
            if let Some(want) = step.strip_prefix("text.") {
                return Step::TextMatch(want.to_string());
            }
            if is_tag_token(step) {
                return Step::Select(step.to_string());
            }
            // Anything else is an attribute name.
            Step::Attr(step.to_string())
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub selector: String,
    pub steps: Vec<Step>,
    pub is_json: bool,
}

impl CompiledRule {
    pub fn compile(rule: &str) -> Self {
        let (raw_selector, raw_steps) = split_steps(rule.trim());
        let (selector, selector_text) = if looks_like_xpath(&raw_selector) {
            xpath_to_css(&raw_selector)
        } else {
            (raw_selector.trim().to_string(), false)
        };

        let mut steps: Vec<Step> = Vec::new();
        // `//text()` means "take the text of the matched nodes".
        if selector_text {
            steps.push(Step::Text);
        }
        steps.extend(raw_steps.iter().map(|s| classify(s.trim())));

        CompiledRule {
            is_json: crate::util::is_json_path(rule),
            selector,
            steps,
        }
    }

    fn is_empty(&self) -> bool {
        self.selector.trim().is_empty() && self.steps.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Selector cache
// ---------------------------------------------------------------------------

thread_local! {
    static SELECTOR_CACHE: RefCell<HashMap<String, Option<Rc<Selector>>>> =
        RefCell::new(HashMap::new());
}

fn cached_selector(sel: &str) -> Option<Rc<Selector>> {
    SELECTOR_CACHE.with(|c| {
        if let Some(hit) = c.borrow().get(sel) {
            return hit.clone();
        }
        let parsed = Selector::parse(sel).ok().map(Rc::new);
        c.borrow_mut().insert(sel.to_string(), parsed.clone());
        parsed
    })
}

/// Translate a Legado selector token into a CSS selector.
///
/// `class.video-player` -> `.video-player`, `id.content` -> `#content`,
/// `tag.div` -> `div`, `div.card` -> `div.card`, `body` -> `body`.
fn to_css(token: &str) -> String {
    let t = token.trim();
    if t.is_empty() {
        return "*".to_string();
    }
    if t == "body" {
        return "body".to_string();
    }
    if t.starts_with('.') || t.starts_with('#') || t.starts_with('[') {
        return t.to_string();
    }
    if let Some(rest) = t.strip_prefix("class.") {
        return format!(".{}", rest);
    }
    if let Some(rest) = t.strip_prefix("id.") {
        return format!("#{}", rest);
    }
    if let Some(rest) = t.strip_prefix("tag.") {
        return rest.trim().to_string();
    }
    let mut out = String::new();
    let mut first = true;
    for part in t.split('.') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if first {
            out.push_str(part);
            first = false;
        } else {
            out.push('.');
            out.push_str(part);
        }
    }
    if out.is_empty() {
        "*".to_string()
    } else {
        out
    }
}

// ---------------------------------------------------------------------------
// Tree navigation (scraper exposes no parent/sibling API)
// ---------------------------------------------------------------------------

fn ptr_eq(a: &ElementRef<'_>, b: &ElementRef<'_>) -> bool {
    std::ptr::eq(
        a.value() as *const scraper::node::Element,
        b.value() as *const scraper::node::Element,
    )
}

/// Remove duplicate nodes, preserving order.
///
/// `@all` mixes matched nodes with their children, and the same element can be
/// reached twice (directly and as a descendant), which would duplicate results.
fn dedup(nodes: Vec<ElementRef<'_>>) -> Vec<ElementRef<'_>> {
    let mut seen: Vec<*const scraper::node::Element> = Vec::with_capacity(nodes.len());
    let mut out = Vec::with_capacity(nodes.len());
    for n in nodes {
        let key = n.value() as *const scraper::node::Element;
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(n);
    }
    out
}

fn index_path<'a>(root: &ElementRef<'a>, target: &ElementRef<'a>) -> Option<Vec<usize>> {
    fn walk(node: &ElementRef<'_>, target: &ElementRef<'_>, path: &mut Vec<usize>) -> bool {
        for (i, child) in node.child_elements().enumerate() {
            path.push(i);
            if ptr_eq(&child, target) || walk(&child, target, path) {
                return true;
            }
            path.pop();
        }
        false
    }
    let mut path = Vec::new();
    if walk(root, target, &mut path) {
        Some(path)
    } else {
        None
    }
}

fn resolve_path<'a>(root: &ElementRef<'a>, path: &[usize]) -> Option<ElementRef<'a>> {
    let mut cur = *root;
    for i in path {
        cur = cur.child_elements().nth(*i)?;
    }
    Some(cur)
}

/// Whether `target` appears anywhere under `node`.
fn has_descendant(node: &ElementRef<'_>, target: ElementRef<'_>) -> bool {
    if let Some(sel) = cached_selector("*") {
        node.select(sel.as_ref()).any(|d| ptr_eq(&d, &target))
    } else {
        false
    }
}

fn navigate<'a>(root: &ElementRef<'a>, node: &ElementRef<'a>, step: &Step) -> Option<ElementRef<'a>> {
    let mut path = index_path(root, node)?;
    match step {
        Step::Parent => {
            path.pop();
            resolve_path(root, &path)
        }
        Step::Next => {
            let idx = path.last()? + 1;
            let parent = resolve_path(root, &path[..path.len() - 1])?;
            parent.child_elements().nth(idx)
        }
        Step::Prev => {
            if path.is_empty() {
                return None;
            }
            let idx = path.last()? - 1;
            let parent = resolve_path(root, &path[..path.len() - 1])?;
            parent.child_elements().nth(idx)
        }
        _ => None,
    }
}

/// Select `css` within each node, also accepting the node itself.
///
/// scraper's `select` only matches descendants, so `class.item@all@img@alt`
/// would find nothing unless self-matching is allowed.
fn select_within<'a>(nodes: &[ElementRef<'a>], css: &str) -> Vec<ElementRef<'a>> {
    let raw = css.trim();
    let Some(sel) = cached_selector(&to_css(raw)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for node in nodes {
        if self_matches(node, raw) {
            out.push(*node);
            continue;
        }
        out.extend(node.select(sel.as_ref()));
    }
    out
}

/// Whether an element matches a *simple* selector on its own.
///
/// `select` only ever returns descendants, so `class.item@all@a@href` needs the
/// `<a>` children tested against `a` directly. Only the selector shapes Legado
/// actually uses mid-chain are handled: tag, `.class`, `#id` and `tag.class`.
fn self_matches(el: &ElementRef<'_>, raw: &str) -> bool {
    let raw = raw.trim();
    if raw.is_empty() || raw == "*" {
        return true;
    }
    let (tag_part, rest) = match raw.split_once('.') {
        Some((t, r)) => (t, Some(r)),
        None => (raw, None),
    };
    if let Some(id) = tag_part.strip_prefix('#') {
        return el.value().id() == Some(id);
    }
    if let Some(class) = rest {
        if !class
            .split('.')
            .all(|c| el.value().has_class(c, scraper::CaseSensitivity::AsciiCaseInsensitive))
        {
            return false;
        }
    }
    if tag_part.is_empty() || tag_part.starts_with('#') {
        return true;
    }
    let tag = tag_part.strip_prefix("tag.").unwrap_or(tag_part);
    el.value().name().eq_ignore_ascii_case(tag)
}

/// How the final nodes should be turned into strings.
#[derive(Debug, Clone, PartialEq)]
enum Extract {
    Attr(String),
    Text,
    OwnText,
    Html,
    OuterHtml,
    RemoveHtml,
    /// The rule had no extraction step: return each node's text.
    Default,
}

// ---------------------------------------------------------------------------
// XPath-style rules
// ---------------------------------------------------------------------------

/// Whether a token uses XPath rather than Legado/CSS syntax.
///
/// Real collections ship rules like `//div.list-com/a` and `//text()`.
fn looks_like_xpath(token: &str) -> bool {
    let t = token.trim();
    t.starts_with("//") || t.starts_with("./") || t.ends_with("text()") || t.contains("[@")
}

/// Translate a simple XPath into an equivalent CSS selector.
///
/// Supports the forms that actually appear in source collections:
/// `//div.a#b`, `/a/b`, `tag[@attr]`, `tag[@attr='v']`, `tag[2]` and a
/// trailing `text()`. The boolean reports whether the rule wants *text*.
fn xpath_to_css(xpath: &str) -> (String, bool) {
    let mut path = xpath.trim();
    let mut wants_text = false;

    if let Some(pos) = path.find("text()") {
        wants_text = true;
        path = path[..pos].trim().trim_end_matches('/').trim();
    }

    let mut parts: Vec<String> = Vec::new();
    for segment in path.split('/') {
        let seg = segment.trim();
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        parts.push(xpath_segment_to_css(seg));
    }

    if parts.is_empty() {
        return ("*".to_string(), wants_text);
    }
    (parts.join(" "), wants_text)
}

/// Convert one XPath step (`div.list-com`, `a[@href]`, `li[2]`) to CSS.
fn xpath_segment_to_css(seg: &str) -> String {
    // Split the trailing predicate: `a[@href='x']`
    let (node, predicate) = match seg.find('[') {
        Some(pos) => {
            let (node, pred) = seg.split_at(pos);
            (node, Some(pred.trim_end_matches(']')))
        }
        None => (seg, None),
    };

    let mut css = String::new();

    // Attribute predicate.
    if let Some(pred) = predicate {
        let pred = pred.trim_start_matches('[').trim();
        if let Some(eq) = pred.find('=') {
            let name = pred[..eq].trim().trim_matches(['@', '\'']).trim();
            let value = pred[eq + 1..]
                .trim()
                .trim_end_matches(']')
                .trim_matches(['\'', '"'])
                .trim();
            css.push_str(&format!("[{name}='{value}']"));
        } else if let Some(name) = pred.strip_prefix('@') {
            css.push_str(&format!("[{name}]"));
        } else if let Ok(index) = pred.parse::<usize>() {
            // `li[2]` is 1-based in XPath.
            css.push_str(&format!(":nth-of-type({})", index.max(1)));
        }
    }

    // Node test: tag, .class, #id and combinations.
    if node.is_empty() {
        return if css.is_empty() { "*".to_string() } else { css };
    }
    let mut first = true;
    for part in node.split('.') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if first {
            css.push_str(part);
            first = false;
        } else {
            css.push('.');
            css.push_str(part);
        }
    }
    if css.is_empty() {
        "*".to_string()
    } else {
        css
    }
}

// ---------------------------------------------------------------------------
// HTML document wrapper
// ---------------------------------------------------------------------------

static SPACE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());

/// A parsed HTML document. Parsing dominates evaluation cost, so callers keep
/// one instance and run every rule against it.
pub struct Doc {
    html: Html,
}

impl Doc {
    pub fn parse(html: &str) -> Self {
        Doc { html: Html::parse_document(html) }
    }

    pub fn root(&self) -> ElementRef<'_> {
        self.html.root_element()
    }

    pub fn text(&self) -> String {
        clean(&self.html.root_element().text().collect::<String>())
    }

    /// Evaluate a rule, returning text (or the requested attribute/markup).
    pub fn eval(&self, rule: &str) -> Vec<String> {
        if rule.trim().is_empty() {
            return vec![self.text()];
        }
        let compiled = CompiledRule::compile(rule);
        if compiled.is_empty() {
            return vec![self.text()];
        }
        let root = self.root();
        let start = select_within(&[root], &compiled.selector);
        // Only fall back to the document root when the rule has no selector at
        // all (`@text`). If a real selector matched nothing the rule genuinely
        // selects nothing, and expanding the whole document would be wrong.
        let start = if start.is_empty() && compiled.selector.trim().is_empty() {
            vec![root]
        } else {
            start
        };
        let (nodes, extract) = self.walk(start, &compiled.steps);
        materialize(nodes, &extract)
    }

    /// Evaluate a rule and return the outer HTML of the matched nodes.
    pub fn eval_outer(&self, rule: &str) -> Vec<String> {
        let compiled = CompiledRule::compile(rule);
        if compiled.selector.trim().is_empty() && compiled.steps.is_empty() {
            return vec![self.html.html()];
        }
        let root = self.root();
        let start = select_within(&[root], &compiled.selector);
        let start = if start.is_empty() && compiled.selector.trim().is_empty() {
            vec![root]
        } else {
            start
        };

        // `@Html` on an otherwise complete rule means "inner HTML of matches".
        let wants_outer = matches!(
            compiled.steps.last(),
            Some(Step::OuterHtml) | None
        ) && compiled.steps.iter().any(|s| matches!(s, Step::Html));

        if wants_outer {
            let trimmed = &compiled.steps[..compiled.steps.len().saturating_sub(1)];
            let (nodes, _) = self.walk(start, trimmed);
            return dedup(nodes).iter().map(|e| e.html()).collect();
        }

        let (nodes, _) = self.walk(start, &compiled.steps);
        dedup(nodes).iter().map(|e| e.html()).collect()
    }

    /// Walk the step chain.
    ///
    /// `@all` is special: Legado re-enters rule parsing for each child, so the
    /// remaining tokens are applied *per child* rather than to the whole set.
    fn walk<'a>(
        &'a self,
        mut current: Vec<ElementRef<'a>>,
        steps: &[Step],
    ) -> (Vec<ElementRef<'a>>, Extract) {
        let root = self.root();
        let mut i = 0;
        while i < steps.len() {
            match &steps[i] {
                Step::All => {
                    let rest = &steps[i + 1..];
                    if rest.is_empty() {
                        // Nothing follows, so `@all` simply means "every match".
                        return (current, Extract::Default);
                    }
                    // Re-entering rule parsing keeps each match *and* its
                    // children, so both `td@all` (iterate the matches) and
                    // `class.item@all@img@alt` (descend into each) work.
                    let mut expanded: Vec<ElementRef<'a>> = Vec::new();
                    for e in &current {
                        expanded.push(*e);
                        expanded.extend(e.child_elements());
                    }
                    let (nodes, extract) = self.walk(expanded, rest);
                    return (nodes, extract);
                }
                Step::Children => {
                    let mut next = Vec::new();
                    for e in &current {
                        next.extend(e.child_elements());
                    }
                    current = next;
                    i += 1;
                }
                Step::Child(n) => {
                    current = current
                        .into_iter()
                        .filter_map(|e| e.child_elements().nth(*n))
                        .collect();
                    i += 1;
                }
                Step::Next | Step::Prev | Step::Parent => {
                    let mut next = Vec::new();
                    for e in &current {
                        if let Some(n) = navigate(&root, e, &steps[i]) {
                            next.push(n);
                        }
                    }
                    current = next;
                    i += 1;
                }
                Step::Select(sel) => {
                    current = select_within(&current, sel);
                    i += 1;
                }
                Step::TextMatch(want) => {
                    // `text.<value>` should yield the element whose text *is*
                    // that value, not every ancestor that happens to contain
                    // it. Searching descendants and preferring an exact match is
                    // what keeps `li@text.一键导入` returning the button rather
                    // than the whole list item.
                    let needle = want.trim();
                    let text_of = |e: &ElementRef<'a>| clean(&e.text().collect::<String>());

                    let exact_in = |nodes: &[ElementRef<'a>]| -> Vec<ElementRef<'a>> {
                        nodes.iter().copied().filter(|e| text_of(e) == needle).collect()
                    };

                    let mut hit = exact_in(&current);
                    if hit.is_empty() {
                        let mut pool = current.clone();
                        for e in &current {
                            if let Some(sel) = cached_selector("*") {
                                pool.extend(e.select(sel.as_ref()));
                            }
                        }
                        hit = exact_in(&pool);
                    }
                    if hit.is_empty() {
                        // No exact text anywhere: accept "contains", then keep
                        // only the deepest matches so ancestors drop out.
                        let mut pool = current.clone();
                        for e in &current {
                            if let Some(sel) = cached_selector("*") {
                                pool.extend(e.select(sel.as_ref()));
                            }
                        }
                        let contains: Vec<ElementRef<'a>> =
                            pool.iter().copied().filter(|e| text_of(e).contains(needle)).collect();
                        hit = contains
                            .iter()
                            .copied()
                            .filter(|e| !contains.iter().any(|o| ptr_eq(e, o) && has_descendant(e, *o)))
                            .collect();
                    }
                    current = hit;
                    i += 1;
                }
                Step::Indexed(base, at) => {
                    // Indexed per container: `ul@li@a.0@href` wants the first
                    // anchor of *each* list item, not the first anchor of the
                    // whole list.
                    let mut next = Vec::new();
                    for e in &current {
                        if let Some(hit) = select_within(&[*e], base).into_iter().nth(*at) {
                            next.push(hit);
                        }
                    }
                    current = next;
                    i += 1;
                }
                Step::Attr(a) => {
                    return (current, Extract::Attr(a.clone()));
                }
                Step::Text => return (current, Extract::Text),
                Step::OwnText => return (current, Extract::OwnText),
                Step::Html => return (current, Extract::Html),
                Step::OuterHtml => return (current, Extract::OuterHtml),
                Step::RemoveHtml => return (current, Extract::RemoveHtml),
            }
        }
        (current, Extract::Default)
    }

    /// Find a link whose visible text matches one of `labels`.
    pub fn find_link_by_text(&self, labels: &[&str]) -> Option<String> {
        let root = self.root();
        let sel = cached_selector("a")?;
        for a in root.select(sel.as_ref()) {
            let text = clean(&a.text().collect::<String>()).to_lowercase();
            if labels.iter().any(|l| text.contains(&l.to_lowercase())) {
                if let Some(href) = a.attr("href") {
                    if !href.trim().is_empty() && !href.starts_with("javascript") {
                        return Some(href.to_string());
                    }
                }
            }
        }
        None
    }

    /// Media URLs referenced by the document (video, audio, images).
    pub fn media_urls(&self) -> Vec<String> {
        let root = self.root();
        let mut out = Vec::new();
        for sel_str in ["video", "audio", "source", "img"] {
            let Some(sel) = cached_selector(sel_str) else { continue };
            for el in root.select(sel.as_ref()) {
                for attr in ["src", "data-src", "data-original", "poster"] {
                    if let Some(v) = el.attr(attr) {
                        if v.trim().is_empty() || v.starts_with("data:") {
                            continue;
                        }
                        out.push(v.to_string());
                        break;
                    }
                }
            }
        }
        out
    }
}

fn materialize(nodes: Vec<ElementRef<'_>>, extract: &Extract) -> Vec<String> {
    let nodes = dedup(nodes);
    match extract {
        Extract::Attr(attr) => nodes.iter().map(|e| e.attr(attr).unwrap_or_default().to_string()).collect(),
        Extract::Html => nodes.iter().map(|e| e.inner_html()).collect(),
        Extract::OuterHtml => nodes.iter().map(|e| e.html()).collect(),
        Extract::RemoveHtml | Extract::OwnText => nodes
            .iter()
            .map(|e| crate::util::html_to_text(&e.inner_html()))
            .collect(),
        Extract::Text | Extract::Default => nodes
            .iter()
            .map(|e| clean(&e.text().collect::<String>()))
            .collect(),
    }
}

fn clean(s: &str) -> String {
    crate::util::clean_text(&SPACE.replace_all(s, " "))
}

// ---------------------------------------------------------------------------
// JSONPath evaluation
// ---------------------------------------------------------------------------

fn json_lookup<'a>(root: &'a Value, path: &str) -> Vec<&'a Value> {
    let path = path.trim();
    if path.is_empty() || path == "$" || path == "." {
        return vec![root];
    }
    let expr = if path.starts_with('$') {
        path.to_string()
    } else {
        format!("$.{path}")
    };
    match jsonpath_lib::select(root, &expr) {
        Ok(v) => v,
        Err(_) => {
            let alt = expr.trim_start_matches('$').trim_start_matches('.');
            jsonpath_lib::select(root, alt).unwrap_or_default()
        }
    }
}

/// What a lookup found — and, more usefully, why it found nothing.
///
/// "The rule is wrong" and "there is nothing today" both used to arrive as an
/// empty vector, so a reader saw a blank list with no way to tell a broken rule
/// from a quiet site. Keeping the reason is what lets the caller say so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    /// The expression is not a path at all, or is not valid JSONPath.
    BadPath(String),
    /// A valid path that matched nothing in this document.
    NoMatch,
    /// Matched, and the values themselves carry no text.
    EmptyValues,
    Values,
}

impl Lookup {
    /// Does this outcome mean the *rule* is at fault?
    ///
    /// Only `BadPath` does. `NoMatch` is what a site that has not updated today
    /// looks like, and telling someone their rule is broken in that case is the
    /// one mistake this whole change exists to avoid.
    pub fn blames_the_rule(&self) -> bool {
        matches!(self, Lookup::BadPath(_))
    }
}

/// Why a lookup ended the way it did, when there is something to say.
pub fn lookup_verdict(root: &Value, rule: &str) -> Lookup {
    let compiled = CompiledRule::compile(rule.trim());
    if compiled.is_empty() {
        return Lookup::BadPath("规则为空".to_string());
    }

    // Does the expression parse at all? `jsonpath_lib` is the authority: if it
    // rejects both the dotted and the bare spelling, the rule is not a path.
    let selector = compiled.selector.trim();
    let (expr, alt) = if selector.is_empty() || selector == "$" || selector == "." {
        ("$".to_string(), "$".to_string())
    } else {
        let e = if selector.starts_with('$') {
            selector.to_string()
        } else {
            format!("$.{selector}")
        };
        let a = e.trim_start_matches('$').trim_start_matches('.').to_string();
        (e, a)
    };

    // Does the expression parse at all? `jsonpath_lib` is the authority: it is
    // valid if *either* the dotted spelling or the bare spelling is accepted.
    // Note that "parses" and "matches" are different questions — a valid path
    // that matches nothing is a working rule on a quiet day, not a broken one.
    let parses = match (jsonpath_lib::select(root, &expr), jsonpath_lib::select(root, &alt)) {
        (Ok(_), _) | (_, Ok(_)) => true,
        (Err(_), Err(_)) => false,
    };
    if !parses {
        return Lookup::BadPath(format!("`{selector}` 不是有效的 JSONPath"));
    }

    let values = eval_json(root, rule);
    if values.is_empty() {
        return Lookup::NoMatch;
    }
    if values.iter().all(|v| v.trim().is_empty()) {
        return Lookup::EmptyValues;
    }
    Lookup::Values
}

/// Evaluate a rule against a JSON body.
pub fn eval_json(root: &Value, rule: &str) -> Vec<String> {
    let rule = rule.trim();
    if rule.is_empty() {
        return vec![json_to_string(root)];
    }
    let compiled = CompiledRule::compile(rule);
    if compiled.is_empty() {
        return vec![json_to_string(root)];
    }

    // Own the matched nodes; the set is tiny, so cloning avoids lifetime noise.
    let mut current: Vec<Value> = json_lookup(root, &compiled.selector)
        .into_iter()
        .cloned()
        .collect();

    for step in &compiled.steps {
        match step {
            Step::All | Step::Children | Step::Child(_) => {
                current = current
                    .iter()
                    .filter_map(|v| v.as_array())
                    .flat_map(|a| a.iter().cloned())
                    .collect();
            }
            Step::Attr(name) | Step::Select(name) => {
                // In JSON rules a trailing token is a property name.
                return current.iter().map(|v| field(v, name)).collect();
            }
            Step::Next => current = current.into_iter().skip(1).collect(),
            Step::Prev => current = current.into_iter().rev().skip(1).collect(),
            _ => {}
        }
    }
    current.into_iter().map(|v| json_to_string(&v)).collect()
}

fn field(v: &Value, name: &str) -> String {
    v.get(name).map(json_to_string).unwrap_or_default()
}

pub fn json_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// Convenience wrappers for one-shot evaluation.
pub fn eval_html(html: &str, rule: &str) -> Vec<String> {
    Doc::parse(html).eval(rule)
}

pub fn eval_html_outer(html: &str, rule: &str) -> Vec<String> {
    Doc::parse(html).eval_outer(rule)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DOC: &str = r#"
      <html><body>
        <div class="list">
          <div class="item"><a href="/p/1"><img alt="First"/><span>2024-01-01</span></a></div>
          <div class="item"><a href="/p/2"><img alt="Second"/><span>2024-02-02</span></a></div>
          <div class="item"><a href="/p/3"><img alt="Third"/><span>2024-03-03</span></a></div>
        </div>
        <div id="content"><p>Hello <b>world</b></p></div>
        <div class="pager"><a href="/page/2">下一页</a></div>
      </body></html>"#;

    fn doc() -> Doc {
        Doc::parse(DOC)
    }

    #[test]
    fn selects_by_class() {
        assert_eq!(doc().eval("class.item@all").len(), 3);
    }

    #[test]
    fn extracts_attribute() {
        assert_eq!(doc().eval("class.item@a@href"), vec!["/p/1", "/p/2", "/p/3"]);
    }

    #[test]
    fn matches_an_element_by_its_text() {
        // Legado's `text.<value>` step: used to locate the "一键导入" button
        // on bookmark pages. Without it the token was read as an attribute name
        // and matched nothing.
        let doc = Doc::parse(
            r#"<ul><li><a href="/a">A</a><em>一键导入</em></li>
                <li><a href="/b">B</a><em>普通链接</em></li></ul>"#,
        );
        let hits = doc.eval("li@all@text.一键导入");
        assert_eq!(hits, vec!["一键导入"], "{hits:?}");
    }

    #[test]
    fn text_match_falls_back_to_contains() {
        let doc = Doc::parse(r#"<div><span>▶ 播放 全集</span></div>"#);
        let hits = doc.eval("span@text.播放");
        assert_eq!(hits, vec!["▶ 播放 全集"], "{hits:?}");
    }

    #[test]
    fn text_match_can_still_take_an_attribute() {
        let doc = Doc::parse(r#"<li><a href="/x">名称</a><b onclick="importApp(1)">一键导入</b></li>"#);
        let hits = doc.eval("li@text.一键导入@onclick");
        assert_eq!(hits, vec!["importApp(1)"], "{hits:?}");
    }

    #[test]
    fn an_index_selects_the_nth_match_per_container() {
        // `a.0@href` appears in 95 rules of one collection; read as CSS it is
        // invalid and silently matched nothing.
        let doc = Doc::parse(
            r#"<ul>
                 <li><h4>第一</h4><a href="/1">播放</a><a href="/1x">别的</a></li>
                 <li><h4>第二</h4><a href="/2">播放</a><a href="/2x">别的</a></li>
               </ul>"#,
        );
        let links = doc.eval("ul@li@a.0@href");
        assert_eq!(links, vec!["/1", "/2"], "{links:?}");
        let second = doc.eval("ul@li@a.1@href");
        assert_eq!(second, vec!["/1x", "/2x"], "{second:?}");
    }

    #[test]
    fn an_index_works_through_the_tag_prefix() {
        let doc = Doc::parse(r#"<div><a href="/one">1</a><a href="/two">2</a></div>"#);
        assert_eq!(doc.eval("div@tag.a.1@href"), vec!["/two"]);
        assert_eq!(doc.eval("div@tag.a.0@href"), vec!["/one"]);
    }

    /// Two levels deep, because that is the whole question: a recursive
    /// descent has to reach `list[].book.title` from the root and a plain
    /// lookup cannot.
    fn nested_json() -> Value {
        json!({
            "book": { "title": "顶层书名" },
            "list": [
                { "book": { "title": "第一本" } },
                { "book": { "title": "第二本" } }
            ]
        })
    }

    #[test]
    fn a_plain_jsonpath_reaches_a_nested_field() {
        let v = eval_json(&nested_json(), "$.list[0].book.title");
        assert_eq!(v, vec!["第一本".to_string()], "the ordinary path is the baseline");
    }

    #[test]
    fn recursive_descent_reaches_every_level() {
        // Recursive JSONPath has always worked, in its standard spelling. A
        // census counted the literal string `$$.` in 49 places across 9 sources
        // and concluded that recursion was unimplemented; reading those rules
        // showed `$$` is JavaScript — a `.map()` parameter or the host of a
        // `.match()` call inside a `<js>` block — not a path. About a dozen
        // sources really do use `$..`, mostly for `ruleContent`.
        let v = eval_json(&nested_json(), "$..title");
        assert_eq!(
            v,
            vec!["顶层书名".to_string(), "第一本".to_string(), "第二本".to_string()],
            "recursive descent must reach the top level and every nested one"
        );
    }

    #[test]
    fn a_dollar_dollar_prefix_is_not_treated_as_a_path() {
        // The rule that must survive a future change: `$$` belongs to the
        // script, not to the JSON evaluator. Translating it into `$..` would
        // "fix" 9 sources by corrupting their scripts — rewrite `.match()` into
        // nonsense and they fail *louder*, not better.
        for rule in ["$$.book.title", "$$..title", "$$.title"] {
            let v = eval_json(&nested_json(), rule);
            println!("`{rule}` -> {v:?}");
        }
        let v = eval_json(&nested_json(), "$$.book.title");
        assert!(
            v.is_empty(),
            "`$$.book.title` returned {v:?}. Before 'fixing' this, read the rules that use \
             `$$`: they are `<js>` blocks where it is a `.map()` parameter or a `.match()` \
             host, so the correct answer stays empty. The real gap in those sources is \
             Legado's DOM host objects (`java.getElements`, `java.setContent`, `java.put`), \
             which are not implemented."
        );
    }

    #[test]
    fn text_nodes_matches_text_on_this_engine() {
        // `textNodes` is Legado's "the text nodes", not "the text". Mapping it
        // onto `Step::Text` makes the two agree, which is what the 蓝奏云盘
        // rules need (`.filename@textNodes` supplies the item title). It is a
        // deliberate simplification, not an equivalence claim: an element with
        // several text nodes returns their concatenation here and a list in
        // Legado. Pinned so a later change to either path is noticed.
        let html = r#"<div class="f">文件名<span class="x">A</span>B</div><div class="f">第二本</div>"#;
        let doc = Doc::parse(html);
        let text = doc.eval(".f@text");
        let nodes = doc.eval(".f@textNodes");
        assert_eq!(text, nodes, "@text and @textNodes should agree after the mapping");
        assert_eq!(text.first().map(String::as_str), Some("文件名AB"));
    }

    #[test]
    fn a_class_ending_in_a_digit_is_still_a_class() {
        // `col2` is a real class name, not an index.
        let doc = Doc::parse(r#"<div><p class="col2">命中</p></div>"#);
        assert_eq!(doc.eval("div@class.col2@text"), vec!["命中"]);
    }

    #[test]
    fn an_out_of_range_index_yields_nothing_rather_than_everything() {
        let doc = Doc::parse(r#"<li><a href="/1">只有一条</a></li>"#);
        assert!(doc.eval("li@a.3@href").is_empty());
    }

    #[test]
    fn a_text_match_that_matches_nothing_returns_nothing() {
        let doc = Doc::parse(r#"<div><span>别的</span></div>"#);
        assert!(doc.eval("span@text.没有这个").is_empty());
    }

    #[test]
    fn nested_attribute_after_all() {
        // `@all` re-enters parsing: each item is searched for an img.
        assert_eq!(doc().eval("class.item@all@img@alt"), vec!["First", "Second", "Third"]);
    }

    #[test]
    fn link_after_all() {
        assert_eq!(
            doc().eval("class.item@all@a@href"),
            vec!["/p/1", "/p/2", "/p/3"]
        );
    }

    #[test]
    fn by_id_text() {
        assert_eq!(doc().eval("id.content@text"), vec!["Hello world"]);
    }

    #[test]
    fn outer_html_of_list_items() {
        let out = doc().eval_outer("class.item");
        assert_eq!(out.len(), 3);
        assert!(out[0].contains("First"));
    }

    #[test]
    fn inner_html_of_content() {
        assert_eq!(doc().eval("id.content@html"), vec!["<p>Hello <b>world</b></p>"]);
    }

    #[test]
    fn finds_next_link() {
        assert_eq!(doc().find_link_by_text(&["下一页"]).as_deref(), Some("/page/2"));
    }

    #[test]
    fn child_index_selects_position() {
        // The first child element of each item is the <a>.
        assert_eq!(doc().eval("class.item@child.0@a@href"), vec!["/p/1", "/p/2", "/p/3"]);
    }

    #[test]
    fn next_sibling_navigation() {
        // Each anchor holds an <img> then a <span>; `@next` walks img -> span.
        let out = doc().eval("class.item@child.0@a@img@next");
        assert_eq!(out, vec!["2024-01-01", "2024-02-02", "2024-03-03"]);
    }

    #[test]
    fn prev_sibling_navigation() {
        let out = doc().eval("class.item@child.0@a@span@prev@alt");
        assert_eq!(out, vec!["First", "Second", "Third"]);
    }

    #[test]
    fn json_path_returns_node() {
        let v: Value = serde_json::from_str(r#"{"model":{"data":[{"title":"a"},{"title":"b"}]}}"#).unwrap();
        // `$.model.data` selects the array itself.
        assert_eq!(eval_json(&v, "$.model.data").len(), 1);
        // `@all` expands it.
        assert_eq!(eval_json(&v, "$.model.data@all").len(), 2);
    }

    #[test]
    fn json_property_after_all() {
        let v: Value = serde_json::from_str(r#"{"model":{"data":[{"title":"a"},{"title":"b"}]}}"#).unwrap();
        assert_eq!(eval_json(&v, "$.model.data@all@title"), vec!["a", "b"]);
    }

    #[test]
    fn json_direct_child_keys() {
        let v: Value = serde_json::from_str(r#"{"a":{"b":{"c":"deep"}}}"#).unwrap();
        assert_eq!(eval_json(&v, "$.a.b.c"), vec!["deep"]);
    }

    #[test]
    fn media_urls_collected() {
        let d = Doc::parse(r#"<video src="/v.mp4" poster="/p.jpg"></video>"#);
        assert!(d.media_urls().contains(&"/v.mp4".to_string()));
    }
}