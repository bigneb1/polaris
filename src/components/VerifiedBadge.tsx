import { BadgeCheck, ShieldCheck, Users, Crown } from "lucide-react";

/** Phase D verification tiers. Index = on-chain tier value. */
export const TIERS = [
  null,
  { label: "Verified", icon: BadgeCheck, cls: "border-blue/40 bg-blue/10 text-blue-l" },
  { label: "Identity verified", icon: ShieldCheck, cls: "border-green/40 bg-green/10 text-green" },
  { label: "Team verified", icon: Users, cls: "border-violet/40 bg-violet/12 text-violet" },
  { label: "Official", icon: Crown, cls: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
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
    return <span className="mono rounded-md border border-border bg-deep px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-grey">Unverified</span>;
  }
  const Icon = t.icon;
  const pad = size === "xs" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]";
  return (
    <span title={note || t.label} className={`mono inline-flex items-center gap-1 rounded-md border ${pad} uppercase tracking-wider ${t.cls}`}>
      <Icon size={size === "xs" ? 10 : 12} /> {t.label}
    </span>
  );
}
