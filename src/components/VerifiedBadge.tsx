import { BadgeCheck, ShieldCheck, Users, Crown } from "lucide-react";

/** Phase D verification tiers. Index = on-chain tier value. */
export const TIERS = [
  null,
  { label: "Verified", icon: BadgeCheck, cls: "border-primary/40 bg-primary/10 text-primary" },
  { label: "Identity verified", icon: ShieldCheck, cls: "border-success/40 bg-success/10 text-success" },
  { label: "Team verified", icon: Users, cls: "border-secondary/40 bg-secondary/12 text-secondary" },
  { label: "Official", icon: Crown, cls: "border-accent/40 bg-accent/10 text-accent" },
] as const;

export const tierLabel = (tier?: number) => (tier && TIERS[tier] ? TIERS[tier]!.label : "Unverified");

/** A small verification badge chip. Renders nothing for tier 0/undefined unless `showNone`. */
export default function VerifiedBadge({
  tier,
  note,
  size = "sm",
  showNone = false,
}: {
  tier?: number;
  note?: string;
  size?: "sm" | "xs";
  showNone?: boolean;
}) {
  const t = tier && TIERS[tier] ? TIERS[tier] : null;
  if (!t) {
    if (!showNone) return null;
    return <span className="font-mono rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">Unverified</span>;
  }
  const Icon = t.icon;
  const pad = size === "xs" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span title={note || t.label} className={`font-mono inline-flex items-center gap-1 rounded-md border ${pad} uppercase tracking-wider ${t.cls}`}>
      <Icon size={size === "xs" ? 10 : 12} /> {t.label}
    </span>
  );
}
