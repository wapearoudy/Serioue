//! t44: B-class source probe — ruleLink vs live container, per source.
//!
//! Read-only investigation: fetches each B-class source's real list page,
//! runs the engine's own `parse_list_detailed` on it, and prints per source:
//! ruleLink verbatim, first container (truncated, never rewritten), what the
//! link rule produced, and the verdict inputs (containers/openable/fallback).
//!
//! Offline part (`repro_*`, no network): cargo-test-ready minimal
//! reproductions. Each asserts TODAY's engine output on a tiny fixture shaped
//! like the live source, so a future fix flips them; the comment on each gives
//! the fixed expectation.
//!
//! ```text
//! cargo test --release --test t44_bclass repro_ -- --nocapture
//! SERIOUS_T44_ONLY=虎牙直播 cargo test --release --test t44_bclass -- --ignored --nocapture
//! SERIOUS_T44_ONLY=all cargo test --release --test t44_bclass -- --ignored --nocapture
//! ```

use serious_lib::engine::{browse, fetch};
use serious_lib::model::Source;
use std::fs;

/// cargo-test-ready minimal reproductions (offline, no network).
mod repro {
    use serious_lib::engine::browse::parse_list;
    use serious_lib::model::Source;

    fn src(art: &str, title: &str, link: &str) -> Source {
        Source {
            source_url: "https://example.com".into(),
            rule_articles: art.into(),
            rule_title: title.into(),
            rule_link: link.into(),
            ..Default::default()
        }
    }

    #[test]
    fn repro_huya_numeric_id_yields_no_link_today() {
        // Live shape (t33-diag-huya.log): {"profileRoom":"660000",...}.
        let s = src("$.data.datas", "$.roomName", "$.profileRoom");
        let body = r#"{"data":{"datas":[{"roomName":"iG vs LNG","profileRoom":"660000"}]}}"#;
        let (items, _) = parse_list(&s, body, "https://www.huya.com/cache.php?m=LiveList&page=1");
        assert_eq!(items.len(), 1);
        println!("huya item: title={:?} link={:?}", items[0].title, items[0].link);
        // TODAY: link == "" (looks_like_link rejects a bare "660000").
        // FIX should yield https://www.huya.com/660000 (Huya room URL pattern).
        assert!(items[0].link.is_empty(), "today the numeric id is dropped");
    }

    #[test]
    fn repro_bili_template_link_yields_no_link_today() {
        // Live shape: {"aid":"114245006003082","title":"...","bvid":"..."}.
        let s = src("$.data.list", "$.title", "https://player.bilibili.com/player.html?aid={{$.aid}}");
        let body = r#"{"data":{"list":[{"aid":"114245006003082","title":"某视频"}]}}"#;
        let (items, _) = parse_list(&s, body, "https://api.bilibili.com/x/web-interface/ranking");
        assert_eq!(items.len(), 1);
        println!("bili item: title={:?} link={:?}", items[0].title, items[0].link);
        // TODAY: link == "" (field_json never renders {{}} templates).
        // FIX should yield https://player.bilibili.com/player.html?aid=114245006003082.
        assert!(items[0].link.is_empty(), "today the template is not substituted");
    }

    #[test]
    fn repro_17k_template_link_yields_no_link_today() {
        let s = src(
            "$.data",
            "【{{$.groupName}}】{{$.title}}",
            "http://api.17k.com/sns/thread/{{$.id}}?groupId={{$.groupId}}",
        );
        let body = r#"{"data":[{"id":126624576,"groupId":2519733,"groupName":"找书圈","title":"反骨逆仙"}]}"#;
        let (items, _) = parse_list(&s, body, "http://api.17k.com/sns/group/thread?page=1");
        println!("17k items: {items:?}");
        // Live probe: title resolved to "反骨逆仙" (groupName template dropped),
        // link == "". FIX should yield title 【找书圈】反骨逆仙 and link
        // http://api.17k.com/sns/thread/126624576?groupId=2519733.
        assert!(items.iter().all(|i| i.link.is_empty()), "today no 17k link resolves");
    }

