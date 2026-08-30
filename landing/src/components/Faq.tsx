import { useState } from "react";
import { MdAdd } from "react-icons/md";
import { LINKS } from "../links";

export const FAQS = [
  {
    q: "What is parametric flight insurance?",
    a: "Coverage that pays out on a measurable event instead of a claims process → your flight being delayed or cancelled. Flight data triggers the payout; no forms, no adjusters, no negotiation.",
  },
  {
    q: "How do payouts work?",
    a: "An oracle fetches your flight's status from real-world data. If it crosses the delay threshold in your policy, the smart contract sends USDC straight to your wallet, automatically.",
  },
  {
    q: "What do I need to buy a policy?",
    a: "A Stellar wallet with a USDC trustline, some USDC for the premium, and a little XLM for network fees. Pick your flight in the app and you're covered.",
  },
  {
    q: "How do underwriters earn?",
    a: "Underwriters deposit USDC into coverage vaults that back the policies. Premiums flow to the vault; if flights are disrupted, payouts are drawn from it. Yield is the reward for carrying that risk.",
  },
  {
    q: "Is this secure?",
    a: "Security is a core focus: the smart contracts are open source, developed with extensive testing, and formal audits are planned. That said, no protocol can guarantee absolute safety → smart-contract vulnerabilities, oracle failures, and other unexpected events can and do happen in DeFi. Never commit more than you can afford to lose. By using the protocol you agree to our Terms and Disclaimers.",
  },
  {
    q: "Where can I learn more?",
    a: "The docs cover the protocol, contracts, and risk model in depth. For questions or issues, reach out on GitHub, X, or Medium → links below.",
  },
] as const;

export default function Faq() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <section id="faq" className="section-y relative mx-auto max-w-3xl scroll-mt-16 px-6">
      <div className="reveal mb-10 flex flex-col items-center gap-4">
        <span className="label">Questions</span>
        <h2 className="waterline section-title text-center">FAQ</h2>
      </div>
      <div className="flex flex-col gap-3">
        {FAQS.map(({ q, a }, i) => {
          const isOpen = open === i;
          return (
            /* reveal lives on a wrapper whose className never changes —
               a re-render of the inner div (bg swap on open) would wipe
               the observer-added `revealed` class */
            <div
              key={q}
              className="reveal"
              style={{ transitionDelay: `${Math.min(i * 0.07, 0.35)}s` }}
            >
            <div
              className={`panel ${isOpen ? "panel-open" : "panel-hover"}`}
            >
              <button
                type="button"
                id={`faq-question-${i}`}
                onClick={() => setOpen(isOpen ? null : i)}
                aria-expanded={isOpen}
                aria-controls={`faq-answer-${i}`}
                className="flex w-full cursor-pointer items-center justify-between gap-6 px-7 py-5 text-left text-xl font-semibold"
              >
                {q}
                {/* plus rotates 45° into an ✕ when open */}
                <MdAdd
                  aria-hidden="true"
                  size={24}
                  className={`shrink-0 text-accent transition-transform duration-300 ${
                    isOpen ? "rotate-45" : ""
                  }`}
                />
              </button>
              <div
                id={`faq-answer-${i}`}
                role="region"
                aria-labelledby={`faq-question-${i}`}
                className={`faq-answer ${isOpen ? "open" : ""}`}
              >
                <div>
                  <p className="px-7 pb-6 text-lg leading-relaxed text-neutral-300">
                    {a}
                  </p>
                </div>
              </div>
            </div>
            </div>
          );
        })}
      </div>
      <p className="reveal mt-10 text-center text-lg text-neutral-400">
        More questions?{" "}
        <a
          href={LINKS.git + "issues"}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-highlight transition-colors hover:text-white"
        >
          Ask here
        </a>
      </p>
    </section>
  );
}
