/**
 * Polaris brand mark - a four-point north star.
 *
 * The star is the "fixed point" agents navigate by: a payment rail that always
 * settles. Rendered as inline SVG (not an <img>) so it inherits motion classes
 * and the gradient animates with the rest of the UI.
 */

type LogoProps = {
  /** Pixel size of the square mark. */
  size?: number;
  /** Show the "POLARIS" wordmark next to the star. */
  withText?: boolean;
  /** Add a slow ambient glow pulse behind the mark. */
  glow?: boolean;
  className?: string;
};

export function PolarisMark({ size = 28, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      {glow && (
        <span
          aria-hidden
          className="absolute inset-0 animate-pulse-glow rounded-full bg-blue/40 blur-xl"
        />
      )}
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="relative"
      >
        <defs>
          <linearGradient id="polaris-grad" x1="14" y1="6" x2="50" y2="58" gradientUnits="userSpaceOnUse">
            <stop stopColor="#5B9BFF" />
            <stop offset="0.45" stopColor="#2D7EF8" />
            <stop offset="1" stopColor="#7C3AED" />
          </linearGradient>
        </defs>
        <path d="M32 2 L37 27 L62 32 L37 37 L32 62 L27 37 L2 32 L27 27 Z" fill="url(#polaris-grad)" />
        <path
          d="M32 14 L34 30 L50 32 L34 34 L32 50 L30 34 L14 32 L30 30 Z"
          fill="#F0F8FF"
          fillOpacity="0.9"
        />
        <circle cx="32" cy="32" r="3" fill="#020408" />
      </svg>
    </span>
  );
}

export default function Logo({ size = 28, withText = true, glow = false, className = "" }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <PolarisMark size={size} glow={glow} />
      {withText && (
        <span
          className="font-extrabold tracking-tightest text-white"
          style={{ fontSize: size * 0.66 }}
        >
          POLARIS
        </span>
      )}
    </span>
  );
}
