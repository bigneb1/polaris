import "dotenv/config";
import { GoogleGenAI, ApiError } from "@google/genai";

/**
 * LLM layer — Google Gemini via the official SDK (free tier — no billing
 * account attached, since enabling billing on the GEMINI_API_KEY's project
 * deletes the free tier entirely).
 *
 * Model: gemini-flash-latest by default (override via LLM_MODEL). Flash
 * models have an internal "thinking" mode that shares the maxOutputTokens
 * budget with the visible answer, so we keep a token floor (never below
 * MIN_TOKENS) the same way the codebase has for every prior provider —
 * short JSON answers (scoring/jury) could otherwise get truncated.
 */
const MODEL = process.env.LLM_MODEL || "gemini-flash-latest";
const MIN_TOKENS = Number(process.env.LLM_MIN_TOKENS || 4096);
const DEFAULT_TOKENS = Number(process.env.LLM_DEFAULT_TOKENS || 8192);
const KEY = process.env.GEMINI_API_KEY;

// Never hardcode a key — resolved from GEMINI_API_KEY above.
const ai = new GoogleGenAI({ apiKey: KEY });

/**
 * Translate OpenAI-shaped content into Gemini `parts`. Strings pass through
 * as a single text part. The only array shape any caller sends today is
 * score.js's scoreImage vision path: [{type:"text"}, {type:"image_url", image_url:{url}}],
 * where `url` is always a `data:image/...;base64,...` URI.
 */
function toParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content ?? "") }];
  return content.map((block) => {
    if (block?.type === "image_url") {
      const url = block.image_url?.url || "";
      const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
      return m ? { inlineData: { mimeType: m[1], data: m[2] } } : { text: url };
    }
    if (block?.type === "text") return { text: block.text };
    return { text: JSON.stringify(block) };
  });
}

/**
 * Call the Gemini API.
 * @param {Array<{role:string, content:string|Array<any>}>} messages
 * @param {{ maxTokens?: number, json?: boolean }} [opts]
 * @returns {Promise<string>} the assistant's text reply
 */
export async function chat(messages, opts = {}) {
  if (!KEY) throw new Error("GEMINI_API_KEY not set — required for the LLM layer");

  const maxTokens = Math.max(MIN_TOKENS, opts.maxTokens ?? DEFAULT_TOKENS);

  // Gemini takes systemInstruction as a separate config field, not a
  // {role:"system"} message. Gemini's assistant role is "model", not "assistant".
  let systemInstruction;
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      systemInstruction = systemInstruction ? `${systemInstruction}\n\n${text}` : text;
    } else {
      contents.push({ role: m.role === "assistant" ? "model" : m.role, parts: toParts(m.content) });
    }
  }

  const config = { maxOutputTokens: maxTokens };
  if (systemInstruction) config.systemInstruction = systemInstruction;
  // Native JSON mode — a real improvement over the prompt-reinforcement
  // workaround prior providers needed. Callers' own JSON-parsing fallbacks
  // (score.js's parseJSON, disputes.js's parse-with-fallback) stay as backup.
  if (opts.json) config.responseMimeType = "application/json";

  let resp;
  try {
    resp = await ai.models.generateContent({ model: MODEL, contents, config });
  } catch (err) {
    if (err instanceof ApiError) {
      // Mirrors the "LLM {status}: {message}" log line used by every prior
      // provider in this file, so log-watching habits keep working.
      throw new Error(`LLM ${err.status ?? "network"}: ${err.message}`);
    }
    throw err;
  }

  return resp.text ?? "";
}

// Image provider: free keyless Pollinations by default. Settlement adjudication
// is handled separately by GenLayer; this provider only creates deliverables.
const IMAGE_PROVIDER = (process.env.IMAGE_PROVIDER || "pollinations").toLowerCase();

/**
 * Generate an image from a text prompt. Returns a `data:image/...;base64,...`
 * URI so it can be stored/rendered inline.
 * @param {string} prompt
 * @returns {Promise<string>} data-URI
 */
export async function image(prompt) {
  if (IMAGE_PROVIDER === "pollinations") return pollinationsImage(prompt);
  throw new Error(`Unknown IMAGE_PROVIDER: ${IMAGE_PROVIDER}`);
}

/** Free, keyless image generation via Pollinations (retried — the free tier is
 *  occasionally rate-limited / 500s). */
async function pollinationsImage(prompt) {
  const p = encodeURIComponent(String(prompt).slice(0, 500));
  const urls = [`https://image.pollinations.ai/prompt/${p}`, `https://image.pollinations.ai/prompt/${p}?width=1024&height=1024`];
  const deadline = Date.now() + Number(process.env.IMAGE_TIMEOUT_MS || 75000);
  let lastErr = "";
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    for (const url of urls) {
      try {
        const ctrl = AbortSignal.timeout(45000);
        const res = await fetch(url, { redirect: "follow", signal: ctrl });
        const ct = res.headers.get("content-type") || "";
        if (res.ok && ct.startsWith("image/")) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 1000) return `data:${ct};base64,${buf.toString("base64")}`;
        }
        lastErr = `${res.status} ${ct}`;
      } catch (e) {
        lastErr = e.message;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Pollinations image failed: ${lastErr}`);
}

export { MODEL as LLM_MODEL };
