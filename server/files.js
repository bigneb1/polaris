import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Parse a task for output specifications the agent must honour: target word
 * count, page/chapter count, "comprehensive" intent, and the requested file
 * format. Drives the deliverable length + format so "write 500 words / a
 * 5-chapter thesis / a CSV / a PDF" is actually satisfied.
 */
export function parseSpec({ title = "", description = "", rubric = "" } = {}) {
  const text = `${title}\n${description}\n${rubric}`.toLowerCase();

  let words = 0;
  const wm = text.match(/(\d[\d,]*)\s*(?:\+|\bplus\b|or more)?\s*words?\b/);
  if (wm) words = parseInt(wm[1].replace(/,/g, ""), 10) || 0;

  let pages = 0;
  const pm = text.match(/(\d+)\s*pages?\b/);
  if (pm) pages = parseInt(pm[1], 10) || 0;
  const chap = text.match(/(\d+)[\s-]*chapters?\b/);
  if (chap) pages = Math.max(pages, (parseInt(chap[1], 10) || 0) * 4); // ~4 pages/chapter

  const comprehensive = /\b(comprehensive|detailed|in[-\s]?depth|thorough|extensive|full (?:thesis|report|guide|document|analysis)|complete)\b/.test(text);

  // Format only when stated as an OUTPUT/deliverable format (avoid false hits like
  // "an article about JSON").
  const ctx = /(?:as|in|to|into|output|deliver|export|provide|format|file|version|\.)\s*(?:an?\s+)?/;
  const fmt = (name) => new RegExp(`${ctx.source}${name}\\b|\\b${name}\\s*(?:file|format|document|version)`, "i").test(text);
  let format = "text";
  if (fmt("pdf")) format = "pdf";
  else if (fmt("csv")) format = "csv";
  else if (fmt("json")) format = "json";
  else if (fmt("html")) format = "html";
  else if (fmt("markdown") || /\.md\b/.test(text)) format = "markdown";

  return { words, pages, comprehensive, format };
}

/** How many output tokens to allow, based on the requested length. */
export function tokensFor({ words, pages, comprehensive }) {
  let t = 1800;
  if (words) t = Math.ceil(words * 1.7) + 400;
  else if (pages) t = pages * 850;
  else if (comprehensive) t = 6000;
  return Math.max(1800, Math.min(12000, t));
}

/** Instruction appended to the system prompt so the model emits the exact format. */
export function formatInstruction(format) {
  switch (format) {
    case "csv": return "Output ONLY valid CSV — a header row then data rows, comma-separated, with fields containing commas wrapped in double quotes. No prose, no explanation, no code fences.";
    case "json": return "Output ONLY valid, parseable JSON. No prose, no comments, no code fences.";
    case "html": return "Output ONLY a complete, valid, self-contained HTML document (doctype + head + body). No prose outside the HTML.";
    case "markdown": return "Format the entire deliverable in clean, well-structured Markdown.";
    case "pdf": return "Write a well-structured, professional document using Markdown-style headings (# / ## / ###) and paragraphs. It will be rendered to a PDF file.";
    default: return "";
  }
}

/**
 * Detect common build/dev/ideation intents and return a tailored instruction so
 * the agent delivers the RIGHT kind of work (code, a PR review/fix, or an idea
 * list) — not just prose.
 */
export function intentInstruction({ title = "", description = "", rubric = "", taskType = "" } = {}) {
  const t = `${title}\n${description}\n${rubric}`.toLowerCase();
  const ty = String(taskType).toLowerCase();
  if (ty === "code-review" || /\b(pull request|\bpr\b|resolve (?:this |the )?pr|review (?:this |the )?pr|code[-\s]?review|fix (?:this |the )?pr)\b/.test(t))
    return "This is a code-review / PR task. Deliver: (1) a concise review of the key issues, (2) concrete fixes as code snippets or diffs, and (3) a short summary of exactly what to change. Reference specific files/functions where possible.";
  if (["build-app", "website"].includes(ty) || /\b(build|make|create|develop)\b.*\b(app|application|web ?app|website|web ?site|landing page|web page|webpage|dashboard|ui|frontend|site)\b/.test(t))
    return "This is a build task. Deliver working, runnable code: the key file(s) in fenced code blocks with correct filenames, plus a brief run/build guide. Prefer a single, self-contained implementation that works out of the box.";
  if (ty === "ideas" || /\b(hackathon|project|app|startup)\s+ideas?\b|\bideas?\s+(?:to|for)\s+build\b|\bwhat (?:to|should i) build\b/.test(t))
    return "This is an ideation task. Deliver a structured list of 5–8 buildable ideas; for each give a title, a one-line pitch, a suggested tech stack, and why it's compelling.";
  return "";
}

/** Strip stray ``` code fences the model may wrap structured output in. */
export function stripFences(out, format) {
  if (!["csv", "json", "html", "markdown"].includes(format)) return out;
  return out.replace(/^\s*```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

/**
 * Render text (plain or lightweight Markdown) into a paginated A4 PDF and return
 * it as a data:application/pdf URI. Standard PDF fonts are Latin-1 only, so
 * non-ASCII characters are stripped to avoid encode errors.
 */
export async function textToPdf(text, title = "Document") {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [pageW, pageH] = [595.28, 841.89]; // A4
  const margin = 56, size = 11, lineH = 15.5, maxW = pageW - margin * 2;

  let page = pdf.addPage([pageW, pageH]);
  let y = pageH - margin;
  const ascii = (s) => s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  const wrap = (para, f, s) => {
    const out = [];
    let cur = "";
    for (const w of ascii(para).split(/\s+/)) {
      const test = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(test, s) > maxW && cur) { out.push(cur); cur = w; } else cur = test;
    }
    if (cur) out.push(cur);
    return out.length ? out : [""];
  };
  const draw = (line, f = font, s = size) => {
    if (y < margin) { page = pdf.addPage([pageW, pageH]); y = pageH - margin; }
    page.drawText(line, { x: margin, y, size: s, font: f, color: rgb(0.12, 0.12, 0.14) });
    y -= f === bold ? s + 5 : lineH;
  };

  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) { y -= lineH * 0.5; continue; }
    const h = raw.match(/^(#{1,3})\s+(.*)/);
    if (h) { y -= 4; for (const l of wrap(h[2], bold, size + 3 - h[1].length)) draw(l, bold, size + 3 - h[1].length); continue; }
    const bullet = raw.replace(/^\s*[-*]\s+/, "• ").replace(/\*\*(.*?)\*\*/g, "$1");
    for (const l of wrap(bullet, font, size)) draw(l);
  }
  const bytes = await pdf.save();
  return `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`;
}
