import { useState, type ReactNode } from "react";
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
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground overflow-hidden">
      <TitleBar />
      <SectionTabs />
      <Toolbar breadcrumb={breadcrumb}>
        {toolbar}
        {panel && (
          <button onClick={() => setPanelOpen(true)} className="tool-btn lg:hidden ml-auto" title="Show details">
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        )}
      </Toolbar>

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
        {panel && <StudioPanel>{panel}</StudioPanel>}
      </div>

      <StatusBar />

      {panel && (
        <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
          <SheetContent side="right" className="w-[85vw] max-w-xs p-0 bg-card border-border overflow-y-auto">
            {panel}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
