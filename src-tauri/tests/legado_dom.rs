//! The 蓝奏云盘 family of rules, exercised through the DOM host objects.
//!
//! Four sources (`阅读难受1`, `影视难受3`, `软件难受4`, `未测难受6`, plus
//! `书源难受2`) drive Legado's DOM API from a `<js>` block. Before the host
//! objects existed, `java.getElements` was not a function at all, so the first
//! call in each of those rules threw and the source yielded nothing.
//!
//! The script below is **copied from the rule itself** — collection 107,
//! `阅读难受1`, the 蓝奏云盘分组链接 branch — rather than written to fit a test.
//! If the engine changes shape around it, this test breaks; that is the point.
//!
//! ```text
//! cargo test --release --test legado_dom
//! ```

use serde_json::json;
use serious_lib::engine::js;

/// Verbatim from the rule, with only the `else {` wrapper of the surrounding
/// if/else chain removed — the body is untouched.
const REAL_RULE_FRAGMENT: &str = r#"
    json = [];
    name = java.getString('.user-radio@text||title@text')
    java.getElements('#folder .mlink').forEach(a => {java.setContent(a);
      json.push({
      	    name_all: java.getString('.filename@textNodes'),
          url: java.getString('a@href'),
          time: 'folder ' + (String(java.getString('.filesize@text')) || name) })
    });
    result = JSON.stringify(json);
"#;

/// A page shaped like the folder listing the rule walks. The site itself is not
/// reachable from the machine this test runs on (its TLS fails), so the markup
/// is a stand-in; the *script* is the real one.
const FOLDER_PAGE: &str = r#"
  <div class="user-radio" title="全部">全部</div>
  <div id="folder">
    <div class="mlink">
      <a href="https://lanzoux.com/a1"><span class="filename">第一本书 v1.zip</span><span class="filesize">12.3 MB</span></a>
    </div>
    <div class="mlink">
      <a href="https://lanzoux.com/a2"><span class="filename">第二本书 v2.zip</span><span class="filesize">88.1 MB</span></a>
    </div>
    <div class="mlink">
      <a href="https://lanzoux.com/a3"><span class="filename">第三本书.zip</span></a>
    </div>
  </div>
"#;

#[test]
fn the_dom_methods_the_rules_call_now_exist() {
    js::set_page(Some(FOLDER_PAGE.to_string()));
    for name in ["getElements", "setContent", "put", "getString"] {
        let kind = js::eval_to_string(&format!("typeof java.{name}"), &json!({}));
        println!("java.{name:<12} -> {kind}");
        assert_eq!(kind, "function", "java.{name} is still missing");
    }
    js::set_page(None);
}

#[test]
fn the_real_rule_produces_items() {
    js::set_page(Some(FOLDER_PAGE.to_string()));
    let out = js::eval_to_string(REAL_RULE_FRAGMENT, &json!({}));
    js::set_page(None);

    println!("rule output: {out}");
    let items: serde_json::Value = serde_json::from_str(&out).expect("the rule should emit JSON");
    let items = items.as_array().expect("an array of items");

    println!("\n  {} item(s):", items.len());
    for item in items {
        println!(
            "    name_all={:?}  url={:?}  time={:?}",
            item["name_all"].as_str().unwrap_or(""),
            item["url"].as_str().unwrap_or(""),
            item["time"].as_str().unwrap_or(""),
        );
    }

    assert_eq!(items.len(), 3, "every folder entry should become an item");
    assert_eq!(items[0]["name_all"], "第一本书 v1.zip");
    assert_eq!(items[0]["url"], "https://lanzoux.com/a1");
    assert_eq!(items[1]["url"], "https://lanzoux.com/a2");
    // The third entry has no size, which is the case the rule's `|| name`
    // fallback exists for.
    assert!(
        items[2]["time"].as_str().unwrap_or("").contains("folder"),
        "the size fallback should still produce a time: {}",
        items[2]["time"],
    );
}

#[test]
fn reports_which_extraction_shapes_the_engine_understands() {
    // Not an assertion of success: a census of which selectors in these rules
    // the engine can actually evaluate, so the remaining gap is written down
    // rather than assumed away.
    js::set_page(Some(FOLDER_PAGE.to_string()));
    for rule in [
        ".user-radio@text||title@text",
        ".user-radio@text",
        ".filename@textNodes",
        ".filename@text",
        ".filesize@text",
        "a@href",
    ] {
        let value = js::eval_to_string(&format!("result = java.getString({:?});", rule), &json!({}));
        println!("{rule:<32} -> {:?}", value.trim());
    }
    js::set_page(None);
}

