import { MdSecurity, MdTrendingUp, MdArrowOutward } from "react-icons/md";
import { LINKS } from "../links";

const CARDS = [
  {
    icon: MdSecurity,
    accent: "text-accent",
    title: "For Travelers",
    lead: "Insure your flight.",
    body: "Buy a policy in minutes. If your flight is delayed or cancelled, your payout is ready to claim on-chain. No forms, no hassle, no waiting on hold.",
    cta: "Get covered",
    href: LINKS.app,
  },
  {
    icon: MdTrendingUp,
    accent: "text-highlight",
    title: "For Underwriters",
    lead: "Earn yield on coverage.",
    body: "Deposit assets into coverage vaults and collect premiums from every policy sold. Transparent on-chain risk, priced by real flight data.",
    cta: "Start earning",
    href: LINKS.earn,
  },
] as const;

export default function Audiences() {
  return (
    <section
      id="audiences"
      className="relative mx-auto max-w-6xl scroll-mt-16 px-6 pt-32 pb-16"
    >
      <h2 className="waterline reveal mb-12 text-center text-4xl font-bold md:text-5xl">
        Two sides of every flight
      </h2>
      <div className="grid gap-8 md:grid-cols-2">
        {CARDS.map(({ icon: Icon, accent, title, lead, body, cta, href }, i) => (
          <div
            key={title}
            className="reveal bg-white/5 p-10 backdrop-blur-sm transition-colors duration-300 hover:bg-white/[0.08] md:p-12"
            style={{ transitionDelay: `${i * 0.12}s` }}
          >
            <Icon className={`mb-6 ${accent}`} size={36} aria-hidden="true" />
            <h3 className="text-3xl font-bold md:text-4xl">{title}</h3>
            <p className={`mt-2 text-xl font-semibold ${accent}`}>{lead}</p>
            <p className="mt-4 text-lg leading-relaxed text-neutral-400">
              {body}
            </p>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 inline-flex items-center gap-2 text-lg font-semibold text-white transition-colors hover:text-accent"
            >
              {cta}
              <MdArrowOutward aria-hidden="true" />
            </a>
          </div>
        ))}
      </div>
      <p className="reveal mt-12 text-center text-lg text-neutral-400">
        One market, both sides. Risk hedged for travelers, yield for
        capital.
      </p>
    </section>
  );
}
