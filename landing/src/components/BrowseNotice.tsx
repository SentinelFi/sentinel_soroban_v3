import { useEffect, useState } from "react";

const KEY = "sentinel.terms-notice.dismissed";

/* Browsewrap notice, pinned bottom-right and dismissed once per browser.
   It renders nothing until an effect has checked storage: the production
   HTML is prerendered and hydrated (see main.tsx), so anything decided from
   localStorage has to happen after the first client render or the two would
   disagree. */
export default function BrowseNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) !== "1") setShow(true);
    } catch {
      // Private mode or storage blocked — show it rather than swallow it.
      setShow(true);
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // Nothing to do: it simply reappears next visit.
    }
    setShow(false);
  };

  return (
    <aside aria-label="Terms notice" className="browse-notice panel">
      <p>
        By browsing this site you agree to our <a href="#/terms">Terms</a>,{" "}
        <a href="#/privacy">Privacy Policy</a> and{" "}
        <a href="#/disclaimers">Disclaimers</a>.
      </p>
      <button type="button" onClick={dismiss} className="browse-notice-ok">
        Got it
      </button>
    </aside>
  );
}
