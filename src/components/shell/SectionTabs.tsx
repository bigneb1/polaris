import { NavLink } from "react-router-dom";
import { Bot, Coins, Compass, LayoutGrid, PlusSquare, Repeat, User, BookOpen } from "lucide-react";

/**
 * The app's primary navigation: one horizontal strip, in the ProofWork idiom.
 *
 * Polaris has eight sections where ProofWork has three, so the strip scrolls on
 * narrow screens rather than collapsing into a menu. That keeps every section one tap
 * away and leaves the full width for content, which matters most on the market and
 * explorer tables. Detail routes (task, agent, plan, dispute) intentionally match no
 * tab and are reached from a list, with the toolbar's back button for the way out.
 */
const SECTIONS = [
  { to: "/tasks", label: "Market", icon: LayoutGrid },
  { to: "/create-task", label: "Create", icon: PlusSquare },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/settlement", label: "Settle", icon: Coins },
  { to: "/explorer", label: "Explorer", icon: Compass },
  { to: "/subscriptions", label: "Recurring", icon: Repeat },
  { to: "/profile", label: "Dashboard", icon: User },
  { to: "/docs", label: "Docs", icon: BookOpen },
];

export function SectionTabs() {
  return (
    <nav className="h-9 shrink-0 flex items-stretch border-b border-border bg-card px-1 overflow-x-auto">
      {SECTIONS.map((s) => (
        <NavLink key={s.to} to={s.to} className="persona-tab" data-active={undefined}>
          {({ isActive }) => (
            <span className="flex items-center gap-1.5" data-active={isActive}>
              <s.icon className="h-3.5 w-3.5" />
              {s.label}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
