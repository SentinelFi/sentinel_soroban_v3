// Injects the server-rendered app + FAQPage JSON-LD into dist/index.html.
// Runs after `vite build` (client) and `vite build --ssr` (server entry).
import { readFileSync, writeFileSync } from "node:fs";

const { render, faqJsonLd } = await import("../dist-ssr/entry-server.js");

const file = new URL("../dist/index.html", import.meta.url);
const html = readFileSync(file, "utf8");

const marker = '<div id="root"></div>';
if (!html.includes(marker)) {
  throw new Error("prerender: root marker not found in dist/index.html");
}

const out = html
  .replace(marker, `<div id="root">${render()}</div>`)
  .replace(
    "</head>",
    `<script type="application/ld+json">${faqJsonLd()}</script></head>`,
  );

writeFileSync(file, out);
console.log("prerender: injected app HTML + FAQPage JSON-LD into dist/index.html");
