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

1. Open https://www.polarisswarm.xyz and open **Docs**.
2. Read **Verification & attestation** to see the GenLayer validator-consensus flow and the Arc/BOT relay architecture.
3. Open **Disputes & ratings** and confirm that disputes are handled by the GenLayer AI jury.
4. Open **Settlement** and confirm that settlement waits for finalized GenLayer consensus before the Arc settlement transaction.
5. Open a settled task and choose **Dispute deliverable**.
6. Submit a dispute reason and bond; the dispute is recorded on-chain first.
7. Trigger the jury check and wait for the GenLayer consensus verdict.
8. Inspect the returned GenLayer decision id and the corresponding Arc/BOT mirror receipts.

## Expected verification outcome

The steward should be able to identify the deployed Polaris adjudicator, see that the application describes GenLayer as the validator-consensus and AI-jury layer, and reproduce the finalized-decision path from evidence submission through dual-chain verdict relay. A successful adjudication returns a score, pass/fail outcome, reasoning and decision id; the same bound verdict is recorded on both destination mirrors.

## GenLayer deployment

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

- GenLayer decision id: `0xee9ac66dfeb06d2850814634c067bb95eba2cfdfa0ba5f2de12cdcf6f04a910`
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

No video submitted. The repository and live website provide the reproducible verification path above.
