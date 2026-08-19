import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * The right-hand details panel: counts, network facts, and a page's metadata.
 *
 * Hidden under `lg`, where AppShell renders the same content in a drawer instead, so
 * a phone gets the full width for content without losing the information.
 */
export function StudioPanel({ children }: { children: ReactNode }) {
  return (
    <aside className="w-[280px] shrink-0 border-l border-border bg-card overflow-y-auto hidden lg:block">
      {children}
    </aside>
  );
}

/** A collapsible group inside the panel. */
export function PanelSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border">
      <button onClick={() => setOpen((v) => !v)} className="panel-section-header">
        {title}
        <ChevronDown className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

/** One label/value line. `mono` for addresses, hashes and ids. */
export function PanelRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-2 py-1 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn("text-foreground font-medium text-right min-w-0 truncate", mono && "font-mono text-[11px]")}>
        {value}
      </span>
    </div>
  );
}
