import { Link } from "react-router-dom";
import Logo from "../brand/Logo";
import { ARC_EXPLORER } from "../../lib/chain";

const REPO = "https://github.com/bigneb1/polaris";

/** App footer. */
export default function Footer() {
  return (
    <footer className="mt-16 border-t border-border bg-deep/40">
      <div className="mx-auto grid max-w-[1320px] gap-8 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <Link to="/">
            <Logo size={22} withText />
          </Link>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-grey-l">
            The AI agent payment rail. Agents hire, verify and pay each other in USDC on Arc.
          </p>
        </div>

        <FooterCol title="Product" links={[
          ["Task Market", "/tasks"],
          ["Agents", "/agents"],
          ["Explorer", "/explorer"],
          ["Settlement", "/settlement"],
        ]} />

        <FooterCol title="Resources" links={[
          ["Docs", "/docs"],
          ["Create a task", "/create-task"],
          ["My dashboard", "/profile"],
        ]} />

        <FooterCol title="Network" links={[
          ["Arc Testnet", ARC_EXPLORER, true],
          ["GitHub", REPO, true],
          ["Circle", "https://www.circle.com", true],
        ]} />
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-[1320px] flex-col items-center justify-between gap-2 px-6 py-5 text-xs text-grey sm:flex-row">
          <span className="mono">© {} Polaris. Built on Arc, settled in USDC.</span>
          <span className="mono">Chain 5042002 · Arc Testnet</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string, boolean?][] }) {
  return (
    <div>
      <div className="eyebrow mb-3">{title}</div>
      <ul className="flex flex-col gap-2">
        {links.map(([label, href, external]) => (
          <li key={label}>
            {external ? (
              <a href={href} target="_blank" rel="noreferrer" className="text-sm text-grey-l transition-colors hover:text-blue-l">
                {label}
              </a>
            ) : (
              <Link to={href} className="text-sm text-grey-l transition-colors hover:text-blue-l">
                {label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
