/** @type {import('tailwindcss').Config} */

// Every color is an RGB-channel CSS variable so (a) Tailwind alpha modifiers
// like bg-card/80 keep working and (b) light/dark themes swap by changing the
// variables in index.css. Token NAMES are unchanged so existing classes
// (bg-card, text-white, text-grey-l, border-border…) become theme-aware.
const c = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        void: c("--c-void"),
        deep: c("--c-deep"),
        panel: c("--c-panel"),
        card: c("--c-card"),
        border: c("--c-border"),
        border2: c("--c-border2"),
        blue: { DEFAULT: c("--c-blue"), l: c("--c-blue-l"), d: c("--c-blue-d") },
        usdc: { DEFAULT: c("--c-usdc"), l: c("--c-usdc-l") },
        purple: c("--c-purple"),
        violet: c("--c-violet"),
        green: c("--c-green"),
        amber: c("--c-amber"),
        red: c("--c-red"),
        white: c("--c-text"),
        "grey-l": c("--c-text-muted"),
        grey: c("--c-text-faint"),
      },
      fontFamily: {
        sans: ["Outfit", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
        display: ["Fraunces", "Outfit", "Georgia", "serif"],
      },
      letterSpacing: { tightest: "-0.04em" },
      boxShadow: {
        glow: "0 0 60px -12px rgb(var(--c-blue) / 0.45)",
        "glow-sm": "0 0 28px -8px rgb(var(--c-blue) / 0.4)",
        panel: "var(--shadow-panel)",
        soft: "var(--shadow-soft)",
      },
      backgroundImage: {
        "blue-violet": "linear-gradient(110deg, rgb(var(--c-blue-l)) 0%, rgb(var(--c-blue)) 38%, rgb(var(--c-purple)) 100%)",
        "grid-faint":
          "linear-gradient(to right, rgb(var(--c-border) / 0.6) 1px, transparent 1px), linear-gradient(to bottom, rgb(var(--c-border) / 0.6) 1px, transparent 1px)",
      },
      keyframes: {
        "fade-up": { "0%": { opacity: "0", transform: "translateY(24px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        "pulse-glow": { "0%, 100%": { opacity: "0.5", transform: "scale(1)" }, "50%": { opacity: "1", transform: "scale(1.08)" } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "slide-marquee": { "0%": { transform: "translateX(0)" }, "100%": { transform: "translateX(-50%)" } },
        "star-spin": { "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(360deg)" } },
        float: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-14px)" } },
        "float-slow": { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-22px)" } },
        "spin-slow": { to: { transform: "rotate(360deg)" } },
        "spin-rev": { to: { transform: "rotate(-360deg)" } },
        "orbit": { from: { transform: "rotate(0deg) translateX(var(--orbit-r)) rotate(0deg)" }, to: { transform: "rotate(360deg) translateX(var(--orbit-r)) rotate(-360deg)" } },
        "dash": { to: { "stroke-dashoffset": "-1000" } },
      },
      animation: {
        "fade-up": "fade-up 0.7s cubic-bezier(0.16,1,0.3,1) both",
        "fade-in": "fade-in 0.9s ease-out both",
        "pulse-glow": "pulse-glow 4s ease-in-out infinite",
        shimmer: "shimmer 1.6s infinite",
        marquee: "slide-marquee 36s linear infinite",
        "star-spin": "star-spin 90s linear infinite",
        float: "float 6s ease-in-out infinite",
        "float-slow": "float-slow 9s ease-in-out infinite",
        "spin-slow": "spin-slow 28s linear infinite",
        "spin-rev": "spin-rev 36s linear infinite",
        "dash": "dash 14s linear infinite",
      },
    },
  },
  plugins: [],
};
