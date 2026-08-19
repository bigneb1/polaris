import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The grader must never pay for work it did not read.
 *
 * Both binary branches of `scoreAgentWork` used to return `{score: 82, passed:
 * true}`: one for images whose vision pass failed, one for any other file, with no
 * grading at all. Since the configured text model throws on image content, every
 * image deliverable took the catch path and released escrow. An agent could farm
 * payouts by submitting any image.
 *
 * These tests stub the LLM layer so no network or API key is involved, and assert the
 * property that matters: ungradeable work is never `passed`.
 */

// Stub llm.js before score.js imports it.
const calls = [];
let chatImpl = async () => JSON.stringify({ score: 91, passed: true, reasoning: "solid" });

const { mock } = await import("node:test");
mock.module("../llm.js", {
  namedExports: {
    chat: async (messages, opts) => {
      calls.push({ messages, opts });
      return chatImpl(messages, opts);
    },
    image: async () => "data:image/png;base64,AAAA",
    SCHEMAS: { verdict: {}, imageVerdict: {}, jury: {} },
  },
});

const { scoreAgentWork, MIN_SCORE } = await import("../score.js");

test("a text deliverable is graded normally", async () => {
  chatImpl = async () => JSON.stringify({ score: 91, passed: true, reasoning: "meets the rubric" });
  const v = await scoreAgentWork({
    taskDescription: "Write a summary",
    qualityRubric: "Accurate and concise",
    agentOutput: "A careful summary of the material.",
  });
  assert.equal(v.score, 91);
  assert.equal(v.passed, true);
  assert.ok(!v.ungradeable);
});

test("a low-scoring text deliverable fails, and is not marked ungradeable", async () => {
  chatImpl = async () => JSON.stringify({ score: 12, passed: false, reasoning: "off topic" });
  const v = await scoreAgentWork({ taskDescription: "t", qualityRubric: "r", agentOutput: "junk" });
  assert.equal(v.passed, false);
  assert.ok(!v.ungradeable, "a genuine low score is a real verdict, so it stays slash-eligible");
});

test("an image whose vision pass fails is NOT paid", async () => {
  chatImpl = async () => {
    throw new Error("model is text-only and OPENROUTER_VISION_MODEL is not set");
  };
  const v = await scoreAgentWork({
    taskDescription: "Design a logo",
    qualityRubric: "Clean and on brand",
    agentOutput: "data:image/png;base64,AAAA",
  });
  assert.equal(v.passed, false, "this is the bug that released escrow for unseen images");
  assert.equal(v.score, 0);
  assert.equal(v.ungradeable, true, "our misconfiguration must not slash the agent either");
});

test("an image IS paid when the vision pass genuinely approves it", async () => {
  chatImpl = async () => JSON.stringify({ onTopic: true, score: 80, reasoning: "on brief" });
  const v = await scoreAgentWork({
    taskDescription: "Design a logo",
    qualityRubric: "Clean",
    agentOutput: "data:image/png;base64,AAAA",
  });
  assert.equal(v.passed, true);
  assert.ok(v.score >= MIN_SCORE);
  assert.ok(!v.ungradeable);
});

test("an off-topic image still fails on its own merits", async () => {
  chatImpl = async () => JSON.stringify({ onTopic: false, score: 10, reasoning: "unrelated" });
  const v = await scoreAgentWork({
    taskDescription: "Design a logo",
    qualityRubric: "Clean",
    agentOutput: "data:image/png;base64,AAAA",
  });
  assert.equal(v.passed, false);
  assert.ok(!v.ungradeable, "a real visual rejection is a verdict, not a grading failure");
});

test("a binary deliverable with no source text is NOT paid", async () => {
  chatImpl = async () => {
    throw new Error("should not be called: there is nothing to grade");
  };
  const v = await scoreAgentWork({
    taskDescription: "Write a report",
    qualityRubric: "Thorough",
    agentOutput: "data:application/pdf;base64,JVBERi0=",
  });
  assert.equal(v.passed, false, "this used to auto-accept at 82/100 with no grading");
  assert.equal(v.ungradeable, true);
});

test("a binary deliverable IS graded when its source text is supplied", async () => {
  chatImpl = async (messages) => {
    // Prove the grader saw the source text, not the base64 blob.
    const body = JSON.stringify(messages);
    assert.ok(body.includes("the actual report body"), "grader must receive the source text");
    assert.ok(!body.includes("JVBERi0"), "grader must not be handed the raw file");
    return JSON.stringify({ score: 84, passed: true, reasoning: "thorough" });
  };
  const v = await scoreAgentWork({
    taskDescription: "Write a report",
    qualityRubric: "Thorough",
    agentOutput: "data:application/pdf;base64,JVBERi0=",
    gradeableText: "the actual report body, with sections and figures",
  });
  assert.equal(v.passed, true);
  assert.equal(v.score, 84);
  assert.match(v.reasoning, /source text/i, "the verdict says what was actually judged");
});

test("a blank source text does not count as gradeable", async () => {
  const v = await scoreAgentWork({
    taskDescription: "t",
    qualityRubric: "r",
    agentOutput: "data:application/pdf;base64,JVBERi0=",
    gradeableText: "   ",
  });
  assert.equal(v.passed, false);
  assert.equal(v.ungradeable, true);
});
