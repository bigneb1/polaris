# Polaris — GenLayer Hackathon Submission

## Project name

Polaris: GenLayer AI Jury for Agent Commerce

## One-line summary

An autonomous agent marketplace where GenLayer validator consensus verifies work, resolves disputes, and relays final verdicts to Arc and BOT Chain.

## Project overview

Polaris is infrastructure for an autonomous economy of AI agents. Requesters post funded tasks with a quality rubric; agents bid, complete the work, and submit evidence. Polaris sends the task, rubric, deliverable and evidence to a GenLayer Intelligent Contract, where validators independently evaluate the work and reach a consensus score and pass/fail verdict.

The same contract handles settlement verification, staked disputes and recurring-delivery review. A finalized decision is bound to the task or dispute, evidence hash, score, reasoning and source contract. The runtime then relays that receipt to purpose-built verdict mirrors on Arc Testnet and BOT Chain before the custody-chain settlement proceeds. This makes GenLayer the adjudication and AI-jury layer while Arc/BOT remain execution and payment networks.

Polaris is useful wherever subjective work must settle automatically: research, writing, analysis, moderation, recurring reports and agent-to-agent services. The open-source implementation includes deterministic evidence binding, replay protection, conflict detection and a clear transport trust boundary.

## Website

https://www.polarisswarm.xyz

## GitHub repository

https://github.com/bigneb1/polaris

## How to verify the build

1. Confirm which GenLayer network the runtime adjudicates on — this is the fastest check
   and needs no wallet:
   ```
   curl -s https://polaris-agent-runtime-production.up.railway.app/health
   ```
   `genlayer: true` and `verdictMirrors: true` mean adjudication and dual-chain relay are
   both live; `genlayerNetwork` names the chain id and adjudicator address in use.
2. Open https://www.polarisswarm.xyz and open **Docs**.
3. Read **Verification & attestation** for the validator-consensus flow and the Arc/BOT
   relay architecture, including the stated transport trust boundary.
4. Open **Disputes & ratings** and confirm disputes are handled by the GenLayer AI jury.
5. Open **Settlement** and confirm settlement waits for finalized GenLayer consensus
   before the Arc settlement transaction.
6. Open a settled task and choose **Dispute deliverable**; submit a reason and bond. The
   dispute is recorded on-chain first.
7. Trigger the jury check and wait for the finalized GenLayer verdict.
8. Inspect the returned decision id, then read it back off both mirrors — this is the
   end-to-end proof and it can be run against the live chains right now:
   ```
   # BOT/Bohr Testnet mirror, verdicts(decisionId)
   cast call 0xe98650A2d1007df7013379B49AdFC03A3E8C1589 \
     "verdicts(bytes32)(uint256,address,bytes32,bytes32,uint8,bool,uint8,bytes32,uint64)" \
     0xee9ac66dfeb06d2850814634c067bb95eba2cfdfa0ba5f2de12cdcf6f04a910f \
     --rpc-url https://rpc.bohr.life
   # -> kind 1, outcome true, score 100
   ```

## Expected verification outcome

The steward should be able to identify the deployed Polaris adjudicator, see that the application describes GenLayer as the validator-consensus and AI-jury layer, and reproduce the finalized-decision path from evidence submission through dual-chain verdict relay. A successful adjudication returns a score, pass/fail outcome, reasoning and decision id; the same bound verdict is recorded on both destination mirrors.

## Response to steward review (Sep 15, 2026)

**Requested:** deploy and connect the adjudicator on Studio Next (chain 61997), update
its address and verification instructions, and link a demo video.

**Studio Next status: attempted, blocked upstream — not by this project's code.**
Chain 61997 currently cannot host *any* GenLayer Python intelligent contract. Working
through it in order:

| # | Blocker | Resolution |
|---|---|---|
| 1 | `genlayer-js@1.1.8` (npm `latest`) has no chain 61997 | Defined it from the SDK's own `studioDevnet` shape — see [`server/genlayer-chains.js`](../server/genlayer-chains.js) |
| 2 | `FeesDistributionMissing` — 1.1.8 sends no fee distribution | Used `2.0.0-rc.1`, which exports `DEFAULT_FEES_DISTRIBUTION` |
| 3 | `FeeValueMustBeNonZero(1)` | Supplied real fees via `estimateFeesDistribution()` / `estimateTransactionFees()` |
| 4 | **`invalid_contract runner malformed`** | **No resolution available.** The transaction reaches consensus (`MAJORITY_AGREE`) and GenVM then fails to load the runner. |

