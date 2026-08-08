import { renderToString } from "react-dom/server";
import App from "./App";
import { FAQS } from "./components/Faq";

/** Build-time prerender entry — see scripts/prerender.mjs. */
export function render(): string {
  return renderToString(<App />);
}

/** FAQPage JSON-LD generated from the live FAQ array so it never drifts. */
export function faqJsonLd(): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  });
}
