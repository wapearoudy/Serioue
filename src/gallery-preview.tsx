// Development harness for the image gallery.
//
// Renders the real `Gallery` so paging, zoom, keyboard access and the failed-image
// placeholder can be exercised in a browser. Opened at /gallery-preview.html
// while `pnpm dev` is running. Never bundled into a release.
//
// `?images=` takes a comma-separated list of image URLs, which lets a browser
// test serve its own pictures (and a URL that 404s) without any fixture having to
// be committed. Without it the page uses inline SVGs, so it works offline with no
// setup at all.

import "./dev-tauri-stub";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gallery } from "./components/media";
import "./styles.css";

/** Inline pictures: they load instantly, need no network, and are obviously
 *  different from one another, which makes paging visible at a glance. */
const DEFAULT_IMAGES = [
  "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#1f4e79"/><text x="300" y="210" font-size="48" fill="#fff" text-anchor="middle">1</text></svg>`,
    ),
  "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#7d3c98"/><text x="300" y="210" font-size="48" fill="#fff" text-anchor="middle">2</text></svg>`,
    ),
  "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#1e8449"/><text x="300" y="210" font-size="48" fill="#fff" text-anchor="middle">3</text></svg>`,
    ),
  "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#b9770e"/><text x="300" y="210" font-size="48" fill="#fff" text-anchor="middle">4</text></svg>`,
    ),
];

const param = new URLSearchParams(window.location.search).get("images");
const images = param
  ? param
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean)
  : DEFAULT_IMAGES;

function Preview() {
  return (
    <div className="main" style={{ maxWidth: 860, margin: "40px auto", padding: "0 16px" }}>
      <div className="main-head">
        <div className="main-title">
          图集预览
          <span>{images.length} 张</span>
        </div>
      </div>
      <div className="main-body">
        <Gallery images={images} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);