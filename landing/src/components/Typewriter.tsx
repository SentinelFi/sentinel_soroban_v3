import { useEffect, useState } from "react";

const TYPE_MS = 75;
const DELETE_MS = 42;
const HOLD_MS = 5200;
const REST_MS = 600;

/** Types each phrase with a blinking cursor, holds, deletes, rotates. */
export default function Typewriter({
  phrases,
}: {
  phrases: readonly string[];
}) {
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setReduced(true);
    }
  }, []);

  useEffect(() => {
    if (reduced) return;
    const full = phrases[index];
    let t: number;
    if (!deleting) {
      if (text.length < full.length) {
        t = window.setTimeout(
          () => setText(full.slice(0, text.length + 1)),
          TYPE_MS,
        );
      } else {
        t = window.setTimeout(() => setDeleting(true), HOLD_MS);
      }
    } else if (text.length > 0) {
      t = window.setTimeout(
        () => setText(full.slice(0, text.length - 1)),
        DELETE_MS,
      );
    } else {
      // brief rest on the empty line before the next phrase starts
      t = window.setTimeout(() => {
        setDeleting(false);
        setIndex((index + 1) % phrases.length);
      }, REST_MS);
    }
    return () => clearTimeout(t);
  }, [text, deleting, index, phrases, reduced]);

  if (reduced) return <span>{phrases[0]}</span>;

  return (
    <span>
      {/* screen readers get the stable phrase, not keystrokes */}
      <span className="sr-only">{phrases[0]}</span>
      <span aria-hidden="true">
        {text}
        <span className="type-cursor" />
      </span>
    </span>
  );
}
