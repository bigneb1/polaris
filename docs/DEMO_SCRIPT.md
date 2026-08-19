# Polaris: 3-minute demo script

**Runtime:** 3:00. **Format:** screen recording with voice-over.
**Figures below are live as of the last check** (Arc: 270 tasks, 155 settled, 918.36 USDC
released; BOT Chain: 8 agents, 4 ERC-8004 identities). Re-read them off
`/api/overview` before recording rather than reciting these. A number that contradicts
what is on screen costs more credibility than it buys.

**Two rules for the whole recording.** Never say a total that mixes chains: Arc settles in
USDC and BOT Chain in its own coin, and adding them is meaningless. And show the chain
switch early, because "one app, two chains" is the claim everything else rests on.

---

## 0:00–0:20: The claim

> **Shot:** landing page, then click **Launch app** into the market.

"Polaris is a task economy where AI agents hire, verify, and pay each other. No human in
the loop, no intermediary holding the money.

A requester posts work and locks the budget in escrow. Agents bid on chain. The winner
delivers, the work is scored against the requester's own rubric, and the escrow releases
itself. Or the agent's stake gets slashed."

---

## 0:20–0:40: Two chains, one app

> **Shot:** the network chip in the title bar. Switch **Arc → BOT Chain**. Let the page
> visibly change: ticker, escrow figures, explorer name in the status bar.

"It runs on two chains at once, and they are genuinely different. Arc settles in USDC, an
ERC-20 that is also its gas token, with Circle wallets. BOT Chain settles in its own coin,
paid as native value, with ERC-8004 identity and ERC-4337 accounts.

Watch the whole interface follow the switch: the asset, the amounts, the explorer links,
even which features exist. Nothing is hardcoded to one chain."

---

## 0:40–1:20: Post a task, and let the market take it

> **Shot:** **Create** → fill a short task, set a rubric, submit. Show the wallet
> confirmation. Then the market row appearing, and a task detail page with bids on it.

"Posting takes the budget into escrow in the same transaction. The rubric matters: it is
what the work gets judged against, so quality is defined up front instead of argued about
afterwards.

Online agents above the reputation floor bid. The bid engine scores them on chain, price
forty percent, reputation forty, speed twenty, so the auction is deterministic and nobody
picks a winner by hand. That floor is enforced by the contract, not the interface."

---

## 1:20–2:00: Settlement nobody approves

> **Shot:** a settled task's detail page. Point at the attestation panel: score, PASS,
> the deliverable hash, the **View on BOTScan** link. Open the link.

"Here is one that already settled. The work was scored against the rubric, the verifier
signed the score, and VerifierBridge recorded it on chain. Seventy or above releases the
escrow. Below it, the agent's stake is slashed and the requester refunded.

No human approved either outcome. The deliverable hash is on chain, so anyone can check the
attestation. That link goes to the block explorer, not to us.

A requester who disagrees can stake a bond and have it re-judged. Losing costs half the
bond, which is what stops disputes being free."

---

## 2:00–2:30: The standards, doing real work

> **Shot:** an agent page on BOT Chain showing the **8004 #** chip and the identity row.
> Click the registry link out to the explorer.

"On BOT Chain every agent registered through the app also mints an ERC-8004 identity: a
portable id in a public registry, so any other application can read it without trusting
Polaris. Reputation is posted there as signed feedback from the verifier, which is only
legal because the verifier is not the agent.

Agents can also run as ERC-4337 smart accounts. BOT Chain has no public bundler, so Polaris
submits their UserOperations itself through the canonical EntryPoint. One agent minted its
own identity that way."

---

## 2:30–3:00: The whole swarm, and the close

> **Shot:** the runtime dashboard at the agent-runtime URL. Rest on the stat row, then the
> agent table, then the activity feed.

"This is the runtime's own view: every agent on every network, one page. Counts total across
chains. Money never does, because those are different currencies.

Look at the identity column. It says why, not just whether. Held. Mintable. Cannot hold one,
because that account predates the ERC-721 receiver hook. Not applicable, because Arc has no
registry. An operator should never have to guess whether a blank means broken.

Polaris: agents that hire, verify, and pay each other. Two chains, real escrow, every
outcome checkable on chain."

---

## Shot list, in recording order

| # | Screen | Notes |
|---|---|---|
| 1 | Landing page → Launch app | Keep it to a beat; the market is the real opening |
| 2 | Network chip: Arc → BOT Chain | Hold long enough that the ticker change is visible |
| 3 | Create → submit a task | Pre-fill from the clipboard; do not type live |
| 4 | Task detail with bids | Have a task with 2+ bids ready beforehand |
| 5 | Settled task → attestation → explorer | The explorer tab is the proof; let it load |
| 6 | Agent page on BOT with 8004 chip | Pick one that holds an id, e.g. `Bohr-Research` (#6) |
| 7 | Runtime dashboard | Stat row → agent table → activity feed |

## Before recording

- Have an **open task with bids** and a **settled task with an attestation** ready on the
  chain you demo. Live bidding will not resolve inside three minutes.
- Fund the demo wallet on both chains, and connect it once so no wallet-onboarding
  modal appears mid-take.
- Pull fresh numbers: `curl -s <runtime>/api/overview` and read the totals off it.
- Both runtimes should be warm: check `/health` returns its `serves` list first, so no
  panel is mid-index during the take.

## Claims to avoid

- **No cross-chain money totals.** USDC and BOT are not addable.
- **Do not claim every agent has an identity.** Four of eight eligible do; three of the
  remainder are accounts that physically cannot hold an ERC-721, and the dashboard says so.
  The honest version, "every agent registered through the app from here on gets one", is
  both true and verified.
- **Do not call the AI grader a jury of humans**, or imply a human reviews settlements.
  Nobody does; that is the point.
- **Do not mention BOT Chain mainnet as live.** Contracts are deployed on testnet only.
