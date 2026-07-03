import "dotenv/config";

/**
 * LLM layer — 0G router (OpenAI-compatible chat completions) running GLM-5.2.
 *
 * GLM-5.2 is a reasoning model: it emits `reasoning_content` BEFORE the final
 * answer, so `max_tokens` must cover both. We floor output at 4096 (and never go
 * below 1500) so the answer isn't truncated by reasoning eating the budget.
 * 1M context; strong coding/engineering; good for produce + jury.
 */
const LLM_URL = process.env.LLM_URL || "https://router-api.0g.ai/v1/chat/completions";
const MODEL = process.env.LLM_MODEL || "glm-5.2";
const KEY = process.env.LLM_API_KEY;
// Reasoning models need a generous floor or the answer comes back empty (all
// tokens spent on reasoning). Configurable but never below 1500.
const MIN_TOKENS = Number(process.env.LLM_MIN_TOKENS || 1500);
const DEFAULT_TOKENS = Number(process.env.LLM_DEFAULT_TOKENS || 4096);

/**
 * Call the chat completions endpoint.
 * @param {Array<{role:string, content:string|Array<any>}>} messages
 * @param {{ maxTokens?: number, json?: boolean }} [opts]
 * @returns {Promise<string>} the assistant message text
 */
export async function chat(messages, opts = {}) {
  if (!KEY) throw new Error("LLM_API_KEY not set");
  const maxTokens = Math.max(MIN_TOKENS, opts.maxTokens ?? DEFAULT_TOKENS);
  const body = { model: MODEL, messages, max_tokens: maxTokens };
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  // GLM can return an empty `content` when reasoning exhausted the budget;
  // fall back to the reasoning text so the caller still gets something usable.
  if (!content && data?.choices?.[0]?.message?.reasoning_content) {
    return String(data.choices[0].message.reasoning_content);
  }
  return content;
}

// Image provider: free keyless Pollinations by default. 0G's GLM-5.2 is text-only,
// so image gen stays on Pollinations (or a future image-capable provider).
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