    #[test]
    fn repro_tuishujun_single_template_link_yields_no_link_today() {
        let s = src(
            "$.data.data[*]",
            "$.title",
            "https://pre-api.tuishujun.com/api/listBookInBooklist?booklist_id={{$.booklist_id}}&page=1&pageSize={{$.book_number}}",
        );
        let body = r#"{"data":{"data":[{"booklist_id":654154,"title":"准备看的书","book_number":8}]}}"#;
        let (items, _) = parse_list(&s, body, "https://pre-api.tuishujun.com/api/listBooklist");
        assert_eq!(items.len(), 1);
        println!("tsj-single item: title={:?} link={:?}", items[0].title, items[0].link);
        // FIX should yield .../listBookInBooklist?booklist_id=654154&page=1&pageSize=8.
        assert!(items[0].link.is_empty(), "today the template is not substituted");
    }

    #[test]
    fn repro_tuishujun_rank_template_link_yields_no_link_today() {
        let s = src("$.data.data[*]", "$.title", "https://baidu.com/s?wd={{$.title}}");
        let body = r#"{"data":{"data":[{"title":"夜无疆"}]}}"#;
        let (items, _) = parse_list(&s, body, "https://pre-api.tuishujun.com/api/listBookRank");
        assert_eq!(items.len(), 1);
        println!("tsj-rank item: title={:?} link={:?}", items[0].title, items[0].link);
        // FIX should yield https://baidu.com/s?wd=夜无疆 (a search link, openable).
        assert!(items[0].link.is_empty(), "today the template is not substituted");
    }

    #[test]
    fn repro_kaiyan_or_branches_only_first_counts() {
        use serious_lib::engine::selector::eval_json;
        use serde_json::json;
        // followCard shape: no .data.text, title lives at content.data.title,
        // and there is no webUrl anywhere (see live probe for key census).
        let card = json!({"type": "followCard", "data": {"header": {"title": "追寻意义"}, "content": {"type": "video", "data": {"title": "追寻意义", "id": 327370}}}});
        let link = eval_json(&card, "$.data.text||$.data.content.data.webUrl.raw||$.data.web.raw");
        let title = eval_json(&card, "$.data.text||$.data.content.data.title||$.data.title");
        println!("followCard link-branches -> {link:?}, title-branches -> {title:?}");
        // TODAY: both [] — first branch misses and no fallback is attempted,
        // even though branch 2 of the title rule would hit.
        assert!(link.is_empty());
        assert!(title.is_empty(), "branch 2 has the title but is never tried");
    }

    #[test]
    fn repro_jinjiang_js_link_yields_no_link_today() {
        // ruleLink verbatim from the source; container shaped like live element.
        // TODAY the whole rule evaluates to "" through field_json.
        let rule = "<js>\ndata_type = java.getString(\"$.data_type\");\nif(data_type==\"2\"){\n\t\"https://app-cdn.jjwxc.com/app.jjwxc/android/reading/Booklist/getDetail?listid={{$.listid}}\"\n\t}else{\n\t\t\"https://app.jjwxc.org/app.jjwxc/android/reading/BookListFindBook/subjectDetail?versionCode=357&listid={{$.listid}}\"\n\t\t}\n</js>";
        let value = serde_json::json!({"listid": "648475", "subject": "最幸福的一集", "data_type": "2"});
        // field_json binds the container as the JS page; eval_to_string alone
        // does not, so mirror the engine path: set_page + js::eval_to_string.
        serious_lib::engine::js::set_page(Some(serde_json::to_string(&value).unwrap()));
        let out = serious_lib::engine::js::eval_to_string(rule, &value);
        serious_lib::engine::js::set_page(None);
        println!("jinjiang js-link eval (page bound) -> {out:?}");
        // Sub-cause isolated earlier: java.getString("$.data_type") reads the
        // DOM page, not the JSON container, so data_type == "" even page-bound
        // against the container JSON; plus bare string literals as if-branch
        // bodies and the unrendered {{$.listid}} inside.
        assert!(out.is_empty(), "today the js link rule yields nothing");
    }

    #[test]
    fn repro_jinjiang_title_hash_op_yields_no_title_today() {
        // ruleTitle verbatim: "$.subject##</*.*?>".
        let s = src("$.data.data[*]", "$.subject##</*.*?>", "$.listid");
        let body = r#"{"data":{"data":[{"listid":"648475","subject":"最幸福的一集"}]}}"#;
        let (items, _) = parse_list(&s, body, "https://app.jjwxc.org/");
        println!("jinjiang title-hash items: {items:?}");
        // TODAY title == "" (the ## strip operator is content-template-only).
        assert!(items.iter().all(|i| i.title.is_empty()));
    }

