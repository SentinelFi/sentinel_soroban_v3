import { FiArrowUpRight } from "react-icons/fi";
import { LINKS } from "../links";

const USDC_STEPS = [
  {
    n: "01",
    title: "Get a Stellar wallet",
    body: "Any wallet that supports Stellar assets and Soroban.",
    href: LINKS.wallet,
    linkText: "Get Freighter",
  },
  {
    n: "02",
    title: "Add the USDC trustline",
    body: "One click in your wallet enables Circle USDC on Stellar.",
    href: LINKS.usdc,
    linkText: "About USDC on Stellar",
  },
  {
    n: "03",
    title: "Bridge or buy USDC",
    body: "Move USDC from other chains in minutes.",
    href: LINKS.bridge,
    linkText: "Bridge via Allbridge",
  },
] as const;

export default function Stack() {
  return (
    <section className="relative mx-auto max-w-6xl px-6 py-32">
      <div className="reveal flex flex-col items-center gap-6 text-center">
        <p className="text-base font-semibold tracking-[0.35em] text-neutral-400 uppercase">
          Built on
        </p>
        <a
          href={LINKS.stellar}
          target="_blank"
          rel="noopener noreferrer"
          className="opacity-80 transition-opacity hover:opacity-100"
          aria-label="Stellar"
        >
          <img
            src="/stellar.svg"
            alt="Stellar"
            className="h-8 invert md:h-10"
          />
        </a>
      </div>

      <div className="mt-24">
        <h2 className="reveal text-center text-3xl font-bold md:text-4xl">
          Runs on <span className="text-highlight">Circle USDC</span>
        </h2>
        <div className="mt-14 grid gap-8 md:grid-cols-3">
          {USDC_STEPS.map(({ n, title, body, ...link }, i) => (
            <div
              key={n}
              className="reveal bg-white/5 p-8"
              style={{ transitionDelay: `${i * 0.12}s` }}
            >
              <span className="text-base font-bold text-accent">{n}</span>
              <h3 className="mt-3 text-2xl font-bold">{title}</h3>
              <p className="mt-2 text-lg text-neutral-400">{body}</p>
              {"href" in link && (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-1.5 text-base font-semibold text-highlight transition-colors hover:text-white"
                >
                  {link.linkText}
                  <FiArrowUpRight aria-hidden="true" />
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
