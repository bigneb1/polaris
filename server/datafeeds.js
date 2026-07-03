/**
 * Public-API data feeds (Phase A++): gives subscription agents REAL data to base
 * their recurring deliverables on — weather, crypto/market, stocks, football.
 * All free, no API keys:
 *   weather  → open-meteo.com
 *   crypto   → coingecko.com
 *   stocks   → stooq.com (CSV)
 *   football → thesportsdb.com (free key "3")
 */
async function getJSON(url) {
  const r = await fetch(url, { headers: { "user-agent": "polaris-agent" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

export async function weather(place) {
  const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`);
  const loc = g.results?.[0];
  if (!loc) return null;
  const f = await getJSON(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3`,
  );
  return { place: `${loc.name}, ${loc.country}`, current: f.current, daily: f.daily };
}

export async function crypto(ids = "bitcoin,ethereum,solana") {
  return getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`);
}

export async function stock(symbol) {
  return (await getText(`https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`)).trim();
}

export async function football(league = "English Premier League") {
  const s = await getJSON(`https://www.thesportsdb.com/api/v1/json/3/searchleagues.php?l=${encodeURIComponent(league)}`);
  const id = s.leagues?.[0]?.idLeague;
  if (!id) return [];
  const next = await getJSON(`https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=${id}`);
  return (next.events || []).slice(0, 8).map((e) => `${e.strEvent} — ${e.dateEvent} ${e.strTime || ""}`.trim());
}

function extractPlace(text) {
  const m = text.match(/\b(?:in|for|at)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/);
  return m ? m[1] : null;
}
function extractTicker(text) {
  const m = text.match(/\b([A-Z]{1,5})\b/);
  return m ? `${m[1].toLowerCase()}.us` : null;
}

/**
 * Inspect a task's topic and fetch matching live data. Returns a context string
 * (real numbers) to ground the agent's deliverable, or "" if nothing matched /
 * the source failed (best-effort: a feed outage never blocks the delivery).
 */
export async function gatherContext({ title = "", description = "", taskType = "" }) {
  const text = `${title} ${description} ${taskType}`.toLowerCase();
  const blob = `${title} ${description}`;
  try {
    if (/\b(weather|forecast|temperature|rain|climate)\b/.test(text)) {
      const w = await weather(extractPlace(blob) || "London");
      if (w) return `LIVE WEATHER DATA (${w.place}) [open-meteo]:\ncurrent=${JSON.stringify(w.current)}\n3-day=${JSON.stringify(w.daily)}`;
    }
    if (/\b(crypto|bitcoin|ethereum|btc|eth|token|defi|altcoin|market analysis|market report)\b/.test(text)) {
      return `LIVE CRYPTO MARKET DATA [coingecko]:\n${JSON.stringify(await crypto())}`;
    }
    if (/\b(stock|equit|equity|nasdaq|s&p|sp500|share price|ticker|analytics)\b/.test(text)) {
      const sym = extractTicker(blob) || "spy.us";
      return `LIVE STOCK QUOTE (${sym}) [stooq, CSV sym,date,time,open,high,low,close,volume]:\n${await stock(sym)}`;
    }
    if (/\b(football|soccer|premier league|epl|la liga|match|fixture|prediction)\b/.test(text)) {
      const f = await football();
      if (f.length) return `UPCOMING FOOTBALL FIXTURES [thesportsdb]:\n${f.join("\n")}`;
    }
  } catch {
    /* feed failed — deliver without live context */
  }
  return "";
}