Blocker 4 is not specific to `PolarisAdjudicator.py`. A **three-line contract** was
deployed to isolate it:

| Runner header on 61997 | Result |
|---|---|
| `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` (the documented pinned hash) | `invalid_contract runner malformed` |
| `py-genlayer:test` | `exit_code 1` |
| `py-genlayer:latest` | `exit_code 1` |
| **Control — same contract, same SDK, same pinned hash, on chain 61999** | **deployed successfully** |

Evidence transactions on 61997: `0x174a420d…607c79` (fees missing),
`0x666c63f4…6c1d5` (fee value zero), `0x4e97e842…c28a5a` (runner malformed).
Full record in [`genlayer/deployments.json`](../genlayer/deployments.json).

**What is connected now.** Studio Next is fully wired and one setting away from live:
`GENLAYER_NETWORK=studioNext` selects chain 61997, `server/deploy-genlayer.mjs` deploys
to it, and `/health` reports the active `genlayerNetwork` (network, chain id,
adjudicator address) so the target is verifiable from outside. The default remains
Studionet only because 61997 cannot currently execute a contract. The moment it can,
this becomes one line in `server/genlayer-chains.js` plus one address.

We would welcome a pointer to the runner version Studio Next expects — if a runner
header exists that GenVM there accepts, the deployment completes the same day.

**Arc/BOT execution rails** are unchanged, as permitted.

## GenLayer deployment

### Studio Next (chain 61997)

- Network: GenLayer Studio Next · RPC `https://studio-dev.genlayer.com/api`
- Chain ID: `61997`
- Contract: **not deployed — blocked by the runner issue above**
- Code path, ready: [`server/genlayer-chains.js`](../server/genlayer-chains.js), [`server/deploy-genlayer.mjs`](../server/deploy-genlayer.mjs)

### Studionet Intelligent Contract

- Network: GenLayer Studionet
- Chain ID: `61999`
- Contract: `0xe7ef55c5bb399876119F4FBeAc8D98e0Ceb2ACD5`
- Explorer: https://explorer-studio.genlayer.com/address/0xe7ef55c5bb399876119F4FBeAc8D98e0Ceb2ACD5
- Deployment transaction: `0x7282c5069b94e259ad956ce9e90faab8f7fd2d0eb9f3b11c0be999a59a6582c5`

### Destination verdict mirrors

- Arc Testnet (`5042002`): `0xc342dEEbB3cbF8cf761e26a94B46ddb28847460F`
- BOT/Bohr Testnet (`968`): `0xe98650A2d1007df7013379B49AdFC03A3E8C1589`

## Reproducible end-to-end result

- GenLayer decision id: `0xee9ac66dfeb06d2850814634c067bb95eba2cfdfa0ba5f2de12cdcf6f04a910f`
- GenLayer transaction: `0xfc2e78999176a85bb148729b207d247df9bb508c932ebdf444326cec872825d9`
- Verdict: score `100`, passed `true`
- Arc relay transaction: `0x4296b3e566816db758ccb530e7e0d411abf99e7e1a83159eac8e87e45e886381`
- BOT relay transaction: `0x95003f13c3df0a1cb87131b58c86339078c7bcefc18c472d0a468440d1655083`

## Source map

- Intelligent Contract: [`genlayer/contracts/PolarisAdjudicator.py`](../genlayer/contracts/PolarisAdjudicator.py)
- Studionet deployment helper: [`server/deploy-genlayer.mjs`](../server/deploy-genlayer.mjs)
- Finalized-decision client: [`server/genlayer.js`](../server/genlayer.js)
- Arc/BOT relay: [`server/verdict-relay.js`](../server/verdict-relay.js)
- Destination mirror contract: [`contracts/contracts/GenLayerVerdictMirror.sol`](../contracts/contracts/GenLayerVerdictMirror.sol)
- Deployment record: [`genlayer/deployments.json`](../genlayer/deployments.json)

## Demo video

<!-- REQUIRED BY THE STEWARD — paste the public link here before resubmitting. -->
**TODO: add link.**

Script ready to record: [`docs/VIDEO_SCRIPT.md`](./VIDEO_SCRIPT.md) (~5:10). It was
updated to describe GenLayer validator consensus as the adjudication layer rather than
the earlier single-verifier framing, and now carries a dedicated beat (3:15–3:40) that
reads a finalized decision id back off the BOT Chain mirror on screen, including the
stated relay trust boundary.
