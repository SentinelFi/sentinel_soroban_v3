import { useEffect, useState } from "react";
import BackToTop from "./components/BackToTop";
import Background from "./components/Background";
import BrowseNotice from "./components/BrowseNotice";
import Hero from "./components/Hero";
import Audiences from "./components/Audiences";
import Stack from "./components/Stack";
import Faq from "./components/Faq";
import ComingSoon from "./components/ComingSoon";
import Footer from "./components/Footer";
import { Privacy, Terms, Disclaimers } from "./components/Legal";
import { useReveal } from "./hooks/useReveal";

/* Hash routes use a leading slash (#/privacy) so they never collide with
   the in-page scroll anchors (#faq, #audiences). */
const LEGAL_PAGES: Record<string, (() => React.JSX.Element) | undefined> = {
  "#/privacy": Privacy,
  "#/terms": Terms,
  "#/disclaimers": Disclaimers,
};

/** Resolves the route, honoring typed path URLs (/privacy) as well as the
 *  canonical hash form. Guarded for the prerender pass (no window in Node). */
export function initialRoute(): string {
  if (typeof window === "undefined") return "";
  const path = window.location.pathname.replace(/\/+$/, "");
  const asHash = `#${path}`;
  return asHash in LEGAL_PAGES ? asHash : window.location.hash;
}

export function isLegalRoute(route: string): boolean {
  return route in LEGAL_PAGES;
}

export default function App() {
  const [route, setRoute] = useState(initialRoute);

  useEffect(() => {
    // Canonicalize a typed path URL (/privacy, served via the vercel.json
    // rewrite) to the hash form so hash links keep working from here on.
    if (window.location.pathname.replace(/\/+$/, "") !== "" && isLegalRoute(route)) {
      window.history.replaceState(null, "", `/${route}`);
    }
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const LegalPage = LEGAL_PAGES[route];

  useEffect(() => {
    if (LegalPage) window.scrollTo(0, 0);
  }, [LegalPage]);

  useReveal([route]);

  return (
    <>
      <Background />
      <main className="relative">
        {LegalPage ? (
          <LegalPage />
        ) : (
          <>
            <Hero />
            <Audiences />
            <Stack />
            <Faq />
            <ComingSoon />
          </>
        )}
        <Footer />
      </main>
      <BackToTop />
      <BrowseNotice />
    </>
  );
}
