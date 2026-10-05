// Development harness for the bookshelf.
//
// Mounts the real ArticleList and the real ShelfPanel against a stubbed
// backend, so the star, the saved state and the panel can be exercised without
// a Tauri IPC bridge. Opened at /shelf-preview.html while `pnpm dev` runs;
// never bundled into a release.

import "./dev-tauri-stub";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArticleList } from "./components/ArticleList";
import { ShelfPanel } from "./components/ShelfPanel";
import { api, shelfId, type ArticleItem, type Category, type ShelfEntry } from "./api";
import "./styles.css";

const SOURCE_ID = "demo:novel";
const SOURCE_NAME = "演示小说源";

const CATEGORIES: Category[] = [
  { name: "全部", url: "/demo/list/all", row: 0, paged: false },
  { name: "玄幻", url: "/demo/list/xuanhuan", row: 0, paged: false },
  { name: "都市", url: "/demo/list/dushi", row: 0, paged: false },
];

function Preview() {
  const [shelf, setShelf] = useState<ShelfEntry[]>([]);
  const [panel, setPanel] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .listShelf()
      .then(setShelf)
      .catch(() => setShelf([]));
  }, []);

  useEffect(refresh, [refresh]);

  const toggle = useCallback(
    ({ category, first }: { category: string; first?: ArticleItem }) => {
      const id = shelfId(SOURCE_ID, category);
      const saved = shelf.some((e) => e.id === id);
      const done = saved
        ? api.removeShelf(id)
        : api.addShelf({
            id,
            source_id: SOURCE_ID,
            source_name: SOURCE_NAME,
            category,
            title: `${SOURCE_NAME} · ${category}`,
            url: first?.link ?? "",
            kind: first?.kind ?? "",
            added_at: 0,
          });
      done.then(refresh).catch(() => refresh());
    },
    [shelf, refresh],
  );

  return (
    <div className="app" style={{ height: "100vh", gridTemplateColumns: "1fr" }}>
      <div className="main" style={{ width: "100%" }}>
        {opened && (
          <div className="banner" onClick={() => setOpened(null)}>
            打开了：{opened}
          </div>
        )}
        {panel ? (
          <ShelfPanel
            onOpen={(e) => {
              setOpened(e.title);
              setPanel(false);
            }}
            onClose={() => setPanel(false)}
          />
        ) : (
          <>
            <div className="main-head">
              <div className="main-title">
                {SOURCE_NAME}
                <span>书架预览</span>
              </div>
              <span className="spacer" />
              <button onClick={() => setPanel(true)}>
                书架{shelf.length > 0 ? ` ${shelf.length}` : ""}
              </button>
            </div>
            <ArticleList
              sourceId={SOURCE_ID}
              sourceName={SOURCE_NAME}
              categories={CATEGORIES}
              onOpen={(item) => setOpened(item.title)}
              isOnShelf={(c) => shelf.some((e) => e.id === shelfId(SOURCE_ID, c))}
              onToggleShelf={toggle}
            />
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);