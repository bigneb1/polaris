import { ethers } from "ethers";
import fs from "node:fs";
import { networkStorePath } from "./store-path.js";

/**
 * ERC-8004 (trustless agents) integration.
 *
 * Polaris deploys the three reference registries on BOT Chain, and this module is
 * what makes them mean something instead of sitting there as deployed addresses:
 *
 *  - **Identity** — an agent mints its own ERC-721 identity the first time it comes
 *    online, so it has a portable id that any other application can read, not just
 *    a row in Polaris's own registry.
 *  - **Validation** — every settled task's deliverable hash is published as a
 *    validation request/response pair, which is the standard's shape for exactly
 *    the attestation VerifierBridge already produces.
 *  - **Reputation** — a settled task's score is posted as feedback against the
 *    agent's id, so its track record is readable off-chain by anyone.
 *
 * TWO CONSTRAINTS THAT SHAPE THE CODE, both read off the deployed contracts rather
 * than assumed:
 *
 *  1. `register()` mints to `msg.sender`, so an agent's identity must be minted BY
 *     the agent's own key. The runtime therefore mints during the agent's own
 *     start-up (it already registers itself on-chain there with the same key), not
 *     from the verifier or the deployer, which would leave the identity owned by
 *     the wrong address.
 *  2. `giveFeedback` reverts with "Self-feedback not allowed" when the caller is
 *     the agent's owner or an operator. Feedback is therefore posted by the
 *     VERIFIER, which is a distinct address from any agent. An agent cannot rate
 *     itself, which is the whole point of the check.
 *  3. `validationRequest` reverts with "Not authorized" unless the caller owns the
 *     agent or is an approved operator.
 *
 * (2) and (3) together rule out one address doing everything, and finding that out
 * cost a live revert: granting the verifier operator rights (so it could open
 * validation requests) immediately made its feedback fail as "Self-feedback",
 * because `giveFeedback` checks `isAuthorizedOrOwner`, which is true for operators
 * too. The roles have to be split the way the standard actually intends:
 *
 *   - the AGENT opens the validation request for its own work, naming the verifier
 *     as validator. It does this when it submits the deliverable, which is the
 *     moment it has something to be validated;
 *   - the VERIFIER answers that request with the score at settlement time, because
 *     `validationResponse` accepts only the named validator;
 *   - the VERIFIER also posts reputation feedback, which stays legal precisely
 *     because it is neither owner nor operator of the agent.
 *
 * So no operator grant is used anywhere. An agent whose key this runtime never
 * holds simply has no validation request, and settlement skips that step with a log
 * instead of failing.
 *
 * Everything here is best-effort: a failure to publish to ERC-8004 must never
 * block a settlement or strand a task, because Polaris's own registry and escrow
 * are the source of truth for the money. Failures are logged and skipped.
 */

/* ── ABIs, trimmed to what Polaris calls ─────────────────────────────────────*/
const IDENTITY_ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  // Declared so a failed mint decodes to a name instead of "unknown custom error".
  // Without it the revert arrives as raw calldata and cannot be told apart from any
  // other failure, which is exactly the mistake that made the first version of the
  // mintability check classify every revert as generic.
  "error ERC721InvalidReceiver(address receiver)",
];
const REPUTATION_ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)",
];
const VALIDATION_ABI = [
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
];

/** Cache of wallet -> agentId, so a warm runtime doesn't re-scan for ids. */
function idStore(ctx) {
  return networkStorePath(`ERC8004_ID_STORE_${ctx.chainId}`, "erc8004-ids.json", { chainId: ctx.chainId });
}
function loadIds(ctx) {
  try {
    return JSON.parse(fs.readFileSync(idStore(ctx), "utf8"));
  } catch {
    return {};
  }
}
function saveIds(ctx, ids) {
  try {
    fs.writeFileSync(idStore(ctx), JSON.stringify(ids));
  } catch {
    /* best-effort cache */
  }
}

/**
 * Cache of wallet -> mintability verdict.
 *
 * Separate from the id cache because it answers a different question, and because the
 * answer is permanent: whether a deployed address can receive an ERC-721 is fixed by its
 * code, so once probed it never needs asking again.
 */
function mintableStore(ctx) {
  return networkStorePath(`ERC8004_MINTABLE_STORE_${ctx.chainId}`, "erc8004-mintable.json", {
    chainId: ctx.chainId,
  });
}

