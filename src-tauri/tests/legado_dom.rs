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