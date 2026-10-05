//! How much the reader has read: today, this week, and all time.
//!
//! Nothing here talks to the network or reads a file. Every number comes from
//! two things the app already writes on its own: `history.json` (which articles
//! were opened, and when) and `progress.json` (where in an article the reader
//! had got, and when that was last saved).
//!
//! The module is deliberately pure — `compute` takes the records and a
//! reference timestamp — so the arithmetic can be tested exactly, at a chosen
//! date, without a store, a window or a clock.

use crate::store::{HistoryEntry, Progress};
use chrono::{Datelike, Duration, Local, NaiveDate, TimeZone};
use serde::Serialize;
use std::collections::HashMap;

/// The longest any single article may claim, in seconds.
///
/// Progress is saved when the reader leaves an article (and on a scroll-save
/// interval), so the gap between "opened" and "last saved" is an *upper* bound
/// on the time actually spent, not a measurement of it. Left alone, a reader who
/// falls asleep with an article open would be credited with eight hours of
/// reading the next morning — and a stat that lies once is worse than no stat at
/// all, because the user has no way to tell it apart from a true number.
///
/// Thirty minutes is the ceiling for one article: long enough that a genuine
/// sitting is never cut short, short enough that an overnight gap cannot
/// dominate the total. This is the same order as a deliberate session, and it is
/// applied per article so a long session split across several articles is still
/// counted in full.
pub const MAX_ARTICLE_SECS: i64 = 30 * 60;

/// One period's totals: how many articles, and how long.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct PeriodStats {
    pub articles: usize,
    pub minutes: u64,
}

/// Articles read from one source, all time.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SourceCount {
    pub source_id: String,
    pub source_name: String,
    pub articles: usize,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ReadingStats {
    pub today: PeriodStats,
    pub week: PeriodStats,
    pub all: PeriodStats,
    /// Busiest sources first, so the list is useful at the top.
    pub by_source: Vec<SourceCount>,
    /// False when there is nothing at all, so the UI can say so instead of
    /// printing three zeroes.
    pub has_data: bool,
}

/// The local calendar day a timestamp falls on.
///
/// Local, not UTC: "read 20 articles today" has to mean the reader's today. A
/// timestamp in a daylight-saving gap has no local instant, so the first valid
/// one after the gap is used rather than dropping the record.
pub fn local_date(secs: i64) -> NaiveDate {
    Local
        .timestamp_opt(secs, 0)
        .single()
        .or_else(|| Local.timestamp_opt(secs, 0).earliest())
        .map(|dt| dt.date_naive())
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch is a valid date"))
}

/// Monday of the week containing `day`.
fn week_start(day: NaiveDate) -> NaiveDate {
    day - Duration::days(day.weekday().num_days_from_monday() as i64)
}

/// Split `secs` of reading starting at `start` across the days it touches.
///
/// A session that runs past midnight must not land entirely on the day it
/// started: 23:50-00:10 is ten minutes on each side, and the day that did not
/// own those minutes should not be given them. Because the window is capped at
/// [`MAX_ARTICLE_SECS`] this walks at most two days.
fn split_across_days(start: i64, secs: i64) -> Vec<(NaiveDate, i64)> {
    let mut out: Vec<(NaiveDate, i64)> = Vec::new();
    let mut remaining = secs;
    let mut cursor = start;
    let mut day = local_date(start);

    while remaining > 0 {
        // Where this local day ends, as a timestamp. `None` means a clock change
        // makes that midnight unobservable, in which case the rest of the
        // window stays on this day rather than looping.
        let midnight = day
            .succ_opt()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .and_then(|naive| Local.from_local_datetime(&naive).earliest())
            .map(|dt| dt.timestamp());

        let take = match midnight {
            Some(m) if m > cursor => (m - cursor).min(remaining),
            _ => remaining,
        };
        if take <= 0 {
            break;
        }
        match out.last_mut() {
            Some((d, acc)) if *d == day => *acc += take,
            _ => out.push((day, take)),
        }
        remaining -= take;
        cursor += take;
        day = day.succ_opt().unwrap_or(day);
    }
    out
}

