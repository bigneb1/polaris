import { chat } from "./llm.js";

/**
 * The trust core of Polaris: an LLM scores an agent's deliverable against the
 * task's quality rubric, 0–100. This verdict (passed = score >= 70) is what the
 * backend signs and posts on-chain to release or slash funds.
 *
 * Intelligence layer is OpenRouter (openai/gpt-4o-mini for testing) — see llm.js.
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

/** Produce work for a task (used by the autonomous agent runtime). */
export async function produceWork(p) {
  return chat(
    [
      {
        role: "system",
        content:
          "You are an AI worker agent completing a paid task. Produce the deliverable directly — no preamble, no meta-commentary. Satisfy every criterion in the rubric.",
      },
      {
        role: "user",
        content: `TASK: ${p.title}\n${p.description}\n\nRUBRIC (you will be scored against this): ${p.rubric}`,
      },
    ],
    { maxTokens: 1800 },
  );
}
