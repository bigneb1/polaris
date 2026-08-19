import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

/**
 * Server-side network registry — the backend twin of src/lib/networks/.
 *
 * Every chain-touching module (indexer, verifier, schedulers, swarms) resolves
 * its provider, contract addresses, escrow asset and signing key through here, so
 * one runtime can serve several chains without any of them sharing state.
 *
 * Ids match the frontend exactly (`arc-testnet`, `botchain-testnet`,
 * `botchain-mainnet`) because they travel over the wire as `?network=`.
 *
 * Arc's addresses keep reading from the existing VITE_CONTRACT_* env vars first
 * (that's what Railway sets today) and fall back to the deployed V4 values, so
 * Arc's behaviour is byte-for-byte what it was. BOT Chain reads BOT_CONTRACT_*
 * env vars, then a deployments/<network>/contracts.json artifact written by the
 * deploy script — so a fresh deployment needs no env editing.
 */

export const DEFAULT_NETWORK = "arc-testnet";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

/** Read deployments/<network>/contracts.json if the deploy script has written it. */
function loadDeployment(networkId) {
  const file = process.env[`DEPLOYMENT_FILE_${envKey(networkId)}`] || path.join(ROOT, "deployments", networkId, "contracts.json");
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return json && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

/** `botchain-testnet` → `BOTCHAIN_TESTNET`, for env var names. */
function envKey(networkId) {
  return networkId.replace(/-/g, "_").toUpperCase();
}

/** First non-empty value: explicit env var, then deployment artifact, then default. */
function addr(envName, deployment, key, fallback = null) {
  return process.env[envName] || deployment?.contracts?.[key] || deployment?.[key] || fallback;
}

const arcDeployment = loadDeployment("arc-testnet");
const botTestnetDeployment = loadDeployment("botchain-testnet");
const botMainnetDeployment = loadDeployment("botchain-mainnet");

/* ── Arc Testnet — the existing deployment, unchanged ─────────────────────── */
const arcTestnet = {
  id: "arc-testnet",
  label: "Arc Testnet",
  chainId: Number(process.env.ARC_CHAIN_ID || 5042002),
  // Comma-separated list allowed (e.g. a dedicated QuickNode key first); the
  // public RPC is appended as a last-resort fallback in chain.js.
  rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
  publicRpcUrl: "https://rpc.testnet.arc.network",
  explorerUrl: "https://testnet.arcscan.app",
  addr: {
    usdc: process.env.VITE_USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
    escrow: addr("VITE_CONTRACT_USDC_ESCROW", arcDeployment, "usdcEscrow", "0xE9955f2A7fEcFC47844a5cDbbF39f424e2917c74"),
    agentRegistry: addr("VITE_CONTRACT_AGENT_REGISTRY", arcDeployment, "agentRegistry", "0xEb27dBC89529Bab0365a635F29Ffc720Eb87C470"),
    bidEngine: addr("VITE_CONTRACT_BID_ENGINE", arcDeployment, "bidEngine", "0x9Cd236e0Dd59496C9540ef657125073252d03397"),
    taskRegistry: addr("VITE_CONTRACT_TASK_REGISTRY", arcDeployment, "taskRegistry", "0xe3ad52025F740599A5b02ffD394514fBD3E80F9C"),
    verifierBridge: addr("VITE_CONTRACT_VERIFIER_BRIDGE", arcDeployment, "verifierBridge", "0xA8C2Cd1D3dd31637e5b9138D856508444E826C3A"),
    subscriptionManager: addr("VITE_CONTRACT_SUBSCRIPTION_MANAGER", arcDeployment, "subscriptionManager", "0x3DbA6eD862d4247A30D6dF76d438bEeC72cfb61a"),
    agentBadges: addr("VITE_CONTRACT_AGENT_BADGES", arcDeployment, "agentBadges", "0x6c5f75992390079A0A0aaD51059D7bA05Dc1b842"),
    disputeManager: addr("VITE_CONTRACT_DISPUTE_MANAGER", arcDeployment, "disputeManager", "0xD965F54429a83F80D46462342B24f1814FeBBf05"),
    recurringMarket: addr("VITE_CONTRACT_RECURRING_MARKET", arcDeployment, "recurringMarket", "0xD0DBF9323f7275305868f4f83AaCF1160d2B20Fd"),
    // ERC-8004 is not wired into Arc (see src/lib/networks/arc.ts).
    erc8004Identity: process.env.ARC_ERC8004_IDENTITY || null,
    erc8004Reputation: process.env.ARC_ERC8004_REPUTATION || null,
  },
  /** The asset budgets/stakes are denominated in. Arc's USDC is the gas token but
   *  still moves as an ERC-20, so this is not the native (msg.value) path. */
  asset: { symbol: "USDC", decimals: 6, native: false },
  /** Gas token. On Arc, gas IS USDC — fees are dollar-denominated. */
  gasSymbol: "USDC",
  /**
   * Arc's live contracts predate the audit's domain-separated verdict digests
   * (chain id + contract address, and agent/requester on task verdicts) — verified
   * against the published source of all four on Arcscan. Redeploying them would
   * orphan every existing task, agent stake and escrowed plan on this chain, so the
   * runtime signs what these instances actually verify. See server/digests.js.
   * Flip this to false the day Arc is redeployed from contracts/.
   */
  legacyVerdictDigest: true,
  /** Env var holding the verdict-signing key for this network. */
  signerKeyEnv: "VERIFIER_SIGNER_KEY",
  indexFromBlock: process.env.INDEX_FROM_BLOCK ? Number(process.env.INDEX_FROM_BLOCK) : 47764000,
  // Per-contract deploy blocks. The extensions were deployed later than the core
  // market, so scanning them from the core's block would re-read ~1.5M pointless
  // blocks on every cold start.
  contractFromBlocks: {
    subscriptionManager: Number(process.env.SUB_FROM_BLOCK || 49327026),
    recurringMarket: Number(process.env.RM_FROM_BLOCK || 49364782),
  },
  chunkBlocks: Number(process.env.INDEX_CHUNK_BLOCKS || 9000),
  /** Arc's swarm runs on Circle MPC agent wallets. */
  swarmMode: "circle",
  supportsX402: true,
};

/* ── BOT Chain — testnet 968 / mainnet 677 ────────────────────────────────────
 * Settles in NATIVE BOT (18 decimals) — the same coin that pays gas — using the
 * native-value contract set (NativeEscrow / NativeAgentRegistry /
 * NativeTaskRegistry). Polaris contract addresses arrive from the deploy script's
 * artifact or BOT_CONTRACT_* env vars; until then this network reports
 * `deployed: false` and the API refuses to serve it rather than falling back to
 * Arc's contracts.
 *
 * Subscriptions, the recurring market and staked disputes are ERC-20-only and are
 * not deployed here — their addresses stay null and the per-network services go
 * inert rather than pretending to work.
 */
function botChain({ id, label, chainId, rpcEnv, rpcDefault, explorerUrl, deployment, fromBlockEnv, fromBlockDefault }) {
  const key = envKey(id);
  return {
    id,
    label,
    chainId,
    rpcUrl: process.env[rpcEnv] || rpcDefault,
    publicRpcUrl: rpcDefault,
    explorerUrl,
    addr: {
      // BOT Chain settles in NATIVE BOT, so there is no escrow token contract —
      // value moves as msg.value. This is null unless a deployment explicitly
      // recorded an ERC-20 escrow asset. There is deliberately NO fallback to the
      // bridged-USDT address: reading a token the escrow was never deployed
      // against would silently check balances and approvals against the wrong
      // asset. Key stays `usdc` so shared code paths are identical across networks.
      usdc: process.env[`BOT_ESCROW_TOKEN_${key}`] || deployment?.escrowToken?.address || null,
      escrow: addr(`BOT_CONTRACT_USDC_ESCROW_${key}`, deployment, "usdcEscrow"),
      agentRegistry: addr(`BOT_CONTRACT_AGENT_REGISTRY_${key}`, deployment, "agentRegistry"),
      bidEngine: addr(`BOT_CONTRACT_BID_ENGINE_${key}`, deployment, "bidEngine"),
      taskRegistry: addr(`BOT_CONTRACT_TASK_REGISTRY_${key}`, deployment, "taskRegistry"),
      verifierBridge: addr(`BOT_CONTRACT_VERIFIER_BRIDGE_${key}`, deployment, "verifierBridge"),
      subscriptionManager: addr(`BOT_CONTRACT_SUBSCRIPTION_MANAGER_${key}`, deployment, "subscriptionManager"),
      agentBadges: addr(`BOT_CONTRACT_AGENT_BADGES_${key}`, deployment, "agentBadges"),
      disputeManager: addr(`BOT_CONTRACT_DISPUTE_MANAGER_${key}`, deployment, "disputeManager"),
      recurringMarket: addr(`BOT_CONTRACT_RECURRING_MARKET_${key}`, deployment, "recurringMarket"),
      erc8004Identity: addr(`BOT_ERC8004_IDENTITY_${key}`, deployment, "erc8004Identity"),
      erc8004Reputation: addr(`BOT_ERC8004_REPUTATION_${key}`, deployment, "erc8004Reputation"),
      erc8004Validation: addr(`BOT_ERC8004_VALIDATION_${key}`, deployment, "erc8004Validation"),
      /** ERC-4337 v0.7 EntryPoint — canonical, verified deployed on both BOT networks. */
      entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
      accountFactory: addr(`BOT_ACCOUNT_FACTORY_${key}`, deployment, "accountFactory"),
    },
    asset: {
      symbol: deployment?.escrowToken?.symbol || "BOT",
      decimals: Number(deployment?.escrowToken?.decimals ?? 18),
      /** True when value moves as msg.value rather than through an ERC-20. */
      native: deployment?.escrowToken?.native !== false,
    },
    /** Agent collateral floor in wei — a deploy parameter here, because BOT's 18
     *  decimals make AgentRegistry's hardcoded 6-decimal constant meaningless. */
    minStakeWei: deployment?.minStakeWei ? BigInt(deployment.minStakeWei) : null,
    /** Gas on BOT Chain is native BOT, never the stablecoin. */
    gasSymbol: "BOT",
    /** Deployed from this repo, so the hardened, domain-separated digests apply. */
    legacyVerdictDigest: false,
    // A separate signer key is allowed per network (recommended: don't reuse the
    // Arc signer on a real-money chain), falling back to the shared one.
    signerKeyEnv: process.env[`BOT_VERIFIER_SIGNER_KEY_${key}`] ? `BOT_VERIFIER_SIGNER_KEY_${key}` : "VERIFIER_SIGNER_KEY",
    indexFromBlock: process.env[fromBlockEnv]
      ? Number(process.env[fromBlockEnv])
      : Number(deployment?.deployBlock || fromBlockDefault),
    // Per-contract scan starts. The core market is at `deployBlock`, but the
    // extensions (and the rescaled BidEngine) were added later, so scanning them
    // from the core block would sweep tens of thousands of empty blocks on every
    // cold start. `extensionsFromBlock` is written by the upgrade script.
    contractFromBlocks: (() => {
      const core = Number(deployment?.deployBlock || fromBlockDefault);
      const ext = Number(deployment?.extensionsFromBlock || core);
      return {
        subscriptionManager: ext,
        recurringMarket: ext,
        disputeManager: ext,
        bidEngine: ext,
      };
    })(),
    chunkBlocks: Number(process.env[`BOT_INDEX_CHUNK_BLOCKS`] || 9000),
    /** BOT agents are raw-key/4337 wallets — Circle has no BOT support. */
    swarmMode: "raw",
    supportsX402: false,
  };
}

const botchainTestnet = botChain({
  id: "botchain-testnet",
  label: "BOT Chain Testnet",
  chainId: Number(process.env.BOT_TESTNET_CHAIN_ID || 968),
  rpcEnv: "BOT_TESTNET_RPC_URL",
  rpcDefault: "https://rpc.bohr.life",
  explorerUrl: "https://scan.bohr.life",
  deployment: botTestnetDeployment,
  fromBlockEnv: "BOT_TESTNET_INDEX_FROM_BLOCK",
  fromBlockDefault: 20216316,
});

const botchainMainnet = botChain({
  id: "botchain-mainnet",
  label: "BOT Chain",
  chainId: Number(process.env.BOT_MAINNET_CHAIN_ID || 677),
  rpcEnv: "BOT_MAINNET_RPC_URL",
  rpcDefault: "https://rpc.botchain.ai",
  explorerUrl: "https://scan.botchain.ai",
  deployment: botMainnetDeployment,
  fromBlockEnv: "BOT_MAINNET_INDEX_FROM_BLOCK",
  fromBlockDefault: 20018236,
});

export const NETWORKS = {
  "arc-testnet": arcTestnet,
  "botchain-testnet": botchainTestnet,
  "botchain-mainnet": botchainMainnet,
};

export const NETWORK_IDS = Object.keys(NETWORKS);

export function isNetworkId(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(NETWORKS, id);
}

/**
 * Resolve a network id from a request (query or body) to a config.
 * Unknown/missing → this runtime's own default (see `fallbackNetworkId`).
 */
export function getNetwork(id) {
  return isNetworkId(id) ? NETWORKS[id] : NETWORKS[fallbackNetworkId()];
}

/**
 * The network an unlabelled request belongs to.
 *
 * When a runtime serves exactly ONE network — which is how Polaris is deployed:
 * one service per chain, because Arc's agents are Circle wallets and BOT's are
 * raw-key/4337 — that network is the only sensible answer. Falling back to Arc
 * inside a BOT-only runtime would answer with an Arc-shaped (and empty, since no
 * Arc indexer is running) result, which reads as "no data" rather than "wrong
 * service". Multi-network runtimes keep the historical Arc default.
 */
export function fallbackNetworkId() {
  const active = activeNetworkIds();
  return active.length === 1 ? active[0] : DEFAULT_NETWORK;
}

export function networkIdOf(req) {
  const raw = req?.query?.network ?? req?.body?.network;
  return isNetworkId(raw) ? raw : fallbackNetworkId();
}

/** True when the core market contracts exist for this network. */
export function isDeployed(id) {
  const n = getNetwork(id);
  return Boolean(n.addr.taskRegistry && n.addr.agentRegistry && n.addr.escrow && n.addr.verifierBridge);
}

let activeCache = null;

/** Networks the runtime should actually operate on (index, schedule, swarm). */
export function activeNetworkIds() {
  if (activeCache) return activeCache;
  activeCache = resolveActiveNetworkIds();
  return activeCache;
}

/**
 * True when THIS runtime serves `id`. Each chain gets its own service, so a
 * request for a network this process doesn't run must be refused rather than
 * answered from an index that was never built — that refusal is what keeps the
 * Arc and BOT Chain deployments independent instead of merely separate.
 */
export function isActiveNetwork(id) {
  return activeNetworkIds().includes(id);
}

function resolveActiveNetworkIds() {
  const configured = (process.env.SWARM_NETWORKS || process.env.POLARIS_NETWORKS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isNetworkId);
  const list = configured.length ? configured : [DEFAULT_NETWORK];
  return list.filter((id) => {
    if (isDeployed(id)) return true;
    console.warn(`[networks] ${id} is configured but its contracts aren't deployed — skipping.`);
    return false;
  });
}

/** The verdict-signing key for a network, or null when unset. */
export function signerKeyFor(id) {
  return process.env[getNetwork(id).signerKeyEnv] || null;
}

/** Namespace an off-chain store key by chain, so ids from different networks can
 *  never collide. A task id is only unique WITHIN a chain. */
export function scopedKey(networkId, id) {
  return `${getNetwork(networkId).chainId}:${String(id).toLowerCase()}`;
}
