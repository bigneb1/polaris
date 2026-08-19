import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toasts, wired to the app's tokens.
 *
 * ProofWork's version reads the active theme from `next-themes`; Polaris is dark only,
 * so the theme is fixed and that dependency is not needed.
 */
const Toaster = ({ ...props }: ToasterProps) => (
  <Sonner
    theme="dark"
    className="toaster group"
    style={
      {
        "--normal-bg": "hsl(var(--popover))",
        "--normal-text": "hsl(var(--popover-foreground))",
        "--normal-border": "hsl(var(--border))",
      } as React.CSSProperties
    }
    {...props}
  />
);

export { Toaster };