/// `java.timeFormat` — the one missing method that keeps a rule from running at all.
///
/// Both shapes found in real collections call it with a millisecond timestamp and
/// **no format at all**, so the default is not an edge case here, it is the
/// common case:
///
/// ```text
/// java.timeFormat(bk.create_time * 1000)      多看阅读
/// java.timeFormat(comments[i].createTime)     葫芦侠
/// ```
///
/// Those two rules' endpoints answer 200 with real data, so this method is the
/// whole difference between a working source and an empty list.
///
/// The reference is Java's `SimpleDateFormat(format)` with no `TimeZone`
/// argument, which means `TimeZone.getDefault()` — the device's own timezone.
/// That is a platform rule, not something Legado invented; we have not read
/// Legado's source and this comment says so rather than implying otherwise. The
/// corroboration is practical: a UTC implementation would hand every reader in
/// UTC+8 yesterday's date between local midnight and 8am, which is the kind of
/// bug everyone notices rather than nobody mentions.
#[test]
fn time_format_defaults_to_a_date_and_honours_java_patterns() {
    // A fixed instant rather than "now", so the expected values can be written
    // out.
    let instant = 1_709_613_223_456i64;

    let no_format = js::eval_to_string(
        &format!("result = java.timeFormat({instant});"),
        &json!({}),
    );
    assert_eq!(
        no_format.trim(),
        js::eval_to_string(
            &format!("result = java.timeFormat({instant}, 'yyyy-MM-dd');"),
            &json!({})
        )
        .trim(),
        "the one-argument form must agree with the same format spelled out",
    );

    // Read the calendar fields back out of the engine rather than hard-coding a
    // date string: the timezone decision is what is being pinned down, and a
    // literal would hide whether it is local or UTC. Padded the same way, since
    // an unpadded `2024-3-5` would turn this into an assertion about formatting
    // rather than about the timezone — and would have failed for the right
    // reason at the wrong value.
    let local = js::eval_to_string(
        &format!(
            "var d = new Date({instant}); \
             var p = function (v) {{ return v < 10 ? '0' + v : String(v); }}; \
             result = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());"
        ),
        &json!({}),
    );
    assert_eq!(
        no_format.trim(),
        local.trim(),
        "timeFormat must render in the device's own timezone, like SimpleDateFormat's default"
    );

    // `MM` is the month and `mm` is the minute. Swapping them is the classic
    // way to get a date that looks almost right.
    let month = js::eval_to_string(
        &format!("result = java.timeFormat({instant}, 'MM');"),
        &json!({}),
    );
    let minute = js::eval_to_string(
        &format!("result = java.timeFormat({instant}, 'mm');"),
        &json!({}),
    );
    assert_eq!(month.len(), 2, "MM must be zero-padded to two digits");
    assert_ne!(month, minute, "MM and mm cannot be the same field");

    let full = js::eval_to_string(
        &format!("result = java.timeFormat({instant}, 'yyyy-MM-dd HH:mm:ss');"),
        &json!({}),
    );
    // Checked as a shape rather than by indexing into the string: `yyyy-MM-dd
    // HH:mm:ss` puts its first separator at index 4, and a magic index is
    // exactly how this assertion ended up comparing a month digit against a
    // hyphen.
    assert!(
        full.trim().len() == 19
            && full.trim().chars().all(|c| c.is_ascii_digit() || "-: ".contains(c))
            && &full.trim()[4..5] == "-"
            && &full.trim()[7..8] == "-"
            && &full.trim()[10..11] == " "
            && &full.trim()[13..14] == ":"
            && &full.trim()[16..17] == ":",
        "yyyy-MM-dd HH:mm:ss should be digits and the separators in the right places, got {full:?}"
    );
}

/// Inputs that must not take the whole source down with them.
///
/// A rule that throws here produces an empty list and nothing on screen to
/// suggest why. Returning an empty string keeps the rest of the rule running,
/// which is the lesser evil — and it is a deliberate departure from Java, where
/// `SimpleDateFormat` throws `IllegalArgumentException`, so it is recorded as
/// one rather than left to be discovered.
#[test]
fn time_format_degrades_instead_of_throwing() {
    for (expr, why) in [
        ("java.timeFormat(null)", "null timestamp"),
        ("java.timeFormat('not a number')", "non-numeric timestamp"),
        ("java.timeFormat()", "no arguments at all"),
        ("java.timeFormat(1709613223456, '')", "empty format"),
        ("java.timeFormat(undefined, 'yyyy')", "undefined timestamp"),
    ] {
        let out = js::eval_to_string(&format!("result = {expr};"), &json!({}));
        assert!(
            out.trim().is_empty(),
            "{why} should render as an empty string, got {out:?}"
        );
    }
}