import { useEffect } from "react";

/**
 * Scroll-reveal: any element with the `.reveal` class fades/slides in when it
 * scrolls into view. Drives the kinetic, sectioned feel of the landing pages
 * (inspired by tresmarescapital.com). Re-runs the observer whenever `deps`
 * change so content rendered after async data loads still animates.
 */
export function useReveal(deps: unknown[] = []) {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal:not(.in)"));
    if (!els.length) return;

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );

    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
