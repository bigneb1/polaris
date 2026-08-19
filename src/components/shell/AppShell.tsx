import { useEffect, useState, type ReactNode } from "react";
import { PanelRight } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { TitleBar } from "./TitleBar";
import { SectionTabs } from "./SectionTabs";
import { Toolbar } from "./Toolbar";
import { StudioPanel } from "./StudioPanel";
import { StatusBar } from "./StatusBar";

/**
 * The application chrome, modelled on the ProofWork studio shell.
 *
 * The layout is fixed to the viewport (`h-dvh`) and ONLY `<main>` scrolls. That is
 * what makes the app feel like a tool rather than a document: the title bar, the
 * section tabs, the toolbar and the status bar stay put while content moves under
 * them, and a long task list can never push the wallet button off screen.
 *
 * The right-hand details panel is a first-class part of the layout on wide screens
 * and becomes a drawer under `lg`, so a phone gets the full width for content while
 * the same metadata stays one tap away.
 */
/** Persisted so the panel stays where the reader left it, across pages and sessions. */
const PANEL_KEY = "polaris-panel-open";

export function AppShell({
  children,
  toolbar,
  breadcrumb,
  panel,
}: {
  children: ReactNode;
  /** Toolbar contents: search, filter chips, the page's primary action. */
  toolbar?: ReactNode;
  /** Shown with a back button, for detail pages. */
  breadcrumb?: string;
  /** Right-hand panel contents, built from PanelSection / PanelRow. */
  panel?: ReactNode;
}) {
  // Two different surfaces, one control. Under `lg` the panel is a drawer, so the
  // button opens a Sheet; at `lg` and up it is a column, so the same button collapses
  // it and gives the width back to the content. Collapsing was previously only
  // possible on a phone, which is backwards: the desktop is where a 280px column
  // competes with a wide table.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(
    () => localStorage.getItem(PANEL_KEY) === "collapsed",
  );
  useEffect(() => {
    localStorage.setItem(PANEL_KEY, panelCollapsed ? "collapsed" : "open");
  }, [panelCollapsed]);

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground overflow-hidden">
      <TitleBar />
      <SectionTabs />
      <Toolbar breadcrumb={breadcrumb}>
        {toolbar}
        {panel && (
          <>
            <button
              onClick={() => setDrawerOpen(true)}
              className="tool-btn ml-auto lg:hidden"
              title="Show details"
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setPanelCollapsed((v) => !v)}
              data-active={!panelCollapsed}
              className="tool-btn ml-auto hidden lg:inline-flex"
              title={panelCollapsed ? "Show details panel" : "Hide details panel"}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </Toolbar>

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
        {panel && !panelCollapsed && <StudioPanel>{panel}</StudioPanel>}
      </div>

      <StatusBar />

      {panel && (
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="right" className="w-[85vw] max-w-xs p-0 bg-card border-border overflow-y-auto">
            {panel}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
