import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  PlusSquare,
  Bot,
  Coins,
  Compass,
  User,
  Home,
  Menu,
  X,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import type { ReactNode } from "react";
import Logo, { PolarisMark } from "../brand/Logo";
import { NetworkBanner } from "./guards";
import ThemeToggle from "../ThemeToggle";
import WalletButton from "../WalletButton";
import Footer from "./Footer";
import { cn } from "../../lib/utils";

const NAV = [
  { to: "/", icon: Home, label: "Home" },
  { to: "/tasks", icon: LayoutDashboard, label: "Task Market" },
  { to: "/create-task", icon: PlusSquare, label: "Create Task" },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/settlement", icon: Coins, label: "Settlement" },
  { to: "/explorer", icon: Compass, label: "Explorer" },
  { to: "/profile", icon: User, label: "Profile" },
];

const PATH_LABELS: Record<string, string> = {
  "/": "home",
  "/tasks": "task-market",
  "/create-task": "create-task",
  "/agents": "agent-registry",
  "/settlement": "settlement-center",
  "/explorer": "agent-explorer",
  "/profile": "my-dashboard",
};

function Sidebar({
  collapsed,
  mobileOpen,
  onNavigate,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onNavigate: () => void;
}) {
  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-50 flex h-screen flex-col border-r border-border bg-deep/95 py-4 backdrop-blur-xl transition-all duration-300",
        collapsed ? "w-[68px]" : "w-[232px]",
        // mobile: slide in/out
        "max-lg:transition-transform",
        mobileOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
      )}
    >
      <NavLink to="/" onClick={onNavigate} className={cn("mb-6 flex items-center gap-2.5 px-4", collapsed && "justify-center px-0")}>
        <PolarisMark size={30} />
        {!collapsed && <span className="font-display text-lg font-semibold tracking-tight text-white">Polaris</span>}
      </NavLink>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            onClick={onNavigate}
            title={label}
            className={({ isActive }) =>
              cn(
                "group relative flex items-center gap-3 rounded-xl py-2.5 text-grey transition-all hover:bg-card hover:text-white",
                collapsed ? "justify-center px-0" : "px-3",
                isActive && "bg-card text-blue-l",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute left-0 h-6 w-[3px] -translate-x-[12px] rounded-r bg-blue-violet" />}
                <Icon size={19} strokeWidth={2} className="shrink-0" />
                {!collapsed && <span className="text-sm font-medium">{label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* bottom: theme toggle + tagline */}
      <div className={cn("mt-auto flex items-center gap-2 border-t border-border px-3 pt-4", collapsed ? "flex-col" : "justify-between")}>
        <ThemeToggle />
        {!collapsed && <span className="mono text-[10px] leading-tight text-grey">Arc · USDC<br />sub-second finality</span>}
      </div>
    </aside>
  );
}

function Topbar({
  collapsed,
  onToggleCollapse,
  onOpenMobile,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenMobile: () => void;
}) {
  const { pathname } = useLocation();
  const seg = "/" + (pathname.split("/")[1] ?? "");
  const label = PATH_LABELS[seg] ?? pathname.replace("/", "");
  return (
    <header className="sticky top-0 z-30 flex h-[56px] items-center justify-between border-b border-border bg-void/70 px-4 backdrop-blur-xl sm:px-6">
      <div className="flex items-center gap-3">
        {/* mobile: hamburger; desktop: collapse toggle */}
        <button onClick={onOpenMobile} className="grid h-9 w-9 place-items-center rounded-lg border border-border bg-card text-grey-l hover:text-white lg:hidden" aria-label="Open menu">
          <Menu size={18} />
        </button>
        <button onClick={onToggleCollapse} className="hidden h-9 w-9 place-items-center rounded-lg border border-border bg-card text-grey-l hover:text-white lg:grid" aria-label="Collapse sidebar">
          {collapsed ? <PanelLeft size={17} /> : <PanelLeftClose size={17} />}
        </button>
        <NavLink to="/"><Logo size={20} withText /></NavLink>
        <span className="mono hidden text-xs text-grey md:inline">/ {label}</span>
      </div>
      <div className="flex items-center gap-2 sm:gap-2.5">
        <span className="mono hidden rounded-full border border-blue/30 bg-blue/10 px-2.5 py-1 text-[10px] uppercase tracking-widest text-blue-l md:inline">
          Arc Testnet
        </span>
        <WalletButton />
      </div>
    </header>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen">
      {/* mobile backdrop */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />
      )}
      <Sidebar collapsed={collapsed} mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />

      {/* mobile close button when drawer open */}
      {mobileOpen && (
        <button
          onClick={() => setMobileOpen(false)}
          className="fixed left-[244px] top-4 z-50 grid h-9 w-9 place-items-center rounded-lg border border-border bg-card text-white lg:hidden"
          aria-label="Close menu"
        >
          <X size={18} />
        </button>
      )}

      <div className={cn("transition-all duration-300", collapsed ? "lg:pl-[68px]" : "lg:pl-[232px]")}>
        <Topbar
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          onOpenMobile={() => setMobileOpen(true)}
        />
        <NetworkBanner />
        <main className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-7">{children}</main>
        <Footer />
      </div>
    </div>
  );
}
