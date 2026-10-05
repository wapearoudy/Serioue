import { useEffect, useState } from "react";
import { api, errorMessage, type PeriodStats, type ReadingStats } from "../api";
import { Banner, Empty, Spinner } from "./ui";

/**
 * How much has been read: today, this week, all time.
 *
 * The numbers arrive from the backend, which derives them from `history.json`
 * and `progress.json`. Nothing here computes a statistic: a panel that did its
 * own arithmetic would eventually disagree with the store it is describing, and
 * the reader would have no way to tell which of the two was wrong.
 */
export function ReaderStatsPanel({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .readingStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="main-head">
        <button className="ghost" onClick={onClose}>
          ← 返回
        </button>
        <div className="main-title">
          阅读统计
          <span>时长按打开文章到最后一次保存阅读位置的时间推断</span>
        </div>
      </div>

      <div className="main-body stats-body">
        {error && <Banner text={error} onClose={() => setError(null)} />}

        {error ? (
          // A failed load must not leave a spinner turning forever — the reader
          // would be left staring at a panel that is never going to arrive. The
          // banner above already carries the reason.
          <Empty
            title="统计没读出来"
            hint="本地记录读取失败，关掉这个页面再打开通常就好；具体原因在上面的提示条里。"
            action={<button onClick={onClose}>返回列表</button>}
          />
        ) : stats === null ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
            <Spinner />
          </div>
        ) : !stats.has_data ? (
          // Three zeroes tell a new reader nothing. Say what would fill them in.
          <Empty
            title="还没有可统计的阅读"
            hint="读任意一篇文章再关掉它，这里就会出现今天的篇数和时间；划线和高亮不计入时长。"
          />
        ) : (
          <>
            <div className="stats-cards">
              <Card period="today" label="今日" stats={stats.today} />
              <Card period="week" label="本周" stats={stats.week} />
              <Card period="all" label="全部" stats={stats.all} />
            </div>

            {stats.by_source.length > 0 && (
              <div className="stats-sources">
                <div className="stats-subhead">按源统计 · 全部时间</div>
                {stats.by_source.map((s) => (
                  <div className="stats-src-row" key={s.source_id || s.source_name}>
                    <span className="stats-src-name">{s.source_name || "未命名源"}</span>
                    <span className="spacer" />
                    <span className="stats-src-count" data-articles={s.articles}>
                      {s.articles} 篇
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="stats-note">
              单篇最多计 30 分钟：把文章开着过夜不会被算成读了很久。
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Card({
  period,
  label,
  stats,
}: {
  period: "today" | "week" | "all";
  label: string;
  stats: PeriodStats;
}) {
  return (
    // The counts are exposed as attributes as well as text so a test can assert
    // the number itself rather than a formatted string that happens to contain it.
    <div className="stats-card" data-period={period} data-articles={stats.articles} data-minutes={stats.minutes}>
      <div className="stats-label">{label}</div>
      <div className="stats-figure">
        <span className="stats-num">{stats.articles}</span>
        <span className="stats-unit">篇</span>
      </div>
      <div className="stats-time">{formatMinutes(stats.minutes)}</div>
    </div>
  );
}

/** Minutes as something a reader can judge at a glance. */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}
