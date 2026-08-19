import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

/**
 * The cross-network overview.
 *
 * Two properties matter enough to pin. First, a network this runtime cannot read must
 * appear as an explicit error row: an operator dashboard that silently shows zero agents
 * on an unreachable chain is worse than one that shows nothing, because it looks like an
 * answer. Second, money is never totalled across chains — Arc settles in USDC and BOT
 * Chain in its own coin, so a combined "escrow" figure would add dollars to BOT.
 */

const localIndex = {
  network: "arc-testnet",
  tasks: [
    { taskId: "0x1", status: "OPEN", budgetUsdc: 10 },
    { taskId: "0x2", status: "SETTLED", budgetUsdc: 20, winningBid: 15 },
  ],
  agents: [
    { wallet: "0xaaa", name: "Atlas", reputation: 300, online: true, tasksCompleted: 4, tasksFailed: 0, stakeUsdc: 100, totalEarned: 55, capabilities: ["research"], erc8004Id: null },
    { wallet: "0xbbb", name: "Borealis", reputation: 120, online: false, tasksCompleted: 1, tasksFailed: 1, stakeUsdc: 100, totalEarned: 5, capabilities: [], erc8004Id: null },
  ],
  bids: [{}, {}],
  activity: [{ id: "e1", kind: "TASK_SETTLED", title: "Settled", atMs: 2000, amountUsdc: 15 }],
  indexedAtMs: 1000,
};

const peerIndex = {
  network: "botchain-testnet",
  tasks: [{ taskId: "0x9", status: "OPEN", budgetUsdc: 0.5 }],
  agents: [
    { wallet: "0xccc", name: "Vega", reputation: 900, online: true, tasksCompleted: 9, tasksFailed: 0, stakeUsdc: 0.02, totalEarned: 0.3, capabilities: ["code"], erc8004Id: "7" },
  ],
  bids: [{}],
  activity: [{ id: "e2", kind: "AGENT_REGISTERED", title: "Registered", atMs: 5000 }],
  indexedAtMs: 4000,
};

mock.module("../indexer.js", {
  namedExports: { getIndex: async () => localIndex },
});
mock.module("../networks.js", {
  namedExports: {
    activeNetworkIds: () => ["arc-testnet"],
    isDeployed: () => true,
    NETWORK_IDS: ["arc-testnet", "botchain-testnet"],
    getNetwork: (id) =>
      id === "arc-testnet"
        ? { label: "Arc Testnet", chainId: 5042002, explorerUrl: "https://arc.example", explorerName: "Arcscan", asset: { symbol: "USDC" } }
        : { label: "BOT Chain Testnet", chainId: 968, explorerUrl: "https://bot.example", explorerName: "Blockscout", asset: { symbol: "BOT" } },
  },
});

const { buildOverview, peerUrls } = await import("../overview.js");
const { renderDashboard } = await import("../dashboardPage.js");

/** Stand in for the peer runtime's HTTP surface. */
function stubFetch({ healthOk = true, indexOk = true } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      if (!healthOk) throw new Error("peer down");
      return { ok: true, json: async () => ({ ok: true, serves: ["botchain-testnet"] }) };
    }
    if (u.includes("/api/index")) {
      if (!indexOk) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, json: async () => peerIndex };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
}

const ENV = { PEER_RUNTIMES: "https://bot-runtime.example" };

test("federates the peer's network into one view", async () => {
  stubFetch();
  const o = await buildOverview({ env: ENV });
  assert.deepEqual(
    o.networks.map((n) => [n.network, n.source]),
    [["arc-testnet", "local"], ["botchain-testnet", "peer"]],
  );
  assert.equal(o.totals.agents, 3, "two local agents plus the peer's one");
  assert.equal(o.totals.online, 2);
  assert.equal(o.totals.withIdentity, 1, "only Vega has an ERC-8004 id");
  assert.equal(o.totals.tasks, 3);
});

test("agents are ranked by reputation across networks, not grouped by chain", async () => {
  stubFetch();
  const o = await buildOverview({ env: ENV });
  assert.deepEqual(o.agents.map((a) => a.name), ["Vega", "Atlas", "Borealis"]);
  // Each agent carries its own chain's ticker, which is what keeps stake and earnings
  // meaningful once the rows are interleaved.
  assert.deepEqual(o.agents.map((a) => a.assetSymbol), ["BOT", "USDC", "USDC"]);
});

test("money is reported per network and never totalled across chains", async () => {
  stubFetch();
  const o = await buildOverview({ env: ENV });
  const arc = o.networks.find((n) => n.network === "arc-testnet");
  const bot = o.networks.find((n) => n.network === "botchain-testnet");
  assert.deepEqual(arc.money, { symbol: "USDC", escrow: 10, settledValue: 15 });
  assert.deepEqual(bot.money, { symbol: "BOT", escrow: 0.5, settledValue: 0 });
  // The guard that matters: no summed currency field anywhere in the totals.
  for (const key of Object.keys(o.totals)) {
    assert.ok(!/usdc|escrow|value|earned/i.test(key), `totals must not carry a cross-chain money field: ${key}`);
  }
});

test("activity is merged newest-first and labelled with its network", async () => {
  stubFetch();
  const o = await buildOverview({ env: ENV });
  assert.deepEqual(o.activity.map((e) => e.id), ["e2", "e1"]);
  assert.deepEqual(o.activity.map((e) => e.networkLabel), ["BOT Chain Testnet", "Arc Testnet"]);
});

test("an unreachable network becomes an explicit error row, not a silent zero", async () => {
  stubFetch({ indexOk: false });
  const o = await buildOverview({ env: ENV });
  const bot = o.networks.find((n) => n.network === "botchain-testnet");
  assert.match(bot.error, /502/);
  assert.equal(o.totals.networksReachable, 1);
  assert.equal(o.totals.networks, 2);
  // Its agents are absent rather than invented.
  assert.equal(o.agents.length, 2);
});

test("a peer whose health check fails contributes no networks at all", async () => {
  stubFetch({ healthOk: false });
  const o = await buildOverview({ env: ENV });
  assert.deepEqual(o.networks.map((n) => n.network), ["arc-testnet"]);
});

test("a runtime never federates with itself", () => {
  const urls = peerUrls({
    RAILWAY_PUBLIC_DOMAIN: "me.up.railway.app",
    RAILWAY_SERVICE_SELF_URL: "me.up.railway.app",
    RAILWAY_SERVICE_PEER_URL: "peer.up.railway.app",
  });
  assert.deepEqual(urls, ["https://peer.up.railway.app"]);
});

test("the rendered page shows every agent and escapes hostile names", async () => {
  stubFetch();
  const o = await buildOverview({ env: ENV });
  o.agents[0].name = '<img src=x onerror="alert(1)">';
  const html = renderDashboard(o);
  assert.ok(html.startsWith("<!doctype html>"));
  for (const name of ["Atlas", "Borealis"]) assert.ok(html.includes(name), `missing ${name}`);
  assert.ok(html.includes("8004"), "the identity column should be present");
  // An agent name comes from a chain event, so it is attacker-controlled input.
  assert.ok(!html.includes("<img src=x"), "agent names must be escaped");
  assert.ok(html.includes("&lt;img src=x"));
  // Both tickers appear; no combined currency total does.
  assert.ok(html.includes("USDC") && html.includes("BOT"));
});
