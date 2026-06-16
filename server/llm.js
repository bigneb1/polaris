import "dotenv/config";

/**
 * LLM layer — OpenRouter (OpenAI-compatible chat completions).
 *
 * Per the build directive, Polaris's agent intelligence is powered by OpenRouter
 * with openai/gpt-4o-mini for testing. Swap OPENROUTER_MODEL to change models
 * without touching code.
 */
const OPENROUTER_URL = process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const KEY = process.env.OPENROUTER_API_KEY;

/**
 * Call the chat completions endpoint.
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ maxTokens?: number, json?: boolean }} [opts]
 * @returns {Promise<string>} the assistant message text
 */
export async function chat(messages, opts = {}) {
  if (!KEY) throw new Error("OPENROUTER_API_KEY not set");
  const body = {
    model: MODEL,
    messages,
    max_tokens: opts.maxTokens ?? 1024,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      // Optional attribution headers OpenRouter recommends.
      "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://polaris.agents",
      "X-Title": "Polaris",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

export { MODEL as LLM_MODEL };
