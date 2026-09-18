import { chat, image, SCHEMAS } from "./llm.js";
import { parseSpec, tokensFor, formatInstruction, intentInstruction, stripFences, textToPdf } from "./files.js";

// Tasks that call for a visual deliverable (logo / graphic / image / illustration).
const IMAGE_RE = /\b(logo|image|graphic|illustration|banner|icon|poster|artwork|drawing|picture|thumbnail|avatar|sticker|mockup|wallpaper|flyer|infographic)\b/i;
function wantsImage({ title = "", description = "", rubric = "", taskType = "" }) {
  if (["logo", "graphics", "image", "illustration", "art"].includes(String(taskType).toLowerCase())) return true;
  return IMAGE_RE.test(`${title} ${description} ${rubric}`);
}

/**
 * Work production, and the gate in front of adjudication.
 *
 * This file no longer decides whether anyone gets paid — GenLayer validators do, in
 * server/genlayer.js. What stays here is the part GenLayer cannot do: its adjudicator
 * reads TEXT, so something has to decide what text a deliverable actually presents to
 * a validator, and refuse the ones that present none.
 *
 * That refusal is load-bearing. Both binary branches below once returned a passing
 * verdict for a deliverable nobody had read, and any agent could farm payouts by
 * submitting an image or a PDF. Handing a raw `data:` URI to GenLayer instead would
 * reintroduce exactly that: validators would grade a base64 blob.
 *
 * Intelligence layer: OpenRouter — see llm.js.
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
 * The verdict returned when work cannot be graded.
 *
 * It must NOT pass. Both binary branches here used to return `{score: 82, passed:
 * true}`, which released escrow for a deliverable nobody had read: any agent could
 * farm payouts by submitting an image or a PDF. "Settlement proceeds" is not worth
 * more than the verdict being real, and the caller already has a safe path for a
 * non-passing verdict (reject with feedback, retry, slash only on a late final
 * failure). `ungradeable` also marks it as NOT the agent's fault, so it never
 * becomes slash-eligible — see the slash gate in server.js.
 */
function ungradeable(reasoning) {
  return { score: 0, passed: false, ungradeable: true, reasoning };
}

/**
 * Resolve a deliverable to the text GenLayer validators should judge.
 *
 * Returns either `{ text }` to adjudicate, or a non-passing `ungradeable` verdict to
 * use as-is — in which case no adjudication is requested at all, which also means no
 * validators are paid to read something unreadable.
 *
 * @param {{ taskDescription: string, qualityRubric: string, agentOutput: string, gradeableText?: string }} p
 * @returns {Promise<{text: string} | {score:number, passed:false, ungradeable:true, reasoning:string}>}
 */
export async function prepareForAdjudication(p) {
  if (typeof p.agentOutput === "string" && p.agentOutput.startsWith("data:")) {
    if (p.agentOutput.startsWith("data:image/")) {
      // GenLayer's adjudicator cannot see. A vision pass is therefore the only thing
      // that can report what the image ACTUALLY contains, and validators judge that
      // report against the rubric. Note this describes the delivered image, not the
      // brief that asked for it — grading an image by its own brief would pay an
      // agent for work that does not match its own description.
      const seen = await scoreImage(p);
      if (seen.ungradeable) return seen;
      return {
        text:
          `IMAGE DELIVERABLE. Validators cannot see it; an independent vision pass ` +
          `examined the delivered image and reported:\n\n${seen.reasoning}\n\n` +
          `Judge that report against the rubric. The image itself is what the requester ` +
          `receives and what is hashed on chain.`,
      };
    }
    // Other file deliverables (PDF and the like) cannot be read as text. If the
    // producer supplied the source text it rendered from, grade THAT: the file is
    // still what the requester receives and what gets hashed on chain, but the
    // judgement is made against real content instead of being assumed.
    if (p.gradeableText && String(p.gradeableText).trim()) return { text: String(p.gradeableText) };
    return ungradeable(
      "Binary deliverable with no gradeable text supplied, so it could not be judged against the rubric. Submit the work as text, or include the source text alongside the file.",
    );
  }
  return { text: p.agentOutput };
}

