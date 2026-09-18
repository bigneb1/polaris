import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Nothing is ever paid for work nobody read.
 *
 * Both binary branches here used to return `{score: 82, passed: true}`: one for
 * images whose vision pass failed, one for any other file, with no grading at all.
 * Since the configured text model throws on image content, every image deliverable
 * took the catch path and released escrow. An agent could farm payouts by submitting
 * any image.
 *
 * GenLayer validators now reach the verdict, which moves the risk rather than
 * removing it: their adjudicator reads TEXT, so handing it a raw `data:` URI would
 * have validators grade a base64 blob and reach consensus on nonsense. The gate that
 * prevents that is `prepareForAdjudication`, and these tests pin its contract —
 * either a deliverable resolves to text a validator can genuinely judge, or it
 * resolves to a non-passing `ungradeable` verdict and no adjudication is requested
 * at all.
 *
 * The LLM layer is stubbed, so no network or API key is involved.
 */

// Stub llm.js before score.js imports it.
const calls = [];
let chatImpl = async () => JSON.stringify({ onTopic: true, score: 80, reasoning: "on brief" });

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

const { prepareForAdjudication } = await import("../score.js");

test("a text deliverable goes to the validators verbatim", async () => {
  const p = await prepareForAdjudication({
    taskDescription: "Write a summary",
    qualityRubric: "Accurate and concise",
    agentOutput: "A careful summary of the material.",
  });
  assert.equal(p.text, "A careful summary of the material.");
  assert.ok(!p.ungradeable);
});

test("an image whose vision pass fails is never adjudicated", async () => {
  chatImpl = async () => {
    throw new Error("model is text-only and OPENROUTER_VISION_MODEL is not set");
  };
  const p = await prepareForAdjudication({
    taskDescription: "Design a logo",
    qualityRubric: "Clean and on brand",
    agentOutput: "data:image/png;base64,AAAA",
  });
  assert.equal(p.passed, false, "this is the bug that released escrow for unseen images");
  assert.equal(p.score, 0);
  assert.equal(p.ungradeable, true, "our misconfiguration must not slash the agent either");
  assert.equal(p.text, undefined, "nothing should be sent to the validators");
});

test("an image reaches the validators as what a vision pass actually saw", async () => {
  chatImpl = async () => JSON.stringify({ onTopic: true, score: 80, reasoning: "a clean wordmark in blue" });
  const p = await prepareForAdjudication({
    taskDescription: "Design a logo",
    qualityRubric: "Clean",
    agentOutput: "data:image/png;base64,AAAA",
  });
  assert.ok(!p.ungradeable);
  assert.match(p.text, /a clean wordmark in blue/, "validators judge the report, not the brief");
  assert.ok(!p.text.includes("AAAA"), "validators must never be handed the raw image bytes");
});

test("an off-topic image reaches the validators with the rejection intact", async () => {
  chatImpl = async () => JSON.stringify({ onTopic: false, score: 10, reasoning: "unrelated stock photo" });
  const p = await prepareForAdjudication({
    taskDescription: "Design a logo",
    qualityRubric: "Clean",
    agentOutput: "data:image/png;base64,AAAA",
  });
  assert.ok(!p.ungradeable, "a real visual rejection is evidence, not a grading failure");
  assert.match(p.text, /unrelated stock photo/);
});

test("a binary deliverable with no source text is never adjudicated", async () => {
  chatImpl = async () => {
    throw new Error("should not be called: there is nothing to grade");
  };
  const p = await prepareForAdjudication({
    taskDescription: "Write a report",
    qualityRubric: "Thorough",
    agentOutput: "data:application/pdf;base64,JVBERi0=",
  });
  assert.equal(p.passed, false, "this used to auto-accept at 82/100 with no grading");
  assert.equal(p.ungradeable, true);
  assert.equal(p.text, undefined);
});

test("a binary deliverable IS adjudicated on the source text it rendered from", async () => {
  const p = await prepareForAdjudication({
    taskDescription: "Write a report",
    qualityRubric: "Thorough",
    agentOutput: "data:application/pdf;base64,JVBERi0=",
    gradeableText: "the actual report body, with sections and figures",
  });
  assert.equal(p.text, "the actual report body, with sections and figures");
  assert.ok(!p.text.includes("JVBERi0"), "validators must not be handed the raw file");
});

test("a blank source text does not count as gradeable", async () => {
  const p = await prepareForAdjudication({
    taskDescription: "t",
    qualityRubric: "r",
    agentOutput: "data:application/pdf;base64,JVBERi0=",
    gradeableText: "   ",
  });
  assert.equal(p.passed, false);
  assert.equal(p.ungradeable, true);
});
