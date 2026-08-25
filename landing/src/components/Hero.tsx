import { MdArrowOutward, MdExpandMore } from "react-icons/md";
import { LINKS } from "../links";
import PlaneFlyby from "./PlaneFlyby";
import Typewriter from "./Typewriter";

const TAGLINES = [
  "decentralized, automated, transparent.",
  "hedge delays, earn on risk.",
  "real flight data, on-chain.",
] as const;

export default function Hero() {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 pt-10 text-center">
      <PlaneFlyby />

      <div className="logo-shine hero-enter mb-8 w-36 md:w-44">
        <img
          src="/logo.webp"
          alt="Sentinel"
          width={352}
          height={259}
          fetchPriority="high"
          className="h-auto w-full"
        />
      </div>

      <h1
        className="hero-title hero-enter text-6xl leading-none font-bold md:text-8xl"
        style={{ animationDelay: "0.2s" }}
      >
        Fly. <span className="text-accent">Insure.</span>{" "}
        <span className="text-highlight">Earn.</span>
      </h1>

      <p
        className="hero-enter mt-8 min-h-[4.2em] text-2xl font-semibold tracking-wide text-white sm:min-h-[2.8em] md:min-h-[1.4em] md:text-3xl"
        style={{ animationDelay: "0.35s" }}
      >
        Parametric flight insurance{" "}
        <span aria-hidden="true" className="text-accent">
          &rarr;
        </span>{" "}
        <Typewriter phrases={TAGLINES} />
      </p>

      <p
        className="hero-enter mt-4 max-w-xl text-lg text-neutral-400 md:text-xl"
        style={{ animationDelay: "0.45s" }}
      >
        Travelers hedge delays with instant on-chain payouts. Underwriters
        provide coverage and earn yield.
      </p>

      <div
        className="hero-enter mt-12 flex flex-col items-center gap-5 sm:flex-row"
        style={{ animationDelay: "0.55s" }}
      >
        <span className="btn-cta btn-cta-accent">
          <a
            href={LINKS.app}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary btn-shine inline-flex items-center gap-2 px-10 py-4 text-xl font-bold"
          >
            Launch App
            <MdArrowOutward aria-hidden="true" />
          </a>
        </span>
      </div>

      <div
        className="hero-enter mt-10 flex flex-col items-center gap-2"
        style={{ animationDelay: "0.62s" }}
      >
        <span className="btn-cta btn-cta-testnet">
          <a
            href={LINKS.testnet}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-testnet btn-shine inline-flex items-center gap-2 px-8 py-3.5 text-lg font-bold"
            title="Test network tokens have no monetary value"
          >
            Try on Testnet
            <MdArrowOutward aria-hidden="true" />
          </a>
        </span>
        <span className="text-sm text-neutral-400">
          <span aria-hidden="true" className="mr-2 text-highlight">
            [
          </span>
          Test network has no monetary value
          <span aria-hidden="true" className="ml-2 text-highlight">
            ]
          </span>
        </span>
      </div>

      <div
        className="hero-enter mt-14 flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-lg text-neutral-400"
        style={{ animationDelay: "0.65s" }}
      >
        <a
          href={LINKS.docs}
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-white"
        >
          Docs
        </a>
        <a href="#faq" className="transition-colors hover:text-white">
          FAQ
        </a>
      </div>

      <a
        href="#audiences"
        aria-label="Scroll to content"
        className="scroll-hint mt-6 text-neutral-400"
      >
        <MdExpandMore size={32} />
      </a>
    </section>
  );
}
