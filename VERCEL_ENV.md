# Vercel environment variables — Polaris frontend

Set these in **Vercel → Project → Settings → Environment Variables** (Production +
Preview), then redeploy. Build command `npm run build`, output `dist`.

> **Contract addresses are NOT needed here.** They are hardcoded in
> `src/lib/contracts.ts` on purpose — a stale `VITE_CONTRACT_*` override points the
> app at a dead contract and your tasks/agents "vanish". **Leave all
> `VITE_CONTRACT_*` UNSET on Vercel.**
>
> **Never put server secrets in Vercel** (they'd ship to the browser). The
> verifier signer key, OpenRouter key, `CIRCLE_UC_API_KEY`, `CIRCLE_UC_ENTITY_SECRET`
> and `ADMIN_SECRET` live **only on the Railway runtime**.

## Required

> **Do NOT set `VITE_API_URL` here.** Arc and BOT Chain run as separate Railway
> services, and each network already carries the correct one as its default
> (`src/lib/networks/`). `VITE_API_URL` is a single global override that wins over
> those defaults, so setting it points **every** network at one runtime: BOT Chain
> requests then reach the Arc runtime, which correctly refuses them with a 409, and
> BOT Chain silently stops working in the deployed app while Arc looks fine. It exists
> for local development, where one process serves both networks. To override a single
> network, use `VITE_API_URL_ARC` or `VITE_API_URL_BOTCHAIN_TESTNET`.

```env
# Backend: leave unset. Each network's runtime URL is already the default.
# Override one network only if you must:
# VITE_API_URL_ARC=https://polaris-agent-runtime-production.up.railway.app
# VITE_API_URL_BOTCHAIN_TESTNET=https://polaris-bot-runtime-production.up.railway.app

# Arc network
VITE_ARC_RPC_URL=https://rpc.testnet.arc.network
VITE_ARC_CHAIN_ID=5042002
VITE_ARC_EXPLORER=https://testnet.arcscan.app
VITE_USDC_ADDRESS=0x3600000000000000000000000000000000000000

# Circle user-controlled wallet (PIN / email) — the "extra connect" option.
# Only the App ID is public; its API key + entity secret stay on Railway.
VITE_CIRCLE_UC_APP_ID=d600913e-7a3b-51d3-bc63-53f3d01a58e5
VITE_CIRCLE_CHAIN_PATH=arcTestnet
```

## Optional — canonical app URL (ERC-8004 identity URIs)

When an agent is registered on a network with ERC-8004 deployed, the app mints the
agent's identity and writes a registration URI into the registry, permanently. That URI
is built from this value, falling back to the browser's current origin.

Set it in **Production** so an identity minted from a preview deployment cannot bake a
`*.vercel.app` preview domain into the chain. It should match the backend's
`PUBLIC_APP_URL`, so a runtime-minted identity and a UI-minted one describe agents the
same way.

```env
VITE_PUBLIC_APP_URL=https://polarisswarm.xyz
```

## Optional — Circle Modular Wallets (passkey, gasless)

These power the **passkey** connect option. They are **currently not configured**
anywhere (empty in the repo `.env`, absent on Railway), so the passkey wallet won't
work until you create a Modular Wallets app at **console.circle.com → Modular
Wallets** and paste its client key + RPC URL here. The PIN/email wallet above works
without them.

```env
VITE_CIRCLE_CLIENT_KEY=            # from console.circle.com → Modular Wallets
VITE_CIRCLE_CLIENT_URL=            # e.g. https://modular-sdk.circle.com/v1/rpc/w3s/<app-token>
```

## What I found on this workspace / Railway

| Credential | Status | Value / source |
|---|---|---|
| **UC App ID** (`VITE_CIRCLE_UC_APP_ID`) | ✅ found | `d600913e-7a3b-51d3-bc63-53f3d01a58e5` (repo `.env` + Railway `CIRCLE_UC_APP_ID`) |
| **UC API key** (`CIRCLE_UC_API_KEY`) | ✅ found (server-only) | set on Railway — `TEST_API_KEY:…` — **do not** put in Vercel |
| **UC entity secret** (`CIRCLE_UC_ENTITY_SECRET`) | ✅ found (server-only) | set on Railway — **do not** put in Vercel |
| **Modular Wallets client key** (`VITE_CIRCLE_CLIENT_KEY`) | ❌ not set | empty in repo `.env`, absent on Railway — create in Circle console |
| **Modular Wallets client URL** (`VITE_CIRCLE_CLIENT_URL`) | ❌ not set | empty in repo `.env`, absent on Railway — create in Circle console |

## Not required (legacy / backend-only)

`VITE_INDEX_LOOKBACK_BLOCKS` and `VITE_INDEX_CHUNK_BLOCKS` are **not used by the
frontend anymore** — the app reads everything from the backend's `/api/index`, so
indexing windows are a Railway concern only.
