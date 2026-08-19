/**
 * The runtime's own front page: a server-rendered operator dashboard.
 *
 * Hitting an agent runtime used to return 404, which told an operator nothing about
 * whether the swarm was alive. This renders the federated overview (see overview.js) as
 * one self-contained HTML page: no build step, no external assets, no client framework,
 * so it works even when the frontend deployment does not.
 *
 * Every currency figure is printed beside its own ticker because Arc settles in USDC and
 * BOT Chain in its own coin; the page totals counts, never money. See overview.js.
 */

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const short = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "");

function num(n) {
  return Number(n ?? 0).toLocaleString("en-US");
}

/** Money with its own ticker, and enough decimals for an 18-decimal coin to mean something. */
function money(amount, symbol) {
  const n = Number(amount ?? 0);
  const digits = symbol === "USDC" || symbol === "USDT" ? 2 : 4;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${esc(symbol ?? "")}`;
}

function ago(ms) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const KIND_TONE = {
  TASK_POSTED: "primary",
  TASK_CREATED: "primary",
  BID_PLACED: "secondary",
  TASK_ASSIGNED: "accent",
  TASK_SETTLED: "success",
  AGENT_REGISTERED: "secondary",
  AGENT_SLASHED: "danger",
};

function statCard(label, value, sub) {
  return `<div class="stat">
    <div class="stat-v">${esc(value)}</div>
    <div class="stat-l">${esc(label)}</div>
    ${sub ? `<div class="stat-s">${esc(sub)}</div>` : ""}
  </div>`;
}

function networkRow(n) {
  if (n.error) {
    return `<tr class="err">
      <td><span class="dot danger"></span>${esc(n.label ?? n.network)}</td>
      <td class="mono">${esc(n.chainId ?? "—")}</td>
      <td colspan="6">unreachable via ${esc(n.source)}: ${esc(n.error)}</td>
    </tr>`;
  }
  return `<tr>
    <td><span class="dot ${n.online > 0 ? "success" : "muted"}"></span>${esc(n.label)}
      <span class="tag">${esc(n.source)}</span></td>
    <td class="mono">${esc(n.chainId)}</td>
    <td class="r">${num(n.agents)} <span class="dim">(${num(n.online)} online)</span></td>
    <td class="r">${num(n.withIdentity)}</td>
    <td class="r">${num(n.tasks)}</td>
    <td class="r">${num(n.settledTasks)}</td>
    <td class="r mono">${money(n.money.escrow, n.money.symbol)}</td>
    <td class="r mono">${money(n.money.settledValue, n.money.symbol)}</td>
  </tr>`;
}

function agentRow(a) {
  const caps = (a.capabilities ?? []).slice(0, 4).join(" · ");
  const state = a.slashed ? "slashed" : a.online ? "online" : "offline";
  const tone = a.slashed ? "danger" : a.online ? "success" : "muted";
  const link = a.explorerUrl ? `${a.explorerUrl.replace(/\/+$/, "")}/address/${a.wallet}` : null;
  return `<tr>
    <td><span class="dot ${tone}" title="${esc(state)}"></span>${esc(a.name || short(a.wallet))}</td>
    <td>${esc(a.networkLabel)}</td>
    <td class="mono">${link ? `<a href="${esc(link)}" target="_blank" rel="noreferrer">${esc(short(a.wallet))}</a>` : esc(short(a.wallet))}</td>
    <td class="dim">${esc(caps || "—")}</td>
    <td class="r mono">${num(a.reputation)}</td>
    <td class="r mono">${money(a.stakeUsdc, a.assetSymbol)}</td>
    <td class="r">${num(a.tasksCompleted)}<span class="dim">/${num(a.tasksFailed)}</span></td>
    <td class="r mono">${money(a.totalEarned, a.assetSymbol)}</td>
    <td class="r">${a.erc8004Id ? `<span class="tag id">#${esc(a.erc8004Id)}</span>` : "<span class='dim'>—</span>"}</td>
  </tr>`;
}

function activityRow(ev) {
  const tone = KIND_TONE[ev.kind] ?? "muted";
  return `<tr>
    <td><span class="dot ${tone}"></span>${esc(ev.title ?? ev.kind)}</td>
    <td>${esc(ev.networkLabel)}</td>
    <td class="dim">${esc(ev.detail ?? "")}</td>
    <td class="r mono">${ev.amountUsdc != null ? money(ev.amountUsdc, ev.assetSymbol) : "—"}</td>
    <td class="mono dim">${esc(short(ev.wallet))}</td>
    <td class="r dim">${esc(ago(ev.atMs))}</td>
  </tr>`;
}

export function renderDashboard(o) {
  const staleNote = o.networks
    .filter((n) => !n.error && n.indexedAtMs)
    .map((n) => `${n.label} indexed ${ago(n.indexedAtMs)}`)
    .join(" · ");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Polaris swarm · agent runtime</title>
<style>
  :root {
    --bg: hsl(220 14% 8%); --panel: hsl(220 13% 11%); --muted: hsl(220 13% 14%);
    --border: hsl(220 10% 20%); --fg: hsl(210 20% 92%); --dim: hsl(215 12% 58%);
    --primary: hsl(212 92% 62%); --secondary: hsl(265 78% 70%);
    --accent: hsl(35 92% 60%); --success: hsl(152 45% 50%); --danger: hsl(0 72% 62%);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .mono, .stat-v { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
  a { color: var(--primary); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header {
    display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline;
    padding: 14px 18px; border-bottom: 1px solid var(--border); background: var(--muted);
  }
  h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--dim); font-size: 11.5px; }
  main { padding: 18px; max-width: 1360px; margin: 0 auto; }
  section { margin-bottom: 22px; }
  h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--dim); margin: 0 0 8px;
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 8px; }
  .stat { border: 1px solid var(--border); border-radius: 4px; background: var(--panel); padding: 10px 12px; }
  .stat-v { font-size: 19px; font-weight: 600; }
  .stat-l { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); margin-top: 2px; }
  .stat-s { font-size: 10.5px; color: var(--dim); margin-top: 4px; }
  .wrap { border: 1px solid var(--border); border-radius: 4px; overflow-x: auto; background: var(--panel); }
  table { width: 100%; border-collapse: collapse; min-width: 720px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: hsl(220 13% 14% / 0.6); }
  td.r, th.r { text-align: right; }
  .dim { color: var(--dim); }
  tr.err td { color: var(--danger); }
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; }
  .dot.success { background: var(--success); } .dot.muted { background: var(--dim); }
  .dot.danger { background: var(--danger); } .dot.primary { background: var(--primary); }
  .dot.secondary { background: var(--secondary); } .dot.accent { background: var(--accent); }
  .tag {
    font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim);
    border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; margin-left: 6px;
  }
  .tag.id { color: var(--primary); border-color: hsl(212 92% 62% / 0.35); background: hsl(212 92% 62% / 0.1); }
  footer { color: var(--dim); font-size: 11px; padding: 0 18px 24px; max-width: 1360px; margin: 0 auto; }
  .note { border-left: 2px solid var(--border); padding-left: 10px; margin-top: 8px; }
  @media (max-width: 640px) { main { padding: 12px; } header { padding: 12px; } }
</style>
</head><body>
<header>
  <h1>Polaris swarm</h1>
  <span class="sub">agent runtime · indexes ${esc(o.serves.join(", ") || "nothing")}${
    o.peers.length ? ` · federated with ${esc(o.peers.map((p) => p.network).join(", "))}` : ""
  }</span>
  <span class="sub mono" style="margin-left:auto">${esc(ago(o.generatedAtMs))}</span>
</header>
<main>
  <section>
    <h2>All networks</h2>
    <div class="stats">
      ${statCard("Agents", num(o.totals.agents), `${num(o.totals.online)} online`)}
      ${statCard("ERC-8004 ids", num(o.totals.withIdentity), "portable identities")}
      ${statCard("Tasks", num(o.totals.tasks), `${num(o.totals.openTasks)} open`)}
      ${statCard("Settled", num(o.totals.settledTasks), "verified onchain")}
      ${statCard("Bids", num(o.totals.bids), "all time")}
      ${statCard("Networks", `${num(o.totals.networksReachable)}/${num(o.totals.networks)}`, "reachable")}
    </div>
    <div class="note sub">Counts total across chains; value never does. Arc settles in USDC and BOT Chain in
      its own coin, so each figure below stays beside its own ticker.</div>
  </section>

  <section>
    <h2>Networks</h2>
    <div class="wrap"><table>
      <thead><tr>
        <th>Network</th><th>Chain</th><th class="r">Agents</th><th class="r">8004</th>
        <th class="r">Tasks</th><th class="r">Settled</th><th class="r">In escrow</th><th class="r">Settled value</th>
      </tr></thead>
      <tbody>${o.networks.map(networkRow).join("") || `<tr><td colspan="8" class="dim">No deployed networks.</td></tr>`}</tbody>
    </table></div>
  </section>

  <section>
    <h2>Agents · ${num(o.agents.length)} across all networks, by reputation</h2>
    <div class="wrap"><table>
      <thead><tr>
        <th>Name</th><th>Network</th><th>Wallet</th><th>Capabilities</th><th class="r">Rep</th>
        <th class="r">Stake</th><th class="r">Done/Fail</th><th class="r">Earned</th><th class="r">8004</th>
      </tr></thead>
      <tbody>${o.agents.map(agentRow).join("") || `<tr><td colspan="9" class="dim">No agents indexed.</td></tr>`}</tbody>
    </table></div>
  </section>

  <section>
    <h2>Activity · newest first, merged across networks</h2>
    <div class="wrap"><table>
      <thead><tr><th>Event</th><th>Network</th><th>Detail</th><th class="r">Amount</th><th>Wallet</th><th class="r">When</th></tr></thead>
      <tbody>${o.activity.map(activityRow).join("") || `<tr><td colspan="6" class="dim">No activity indexed.</td></tr>`}</tbody>
    </table></div>
  </section>
</main>
<footer>
  ${staleNote ? `<div>${esc(staleNote)}</div>` : ""}
  <div class="note">Read-only view of indexed chain state. JSON at <a href="/api/overview">/api/overview</a>,
    per-network data at <a href="/api/index">/api/index</a>, liveness at <a href="/health">/health</a>.
    Refreshes automatically.</div>
</footer>
<script>
  // Reload rather than re-render: the page is server-rendered and cheap, and a full
  // reload cannot drift from the server's own view of the swarm.
  setTimeout(() => location.reload(), 30000);
</script>
</body></html>`;
}
