import { useEffect, useState } from "react";

/** Live "next in 2d 3h 14m" countdown to a target timestamp (recurring deliveries). */
export function Countdown({ to, className }: { to?: number | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!to) return null;
  const ms = to - now;
  if (ms <= 0) return <span className={className}>due now</span>;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const label = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  return <span className={className}>next in {label}</span>;
}
