import fs from "node:fs";
import { provider as arcProvider, scanRange as arcScanRange } from "./chain.js";

/**
 * MULTI-CHAIN: both index factories below take an optional `provider` and
 * `scanRange` so each network's indexer scans with its OWN chain context. They
 * default to Arc's, which is what every pre-multi-chain caller meant. Without
 * this, a BOT Chain index would silently scan Arc.
 */

/**
 * Persistent, incremental event index.
 *
 * Fixes the "created but not displaying" fragility: instead of re-scanning a
 * rolling 500k-block window on every refresh (expensive, starvable by the RPC,
 * empty after every redeploy, and blind to anything older than the window), this
 * keeps a durable set of events keyed by their indexed id and only scans NEW
 * blocks since a persisted checkpoint.
 *
 * State `{ lastBlock, byId }` is persisted to `store` on the /data volume and
 * loaded synchronously at construction, so the data is available instantly at
 * boot. `catchUp()` scans [lastBlock+1 .. head], advancing the checkpoint per
 * successful chunk (see scanRange) — a rate-limit just pauses progress and
 * resumes next call; events are never dropped by age or a transient RPC error.
 *
 * @param {object} p
 * @param {string} p.name          label for logs
 * @param {import('ethers').Contract} p.contract
 * @param {any} p.filter           an event filter, e.g. contract.filters.PlanCreated()
 * @param {string} p.store         path to the JSON checkpoint file
 * @param {number} p.fromBlock     block to backfill from on first run (contract deploy block)
 * @param {string} p.idKey         indexed arg to key records by (e.g. "planId")
 * @param {(log:any)=>object} p.decode  map a log to a JSON-safe record (no BigInt)
 * @param {import('ethers').Provider} [p.provider]  chain to read the head from (default Arc)
 * @param {Function} [p.scanRange]  that chain's chunked scanner (default Arc)
 * @param {object} [p.db]      SQLite index store (see indexStore.js). When present it
 *                             replaces the JSON file: incremental upserts, and the
 *                             cursor advances in the SAME transaction as the records,
 *                             so a crash can't leave a checkpoint ahead of the data.
 * @param {string} [p.key]     table key for this index inside `db`
 */
