/**
 * AgentAvatar — the landing hero figure. A sleek AI-agent bust (not a generic
 * orbit): rounded head with a gradient visor, glowing eyes, a Polaris-star
 * antenna, and a subtle USDC chip on the chest. Pure SVG + CSS so it's crisp,
 * theme-aware, and lightweight. Gentle float — no busy motion.
 */
export default function AgentAvatar() {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[460px] select-none">
      {/* ambient glow */}
      <div className="absolute inset-[14%] animate-pulse-glow rounded-full bg-blue/25 blur-3xl" />
      <div className="absolute inset-[30%] rounded-full bg-purple/20 blur-2xl" />

      <div className="animate-float-slow relative">
        <svg viewBox="0 0 320 320" className="h-full w-full drop-shadow-2xl" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="visor" x1="90" y1="96" x2="230" y2="190" gradientUnits="userSpaceOnUse">
              <stop stopColor="#5B9BFF" />
              <stop offset="0.5" stopColor="#2D7EF8" />
              <stop offset="1" stopColor="#7C3AED" />
            </linearGradient>
            <linearGradient id="shell" x1="70" y1="70" x2="250" y2="280" gradientUnits="userSpaceOnUse">
              <stop stopColor="rgb(var(--c-card))" />
              <stop offset="1" stopColor="rgb(var(--c-panel))" />
            </linearGradient>
            <linearGradient id="star" x1="140" y1="20" x2="180" y2="64" gradientUnits="userSpaceOnUse">
              <stop stopColor="#5B9BFF" />
              <stop offset="1" stopColor="#7C3AED" />
            </linearGradient>
            <radialGradient id="eye" cx="0.5" cy="0.4" r="0.6">
              <stop stopColor="#EAF2FF" />
              <stop offset="1" stopColor="#5B9BFF" />
            </radialGradient>
          </defs>

          {/* antenna + Polaris star */}
          <line x1="160" y1="60" x2="160" y2="92" stroke="rgb(var(--c-border2))" strokeWidth="4" strokeLinecap="round" />
          <path d="M160 18 L168 40 L190 48 L168 56 L160 78 L152 56 L130 48 L152 40 Z" fill="url(#star)" className="animate-pulse-glow" style={{ transformOrigin: "160px 48px" }} />

          {/* shoulders / bust */}
          <path d="M64 300 Q64 232 160 232 Q256 232 256 300 Z" fill="url(#shell)" stroke="rgb(var(--c-border2))" strokeWidth="2" />
          {/* USDC chip on chest */}
          <circle cx="160" cy="270" r="15" fill="#2775CA" />
          <text x="160" y="276" textAnchor="middle" fontSize="16" fontWeight="700" fill="#fff" fontFamily="JetBrains Mono, monospace">$</text>

          {/* head shell */}
          <rect x="84" y="86" width="152" height="132" rx="38" fill="url(#shell)" stroke="rgb(var(--c-border2))" strokeWidth="2" />
          {/* side ears */}
          <rect x="72" y="132" width="16" height="40" rx="7" fill="rgb(var(--c-panel))" stroke="rgb(var(--c-border2))" strokeWidth="2" />
          <rect x="232" y="132" width="16" height="40" rx="7" fill="rgb(var(--c-panel))" stroke="rgb(var(--c-border2))" strokeWidth="2" />

          {/* visor */}
          <rect x="100" y="108" width="120" height="78" rx="26" fill="url(#visor)" />
          <rect x="100" y="108" width="120" height="78" rx="26" fill="#000" fillOpacity="0.12" />
          {/* eyes */}
          <circle cx="138" cy="148" r="11" fill="url(#eye)" className="animate-pulse-glow" />
          <circle cx="182" cy="148" r="11" fill="url(#eye)" className="animate-pulse-glow" style={{ animationDelay: "0.6s" }} />
          {/* smile / status line */}
          <path d="M138 170 Q160 182 182 170" stroke="#EAF2FF" strokeOpacity="0.8" strokeWidth="3" strokeLinecap="round" fill="none" />
        </svg>
      </div>

      {/* floating accent chips */}
      <div className="absolute -left-2 top-10 animate-float rounded-xl border border-border2 bg-card/90 px-3 py-1.5 text-[10px] mono text-blue-l shadow-glow-sm backdrop-blur">
        bidding…
      </div>
      <div className="absolute -right-1 bottom-16 animate-float-slow rounded-xl border border-border2 bg-card/90 px-3 py-1.5 text-[10px] mono text-green shadow-glow-sm backdrop-blur">
        +USDC settled
      </div>
    </div>
  );
}
