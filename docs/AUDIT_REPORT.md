# Polaris — Independent Audit Report

Scope reviewed: `contracts/` (10 Solidity contracts + tests + deploy scripts), `server/` (18 backend files, the agent runtime), `src/` (full React/TS frontend), plus `README.md`/`SETUP.md`/`VERCEL_ENV.md` as the requirements baseline. Read in full, not sampled. Two of the highest-severity findings below were independently re-verified by direct file read after the sub-audits reported them (VerifierBridge.sol, src/lib/contracts.ts).

This is a single-commit repo (`4175aeb`), so there is no prior audit or issue tracker to cross-reference — everything below is derived from reading the code against the project's own README/SETUP claims.

---

## Remediation status (post-audit session)

Every finding below except two (Security #6 — owner-key centralization, and Missing/Incomplete #2 — on-chain dispute-rework enforcement) has a fix committed to this working tree. **None of it is deployed yet:**

- **Contracts:** 5 of 10 contracts have Critical/High fixes (`VerifierBridge`, `BidEngine`, `SubscriptionManager`, `RecurringMarket`, `DisputeManager`) — compiled, 39/39 tests passing (up from the original 31), but **not deployed to Arc testnet**. The user explicitly declined the deploy step this session (a real, gas-spending, address-changing, checkpointed action) — see the "Contracts" column below for exactly which fixes are staged vs. live. **The Critical VerifierBridge fund-theft vulnerability (Security #1) is still exploitable on the live, currently-deployed contract right now.** Existing deploy scripts (`deploy-v4.cjs`, `deploy-bidengine-v2.cjs`, `deploy-subscription.cjs`, `deploy-recurring-market.cjs`, `deploy-dispute.cjs` — the last already updated for the new constructor arg) are ready to run when desired.
- **Backend & frontend:** all fixes are in the repo, typechecked, linted (zero new errors beyond the 5 pre-existing, unrelated ones), and build cleanly — but **not deployed** to Railway (backend) or Vercel (frontend). The live app at the production URLs is still running the pre-audit code until those are redeployed.

In short: **fixed in code, not fixed in production.** Treat every ✅ below as "ready to ship," not "already shipped."

| # | Finding | Code status | Deployed? |
|---|---|---|---|
| Bug #1 | BidEngine address "mismatch" | Corrected — was a stale README, not a real bug (verified live on-chain) | ✅ doc fix only, trivially "live" |
| Bug #2 | BidEngine bid-spam | ✅ Fixed (contract) | ❌ Not deployed |
| Bug #3 | Ratings ungated | ✅ Fixed (frontend + backend) | ❌ Not deployed |
| Bug #4 | Bid-then-withdraw race | ✅ Fixed (contract) | ❌ Not deployed |
| Bug #5 | Unbounded bid loops | ✅ Fixed (contract) | ❌ Not deployed |
| Bug #6 | "Read directly from Arc" copy | ✅ Fixed (copy) | ❌ Not deployed |
| Bug #7 | Fetch-error vs. empty state | ✅ Fixed (frontend) | ❌ Not deployed |
| Bug #8 | CreateTask deadline validation | ✅ Fixed (frontend) | ❌ Not deployed |
| Bug #9 | Dead `AgentOrb.tsx` | ✅ Fixed (deleted) | ❌ Not deployed |
| Bug #10 | `slashOnTimeout` untested | ✅ Fixed (new tests) | N/A (test-only) |
| Security #1 | VerifierBridge signature binding | ✅ Fixed (contract) | ❌ **Not deployed — still exploitable live** |
| Security #2 | No auth on deliverable/verify | ✅ Fixed (backend signature auth + on-chain-agent binding) | ❌ Not deployed |
| Security #3 | Hosted-agent key storage | ⚠️ Partially fixed — `.gitignore` fixed now; `/data`-volume auto-detection fixed in code; **raw private keys are still stored in plaintext** (not swapped for a keyless scheme) | ❌ Not deployed |
| Security #4 | `/api/verify` cost amplification | ✅ Fixed (backend) | ❌ Not deployed |
| Security #5 | No signature domain separation | ✅ Fixed (contracts + backend, in lockstep) | ❌ **Not deployed** |
| Security #6 | Owner/trustedSigner centralization | ⚠️ Partially addressed — zero-address guards added; **no multisig/timelock** (out of scope: a genuine infra change, not a bug patch) | ❌ Not deployed |
| Security #7 | Deliverable view is UI-only-gated | ✅ Fixed (signed short-lived view token, backend + frontend) | ❌ Not deployed |
| Security #8 | `ADMIN_SECRET` timing/query leak | ✅ Fixed (backend) | ❌ Not deployed |
| Security #9 | Admin secret needs devtools | ✅ Fixed (in-app unlock prompt) | ❌ Not deployed |
| Missing #1 | Bid formula docs stale | ✅ Fixed (README + in-app docs) | ❌ Not deployed |
| Missing #2 | Dispute rework not on-chain | ❌ Not fixed — would need a deeper `AgentRegistry`/`TaskRegistry` re-wire the codebase's own comments say isn't currently possible; out of scope this session | — |
| Missing #3 | Off-chain stores not persistent | ✅ Fixed — more robustly than originally scoped: `/data` volume is now auto-detected at runtime (`server/store-path.js`), not just documented | ❌ Not deployed |
| Missing #4 | "AI jury" framing | Reassessed — grepped the actual in-app/README copy and found no "multi-member" claim anywhere (only "AI jury" / "impartial jury"), so there's no false claim to correct here | — |
| Perf: swarm tick overlap | ✅ Fixed (both swarm variants) | ❌ Not deployed |
| Perf: `/api/verify` cache bypass | ✅ Fixed (memoized `readTaskMeta`) | ❌ Not deployed |
| Perf: unbounded bid loops | ✅ Fixed (same as Bug #5) | ❌ Not deployed |
| Perf: `hosted.js` tick race | ✅ Fixed | ❌ Not deployed |
| Perf: flat 8s polling | ❌ Not fixed — low priority, out of scope this session | — |

**Verification performed this session:** 39/39 Hardhat tests passing (8 new, covering exactly the new fixes), zero TypeScript errors, clean production build, zero new ESLint errors (baseline pre-existing: 5 errors / 6 warnings, all unrelated to this work and unchanged), all 18 backend files pass `node --check`. No live browser click-through was performed (no running dev server / deployed backend in this session) — that remains the one verification step still worth doing before calling this production-ready.

---

## Requirements traceability (README claims → actual code)

| Claim | Status |
|---|---|
| Escrow is single funds-puller (double-`transferFrom` bug fixed) | ✅ Verified fixed, tested |
| Reverse-auction bidding, reputation floor 70 to bid | ⚠️ Floor enforced; scoring formula in code (`price·25 + rep·10 + speed·10 + random·55`) does not match the README's stated `price·.4 + rep·.4 + speed·.2`. Bidding itself works correctly on-chain (verified — see corrected Bug #1) |
| Trusted-signer verdict → release/refund/slash | ❌ Implemented but exploitable — no binding of `agent`/`requester` to the signature (Security #1) |
| Deadline slashing (`slashOnTimeout`) | ✅ Implemented, permissionless, correct — but zero test coverage |
| Direct hire (`submitDirectTask`) | ✅ Implemented and tested |
| Agent stake/deactivate/withdraw, zero-active-tasks gate | ✅ Correct for the happy path; race window exists (Bug #4) |
| On-chain deliverable attestation (keccak256 hash) | ✅ Implemented correctly |
| Recurring subscriptions (`SubscriptionManager`) | ✅ Solid implementation, well tested |
| Recurring market (`RecurringMarket`) | ✅ Solid implementation, well tested |
| Real-data deliverables (Open-Meteo/CoinGecko/Stooq/TheSportsDB) | ✅ Genuine live HTTP calls, no mocking |
| Hosted persona agents | ✅ Loop is real and wired — but see Critical #3 (key storage) |
| Staked disputes + AI jury | ⚠️ Real, distinct LLM call — but it's one LLM call, not an "AI jury" of multiple members as framed; on-chain rework consequence not enforced |
| Reviews & ratings | ⚠️ Real but ungated — any wallet can post unlimited fake reviews (Bug #3, frontend) |
| Verification tiers / badges | ✅ Implemented correctly, access-controlled |
| Circle agent MPC wallets + Modular passkey wallets + PIN wallets | ✅ All three genuinely wired to real Circle SDK/CLI calls, not stubs |
| x402/Gateway nanopayment paywall | ✅ Middleware genuinely enforced, not decorative |
| "Chain is source of truth, no database" | ⚠️ True of the *backend* (indexer reconstructs from `eth_getLogs`); the frontend does **not** read chain logs itself, it polls the backend's `/api/index` REST endpoint — in-app copy states this as a frontend/browser property in three places, which is inaccurate (Bug #6) |

---

## ✅ Implemented correctly

- **USDCEscrow single-puller fix** — `USDCEscrow.lockFunds` is the only `transferFrom`; verified by `polaris.test.cjs`.
- **Reentrancy protection & CEI ordering** — applied consistently across `USDCEscrow`, `AgentRegistry`, `SubscriptionManager`, `RecurringMarket`, `DisputeManager`; state flags set before external calls throughout.
- **USDC 6-decimal handling** — consistent everywhere in contracts and frontend (`USDC_DECIMALS = 6` centralized in `chain.ts`), no 18-decimal copy/paste bugs found anywhere.
- **SubscriptionManager & RecurringMarket** — both are the best-built contracts in the repo: correct per-delivery release, replay-blocked via delivery-index mappings, correct escrow/refund math, well tested.
- **DisputeManager bond math** — 30%/20%/50% split verified exactly correct and tested.
- **AgentBadges** — correct access control, tier bounds enforced, tested.
- **Deadline timeout slashing logic** — correct (though untested).
- **Direct hire path** — implemented and tested.
- **Indexer (`server/indexer.js`)** — genuinely well-built: chunks `eth_getLogs` ≤9000 blocks as required, single-flighted, stale-while-revalidate cached, defends against a transient empty response clobbering good cache.
- **Verifier signer key handling** — never hardcoded, read from env only, `.env` properly gitignored, confirmed absent from git history.
- **Pay-only-after-PASS core loop** (`server/server.js`) — sound reject/retry/slash state machine.
- **Real-data grounding** (`server/datafeeds.js`) — genuine external API calls, fails soft rather than fabricating data.
- **Circle wallet integrations** (agent MPC, human passkey, PIN/email) — all three call real SDK/CLI methods end-to-end, not placeholders.
- **x402 paywall** — middleware genuinely gates the route.
- **Frontend transaction UX** (`useTx.ts`, `lib/errors.ts`) — well-built shared runner: loading/pending/success/failure states, human-readable revert-reason mapping, explorer links.
- **Routing completeness** — all 12 route files mounted, no orphans; no dead UI buttons or TODO-stubbed handlers found anywhere in the frontend.
- **No mock/placeholder data shipped** — clean grep across both frontend and contracts for TODO/FIXME/mock/dummy/fake patterns.

---

## ⚠️ Missing or incomplete

1. **README's stated bid-scoring formula doesn't match deployed code.** README says `price·.4 + rep·.4 + speed·.2`; the actual live `BidEngine` (v2, fairness-lottery) is `price·25 + rep·10 + speed·10 + random·55` — a materially different, randomness-dominated mechanism. Docs are stale relative to what's live.
   *File: `contracts/contracts/BidEngine.sol:71-100` vs `README.md:36`. Severity: Low (docs), but see Bug #1 for why it doesn't matter in production right now.*

2. **Dispute "rework" consequence is not enforced on-chain.** README states an upheld dispute leads to "agent reworks"; `DisputeManager` never calls back into `TaskRegistry`/`AgentRegistry` to compel or record this — it's entirely an off-chain convention.
   *File: `contracts/contracts/DisputeManager.sol`. Severity: Medium.*

3. **Off-chain persistent stores are not actually persistent in the current deployment.** README/SETUP say `HOSTED_STORE`, `DELIVERABLE_STORE`, `SUB_DELIVERY_STORE`, `RM_DELIVERY_STORE`, `RATINGS_STORE`, `ASSET_STORE`, `AGENT_META_STORE` must point at a Railway `/data` volume — none of these appear in `server/.env.example`, and the real `server/.env` sets `DELIVERABLE_STORE=./deliverables.json` (ephemeral, not `/data`). Every deliverable, rating, flag, and hosted-agent key is wiped on every Railway redeploy.
   *Files: `server/.env.example`, `server/.env`. Severity: High (data loss, and for hosted-agent keys, fund loss — see Security #3).*

4. **"AI jury" is a single LLM call, not a multi-member jury** as the "jury" framing implies (no ensemble, no independent votes/models).
   *File: `server/disputes.js:47-65`. Severity: Low — cosmetic vs. the marketing framing, not a functional defect.*

---

## ❌ Bugs

**#1 — CORRECTED (was reported Critical, downgraded to Low after on-chain verification): README's documented BidEngine address was stale — the frontend and live deployment were actually correct.**
Initial static analysis found `src/lib/contracts.ts:22` (`0x9Cd236...`) disagreeing with `README.md` (lines 132, 195, 227: `0x5A1D8e1e...`), and assumed the frontend was wrong since two docs agreed against one code file. Before "fixing" `contracts.ts`, I queried the live `TaskRegistry` contract directly (`TaskRegistry.bidEngine()`, a public state variable — the actual source of truth for which BidEngine the market is wired to) via RPC:
```
TaskRegistry.bidEngine() on-chain → 0x9Cd236e0Dd59496C9540ef657125073252d03397
```
This matches `src/lib/contracts.ts` and the local `server/.env` exactly — **the frontend and backend config were both already correct**; `README.md` had the stale address (from an earlier BidEngine deployment, before the "v2 fairness-lottery" `deploy-bidengine-v2.cjs` redeploy documented in `SETUP.md` §4 rewired `TaskRegistry` to a new instance). Bidding was never actually broken. I additionally cross-checked every other documented contract pointer (`verifierBridge`, `escrow`, `agentRegistry`, `taskRegistry`) against their live on-chain values and all matched README exactly — only BidEngine had drifted.
*Fix applied: corrected the three stale addresses in `README.md` (lines 132, 195, 227) to `0x9Cd236e0Dd59496C9540ef657125073252d03397`, matching on-chain reality. No code change needed. Residual risk: I could not verify Railway's live `VITE_CONTRACT_BID_ENGINE` env var from this environment — worth a one-time manual check that it matches the corrected README value.*

**#2 — HIGH: `BidEngine.placeBid` has no per-agent-per-task bid limit.** A single agent can submit unlimited bids on the same task, each getting an independent 55%-weighted random roll, directly defeating the "fairness lottery" the contract and its own test suite (`fairness.test.cjs`) claim to guarantee, and growing `bids[taskId]` toward the unbounded-loop gas-DoS in `awardBid` (Bug #5 below).
*File: `contracts/contracts/BidEngine.sol:62-104`. Fix: `require(!hasBid[taskId][msg.sender])`.*

**#3 — HIGH: Ratings/reviews have no proof-of-engagement.** `RatingsPanel.tsx:78` always calls `submitRating(wallet, "", address, stars, comment)` with a hardcoded empty `taskId`; the backend only dedupes on `(taskId, rater)`, so any freshly-created wallet (free via passkey) can post unlimited fake reviews for any agent with zero proof of a real transaction.
*Files: `src/components/RatingsPanel.tsx:78`, `server/server.js:264-279`. Fix: require a real completed-task id tied to the rater's wallet, verified against on-chain settlement, before accepting a rating.*

**#4 — MEDIUM: Bid-then-withdraw race can permanently block auction award for a task.** An agent can place a bid (which doesn't increment `activeTasks`), then immediately `deactivate()` + `withdrawStake()` (allowed since `activeTasks==0`). If that stale bid remains the highest-scored entry, every future `awardBid(taskId)` call reverts inside `AgentRegistry.onAssigned` (`"Unknown agent"`), bricking that task's auction (requester can still cancel while status stays OPEN — not a fund-loss bug, but a DoS).
*Files: `contracts/contracts/BidEngine.sol:106-125`, `contracts/contracts/AgentRegistry.sol:98-138`. Fix: skip/remove stale bids from deregistered agents in `awardBid`, or block withdrawal while any of the agent's pending bids are still un-awarded.*

**#5 — MEDIUM: Unbounded loops in `BidEngine.awardBid` and `RecurringMarket.award` over the full bids array** — no cap, so a large enough bid count (worsened by Bug #2) can exceed the block gas limit and permanently brick the award call for that task/plan.
*Files: `contracts/contracts/BidEngine.sol:106-125`, `contracts/contracts/RecurringMarket.sol:106-126`. Fix: cap max bids per task, or switch to an incrementally-tracked running-max instead of a full re-scan at award time.*

**#6 — MEDIUM: In-app copy asserts the *frontend* reads directly from chain; it actually polls the backend REST API.** `Docs.tsx:130`, `Explorer.tsx:39`, `TaskMarket.tsx:34` all state variants of "read directly from Arc, no database," but `src/lib/onchain.ts` is a pure `/api/index` REST poller (every 8s) with no `eth_getLogs` call anywhere in `src/`. If the backend index is stale, wrong, or down, the browser has no independent way to detect or flag the discrepancy — see Bug #7.
*Files: `src/lib/onchain.ts`, `src/routes/Docs.tsx:130`, `src/routes/Explorer.tsx:39`, `src/routes/TaskMarket.tsx:34`. Fix: either rephrase the in-app copy to describe the backend's indexing property accurately, or actually add a client-side spot-check against `eth_getLogs`/a public RPC for critical values.*

**#7 — HIGH: Fetch-error state is indistinguishable from a genuinely empty market.** None of the 9 routes that consume `useIndex`/`useTasks`/etc. read the `error` field react-query exposes — all destructure only `{ tasks/agents, isLoading }`, so `[]` on error renders the identical "No tasks here yet" empty state as a real empty market. This is exactly the ambiguity the README warns operators about (`VITE_INDEX_CHUNK_BLOCKS=10000` "silently shows zero agents/tasks") — and the frontend does nothing to disambiguate it for end users.
*Files: all 9 consuming routes; root cause `src/lib/onchain.ts:36`. Fix: surface `error` and render a distinct "couldn't load — retry" state.*

**#8 — MEDIUM: CreateTask deadline validation is server/contract-only, producing a confusing partial-success UX.** `CreateTask.tsx:233-235` shows `min="1"` as an HTML hint only; it's not included in the `valid` boolean gating submit (`CreateTask.tsx:66-68`), so a 0/negative deadline lets the `approve()` call succeed and only the second `submitTask()` call revert — the user sees one transaction succeed and the next fail for a validation error that should have been caught client-side.
*File: `src/routes/CreateTask.tsx:66-68,233-235`. Fix: include the deadline check in the `valid` gate before allowing `approve()` to fire.*

**#9 — LOW: Dead component.** `src/components/AgentOrb.tsx` is a fully built, never-imported alternate hero visual (Home.tsx uses `AgentAvatar.tsx` instead). No runtime cost (Vite tree-shakes it) but stale source.
*File: `src/components/AgentOrb.tsx`.*

**#10 — LOW: `slashOnTimeout` has zero test coverage** despite being one of only two paths that move escrowed funds outside the main verify flow.
*File: `contracts/contracts/TaskRegistry.sol:208-216`.*

---

## 🔒 Security issues

**#1 — CRITICAL: `VerifierBridge.submitVerification` doesn't bind `agent`/`requester` to the signature — funds and reputation can be redirected by any third party.** Verified by direct read: the signed digest is `keccak256(taskId, passed, score, deliverableHash).toEthSignedMessageHash()` (`VerifierBridge.sol:88`) — `agent` and `requester` are ordinary unsigned calldata parameters, and the function has **no access-control modifier at all** (anyone can call it). Concretely:
  - *Pass path:* once the backend's legitimate signature for `(taskId, true, score, hash)` exists (visible the moment it's broadcast, or even just known off-chain), anyone can front-run/replay it with `agent = <attacker's own registered address>`. `escrow.releaseSplit` pays the attacker the full winning bid; `agentRegistry.recordSuccess` credits the attacker's reputation; `processed[taskId] = true` then permanently blocks the real agent from ever being paid.
  - *Fail path:* even cheaper — no attacker registration needed. Call with the real `agent` (untouched, so `agentRegistry.slash` succeeds) but `requester = attacker`; the 10% slash beneficiary payment goes to the attacker instead of the wronged requester.
  This is completely uncovered by `contracts/test/polaris.test.cjs` (every test happens to call it with correct/matching addresses, which is why it wasn't caught).
  *File: `contracts/contracts/VerifierBridge.sol:76-112`.*
  *Fix: (a) gate `submitVerification` to `onlyOwner`/`onlyBackend` (the backend is the only intended caller anyway, per the trust model doc-comment), **and** (b) include `agent` and `requester` inside the signed digest so the signature itself binds them, closing the hole even if the access-control gate is ever loosened. Do both — belt and suspenders, since this function moves real money.*

**#2 — CRITICAL: No auth binding a deliverable submission or verification trigger to the actual on-chain agent.** `POST /api/deliverable` and `POST /api/verify` (`server/server.js:127,346`) accept any caller who knows a public `taskId` — no signature proving control of the assigned agent's wallet. An attacker can submit a bogus deliverable "as" a victim agent and trigger `/api/verify`, burning the victim's limited review attempts, forcing a premature reopen, or driving a real, innocent agent into the slash path.
  *Fix: require the request to include a wallet signature over the deliverable/task id, verified against `readAssignedAgent(taskId)` before accepting.*

**#3 — CRITICAL: Hosted-agent private keys are stored in plaintext, on ephemeral (non-`/data`) storage, and the store file isn't gitignored.** `hosted.js:16,52` writes raw `privateKey` to `HOSTED_STORE`, which defaults to `./hosted-agents.json`. The real `server/.env` leaves this var unset, so on Railway it lives on ephemeral disk and is wiped every redeploy — permanently orphaning any wallet a user funded with their 100 USDC stake. Separately, `hosted-agents.json` (unlike `deliverables.json`/`assets.json`/`agent-meta.json`) is **not** in `.gitignore`, so a routine `git add -A` risks committing live funded private keys to source control.
  *Files: `server/hosted.js:16,52`, `.gitignore`, `server/.env`. Fix: (1) add the file to `.gitignore` immediately, (2) point `HOSTED_STORE` at the `/data` volume in production, (3) stop storing raw private keys at all if avoidable — this is exactly the kind of wallet the Circle MPC integration exists to avoid needing raw keys for.*

**#4 — HIGH: `/api/verify` is a free, unauthenticated LLM-cost and RPC-quota amplifier.** The scoring LLM call runs before the "already processed" check, and the task-metadata lookup does an **uncached** chunked `eth_getLogs` scan (up to ~56 RPC calls) instead of using the existing indexer cache. No rate limiting anywhere on this route. Repeated calls burn LLM spend and can exhaust the same RPC quota the indexer module was specifically built to protect.
  *File: `server/server.js:346-374`. Fix: check `bridge.processed(taskId)` and rate-limit before the LLM call; route the metadata lookup through the cached indexer.*

**#5 — HIGH: Signed verdicts have no domain separation** (`chainid`/contract address not included in any of the four signing schemes across `VerifierBridge`, `SubscriptionManager`, `RecurringMarket`, `DisputeManager`), and `SubscriptionManager`/`RecurringMarket` sign an identical field layout `(id, index, deliverableHash, score)` typically under the same signer key. Combined with this project's demonstrated habit of redeploying contracts while reusing the same `VERIFIER_SIGNER_ADDRESS` (old instances never disabled), a verdict is replayable across deployments or potentially across the two sibling contracts if ids collide.
  *Files: `VerifierBridge.sol:88`, `SubscriptionManager.sol:144`, `RecurringMarket.sol:134`, `DisputeManager.sol:106`. Fix: include `block.chainid` and `address(this)` in every signed digest.*

**#6 — MEDIUM: Owner/trustedSigner keys are single EOAs with unrestricted, non-timelocked rewiring power** across every contract (`setTrustedSigner`, `setVerifierBridge`, etc., no multisig/timelock, no zero-address checks). A single key compromise anywhere can redirect settlement or drain future escrow. Common at MVP stage, but should be explicitly disclosed as a trust assumption (README currently only discloses the *scoring* signer as trusted, not the breadth of owner powers).
  *Files: e.g. `USDCEscrow.sol:42-50`, `VerifierBridge.sol:70-74`, `DisputeManager.sol:62-71`. Fix: multisig + timelock for owner actions before mainnet; at minimum add zero-address guards.*

**#7 — MEDIUM: Owner-only deliverable UI gate is client-side only.** `TaskDetail.tsx:489-497` conditionally renders the deliverable behind an "owner only" lock icon, but `GET /api/deliverable/:taskId` (`server/server.js:138-142`) has no auth check — anyone can fetch any task's deliverable directly.
  *Fix: require a signature or session proving requester identity before returning the deliverable body.*

**#8 — LOW: `ADMIN_SECRET` comparison uses naive `!==`** (not timing-safe) and one admin-adjacent route (`GET /api/flags?secret=`) accepts the secret as a query parameter, which lands in server access logs and browser history.
  *File: `server/server.js:324,333`. Fix: `crypto.timingSafeEqual`, move to a header, never a query string.*

**#9 — LOW: Admin secret sits in `localStorage` indefinitely with no login UX** — functional but relies on tribal knowledge (must be set via devtools) and unencrypted persistent client storage of a privileged secret.
  *File: `src/components/AdminBadgePanel.tsx:9,18,23`.*

---

## 🚀 Performance improvements

- **Swarm tick overlap** — `agent-circle.js`'s `tick()` loop does long in-process `await sleep(workMs)` calls (20–30 min simulated work) inside the main task loop, while `setInterval(tick, POLL_MS)` (30s) keeps firing regardless, producing overlapping concurrent ticks that redundantly re-fetch `/api/index`/`/api/recurring-plans`/`/api/reworks` during any busy window. Add a re-entrancy guard so a new tick doesn't start while one is still in flight.
- **`/api/verify`'s task-metadata lookup bypasses the indexer cache** (see Security #4) — route it through the existing cached index instead of a fresh uncached `eth_getLogs` scan.
- **`BidEngine.awardBid`/`RecurringMarket.award` unbounded loops** (Bug #5) — beyond the DoS framing, this is also a plain gas-cost/scalability issue that gets worse linearly with bid count; worth capping regardless of the adversarial angle.
- **`hosted.js`'s `tick()`** does `load()` → many `await`s → `save()`, a genuine lost-update race under concurrent `POST /api/hosted-agent` calls (lower-impact than the private-key storage issue, but still a correctness/perf issue under load).
- **Frontend `/api/index` polling at a flat 8s interval** on every route regardless of tab visibility or user activity — consider backing off when the tab is hidden (`document.visibilityState`) to reduce unnecessary backend/RPC load.

---

## 📋 Final implementation score

### Pre-fix baseline (start of this session)

- **Requirements coverage: 82/100** — corrected upward from the original 78 after verifying Bug #1 on-chain: bidding was never actually broken (a stale README, not a code bug). Nearly every claimed feature (task market, escrow, verification, disputes+jury, recurring market, subscriptions, badges, ratings, hosted agents, all three Circle wallet types, x402) genuinely exists and is wired, not stubbed. Points still lost because several documented guarantees (persistent off-chain stores, on-chain dispute-rework enforcement) didn't match what was actually deployed/running.

- **Code quality: 60/100** — the architecture is genuinely thoughtful in places (chain-as-truth indexing with proper chunking/caching, a well-built shared tx/error-handling layer, consistent decimal handling, good CEI/reentrancy discipline in most contracts). But it was undermined by a critical unauthenticated-signature bug in the core settlement contract that the test suite happened not to exercise, and several client-side validation/error-surfacing gaps that were inconsistent between components.

- **Production readiness: 38/100** — not safe to run with real value at stake. A critical, cheap, single-transaction fund-theft/reputation-hijack vector existed in the contract that actually moves the money (Security #1); off-chain persistent stores were misconfigured to be ephemeral in production, which for hosted-agent private keys meant real fund loss on every redeploy (Security #3); and there was no rate limiting on a route that spends LLM budget and RPC quota (Security #4).

### Post-fix, pre-deploy (end of this session)

- **Requirements coverage: 82/100** — unchanged; this session fixed bugs, it didn't add or remove scope.

- **Code quality: 84/100** — every Critical/High finding has a real, tested fix in the working tree (39/39 contract tests including 8 new ones targeting exactly these fixes; clean TypeScript/build/lint). Remaining deductions: owner-key centralization has no multisig/timelock (disclosed, not fixed — a genuine infra project, not a patch), the dispute-rework consequence still isn't enforced on-chain (the contract's own doc-comment says this needs a bigger re-wire), and hosted-agent keys are still raw plaintext in a JSON file (harder to fully close without replacing that wallet model, e.g. with Circle MPC the way the agent swarm already does it).

- **Production readiness: 40/100 as currently deployed, would be ~85/100 once shipped** — this is the number that matters most and it needs to be read carefully: **nothing in this session has been deployed.** The contracts still live at the original addresses with the original Critical vulnerability exploitable right now; the backend and frontend fixes exist only in this repo's working tree, not on Railway/Vercel. The score is low today because the live system is unchanged. It is not a 40 once someone runs the 5 existing deploy scripts and pushes the backend/frontend — at that point the blocking issues from the original 38 are resolved and the remaining gaps (owner centralization, dispute-rework enforcement, hosted-key storage) are disclosed, bounded, and no longer Critical/High.
