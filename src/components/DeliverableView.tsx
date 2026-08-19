import { Download } from "lucide-react";

/** Infer a filename extension + MIME from a deliverable string. */
function inferFile(content: string): { ext: string; mime: string } {
  if (content.startsWith("data:application/pdf")) return { ext: "pdf", mime: "application/pdf" };
  if (content.startsWith("data:image/")) {
    const m = content.match(/^data:image\/([a-zA-Z]+)/);
    return { ext: m?.[1] || "png", mime: `image/${m?.[1] || "png"}` };
  }
  const t = content.trimStart().toLowerCase();
  if (t.startsWith("<!doctype html") || t.startsWith("<html")) return { ext: "html", mime: "text/html" };
  try {
    const j = content.trim();
    if ((j.startsWith("{") || j.startsWith("[")) && JSON.parse(j)) return { ext: "json", mime: "application/json" };
  } catch { /* not json */ }
  // CSV heuristic: multiple lines, commas, roughly consistent column counts.
  const lines = content.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length >= 2 && lines.slice(0, 5).every((l) => l.includes(","))) return { ext: "csv", mime: "text/csv" };
  return { ext: "txt", mime: "text/plain" };
}

function download(content: string, title: string) {
  const { ext, mime } = inferFile(content);
  const name = `${(title || "deliverable").replace(/[^a-z0-9]+/gi, "-").slice(0, 40).toLowerCase()}.${ext}`;
  const a = document.createElement("a");
  if (content.startsWith("data:")) {
    a.href = content;
  } else {
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  }
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Render a deliverable by type (image / PDF / text) with a Download control. */
export function DeliverableView({ content, title = "deliverable", compact = false }: { content: string; title?: string; compact?: boolean }) {
  const isImage = content.startsWith("data:image/");
  const isPdf = content.startsWith("data:application/pdf");
  return (
    <div className="flex flex-col gap-2">
      {isImage ? (
        <img src={content} alt="deliverable" className={`mx-auto max-w-full rounded-lg ${compact ? "max-h-72" : "max-h-[500px]"}`} />
      ) : isPdf ? (
        <iframe src={content} title="deliverable-pdf" className={`w-full rounded-lg border border-border ${compact ? "h-72" : "h-[520px]"}`} />
      ) : (
        <pre className={`overflow-y-auto whitespace-pre-wrap break-words font-sans leading-relaxed text-muted-foreground ${compact ? "max-h-60 text-[13px]" : "max-h-[480px] text-sm"}`}>{content}</pre>
      )}
      <button onClick={() => download(content, title)} className="font-mono inline-flex items-center gap-1.5 self-start text-[11px] text-muted-foreground transition-colors hover:text-primary">
        <Download size={12} /> Download {inferFile(content).ext.toUpperCase()}
      </button>
    </div>
  );
}