function readMintableFile(ctx) {
  try {
    return JSON.parse(fs.readFileSync(mintableStore(ctx), "utf8"));
  } catch {
    return {};
  }
}

/**
 * In-memory view of the cache, per chain.
 *
 * The overview probes every identity-less agent concurrently, and the first version of
 * this read the whole JSON file, added one key, and wrote the file back. Four parallel
 * probes therefore each wrote a map containing only their own result and the last one won:
 * three verdicts were computed, cached in nobody's copy, and lost. Production showed it
 * plainly — one agent carried a verdict and three stayed unknown.
 *
 * So writes merge instead of replacing, and the merged map is kept in memory so repeat
 * reads cost nothing.
 */
const mintableCache = new Map(); // chainId -> { [wallet]: verdict }

function loadMintable(ctx) {
  let map = mintableCache.get(ctx.chainId);
  if (!map) {
    map = readMintableFile(ctx);
    mintableCache.set(ctx.chainId, map);
  }
  return map;
}

/**
 * Record one verdict. Merges over whatever is already on disk, so a concurrent writer's
 * entry survives, and keeps the in-memory map in step.
 */
function recordMintable(ctx, wallet, verdict) {
  const map = loadMintable(ctx);
  map[wallet] = verdict;
  try {
    const merged = { ...readMintableFile(ctx), ...map };
    mintableCache.set(ctx.chainId, merged);
    fs.writeFileSync(mintableStore(ctx), JSON.stringify(merged));
  } catch {
    /* best-effort cache; the in-memory map still holds the verdict for this process */
  }
}

/**
 * Every known mintability verdict, straight from the cache.
 *
 * Cache-only and synchronous for the same reason `cachedAgentIds` is: the indexer calls it
 * on every build, and an eth_call per agent there would put the market page behind the
 * rate-limited RPC. `identityMintability` is what fills the cache, from the overview build
 * where one slow call is acceptable. Reading it here is what carries the verdict to a peer
 * runtime through /api/index, so a runtime that cannot probe another chain still knows why
 * an agent on it has no identity.
 */
export function cachedMintability(ctx) {
  return loadMintable(ctx);
}

/**
 * `ERC721InvalidReceiver(address)`. Matched on the selector rather than on the error
 * message: a node returns raw revert data, and whether the client can name it depends on
 * the ABI it happens to hold, so text matching silently degrades to "generic failure".
 * The selector is the same four bytes regardless.
 */
const INVALID_RECEIVER_SELECTOR = ethers.id("ERC721InvalidReceiver(address)").slice(0, 10);

function isInvalidReceiver(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? "";
  if (typeof data === "string" && data.startsWith(INVALID_RECEIVER_SELECTOR)) return true;
  // Belt and braces: a client that does know the name reports it in the message.
  return /ERC721InvalidReceiver/i.test(e?.shortMessage || e?.message || "");
}

/**
 * Could this address be given an ERC-8004 identity at all?
 *
 * The registry `_safeMint`s an ERC-721, so an address that does not implement
 * `onERC721Received` can never hold one: the mint reverts with `ERC721InvalidReceiver`.
 * Several ERC-4337 accounts on BOT Chain were deployed by a factory predating the
 * receiver hook and are permanently in that state.
 *
 * This mirrors `canMintAgentIdentity` in src/lib/tx.ts deliberately: the frontend needs it
 * to avoid asking a user to sign a mint that reverts, and the dashboard needs it to explain
 * why an agent has no identity instead of printing a bare dash that reads as a failure.
 * Both simulate the real call rather than sniffing bytecode, so a future cause is caught
 * as well as this one.
 *
 * Returns "mintable" | "unsupported-receiver" | "rejected". Cached permanently per
 * address, so a cold runtime spends one eth_call per identity-less agent and a warm one
 * spends none. That matters: this is the same rate-limited endpoint whose throttling once
 * left the production index serving 4 tasks out of 270.
 */
export async function identityMintability(ctx, wallet) {
  if (!erc8004Available(ctx)) return "rejected";
  const key = String(wallet).toLowerCase();
  const cached = loadMintable(ctx);
  if (cached[key]) return cached[key];

  let verdict;
  try {
    // `from` is the agent, because `register` mints to msg.sender: simulating from anyone
    // else would answer a different question than the one being asked.
    await identity(ctx, ctx.provider).register.staticCall(agentUriFor(wallet), { from: wallet });
    verdict = "mintable";
  } catch (e) {
    verdict = isInvalidReceiver(e) ? "unsupported-receiver" : "rejected";
  }

  recordMintable(ctx, key, verdict);
  return verdict;
}

