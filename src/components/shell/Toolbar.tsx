import { Children, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * The per-page action row: a back button and breadcrumb for detail pages, then
 * whatever the page needs (search, filter chips, its primary action).
 *
 * Renders nothing when a page supplies neither, so a page without actions does not
 * pay for an empty bar.
 */
export function Toolbar({ children, breadcrumb }: { children?: ReactNode; breadcrumb?: string }) {
  const navigate = useNavigate();
  const hasContent = Children.toArray(children).filter(Boolean).length > 0;
  if (!hasContent && !breadcrumb) return null;

  return (
    <div className="min-h-10 shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-border bg-card">
      {breadcrumb && (
        <>
          <button onClick={() => navigate(-1)} className="tool-btn h-7 px-1.5 shrink-0" title="Back">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs text-muted-foreground font-mono mr-1 truncate max-w-[45vw] sm:max-w-xs">
            {breadcrumb}
          </span>
          <div className="w-px h-4 bg-border mr-1 hidden sm:block" />
        </>
      )}
      {children}
    </div>
  );
}
