import { PolarisMark } from "./brand/Logo";

/**
 * AgentOrb — the landing-page hero visual. A living 3D-style "agent network":
 * a glowing payment core at the centre, autonomous agents orbiting it on tilted
 * rings, and USDC flowing between them. Pure CSS/SVG (no WebGL) so it's light,
 * theme-aware, and animates smoothly on mobile.
 */

type NodeDef = { r: number; dur: number; delay: number; kind: "agent" | "usdc"; label: string };

const NODES: NodeDef[] = [
  { r: 120, dur: 18, delay: 0, kind: "agent", label: "A" },
  { r: 120, dur: 18, delay: -9, kind: "usdc", label: "$" },
  { r: 178, dur: 26, delay: -4, kind: "agent", label: "B" },
  { r: 178, dur: 26, delay: -17, kind: "usdc", label: "$" },
  { r: 232, dur: 34, delay: -10, kind: "agent", label: "C" },
];

export default function AgentOrb() {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[520px] select-none [perspective:1100px]">
      {/* ambient halo */}
      <div className="absolute inset-[12%] animate-pulse-glow rounded-full bg-blue/30 blur-3xl" />
      <div className="absolute inset-[26%] rounded-full bg-purple/20 blur-2xl" />

      {/* tilted stage */}
      <div className="absolute inset-0 [transform:rotateX(62deg)] [transform-style:preserve-3d]">
        {/* orbit rings */}
        {[120, 178, 232].map((r, i) => (
          <div
            key={r}
            className={`absolute left-1/2 top-1/2 rounded-full border border-border2/70 ${i % 2 ? "animate-spin-rev" : "animate-spin-slow"}`}
            style={{ width: r * 2, height: r * 2, marginLeft: -r, marginTop: -r }}
          />
        ))}

        {/* orbiting nodes (counter-rotated so chips stay flat on the ring) */}
        {NODES.map((n, i) => (
          <div
            key={i}
            className="absolute left-1/2 top-1/2"
            style={
              {
                "--orbit-r": `${n.r}px`,
                animation: `orbit ${n.dur}s linear infinite`,
                animationDelay: `${n.delay}s`,
              } as React.CSSProperties
            }
          >
            <div
              className={`grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl border shadow-glow-sm [transform:rotateX(-62deg)] ${
                n.kind === "usdc"
                  ? "border-usdc/50 bg-usdc/15 text-usdc-l"
                  : "border-blue/50 bg-card text-blue-l"
              }`}
            >
              {n.kind === "usdc" ? (
                <UsdcGlyph />
              ) : (
                <span className="font-display text-sm font-semibold">{n.label}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* central payment core (upright, above the tilted stage) */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="relative grid h-24 w-24 place-items-center rounded-[28px] border border-border2 bg-card/90 shadow-glow backdrop-blur-xl">
          <div className="absolute inset-0 animate-pulse-glow rounded-[28px] bg-blue-violet opacity-20 blur-md" />
          <PolarisMark size={46} />
        </div>
      </div>

      {/* flow lines pulsing outward */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 520 520" fill="none">
        {[40, 140, 250, 330, 430].map((_, i) => (
          <circle
            key={i}
            cx="260"
            cy="260"
            r={70 + i * 30}
            stroke="url(#flow)"
            strokeWidth="1"
            strokeDasharray="4 10"
            className="animate-dash"
            style={{ animationDuration: `${10 + i * 3}s`, opacity: 0.35 }}
          />
        ))}
        <defs>
          <linearGradient id="flow" x1="0" y1="0" x2="520" y2="520">
            <stop stopColor="rgb(var(--c-blue))" />
            <stop offset="1" stopColor="rgb(var(--c-purple))" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

function UsdcGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="12" fill="#2775CA" />
      <path
        d="M12 5.2c-.5 0-.9.4-.9.9v.5c-1.6.2-2.7 1.1-2.7 2.5 0 1.6 1.2 2.2 2.9 2.6 1.3.3 1.6.6 1.6 1.1 0 .5-.5.9-1.3.9-1 0-1.6-.4-1.8-1-.1-.4-.4-.6-.8-.6-.5 0-.9.4-.8.9.2 1.1 1.1 1.8 2.4 2v.5c0 .5.4.9.9.9s.9-.4.9-.9v-.5c1.7-.2 2.8-1.2 2.8-2.6 0-1.6-1.2-2.3-3-2.7-1.2-.3-1.5-.6-1.5-1 0-.5.4-.8 1.2-.8.8 0 1.3.3 1.5.9.1.3.4.5.8.5.5 0 .9-.5.7-1-.3-.9-1-1.5-2-1.7v-.5c0-.5-.4-.9-.9-.9z"
        fill="#fff"
      />
    </svg>
  );
}
