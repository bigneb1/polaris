import { Moon } from "lucide-react";

export default function ThemeToggle() {
  return (
    <button type="button" className="tool-btn" aria-label="Dark theme enabled" title="Dark theme">
      <Moon className="h-3.5 w-3.5" />
    </button>
  );
}
