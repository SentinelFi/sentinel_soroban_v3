import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import App, { initialRoute, isLegalRoute } from "./App.tsx";
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

// Production HTML is prerendered (scripts/prerender.mjs) with the HOME page —
// hydrate only when that's what this visit renders. A direct legal-page visit
// (/privacy or #/privacy) must render fresh or hydration would mismatch.
// Dev serves an empty root — render from scratch.
if (root.hasChildNodes() && !isLegalRoute(initialRoute())) {
  hydrateRoot(root, app);
} else {
  root.innerHTML = "";
  createRoot(root).render(app);
}