    #[test]
    fn repro_bizhi_articles_js_shape() {
        // ruleArticles head verbatim: a "||" selector line followed by an
        // @js: script that needs baseUrl/source globals. The engine treats the
        // whole string as a script and it throws outside a full list context.
        let rule = "$.res.category||$.res.album||$.res.keyword[0].items\n@js:\njson=[]\nc1=baseUrl.match(/skip=/)\nresult=json";
        let body = serde_json::json!({"res": {"category": [{"name": "美女"}]}});
        let out = serious_lib::engine::js::eval_to_json(rule, &body);
        println!("bizhi articles-js eval -> {out:?}");
        // Live parse_list_detailed on the real endpoint: containers=0, items=0
        // (shape printed by the live probe). The rule's own fallback chain
        // ($.res.category first branch) DOES match the live JSON — the engine
        // never tries it because the trailing script poisons the whole rule.
    }
}

#[test]
#[ignore]
fn probe_template_semantics_offline() {
    use serious_lib::engine::template::render_template;
    use serde_json::json;
    // The template engine itself substitutes {{$.x}} correctly — the gap is
    // that the LIST FIELD path (field_json) never calls it.
    let item = json!({"aid": "114245006003082", "title": "某视频", "id": 126624576, "groupId": 2519733, "booklist_id": 654154, "book_number": 8});
    for rule in [
        "https://player.bilibili.com/player.html?aid={{$.aid}}",
        "https://baidu.com/s?wd={{$.title}}",
        "http://api.17k.com/sns/thread/{{$.id}}?groupId={{$.groupId}}",
        "https://pre-api.tuishujun.com/api/listBookInBooklist?booklist_id={{$.booklist_id}}&page=1&pageSize={{$.book_number}}",
        "$.profileRoom",
        "$.data.text||$.data.content.data.webUrl.raw||$.data.web.raw",
    ] {
        println!("rule {rule:?} -> rendered {:?}", render_template(rule, &item));
    }
}

#[test]
#[ignore]
fn probe_or_branch_semantics_offline() {
    use serious_lib::engine::selector::eval_json;
    use serde_json::json;
    let item = json!({"data": {"text": "近期热门", "content": {"data": {"title": "某视频", "webUrl": {"raw": "https://api.com/v"}}}, "web": {"raw": "https://web.raw/x"}}});
    for rule in [
        "$.data.text",
        "$.data.content.data.title",
        "$.data.content.data.webUrl.raw",
        "$.data.text||$.data.content.data.webUrl.raw||$.data.web.raw",
        "$.res.category",
        "$.data.list||$.data",
    ] {
        println!("eval_json {rule:?} -> {:?}", eval_json(&item, rule));
    }
    let v = json!({"data": {"list": [1, 2]}});
    println!("eval_json list||data on {{\"data\":{{\"list\":..}}}} -> {:?}", eval_json(&v, "$.data.list||$.data"));
    let text_card = json!({"type": "textCard", "data": {"dataType": "TextCard", "text": "近期热门"}});
    println!("textCard full-link-rule -> {:?}", eval_json(&text_card, "$.data.text||$.data.content.data.webUrl.raw||$.data.web.raw"));
    println!("textCard $.data.text -> {:?}", eval_json(&text_card, "$.data.text"));
    let follow = json!({"type": "followCard", "data": {"header": {"title": "追寻意义"}, "content": {"type": "video", "data": {"title": "追寻意义", "id": 327370}}}});
    println!("followCard link-rule -> {:?}", eval_json(&follow, "$.data.text||$.data.content.data.webUrl.raw||$.data.web.raw"));
    println!("followCard title-rule -> {:?}", eval_json(&follow, "$.data.text||$.data.content.data.title||$.data.title"));
}

fn collection() -> Vec<Source> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-results")
        .join("collection-160.json");
    let text = fs::read_to_string(&path).expect("collection cache");
    Source::parse_collection(&text).expect("parse collection")
}

fn pick<'a>(all: &'a [Source], name: &str, url_part: &str) -> &'a Source {
    all.iter()
        .filter(|s| s.display_name() == name)
        .find(|s| s.source_url.contains(url_part))
        .unwrap_or_else(|| panic!("no source {name} with url containing {url_part}"))
}

