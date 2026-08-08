import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import App from "./App.tsx";
// Titillium Web is self-hosted from /public/fonts (declared in index.css),
// not imported from @fontsource: bundler-hashed URLs can't be preloaded
// from index.html.
import "./index.css";

const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// Production HTML is prerendered (scripts/prerender.mjs) — hydrate it.
// Dev serves an empty root — render from scratch.
if (root.hasChildNodes()) {
  hydrateRoot(root, app);
} else {
  createRoot(root).render(app);
}