export function erc8004Available(ctx) {
  return Boolean(ctx.ADDR.erc8004Identity);
}

/** The identity registry bound to any signer or provider. */
export function identityContract(ctx, signerOrProvider) {
  return identity(ctx, signerOrProvider);
}

/** The agentURI Polaris registers: its own agent page, stable and resolvable. */
export function agentUriFor(wallet, appUrl) {
  const base = (appUrl || process.env.PUBLIC_APP_URL || "https://polarisswarm.xyz").replace(/\/$/, "");
  return `${base}/agent/${wallet}`;
}

/**
 * Every known wallet -> agentId, straight from the cache.
 *
 * Deliberately cache-only and synchronous: the indexer calls this on every build, and
 * resolving ids from chain there would put the whole market page behind the
 * rate-limited RPC. Agents this runtime minted for are present; others simply have no
 * id to display.
 */
export function cachedAgentIds(ctx) {
  return loadIds(ctx);
}

/** Remember a wallet's agentId, so later lookups skip the chain scan. */
export function recordAgentId(ctx, wallet, agentId) {
  const ids = loadIds(ctx);
  ids[String(wallet).toLowerCase()] = String(agentId);
  saveIds(ctx, ids);
}

/** Pull the minted agentId out of a receipt's logs. */
export function parseRegisteredId(ctx, logs) {
  const reg = identity(ctx);
  for (const log of logs ?? []) {
    try {
      const parsed = reg.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "Registered") return parsed.args.agentId;
    } catch {
      /* not one of ours */
    }
  }
  return null;
}

function identity(ctx, signer) {
  return new ethers.Contract(ctx.ADDR.erc8004Identity, IDENTITY_ABI, signer ?? ctx.provider);
}

/**
 * The agent's ERC-8004 id, from cache, else from the chain.
 *
 * `Registered` indexes `owner`, so one filtered query answers it without a wide
 * scan. Returns null when the agent has no identity yet.
 */
export async function agentIdOf(ctx, wallet) {
  if (!erc8004Available(ctx)) return null;
  const key = String(wallet).toLowerCase();
  const ids = loadIds(ctx);
  if (ids[key] != null) return BigInt(ids[key]);
  try {
    const reg = identity(ctx);
    // Registered(agentId indexed, agentURI, owner indexed): ethers maps filter
    // arguments across ALL event inputs positionally, so `owner` is the third slot
    // even though the middle one isn't indexed.
    const logs = await ctx.queryLogsChunked(
      reg,
      reg.filters.Registered(null, null, wallet),
      undefined,
      ctx.fromBlockFor("erc8004Identity"),
    );
    if (!logs.length) return null;
    // Keep the first identity: an agent minting twice is a mistake, not a feature,
    // and its reputation history hangs off whichever id it started with.
    const agentId = logs[0].args.agentId;
    ids[key] = agentId.toString();
    saveIds(ctx, ids);
    return agentId;
  } catch (e) {
    console.warn(`[erc8004:${ctx.id}] id lookup failed for ${wallet}: ${e.shortMessage || e.message}`);
    return null;
  }
}

/**
 * Mint this agent's ERC-8004 identity if it doesn't have one. MUST be called with
 * the AGENT's own signer: `register` mints to `msg.sender`, so calling it from the
 * verifier or deployer would hand the identity to the wrong owner.
 *
 * `agentURI` follows the standard's registration-file idea: a URI describing the
 * agent. We point it at this deployment's own agent page, which is stable and
 * resolvable, rather than inventing a metadata host.
 */
