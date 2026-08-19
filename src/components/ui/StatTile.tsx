import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * One headline number, in ProofWork's tile shape: an accented icon square, the value,
 * and a quiet label under it.
 *
 * These sit above the list on every page that has aggregates, because the figures are
 * the first thing anyone wants and the details panel is hidden under `lg`. The panel
 * still carries the same numbers for the desktop reader who wants them beside the
 * content rather than above it.
 */
const ACCENT: Record<string, string> = {
  primary: "text-primary",
  secondary: "text-secondary",
  success: "text-success",
  accent: "text-accent",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

export function StatTile({
  icon: Icon,
  label,
  value,
  accent = "muted",
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  accent?: keyof typeof ACCENT;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5 rounded-[4px] border border-border bg-card p-2.5", className)}>
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] bg-muted/60",
          ACCENT[accent] ?? ACCENT.muted,
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[15px] font-semibold leading-tight text-foreground">{value}</p>
        <p className="truncate text-[11px] text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

/** The responsive row the tiles live in. Six across on a wide screen, two on a phone. */
export function StatRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6", className)}>{children}</div>
  );
}
