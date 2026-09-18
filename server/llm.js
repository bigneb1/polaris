import "dotenv/config";

/**
 * LLM layer — OpenRouter (OpenAI-compatible chat completions).
 *
 * Default model: deepseek/deepseek-v4-flash-0731. Two properties of that model
 * shape this file:
 *
 *  1. It is a REASONING model. Reasoning tokens are drawn from the same
 *     max_tokens budget as the visible answer (measured: 76 of 98 completion
 *     tokens on a short grading call), so a small budget yields an empty answer.
 *     Hence the MIN_TOKENS floor, and `reasoning.exclude` so the thinking never
 *     comes back as content for callers to trip over. Every prior provider in this
 *     file needed the same floor for the same reason.
 *
 *  2. It is TEXT-ONLY (`input_modalities: ["text"]`). Image deliverables therefore
 *     cannot be graded by this model; `chat` rejects image content with a clear
 *     error rather than sending a request that is guaranteed to fail, so
 *     score.js's fallback path engages immediately.
 *
 * Verdicts move money, so JSON responses use OpenRouter's STRICT json_schema
 * structured output where a caller supplies a schema. Without it this model
 * occasionally emits a malformed key (observed: `{":": 100}` instead of
 * `{"score": 100}`), which would parse to score 0 and fail an honest agent.
 */
const BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL = process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || "deepseek/deepseek-v4-flash-0731";
/**
 * Model used when a request carries an image. The default text model is
 * `input_modalities: ["text"]` and cannot see, so image grading needs its own
 * model. Unset means image grading is UNAVAILABLE, and callers must treat that as
 * "cannot grade" rather than "accept": score.js used to swallow the error and pay
 * the agent 82/100 for an image nobody had looked at.
 */
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "";
const KEY = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
const MIN_TOKENS = Number(process.env.LLM_MIN_TOKENS || 4096);
const DEFAULT_TOKENS = Number(process.env.LLM_DEFAULT_TOKENS || 8192);
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);
const RETRIES = Number(process.env.LLM_RETRIES || 2);

/** Common JSON shapes, so callers get schema-enforced output on the money path. */
export const SCHEMAS = {
  verdict: {
    name: "verdict",
    strict: true,
    schema: {
      type: "object",
      properties: {
        score: { type: "integer", description: "0-100 quality score against the rubric" },
        passed: { type: "boolean" },
        reasoning: { type: "string" },
      },
      required: ["score", "passed", "reasoning"],
      additionalProperties: false,
    },
  },
  imageVerdict: {
    name: "image_verdict",
    strict: true,
    schema: {
      type: "object",
      properties: {
        onTopic: { type: "boolean" },
        score: { type: "integer" },
        reasoning: { type: "string" },
      },
      required: ["onTopic", "score", "reasoning"],
      additionalProperties: false,
    },
  },
  jury: {
    name: "jury_verdict",
    strict: true,
    schema: {
      type: "object",
      properties: {
        upheld: { type: "boolean" },
        reasoning: { type: "string" },
      },
      required: ["upheld", "reasoning"],
      additionalProperties: false,
    },
  },
};

/** True when any message carries non-text content this model can't accept. */
function hasImageContent(messages) {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "image_url"),
  );
}

/**
 * Call OpenRouter.
 * @param {Array<{role:string, content:string|Array<any>}>} messages
 * @param {{ maxTokens?: number, json?: boolean, schema?: object }} [opts]
 * @returns {Promise<string>} the assistant's text reply
 */
export async function chat(messages, opts = {}) {
  if (!KEY) throw new Error("OPENROUTER_API_KEY not set — required for the LLM layer");
  // Pick the model per request: an image needs a vision-capable one.
  const withImages = hasImageContent(messages);
  if (withImages && !VISION_MODEL) {
    // Deliberately an error, not a silent pass. The caller must decide, and the
    // only safe decision on the money path is "not graded, so not paid".
    throw new Error(
      `${MODEL} cannot see images and OPENROUTER_VISION_MODEL is not set, so image deliverables cannot be graded`,
    );
  }
  const model = withImages ? VISION_MODEL : MODEL;

  const body = {
    model,
    messages,
    max_tokens: Math.max(MIN_TOKENS, opts.maxTokens ?? DEFAULT_TOKENS),
    // Keep chain-of-thought out of `content`; we only ever want the answer.
    reasoning: { exclude: true },
  };
  if (opts.json) {
    body.response_format = opts.schema
      ? { type: "json_schema", json_schema: opts.schema }
      : { type: "json_object" };
  }

  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "Content-Type": "application/json",
          // OpenRouter attribution headers (optional, and useful in its dashboard).
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://polarisswarm.xyz",
          "X-Title": "Polaris",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const text = await res.text();
      if (!res.ok) {
        // Mirrors the "LLM {status}: {message}" log line every prior provider in
        // this file used, so log-watching habits keep working.
        const err = new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
        // Retry transient failures only; a bad key or bad request never recovers.
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }

      const data = JSON.parse(text);
      if (data.error) throw new Error(`LLM error: ${JSON.stringify(data.error).slice(0, 300)}`);

      // An empty completion is a FAILURE, not a value.
      //
      // This used to `?? ""`, and that empty string became the agent's deliverable. The
      // deliverable endpoint then correctly refused it with 400 "taskId and deliverable
      // required", the agent treated the 400 as retryable, and the task retried every ~20s
      // forever: a model call paid for on each pass, and a task that could never leave
      // ASSIGNED. A provider that returns no content (a refusal, a truncation, a filtered
      // response) has failed, and the only safe thing to do with a failure is surface it.
      //
      // Marked retryable because the usual causes are transient, so the retry ladder above
      // gets a chance before the caller ever sees it.
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        const reason = data.choices?.[0]?.finish_reason ?? "none";
        const err = new Error(`LLM returned an empty completion (model=${model}, finish_reason=${reason})`);
        err.retryable = true;
        throw err;
      }
      return content;
    } catch (e) {
      lastErr = e;
      const retryable = e.retryable || e.name === "TimeoutError" || e.name === "AbortError";
      if (attempt === RETRIES || !retryable) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Image provider: free keyless Pollinations. The text model can't generate images,
// so image deliverables stay on a dedicated provider.
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
        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(45000) });
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
