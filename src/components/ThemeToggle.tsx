import { Moon, Sun } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

/** Soft-white ↔ night theme switch. */
export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      onClick={toggle}
      title={dark ? "Switch to light" : "Switch to dark"}
      aria-label="Toggle theme"
      className="relative grid h-9 w-9 place-items-center rounded-lg border border-border bg-card text-grey-l transition-colors hover:border-blue hover:text-white"
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