export async function ensureIdentity(ctx, agentSigner, { name, capabilities, appUrl } = {}) {
  if (!erc8004Available(ctx)) return null;
  const wallet = await agentSigner.getAddress();
  const existing = await agentIdOf(ctx, wallet);
  if (existing != null) return existing;

  const base = (appUrl || process.env.PUBLIC_APP_URL || "https://polarisswarm.xyz").replace(/\/$/, "");
  const agentURI = `${base}/agent/${wallet}`;
  try {
    const reg = identity(ctx, agentSigner);
    const tx = await reg["register(string)"](agentURI);
    const receipt = await tx.wait();
    // Read the id back out of the event rather than guessing the counter.
    let agentId = null;
    for (const log of receipt.logs) {
      try {
        const parsed = reg.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "Registered") {
          agentId = parsed.args.agentId;
          break;
        }
      } catch {
        /* not one of ours */
      }
    }
    if (agentId == null) return null;
    const ids = loadIds(ctx);
    ids[wallet.toLowerCase()] = agentId.toString();
    saveIds(ctx, ids);
    console.log(
      `[erc8004:${ctx.id}] minted identity #${agentId} for ${name || wallet} (${capabilities || "no caps"}) — ${agentURI}`,
    );
    return agentId;
  } catch (e) {
    console.error(`[erc8004:${ctx.id}] identity mint failed for ${wallet}: ${e.shortMessage || e.message}`);
    return null;
  }
}

/**
 * The request hash both sides derive independently: the agent when it opens the
 * request, the verifier when it answers. Binding agentId + taskId + this
 * deployment's bridge keeps two tasks (or two networks) from colliding on one hash.
 */
export function validationRequestHash(ctx, agentId, taskId) {
  return ethers.solidityPackedKeccak256(
    ["string", "uint256", "bytes32", "address"],
    ["polaris-validation", agentId, taskId, ctx.ADDR.verifierBridge],
  );
}

/**
 * The AGENT asks for its own work to be validated, naming the verifier as
 * validator. Called with the agent's signer right after it submits a deliverable,
 * because only an owner (or operator) may open a request, and making the verifier
 * an operator would disqualify it from giving feedback later.
 */
export async function requestValidation(ctx, agentSigner, { taskId, appUrl }) {
  if (!erc8004Available(ctx) || !ctx.ADDR.erc8004Validation) return null;
  const validator = ctx.signer()?.address;
  if (!validator) return null;
  try {
    const wallet = await agentSigner.getAddress();
    const agentId = await agentIdOf(ctx, wallet);
    if (agentId == null) return null;
    const base = (appUrl || process.env.PUBLIC_APP_URL || "https://polarisswarm.xyz").replace(/\/$/, "");
    const requestHash = validationRequestHash(ctx, agentId, taskId);
    const reg = new ethers.Contract(ctx.ADDR.erc8004Validation, VALIDATION_ABI, agentSigner);
    // Already open (a retried submission) is success, not an error.
    try {
      const existing = await reg.getValidationStatus(requestHash);
      if (existing[0] !== ethers.ZeroAddress) return requestHash;
    } catch {
      /* "unknown" means it isn't open yet */
    }
    await (await reg.validationRequest(validator, agentId, `${base}/task/${taskId}`, requestHash)).wait();
    console.log(`[erc8004:${ctx.id}] agent #${agentId} requested validation of task ${String(taskId).slice(0, 10)}…`);
    return requestHash;
  } catch (e) {
    console.warn(`[erc8004:${ctx.id}] validation request failed: ${e.shortMessage || e.message}`);
    return null;
  }
}

/**
 * Poll until a validation request is readable.
 *
 * Two reasons this is a poll and not a single read. The agent opens the request from
 * its own process, so it may land a moment after settlement starts; and on BOT
 * Chain's ~0.67s blocks a mined receipt is not the same as the write being visible to
 * the node simulating the next call, which made an immediate response revert with
 * "unknown". Bounded, and returns false rather than throwing: a deferred response
 * costs an attestation, never the payment.
 */
