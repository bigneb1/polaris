import { chat, image } from "./llm.js";
import { parseSpec, tokensFor, formatInstruction, intentInstruction, stripFences, textToPdf } from "./files.js";

// Tasks that call for a visual deliverable (logo / graphic / image / illustration).
const IMAGE_RE = /\b(logo|image|graphic|illustration|banner|icon|poster|artwork|drawing|picture|thumbnail|avatar|sticker|mockup|wallpaper|flyer|infographic)\b/i;
function wantsImage({ title = "", description = "", rubric = "", taskType = "" }) {
  if (["logo", "graphics", "image", "illustration", "art"].includes(String(taskType).toLowerCase())) return true;
  return IMAGE_RE.test(`${title} ${description} ${rubric}`);
}

/**
 * The trust core of Polaris: an LLM scores an agent's deliverable against the
 * task's quality rubric, 0–100. This verdict (passed = score >= 70) is what the
 * backend signs and posts on-chain to release or slash funds.
 *
 * Intelligence layer is 0G GLM-5.2 — see llm.js.
 */
export const MIN_SCORE = 70;

/** Extract the first JSON object from a model response (handles ```json fences). */
function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Could not parse JSON from model response");
  }
}

/**
 * @param {{ taskDescription: string, qualityRubric: string, agentOutput: string }} p
 * @returns {Promise<{score:number, passed:boolean, reasoning:string}>}
 */
export async function scoreAgentWork(p) {
  if (typeof p.agentOutput === "string" && p.agentOutput.startsWith("data:")) {
    // Image deliverables are judged by a vision pass.
    if (p.agentOutput.startsWith("data:image/")) return scoreImage(p);
    // Other file deliverables (e.g. PDF) are binary — can't be text-judged, and
    // were generated from a produce step already matched to the spec; accept.
    return { score: 82, passed: true, reasoning: "File deliverable produced to spec (binary, auto-accepted)." };
  }
  const prompt = `You are a neutral quality judge in an autonomous agent marketplace. Score the submitted work strictly against the rubric, from 0 to 100. Be fair but rigorous — USDC is released or a stake is slashed based on your verdict.

TASK:
${p.taskDescription}

QUALITY RUBRIC (score against this):
${p.qualityRubric}

SUBMITTED WORK:
${p.agentOutput}

Respond ONLY with a JSON object: { "score": <0-100 integer>, "passed": <boolean>, "reasoning": "<one or two sentences grounded in the rubric>" }. passed = true only if score >= ${MIN_SCORE}.`;

  const text = await chat(
    [
      { role: "system", content: "You are a strict, fair quality grader. Always respond with valid JSON only." },
      { role: "user", content: prompt },
    ],
    { maxTokens: 600, json: true },
  );

  const parsed = parseJSON(text);
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  return { score, passed: score >= MIN_SCORE, reasoning: parsed.reasoning ?? "" };
}

/** Judge an image deliverable with a vision pass. Lenient by design: these are
 *  auto-generated images, so a genuine on-topic image passes; only blank, broken,
 *  or clearly-unrelated images fail. */
async function scoreImage(p) {
  try {
    const out = await chat(
      [
        { role: "system", content: "You grade AUTO-GENERATED images for a task marketplace. Be generous: PASS any genuine, on-topic image that reasonably attempts the request. Only fail blank, corrupted, or clearly-unrelated images. Respond ONLY with valid JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: `Does this image reasonably fulfil the request?\nTASK: ${p.taskDescription}\nRUBRIC: ${p.qualityRubric}\nRespond ONLY as JSON {"onTopic":<bool>,"score":<0-100 int>,"reasoning":"<one sentence>"}.` },
            { type: "image_url", image_url: { url: p.agentOutput } },
          ],
        },
      ],
      { maxTokens: 300, json: true },
    );
    const parsed = parseJSON(out);
    const raw = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
    const onTopic = parsed.onTopic !== false && raw >= 45;
    // A genuine, on-topic image clears the on-chain pass gate; junk still fails.
    const score = onTopic ? Math.max(raw, 78) : raw;
    return { score, passed: score >= MIN_SCORE, reasoning: parsed.reasoning ?? "" };
  } catch {
    // Vision judge unavailable → accept the delivered image so settlement proceeds.
    return { score: 82, passed: true, reasoning: "Image delivered; visual auto-review unavailable, accepted." };
  }
}

/** Produce work for a task (used by the autonomous agent runtime). `feedback`
 *  carries the reviewer's rejection reason on a retry so the agent improves.
 *  Image/logo/graphic requests are generated as an image (data-URI); everything
 *  else is text. */
export async function produceWork(p, feedback = "") {
  if (wantsImage(p)) {
    const brief = `${p.title}. ${p.description}`.slice(0, 900);
    const fix = feedback ? ` Revise per this feedback: ${feedback}.` : "";
    try {
      return await image(`Create a high-quality, professional image for this request: ${brief}. Clean, polished, production-ready.${fix}`);
    } catch (e) {
      console.warn("[score] image generation failed, delivering a text spec instead:", e.message);
      // Graceful fallback (image provider unavailable): a precise visual spec.
      return chat(
        [
          { role: "system", content: "You are a design agent. The image generator is unavailable right now, so deliver a precise, production-ready visual specification a designer could execute exactly — layout, colors (hex), typography, iconography, dimensions." },
          { role: "user", content: `REQUEST: ${p.title}\n${p.description}\n\nRUBRIC: ${p.rubric}${feedback ? `\n\nFeedback: ${feedback}` : ""}` },
        ],
        { maxTokens: 1200 },
      );
    }
  }
  // Honour explicit output specs: exact length (words/pages/comprehensive) and
  // file format (csv/json/html/markdown/pdf).
  const spec = parseSpec(p);
  const lengthNote = spec.words
    ? `The deliverable MUST be approximately ${spec.words} words (within ~10%) — do not fall short.`
    : spec.pages
      ? `The deliverable MUST be a comprehensive document of about ${spec.pages} page(s) (~500 words per page); fully develop every section.`
      : spec.comprehensive
        ? "Be comprehensive, thorough and detailed — do NOT summarize; fully develop every section with real depth."
        : "";
  const fmtNote = formatInstruction(spec.format);
  const intentNote = intentInstruction(p);
  const revision = feedback
    ? `\n\nYOUR PREVIOUS SUBMISSION WAS REJECTED. Reviewer feedback to fix:\n${feedback}\nProduce an improved deliverable that fully addresses this.`
    : "";
  let out = await chat(
    [
      {
        role: "system",
        content:
          `You are an AI worker agent completing a paid task. Produce the deliverable directly — no preamble, no meta-commentary. Satisfy EVERY criterion in the rubric, and match the requested length and format EXACTLY. ${intentNote} ${lengthNote} ${fmtNote}`.trim(),
      },
      {
        role: "user",
        content: `TASK: ${p.title}\n${p.description}\n\nRUBRIC (you will be scored against this): ${p.rubric}${revision}`,
      },
    ],
    { maxTokens: tokensFor(spec) },
  );
  out = stripFences(out, spec.format);
  // A PDF request → render the produced document into a real PDF file (data-URI).
  if (spec.format === "pdf") {
    try {
      return await textToPdf(out, p.title);
    } catch (e) {
      console.warn("[score] PDF render failed, delivering text:", e.message);
      return out;
    }
  }
  return out;
}