export function createEventIndex({
  name,
  contract,
  filter,
  store,
  fromBlock,
  idKey,
  decode,
  provider = arcProvider,
  scanRange = arcScanRange,
  db = null,
  key = null,
}) {
  const tableKey = key || name;
  // Fold any pre-existing JSON checkpoint in once, so switching to SQLite doesn't
  // discard a warm index and re-scan from the deploy block.
  if (db && store) db.importJson(tableKey, store, "records");
  let state = load();
  /** Records written since the last persist, so a chunk writes only its own rows. */
  let dirty = new Map();

  function load() {
    if (db) {
      try {
        return { lastBlock: db.lastBlock(tableKey), byId: db.loadRecords(tableKey) };
      } catch (e) {
        console.error(`[eventIndex ${name}] sqlite load failed, falling back to JSON: ${e.message}`);
      }
    }
    try {
      const s = JSON.parse(fs.readFileSync(store, "utf8"));
      if (s && typeof s === "object" && s.byId) return { lastBlock: s.lastBlock ?? null, byId: s.byId };
    } catch {
      /* first run / unreadable → empty */
    }
    return { lastBlock: null, byId: {} };
  }

  function persist() {
    if (db) {
      try {
        db.saveRecords(tableKey, [...dirty.entries()], state.lastBlock);
        dirty = new Map();
        return;
      } catch (e) {
        console.error(`[eventIndex ${name}] sqlite persist failed:`, e.message);
      }
    }
    try {
      fs.writeFileSync(store, JSON.stringify(state));
      dirty = new Map();
    } catch (e) {
      console.error(`[eventIndex ${name}] persist failed:`, e.message);
    }
  }

  /**
   * One scan at a time per index.
   *
   * `catchUp` is called from request handlers, so several requests can arrive while a
   * backfill is still running. Without this guard each one started its own scan of the
   * same block range: the work was duplicated and, worse, the concurrent getLogs calls
   * were what tripped the RPC's rate limiter that the scan was already struggling
   * with. Callers now share the in-flight scan and all resolve from its result.
   */
  let inFlight = null;
  function catchUp() {
    if (!inFlight) inFlight = scan().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function scan() {
    let head;
    try {
      head = await provider.getBlockNumber();
    } catch (e) {
      console.warn(`[eventIndex ${name}] head unavailable, serving cache: ${e.shortMessage || e.message}`);
      return Object.values(state.byId);
    }
    const from = state.lastBlock != null ? state.lastBlock + 1 : (fromBlock ?? 0);
    if (from > head) return Object.values(state.byId);

    const last = await scanRange(contract, filter, from, head, async (logs, toBlock) => {
      for (const log of logs) {
        const id = log.args?.[idKey];
        if (id == null) continue;
        const rec = { ...decode(log), blockNumber: log.blockNumber };
        state.byId[String(id)] = rec;
        dirty.set(String(id), rec);
      }
      state.lastBlock = toBlock;
      persist(); // checkpoint after every fully-scanned chunk
    });
    if (last >= from) {
      state.lastBlock = last;
      persist();
    }
    return Object.values(state.byId);
  }

  return {
    catchUp,
    all: () => Object.values(state.byId),
    get: (id) => state.byId[String(id)],
    get lastBlock() {
      return state.lastBlock;
    },
  };
}

/**
 * Persistent, incremental log ACCUMULATOR — a sibling to createEventIndex above,
 * for callers that need the full ordered sequence of every matching event
 * (e.g. TaskSubmitted -> TaskAssigned -> TaskSettled -> ...) rather than one
 * collapsed record per id. createEventIndex overwrites state.byId[id] on each
 * matching log, so it only ever keeps the LATEST event per id — wrong for a
 * caller that needs to fold state transitions across a whole event history
 * (this is what server/indexer.js needs for its six core-contract scans).
 *
 * Same checkpoint/persistence contract as createEventIndex: scans
 * [lastBlock+1..head] incrementally, persists after every fully-scanned
 * chunk, and never drops events by age (see scanRange in chain.js).
 *
 * @param {object} p
 * @param {string} p.name
 * @param {import('ethers').Contract} p.contract
 * @param {any} p.filter  pass "*" to match every event on the contract
 * @param {string} p.store
 * @param {number} p.fromBlock
 * @param {import('ethers').Provider} [p.provider]  chain to read the head from (default Arc)
 * @param {Function} [p.scanRange]  that chain's chunked scanner (default Arc)
 */
export function createLogIndex({
  name,
  contract,
  filter,
  store,
  fromBlock,
  provider = arcProvider,
  scanRange = arcScanRange,
  db = null,
  key = null,
}) {
  // A wildcard "*" filter returns raw Logs, not auto-parsed EventLogs (unlike a
  // filter built from a named event fragment) — parse manually via the
  // contract's own interface, same as the pre-incremental getAllLogs did.
  const iface = contract.interface;
  const tableKey = key || name;
  // Fold an existing JSON checkpoint in once (see indexStore.importJson).
  if (db && store) db.importJson(tableKey, store, "logs");
  let state = load();
  /** Logs appended since the last persist. With SQLite only these are written —
   *  the JSON path had to re-serialise the entire history after every chunk, which
   *  on Arc's task log meant rewriting 330 KB (and growing) each time. */
  let pending = [];

  function load() {
    if (db) {
      try {
        return { lastBlock: db.lastBlock(tableKey), logs: db.loadLogs(tableKey) };
      } catch (e) {
        console.error(`[logIndex ${name}] sqlite load failed, falling back to JSON: ${e.message}`);
      }
    }
    try {
      const s = JSON.parse(fs.readFileSync(store, "utf8"));
      if (s && Array.isArray(s.logs)) return { lastBlock: s.lastBlock ?? null, logs: s.logs };
    } catch {
      /* first run / unreadable -> empty */
    }
    return { lastBlock: null, logs: [] };
  }

  function persist() {
    if (db) {
      try {
        db.saveLogs(tableKey, pending, state.lastBlock);
        pending = [];
        return;
      } catch (e) {
        console.error(`[logIndex ${name}] sqlite persist failed:`, e.message);
      }
    }
    try {
      // BigInt args (uint256 etc.) don't survive JSON.stringify by default —
      // stringify them. Downstream consumers already tolerate a numeric
      // string wherever they'd otherwise see a BigInt (Number(x), ethers.formatUnits).
      fs.writeFileSync(store, JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      pending = [];
    } catch (e) {
      console.error(`[logIndex ${name}] persist failed:`, e.message);
    }
  }

  // One scan at a time per index; see the note on createEventIndex.catchUp above.
  let inFlight = null;
  function catchUp() {
    if (!inFlight) inFlight = scan().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function scan() {
    let head;
    try {
      head = await provider.getBlockNumber();
    } catch (e) {
      console.warn(`[logIndex ${name}] head unavailable, serving cache: ${e.shortMessage || e.message}`);
      return state.logs;
    }
    const from = state.lastBlock != null ? state.lastBlock + 1 : (fromBlock ?? 0);
    if (from > head) return state.logs;

    const last = await scanRange(contract, filter, from, head, async (logs, toBlock) => {
      for (const log of logs) {
        let parsed;
        try {
          parsed = iface.parseLog({ topics: log.topics, data: log.data });
        } catch {
          continue; // not one of our events
        }
        if (!parsed) continue;
        const rec = {
          name: parsed.name,
          args: parsed.args.toObject(),
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          // Position within the block. Makes a re-scanned chunk idempotent in
          // SQLite (PK is (store, block, li)) instead of duplicating events and
          // skewing folds like "how many bids did this agent place".
          li: log.index ?? log.logIndex ?? 0,
        };
        state.logs.push(rec);
        pending.push(rec);
      }
      state.lastBlock = toBlock;
      persist(); // checkpoint after every fully-scanned chunk
    });
    if (last >= from) {
      state.lastBlock = last;
      persist();
    }
    return state.logs;
  }

  return {
    catchUp,
    all: () => state.logs,
    get lastBlock() {
      return state.lastBlock;
    },
  };
}
