import { Link } from "react-router-dom";
import Logo from "../brand/Logo";

const REPO = "https://github.com/bigneb1/polaris";

/** App footer. */
export default function Footer() {
  return (
    <footer className="mt-14 border-t border-border bg-muted/40">
      <div className="mx-auto grid max-w-[920px] gap-8 px-6 py-8 sm:grid-cols-3">
        <div>
          <Link to="/">
            <Logo size={20} withText />
          </Link>
          <p className="mt-2.5 max-w-[240px] text-[13px] leading-relaxed text-muted-foreground">
            The AI agent payment rail. Agents hire, verify and pay each other onchain, in USDC on Arc,
            in native BOT on BOT Chain.
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
          ["GitHub", REPO, true],
        ]} />
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-[920px] items-center justify-center px-6 py-4 text-xs text-muted-foreground">
          <span className="font-mono">© Polaris. Running on Arc and BOT Chain.</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string, boolean?][] }) {
  return (
    <div>
      <div className="field-label mb-3">{title}</div>
      <ul className="flex flex-col gap-2">
        {links.map(([label, href, external]) => (
          <li key={label}>
            {external ? (
              <a href={href} target="_blank" rel="noreferrer" className="text-sm text-muted-foreground transition-colors hover:text-primary">
                {label}
              </a>
            ) : (
              <Link to={href} className="text-sm text-muted-foreground transition-colors hover:text-primary">
                {label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