/// Compute the statistics from stored records.
///
/// `now` is passed in rather than read from the clock so the tests can place
/// "today" exactly where they mean it.
pub fn compute(
    history: &[HistoryEntry],
    progress: &HashMap<String, Progress>,
    now: i64,
) -> ReadingStats {
    let today = local_date(now);
    let monday = week_start(today);

    let mut seconds_by_day: HashMap<NaiveDate, i64> = HashMap::new();
    let mut articles_by_day: HashMap<NaiveDate, usize> = HashMap::new();
    let mut by_source: HashMap<String, SourceCount> = HashMap::new();
    let mut total_secs: i64 = 0;

    for entry in history {
        let day = local_date(entry.viewed_at);
        *articles_by_day.entry(day).or_default() += 1;

        // Group by source id, falling back to the name for records written
        // before an id was stored; an unnamed bucket would read as "unknown".
        let key = if entry.source_id.is_empty() {
            entry.source_name.clone()
        } else {
            entry.source_id.clone()
        };
        let bucket = by_source.entry(key).or_insert_with(|| SourceCount {
            source_id: entry.source_id.clone(),
            source_name: entry.source_name.clone(),
            articles: 0,
        });
        bucket.articles += 1;
        if bucket.source_name.is_empty() {
            bucket.source_name = entry.source_name.clone();
        }

        // Reading time can only be inferred where a position was saved; an
        // article in history with no progress record still counts as opened.
        let Some(p) = progress.get(&entry.url) else { continue };
        // The window is the gap between the two records for this article. If
        // they were saved out of order (a stale clock, a restored file) the
        // earlier one still marks when reading began.
        let start = entry.viewed_at.min(p.updated_at);
        let end = entry.viewed_at.max(p.updated_at);
        if end <= start {
            continue;
        }
        let capped = (end - start).min(MAX_ARTICLE_SECS);
        for (day, secs) in split_across_days(start, capped) {
            *seconds_by_day.entry(day).or_default() += secs;
            total_secs += secs;
        }
    }

    // This week runs Monday to today. Days after today cannot happen, but the
    // bound is written out rather than assumed.
    let week_secs: i64 = seconds_by_day
        .iter()
        .filter(|(d, _)| **d >= monday && **d <= today)
        .map(|(_, s)| *s)
        .sum::<i64>()
        .max(0);
    let week_articles: usize = articles_by_day
        .iter()
        .filter(|(d, _)| **d >= monday && **d <= today)
        .map(|(_, n)| n)
        .sum();

    let week = PeriodStats { articles: week_articles, minutes: (week_secs / 60) as u64 };

    let mut sources: Vec<SourceCount> = by_source.into_values().collect();
    // Busiest first; the source name keeps equal counts in a stable order.
    sources.sort_by(|a, b| {
        b.articles
            .cmp(&a.articles)
            .then_with(|| a.source_name.cmp(&b.source_name))
    });

    ReadingStats {
        today: PeriodStats {
            articles: articles_by_day.get(&today).copied().unwrap_or(0),
            minutes: (seconds_by_day.get(&today).copied().unwrap_or(0).max(0) / 60) as u64,
        },
        week,
        all: PeriodStats { articles: history.len(), minutes: (total_secs.max(0) / 60) as u64 },
        by_source: sources,
        has_data: !history.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(url: &str, at: i64) -> HistoryEntry {
        HistoryEntry {
            id: String::new(),
            source_id: "s1".into(),
            title: format!("文章 {url}"),
            url: url.into(),
            source_name: "演示源".into(),
            viewed_at: at,
        }
    }

    fn position(updated_at: i64) -> Progress {
        Progress { ratio: 0.5, updated_at }
    }

    /// A wall-clock time `offset_days` away from the day `secs` falls on.
    ///
    /// Going through the local date rather than subtracting 86 400 keeps the
    /// hour of the day stable, which is what these tests need when the machine
    /// is on a daylight-saving boundary.
    fn on_day(secs: i64, offset_days: i64, hour: u32, minute: u32) -> i64 {
        let day = local_date(secs) + Duration::days(offset_days);
        Local
            .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .unwrap()
            .timestamp()
            + hour as i64 * 3600
            + minute as i64 * 60
    }

    fn at(secs: i64, hour: u32, minute: u32) -> i64 {
        on_day(secs, 0, hour, minute)
    }

    // The tests below use the machine's local zone rather than a fixed one, so
    // they hold wherever the app is run: "today" means the reader's today.

    #[test]
    fn nothing_read_yet_reports_no_data_rather_than_zeroes() {
        let stats = compute(&[], &HashMap::new(), 1_700_000_000);
        assert!(!stats.has_data, "an empty history must not look like a record");
        assert_eq!(stats.today, PeriodStats { articles: 0, minutes: 0 });
        assert!(stats.by_source.is_empty());
    }

    #[test]
    fn several_articles_read_today_add_up_into_one_day() {
        // Three articles opened today, with reading windows of 10, 20 and 15
        // minutes. They are separate records and must sum, not overwrite.
        let now = 1_700_000_000;
        let history = vec![
            view("https://x.com/1", at(now, 9, 0)),
            view("https://x.com/2", at(now, 11, 0)),
            view("https://x.com/3", at(now, 14, 30)),
        ];
        let progress: HashMap<String, Progress> = history
            .iter()
            .zip([600i64, 1200, 900])
            .map(|(h, secs)| (h.url.clone(), position(h.viewed_at + secs)))
            .collect();

        let s = compute(&history, &progress, now);
        assert_eq!(s.today.articles, 3, "today's article count is wrong");
        assert_eq!(s.today.minutes, 45, "today's minutes are wrong: {:?}", s.today);
        assert_eq!(s.week, s.today, "with no other days, this week is today");
        assert_eq!(s.all, s.today, "with no other days, all time is today");
    }

    #[test]
    fn a_day_with_no_reading_is_not_counted_into_today() {
        let now = 1_700_000_000;
        // Read yesterday, with progress saved yesterday too. Yesterday is always
        // in the same ISO week as today except on a Monday, so the week
        // assertions below pin the reference day first.
        let now = if week_start(local_date(now)) == local_date(now) {
            // Today is a Monday: yesterday belongs to the previous week, so
            // step back a week to keep "this week" meaningful.
            now - 7 * 86_400
        } else {
            now
        };
        let history = vec![view("https://x.com/1", on_day(now, -1, 20, 0))];
        let progress: HashMap<String, Progress> =
            [("https://x.com/1".to_string(), position(on_day(now, -1, 20, 20)))]
                .into_iter()
                .collect();

        let s = compute(&history, &progress, now);
        assert_eq!(s.today.articles, 0, "yesterday's article leaked into today");
        assert_eq!(s.today.minutes, 0);
        assert_eq!(s.week.articles, 1, "yesterday is still this week");
        assert_eq!(s.week.minutes, 20);
        assert_eq!(s.all.minutes, 20);
    }

    #[test]
    fn a_session_that_crosses_midnight_is_split_between_two_days() {
        // 23:50 to 00:10 is ten minutes either side of midnight. Counting the
        // whole window on the day it started would put twenty minutes on a day
        // the reader only spent ten of.
        let start = at(1_700_000_000, 23, 50);
        let split = split_across_days(start, 20 * 60);
        assert_eq!(
            split,
            vec![(local_date(start), 10 * 60), (local_date(start) + Duration::days(1), 10 * 60)],
            "the window was not split at midnight: {split:?}"
        );

        // And through the full calculation: the day the session ended carries
        // only its own share, while the total keeps all twenty minutes.
        let history = vec![view("https://x.com/1", start)];
        let progress: HashMap<String, Progress> =
            [("https://x.com/1".to_string(), position(start + 20 * 60))].into_iter().collect();
        let s = compute(&history, &progress, start + 20 * 60);
        assert_eq!(s.today.minutes, 10, "the day after midnight was given the whole session");
        assert_eq!(s.all.minutes, 20, "the total lost the minutes before midnight");
    }

    #[test]
    fn a_session_that_crosses_the_week_boundary_lands_only_in_the_new_week() {
        // Sunday 23:50 into Monday 00:10. The week boundary is handled by the
        // same split as the day boundary, so only the ten minutes after
        // midnight belong to this week.
        let now = 1_700_000_000;
        let monday = week_start(local_date(now));
        // Only meaningful if `now` is after that Monday; shift a week back when
        // it is not, so the Sunday under test is definitely last week's.
        let now = if monday >= local_date(now) { now - 7 * 86_400 } else { now };
        // The Sunday immediately before this week's Monday.
        let sunday_start = {
            let sunday = monday - Duration::days(1);
            Local
                .from_local_datetime(&sunday.and_hms_opt(0, 0, 0).unwrap())
                .earliest()
                .unwrap()
                .timestamp()
        };
        let start = sunday_start + 23 * 3600 + 50 * 60;
        let history = vec![view("https://x.com/1", start)];
        let progress: HashMap<String, Progress> =
            [("https://x.com/1".to_string(), position(start + 20 * 60))].into_iter().collect();

        let s = compute(&history, &progress, now);
        assert_eq!(s.today.articles, 0, "nothing was opened on the Monday itself");
        assert_eq!(s.week.articles, 0, "Sunday evening belongs to last week");
        assert_eq!(s.week.minutes, 10, "only the post-midnight minutes are this week's");
        assert_eq!(s.all.minutes, 20, "the whole session is still counted overall");
    }

    #[test]
    fn a_single_article_is_capped_at_thirty_minutes() {
        // Three hours on one article in one sitting: one article, and the
        // minutes capped at the ceiling rather than the raw gap.
        let now = 1_700_000_000;
        let opened = at(now, 14, 0);
        let closed = opened + 3 * 3600;
        let history = vec![view("https://x.com/1", opened)];
        let progress: HashMap<String, Progress> =
            [("https://x.com/1".to_string(), position(closed))].into_iter().collect();

        let s = compute(&history, &progress, closed);
        assert_eq!(s.today.articles, 1, "the article itself is still counted");
        assert_eq!(s.today.minutes, 30, "three hours was credited as reading: {s:?}");
        assert_eq!(s.all.minutes, 30);
    }

    #[test]
    fn an_article_left_open_overnight_is_not_credited_with_the_night() {
        // The case the cap exists for. Opened at 22:00, last saved at 06:00:
        // eight hours of wall clock, and the morning of the next day must not
        // be handed the reading time either.
        let now = 1_700_000_000;
        let opened = at(now, 22, 0);
        let closed = opened + 8 * 3600;
        let history = vec![view("https://x.com/1", opened)];
        let progress: HashMap<String, Progress> =
            [("https://x.com/1".to_string(), position(closed))].into_iter().collect();

        let s = compute(&history, &progress, closed);
        assert_eq!(s.today.articles, 0, "nothing was opened on the second day");
        assert_eq!(s.today.minutes, 0, "the night was credited to the morning");
        assert_eq!(s.all.articles, 1);
        assert_eq!(s.all.minutes, 30);
    }

    #[test]
    fn the_cap_is_applied_per_article_not_to_the_day() {
        // Four articles in one evening: each is under the cap, so the evening
        // adds up to more than thirty minutes.
        let now = 1_700_000_000;
        let history: Vec<HistoryEntry> = (0..4)
            .map(|i| view(&format!("https://x.com/{i}"), at(now, 19, i * 20)))
            .collect();
        let progress: HashMap<String, Progress> = history
            .iter()
            .map(|h| (h.url.clone(), position(h.viewed_at + 25 * 60)))
            .collect();

        let s = compute(&history, &progress, now);
        assert_eq!(s.today.minutes, 100, "the cap must not swallow a whole evening");
    }

    #[test]
    fn an_article_with_no_saved_position_counts_as_opened_but_not_read() {
        let now = 1_700_000_000;
        let history = vec![view("https://x.com/1", at(now, 9, 0))];
        let s = compute(&history, &HashMap::new(), now);
        assert_eq!(s.today.articles, 1);
        assert_eq!(s.today.minutes, 0, "there is no evidence of any reading time");
    }

    #[test]
    fn articles_are_grouped_by_source_busiest_first() {
        let now = 1_700_000_000;
        let mut history = Vec::new();
        for i in 0..3 {
            let mut h = view(&format!("https://a.com/{i}"), at(now, 9, i as u32));
            h.source_id = "a".into();
            h.source_name = "源 A".into();
            history.push(h);
        }
        let mut h = view("https://b.com/1", at(now, 10, 0));
        h.source_id = "b".into();
        h.source_name = "源 B".into();
        history.push(h);

        let s = compute(&history, &HashMap::new(), now);
        assert_eq!(s.by_source.len(), 2);
        assert_eq!(s.by_source[0].source_name, "源 A");
        assert_eq!(s.by_source[0].articles, 3);
        assert_eq!(s.by_source[1].source_name, "源 B");
        assert_eq!(s.by_source[1].articles, 1);
        assert_eq!(s.today.articles, 4, "grouping must not lose articles");
    }

    #[test]
    fn the_same_article_opened_twice_is_still_one_article() {
        // The store keeps one history row per URL, so the count is the number of
        // distinct URLs rather than the number of visits. Asserted here because
        // the arithmetic is what makes that true.
        let now = 1_700_000_000;
        let history = vec![
            view("https://x.com/1", at(now, 9, 0)),
            view("https://x.com/2", at(now, 9, 30)),
        ];
        let progress: HashMap<String, Progress> = history
            .iter()
            .map(|h| (h.url.clone(), position(h.viewed_at + 10 * 60)))
            .collect();
        let s = compute(&history, &progress, now);
        assert_eq!(s.today.articles, history.len());
        assert_eq!(s.today.minutes, 20);
    }
}
