import { FaXTwitter, FaMedium, FaGithub } from "react-icons/fa6";
import { LINKS } from "../links";

const SOCIALS = [
  { href: LINKS.x, label: "X (Twitter)", Icon: FaXTwitter },
  { href: LINKS.blog, label: "Medium blog", Icon: FaMedium },
  { href: LINKS.git, label: "GitHub", Icon: FaGithub },
] as const;

export default function Footer() {
  return (
    <footer className="relative px-6 pt-16 pb-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-8 text-center">
        <div className="flex items-center gap-7">
          {SOCIALS.map(({ href, label, Icon }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={label}
              className="text-neutral-400 transition-colors hover:text-accent"
            >
              <Icon size={22} />
            </a>
          ))}
        </div>

        <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-base text-neutral-400">
          <a href="#/privacy" className="transition-colors hover:text-white">
            Privacy
          </a>
          <span aria-hidden="true" className="text-neutral-700">
            |
          </span>
          <a href="#/terms" className="transition-colors hover:text-white">
            Terms
          </a>
          <span aria-hidden="true" className="text-neutral-700">
            |
          </span>
          <a
            href="#/disclaimers"
            className="transition-colors hover:text-white"
          >
            Disclaimers
          </a>
          <span aria-hidden="true" className="text-neutral-700">
            |
          </span>
          <a
            href={LINKS.git + "issues"}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-white"
          >
            Contact
          </a>
        </nav>

        <p className="text-base text-neutral-400">
          &copy; {new Date().getFullYear()} Parametric flight
          insurance, on-chain. Not financial advice.
        </p>
      </div>
    </footer>
  );
}
