import { useEffect, useState } from "react";
import Background from "./components/Background";
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

export default function App() {
  const [route, setRoute] = useState(window.location.hash);

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
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
    </>
  );
}
