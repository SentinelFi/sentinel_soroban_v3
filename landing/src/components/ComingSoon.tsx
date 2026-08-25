import { MdMailOutline, MdAutoAwesome } from "react-icons/md";
import PlaneFlyby from "./PlaneFlyby";

/* Placeholder strip — subscribe + NFT mint land here (just before the
   footer) once live; visitors reach this point having read everything. */
export default function ComingSoon() {
  return (
    <section className="relative mx-auto max-w-6xl px-6 py-16">
      <PlaneFlyby back />
      <div className="grid gap-8 md:grid-cols-2">
        <div className="reveal bg-white/5 p-10">
          <MdMailOutline
            className="mb-5 text-accent"
            size={30}
            aria-hidden="true"
          />
          <h3 className="text-3xl font-bold">Stay in the loop</h3>
          <p className="mt-3 text-lg text-neutral-400">
            Product updates, new routes, and protocol news. No spam,
            unsubscribe at any time.
          </p>
          <form
            className="mt-6 flex gap-3"
            aria-label="Newsletter signup (coming soon)"
          >
            <input
              type="email"
              placeholder="you@example.com"
              disabled
              className="w-full bg-black/40 px-4 py-3 text-white placeholder-neutral-600 outline-none"
            />
            <button
              type="button"
              disabled
              className="btn-ghost cursor-not-allowed px-6 py-3 text-lg font-semibold text-neutral-500"
            >
              Subscribe
            </button>
          </form>
          <p className="mt-3 text-base text-neutral-400">Coming soon.</p>
        </div>

        <div className="reveal bg-white/5 p-10" style={{ transitionDelay: "0.12s" }}>
          <MdAutoAwesome
            className="mb-5 text-highlight"
            size={30}
            aria-hidden="true"
          />
          <h3 className="text-3xl font-bold">OG NFT</h3>
          <p className="mt-3 text-lg text-neutral-400">
            A collectible for early travelers and underwriters. No monetary or
            speculative value.
          </p>
          <button
            type="button"
            disabled
            className="btn-ghost mt-6 cursor-not-allowed px-6 py-3 text-lg font-semibold text-neutral-500"
          >
            Mint
          </button>
          <p className="mt-3 text-base text-neutral-400">Coming soon.</p>
        </div>
      </div>
    </section>
  );
}