/** Look at an image deliverable and report what it contains. Lenient by design:
 *  these are auto-generated images, so a genuine on-topic image is described
 *  favourably; blank, corrupted or clearly-unrelated ones are not. The score here no
 *  longer settles anything — it only shapes the report GenLayer validators read. */
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
      { maxTokens: 300, json: true, schema: SCHEMAS.imageVerdict },
    );
    const parsed = parseJSON(out);
    const raw = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
    const onTopic = parsed.onTopic !== false && raw >= 45;
    // A genuine, on-topic image clears the on-chain pass gate; junk still fails.
    const score = onTopic ? Math.max(raw, 78) : raw;
    return { score, passed: score >= MIN_SCORE, reasoning: parsed.reasoning ?? "" };
  } catch (e) {
    // No vision model, or the vision call failed. Nobody has looked at this image,
    // so it cannot be paid for. Set OPENROUTER_VISION_MODEL to a vision-capable
    // model to grade images properly.
    const why = e?.message || "vision grading unavailable";
    console.error(`[score] image could not be graded: ${why}`);
    return ungradeable(`The image could not be visually verified (${why}), so it was not accepted.`);
  }
}

/**
 * Produce work for a task (used by the autonomous agent runtime). `feedback`
 * carries the reviewer's rejection reason on a retry so the agent improves.
 * Image/logo/graphic requests are generated as an image (data-URI); everything
 * else is text.
 *
 * Returns `{ deliverable, gradeableText }`:
 *  - `deliverable` is what the requester receives and what is hashed on chain;
 *  - `gradeableText` is text a grader can actually judge. For a text deliverable
 *    they are the same. For a rendered file (PDF) it is the source document, which
 *    is what makes a binary deliverable gradeable at all: without it the verifier
 *    has nothing to score, and scoring nothing must never mean paying (see
 *    `ungradeable` above).
 *
 * An image has no gradeable text on purpose: it must be judged by a vision model,
 * not by the brief that requested it, or an agent could be paid for an image that
 * does not match its own description.
 */
export async function produceWork(p, feedback = "") {
  if (wantsImage(p)) {
    const brief = `${p.title}. ${p.description}`.slice(0, 900);
    const fix = feedback ? ` Revise per this feedback: ${feedback}.` : "";
    try {
      const img = await image(`Create a high-quality, professional image for this request: ${brief}. Clean, polished, production-ready.${fix}`);
      // No gradeableText: an image must be judged visually, not from its prompt.
      return { deliverable: img, gradeableText: "" };
    } catch (e) {
      console.warn("[score] image generation failed, delivering a text spec instead:", e.message);
      // Graceful fallback (image provider unavailable): a precise visual spec. That
      // IS text, so it is gradeable in the ordinary way.
      const visualSpec = await chat(
        [
          { role: "system", content: "You are a design agent. The image generator is unavailable right now, so deliver a precise, production-ready visual specification a designer could execute exactly — layout, colors (hex), typography, iconography, dimensions." },
          { role: "user", content: `REQUEST: ${p.title}\n${p.description}\n\nRUBRIC: ${p.rubric}${feedback ? `\n\nFeedback: ${feedback}` : ""}` },
        ],
        { maxTokens: 1200 },
      );
      return { deliverable: visualSpec, gradeableText: visualSpec };
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
  const messages = [
    {
      role: "system",
      content:
        `You are an AI worker agent completing a paid task. Produce the deliverable directly — no preamble, no meta-commentary. Satisfy EVERY criterion in the rubric, and match the requested length and format EXACTLY. ${intentNote} ${lengthNote} ${fmtNote}`.trim(),
    },
    {
      role: "user",
      content: `TASK: ${p.title}\n${p.description}\n\nRUBRIC (you will be scored against this): ${p.rubric}${revision}`,
    },
  ];

  // One extra attempt of our own on top of the transport-level retries in chat(). A model
  // that returns nothing is usually transient, and one more try is far cheaper than the
  // alternative this code used to produce: an empty deliverable that no endpoint would
  // accept, retried by the agent forever.
  let out;
  try {
    out = await chat(messages, { maxTokens: tokensFor(spec) });
  } catch (e) {
    console.warn(`[score] first generation attempt failed, retrying once: ${e.message}`);
    out = await chat(messages, { maxTokens: tokensFor(spec) });
  }
  out = stripFences(out, spec.format);
  // Never hand back a deliverable nothing can accept. `stripFences` can also empty a
  // response that was nothing but a code fence, so this is checked after it, not before.
  if (typeof out !== "string" || out.trim() === "") {
    throw new Error("the model produced no usable deliverable for this task");
  }
  // A PDF request → render the produced document into a real PDF file (data-URI).
  if (spec.format === "pdf") {
    try {
      // The file is the deliverable; the text it was rendered from is what the
      // verifier grades.
      return { deliverable: await textToPdf(out, p.title), gradeableText: out };
    } catch (e) {
      console.warn("[score] PDF render failed, delivering text:", e.message);
      return { deliverable: out, gradeableText: out };
    }
  }
  return { deliverable: out, gradeableText: out };
}