async function waitForRequest(reg, requestHash, tries = 10, delayMs = 1000) {
  for (let i = 0; i < tries; i++) {
    try {
      const s = await reg.getValidationStatus(requestHash);
      if (s[0] !== ethers.ZeroAddress) return true;
    } catch {
      /* "unknown" until the write lands */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Publish a settled task's verdict to the validation registry: a request naming the
 * verifier as validator, then that validator's response carrying the score.
 *
 * Both calls come from the verifier. The response MUST come from the address named
 * in the request (`require(msg.sender == s.validatorAddress)`), and having the
 * verifier make the request too means this works for every settlement, including
 * tasks done by agents whose keys this runtime never holds.
 *
 * `response` is the standard's 0-100 value, so the rubric score maps straight onto
 * it. The deliverable hash is the response hash, which makes the on-chain record
 * point at the exact work that was judged.
 */
export async function recordValidation(ctx, verifierSigner, { agentId, score, deliverableHash, taskId, appUrl }) {
  if (!erc8004Available(ctx) || !ctx.ADDR.erc8004Validation || agentId == null) return null;
  const base = (appUrl || process.env.PUBLIC_APP_URL || "https://polarisswarm.xyz").replace(/\/$/, "");
  const requestURI = `${base}/task/${taskId}`;
  const requestHash = validationRequestHash(ctx, agentId, taskId);
  try {
    const reg = new ethers.Contract(ctx.ADDR.erc8004Validation, VALIDATION_ABI, verifierSigner);

    // The agent opens the request (see the role split at the top of this file), so
    // wait for it to be readable rather than assuming it is there. On BOT Chain's
    // ~0.67s blocks a mined receipt is not the same as the write being visible to
    // the node simulating the next call: answering too early reverts with
    // "unknown". If the request never appears the agent never asked, which is
    // normal for an agent this runtime doesn't run.
    if (!(await waitForRequest(reg, requestHash))) {
      console.log(
        `[erc8004:${ctx.id}] no validation request open for agent #${agentId} on this task, ` +
          `so there is nothing to answer. Feedback still applies.`,
      );
      return null;
    }
    await (
      await reg.validationResponse(requestHash, Math.max(0, Math.min(100, Number(score))), requestURI, deliverableHash, "polaris-verifier")
    ).wait();
    console.log(`[erc8004:${ctx.id}] validation recorded for agent #${agentId}, score ${score}`);
    return requestHash;
  } catch (e) {
    console.error(`[erc8004:${ctx.id}] validation publish failed: ${e.shortMessage || e.message}`);
    return null;
  }
}

/**
 * Post a settled task's score as ERC-8004 feedback.
 *
 * Sent by the verifier, never by the agent: `giveFeedback` rejects the agent's own
 * owner and operators ("Self-feedback not allowed"), which is the standard stopping
 * an agent from inflating its own record.
 *
 * `value` is the 0-100 rubric score with 0 decimals, tagged so a reader can tell
 * Polaris feedback apart from anyone else's.
 */
export async function recordFeedback(ctx, verifierSigner, { agentId, score, taskId, endpoint, appUrl }) {
  if (!erc8004Available(ctx) || !ctx.ADDR.erc8004Reputation || agentId == null) return false;
  const base = (appUrl || process.env.PUBLIC_APP_URL || "https://polarisswarm.xyz").replace(/\/$/, "");
  try {
    const reg = new ethers.Contract(ctx.ADDR.erc8004Reputation, REPUTATION_ABI, verifierSigner);
    await (
      await reg.giveFeedback(
        agentId,
        Math.max(0, Math.min(100, Number(score))),
        0,
        "polaris",
        "task-settlement",
        endpoint || "",
        `${base}/task/${taskId}`,
        ethers.keccak256(ethers.toUtf8Bytes(String(taskId))),
      )
    ).wait();
    console.log(`[erc8004:${ctx.id}] feedback ${score}/100 posted for agent #${agentId}`);
    return true;
  } catch (e) {
    // A self-feedback revert here means the verifier key also owns the agent, which
    // is a configuration problem worth naming rather than a transient failure.
    const msg = e.shortMessage || e.message || "";
    if (msg.includes("Self-feedback")) {
      console.error(
        `[erc8004:${ctx.id}] feedback refused: the verifier key owns agent #${agentId}. ` +
          `ERC-8004 forbids self-feedback, so the verifier must be a different address than the agent.`,
      );
    } else {
      console.error(`[erc8004:${ctx.id}] feedback failed: ${msg}`);
    }
    return false;
  }
}

/**
 * Everything Polaris publishes after a settlement, in one call. Best-effort by
 * design: the money already moved through VerifierBridge, so a registry hiccup must
 * not fail the request that triggered it.
 */
export async function publishSettlement(ctx, verifierSigner, { agentWallet, score, deliverableHash, taskId, endpoint }) {
  if (!erc8004Available(ctx)) return { published: false };
  const agentId = await agentIdOf(ctx, agentWallet);
  if (agentId == null) {
    console.log(`[erc8004:${ctx.id}] ${agentWallet} has no ERC-8004 identity yet — nothing to publish against.`);
    return { published: false };
  }
  const validation = await recordValidation(ctx, verifierSigner, { agentId, score, deliverableHash, taskId });
  const feedback = await recordFeedback(ctx, verifierSigner, { agentId, score, taskId, endpoint });
  return { published: Boolean(validation || feedback), agentId: agentId.toString(), validation, feedback };
}
