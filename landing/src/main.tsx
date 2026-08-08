import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
// Titillium Web is self-hosted from /public/fonts (declared in index.css),
// not imported from @fontsource: bundler-hashed URLs can't be preloaded
// from index.html.
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
