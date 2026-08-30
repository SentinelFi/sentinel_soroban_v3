import { useEffect, useState } from "react";

/* The hero's scroll cue in reverse: a hairline pinned to the right edge with
   its light travelling upward, appearing once the hero is behind you.
   It renders hidden on the server and on the first client pass, so the
   prerendered HTML and the hydrated tree agree (see main.tsx). */
export default function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight * 0.8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      aria-label="Back to top"
      aria-hidden={!show}
      tabIndex={show ? undefined : -1}
      // No `behavior`, so this follows the stylesheet — smooth normally,
      // instant under prefers-reduced-motion.
      onClick={() => window.scrollTo({ top: 0 })}
      className={show ? "back-to-top is-visible" : "back-to-top"}
    >
      <span className="back-to-top-track" aria-hidden="true" />
    </button>
  );
}