fn targets(all: &[Source]) -> Vec<&Source> {
    vec![
        pick(all, "虎牙直播", "huya.com"),
        pick(all, "哔哩分区", "rid=168"),
        pick(all, "哔哩哔哩", "api.bilibili.com"),
        pick(all, "十七找书", "17k.com"),
        pick(all, "推书君单", "tuishujun"),
        pick(all, "推书君子", "tuishujun"),
        pick(all, "晋江书单", "jjwxc"),
        pick(all, "壁纸小喵", "lightwp/category"),
        pick(all, "开眼视频", "kaiyanapp"),
    ]
}

fn first_category_url(src: &Source) -> String {
    let cats = browse::categories(src);
    let probe = cats.first().map(|c| c.url.clone()).unwrap_or_else(|| src.source_url.clone());
    let probe = browse::expand(&probe, 1);
    serious_lib::util::absolute_url(probe.trim(), &src.source_url)
}

fn short(s: &str, n: usize) -> String {
    let c: Vec<char> = s.chars().collect();
    if c.len() <= n {
        s.to_string()
    } else {
        c[..n].iter().collect()
    }
}

#[test]
#[ignore]
fn probe_b_class() {
    let only = std::env::var("SERIOUS_T44_ONLY").unwrap_or_else(|_| "all".into());
    let all = collection();
    let list = targets(&all);
    for src in list {
        let name = src.display_name().to_string();
        if only != "all" && name != only {
            continue;
        }
        println!("\n===== {name} =====");
        println!("sourceUrl : {}", src.source_url);
        println!("ruleArt   : {:?}", short(&src.rule_articles, 200));
        println!("ruleTitle : {:?}", short(&src.rule_title, 200));
        println!("ruleLink  : {:?}", short(&src.rule_link, 400));
        println!("enableJs  : {}", src.enable_js);

        let probe = first_category_url(src);
        println!("probe url : {probe}");
        let resp = match fetch::fetch_ok(Some(src), &probe) {
            Ok(r) => r,
            Err(e) => {
                println!("FETCH FAILED: {e}");
                continue;
            }
        };
        println!("status {} · {} · {} bytes", resp.status, resp.content_type, resp.body.len());
        let (items, next, shape) = browse::parse_list_detailed(src, &resp.body, &resp.url);
        println!(
            "shape: containers={} openable={} fallback={}",
            shape.containers, shape.openable, shape.fallback_links
        );
        println!("items: {} next: {:?}", items.len(), next);
        let with_link = items.iter().filter(|i| !i.link.is_empty()).count();
        println!("with_link: {with_link}");
        for (i, it) in items.iter().take(3).enumerate() {
            println!(
                "  item{i}: title={:?} link={:?}",
                short(&it.title, 60),
                short(&it.link, 120)
            );
        }
        let body = resp.body.clone();
        let trimmed = body.trim_start();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let sel = src.rule_articles.trim();
                if !sel.is_empty() && !sel.contains("java.") && !sel.starts_with("<js") && !sel.starts_with("@js:") {
                    match jsonpath_lib::select(&v, sel) {
                        Ok(nodes) => {
                            println!("containers matched by rule: {}", nodes.len());
                            if let Some(first) = nodes.first() {
                                let s = serde_json::to_string(first).unwrap_or_default();
                                println!("container#0 (truncated 1200): {}", short(&s, 1200));
                                for branch in src.rule_link.split("||") {
                                    let b = branch.trim();
                                    if b.is_empty() || b.contains("{{") || b.starts_with("<js") || b.starts_with("@js:") || b.contains("java.") {
                                        println!("  link-branch {b:?} -> (template/js branch, see template probe below)");
                                        continue;
                                    }
                                    match jsonpath_lib::select(first, b) {
                                        Ok(vv) => println!(
                                            "  link-branch {b:?} -> {} hit(s), first={:?}",
                                            vv.len(),
                                            vv.first().map(|x| short(&x.to_string(), 120))
                                        ),
                                        Err(e) => println!("  link-branch {b:?} -> JSONPath error: {e}"),
                                    }
                                }
                                let rendered = serious_lib::engine::template::render_template(&src.rule_link, first);
                                println!("  template-rendered ruleLink (truncated 300): {:?}", short(&rendered, 300));
                                println!("  rendered==ruleLink verbatim (no substitution)? {}", rendered == src.rule_link);
                            }
                        }
                        Err(e) => println!("ruleArticles JSONPath error: {e}"),
                    }
                } else {
                    println!("ruleArticles is a JS/hybrid rule; container mirror skipped");
                }
            }
        } else {
            println!("non-JSON body; container mirror skipped");
        }
    }
}
