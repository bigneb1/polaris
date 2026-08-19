import fs from "node:fs";
import path from "node:path";
import { storePath } from "./store-path.js";

/**
 * SQLite index store — the durable home for everything the indexer reads off chain.
 *
 * WHY THIS EXISTS. The event indexes were already persistent (a JSON file per
 * contract on the Railway volume), but three properties of that made the runtime
 * re-fetch far more than it should:
 *
 *  1. **Whole-file rewrites.** `createLogIndex` appends to an array and rewrote the
 *     entire file after every scanned chunk. Arc's task log is already 330 KB and
 *     only grows, so steady-state indexing re-serialised the whole history
 *     repeatedly, and the cost rises forever.
 *  2. **Non-atomic writes.** A plain `writeFileSync` truncates before it writes. A
 *     container kill mid-write (Railway redeploys constantly) leaves a truncated
 *     file, `load()` silently falls back to empty, and the next boot re-scans the
 *     chain from the deploy block — which on a rate-limited public RPC takes hours.
 *     A crash could therefore *destroy* the very cache that prevents re-fetching.
 *  3. **Block timestamps were never persisted at all**, despite the comment
 *     claiming otherwise: `blockTimeCache` was a plain in-memory `Map`. Every
 *     restart re-resolved every block a task touched via `eth_getBlock` — thousands
 *     of RPC calls per boot, and the single biggest source of the rate-limit errors
 *     seen on Arc. Block times are immutable, so re-fetching them is pure waste.
 *
 * SQLite fixes all three structurally: rows are inserted incrementally, every write
 * is a transaction (so a crash rolls back rather than corrupting), and block times
 * get a table. It also makes re-scans idempotent — logs are keyed by
 * `(block, logIndex)`, so replaying a chunk after a crash can no longer duplicate
 * events and skew a fold like "count this agent's bids".
 *
 * WHY `node:sqlite` AND NOT A SERVER. This is Node's built-in SQLite (Node 22+), so
 * there is no dependency to install and no native module to compile on Railway. A
 * networked database (Postgres) would buy nothing here: each runtime owns exactly
 * one chain's data, there is a single writer, and the data lives next to the process
 * on the volume it already mounts. One file per chain id keeps the two networks as
 * isolated on disk as they are everywhere else.
 *
 * FALLBACK. `openIndexStore` returns null if SQLite is unavailable or the file
 * cannot be opened, and every caller keeps its JSON path for that case. A live
 * settlement runtime should not fail to boot because a storage backend is missing.
 *
 * MIGRATION. `importJson` folds an existing JSON checkpoint into the tables the
 * first time a store is used, so upgrading does not throw away a warm index and
 * re-scan the chain. The JSON files are deliberately left in place afterwards: they
 * are harmless, and they remain a usable (if stale) fallback should SQLite ever fail
 * to open — resuming from an older checkpoint costs a re-scan, not correctness,
 * because records are keyed by id and logs by (block, logIndex).
 *
 * Measured on the existing Arc index: 598 distinct blocks are referenced by its
 * events, so the old in-memory-only block cache meant 598 `eth_getBlock` calls on
 * every single boot. That is now zero after the first.
 */

let DatabaseSync = null;
try {
  // eslint-disable-next-line
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null; // pre-22 Node, or a build without SQLite
}

const stores = new Map(); // chainId -> store handle (or null once known-unavailable)

/** `/data/polaris-index-<chainId>.db` on the volume, else beside the process. */
function dbPath(chainId) {
  const env = process.env[`INDEX_DB_${chainId}`] || process.env.INDEX_DB;
  if (env) return env;
  return storePath("__none__", `polaris-index-${chainId}.db`);
}

/**
 * Open (once per chain) the SQLite store for a chain id. Returns null when SQLite
 * isn't usable, which callers treat as "stay on the JSON store".
 */
export function openIndexStore(chainId) {
  if (stores.has(chainId)) return stores.get(chainId);
  let handle = null;
  if (DatabaseSync) {
    try {
      const file = dbPath(chainId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      handle = build(new DatabaseSync(file), chainId, file);
      console.log(`[indexStore:${chainId}] sqlite at ${file}`);
    } catch (e) {
      console.error(`[indexStore:${chainId}] sqlite unavailable, using JSON stores: ${e.message}`);
      handle = null;
    }
  } else {
    console.log(`[indexStore:${chainId}] node:sqlite not available — using JSON stores`);
  }
  stores.set(chainId, handle);
  return handle;
}

function build(db, chainId, file) {
  // WAL keeps readers non-blocking and survives an unclean shutdown; NORMAL sync is
  // the right trade for a cache that can always be rebuilt from chain.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      store      TEXT PRIMARY KEY,
      last_block INTEGER NOT NULL
    );
    -- One collapsed record per id (createEventIndex): latest state per plan/sub.
    CREATE TABLE IF NOT EXISTS records (
      store TEXT NOT NULL,
      id    TEXT NOT NULL,
      block INTEGER,
      json  TEXT NOT NULL,
      PRIMARY KEY (store, id)
    );
    -- The full ordered event stream (createLogIndex). Keyed by position on chain,
    -- so re-scanning a chunk overwrites rather than duplicating.
    CREATE TABLE IF NOT EXISTS logs (
      store TEXT NOT NULL,
      block INTEGER NOT NULL,
      li    INTEGER NOT NULL,
      name  TEXT,
      tx    TEXT,
      json  TEXT NOT NULL,
      PRIMARY KEY (store, block, li)
    );
    CREATE TABLE IF NOT EXISTS block_times (
      block INTEGER PRIMARY KEY,
      ts    INTEGER NOT NULL
    );
  `);

  const q = {
    getCheckpoint: db.prepare("SELECT last_block FROM checkpoints WHERE store = ?"),
    setCheckpoint: db.prepare("INSERT INTO checkpoints (store, last_block) VALUES (?, ?) ON CONFLICT(store) DO UPDATE SET last_block = excluded.last_block"),
    allRecords: db.prepare("SELECT id, json FROM records WHERE store = ?"),
    putRecord: db.prepare("INSERT INTO records (store, id, block, json) VALUES (?, ?, ?, ?) ON CONFLICT(store, id) DO UPDATE SET block = excluded.block, json = excluded.json"),
    countRecords: db.prepare("SELECT count(*) AS n FROM records WHERE store = ?"),
    allLogs: db.prepare("SELECT json FROM logs WHERE store = ? ORDER BY block, li"),
    putLog: db.prepare("INSERT INTO logs (store, block, li, name, tx, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(store, block, li) DO UPDATE SET name = excluded.name, tx = excluded.tx, json = excluded.json"),
    countLogs: db.prepare("SELECT count(*) AS n FROM logs WHERE store = ?"),
    getBlockTimes: db.prepare("SELECT block, ts FROM block_times"),
    putBlockTime: db.prepare("INSERT INTO block_times (block, ts) VALUES (?, ?) ON CONFLICT(block) DO NOTHING"),
  };

  /** BigInt args (uint256) don't survive JSON.stringify — same convention the JSON
   *  stores used, and downstream code already tolerates the numeric string. */
  const enc = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

  function tx(fn) {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  return {
    chainId,
    file,

    /* ── checkpoints ─────────────────────────────────────────────────────── */
    lastBlock(store) {
      const row = q.getCheckpoint.get(store);
      return row ? Number(row.last_block) : null;
    },

    /* ── keyed records (createEventIndex) ────────────────────────────────── */
    loadRecords(store) {
      const byId = {};
      for (const row of q.allRecords.all(store)) byId[row.id] = JSON.parse(row.json);
      return byId;
    },
    /** Upsert a batch of records and advance the checkpoint in ONE transaction, so
     *  the cursor can never claim blocks whose records didn't land. */
    saveRecords(store, entries, lastBlock) {
      tx(() => {
        for (const [id, rec] of entries) q.putRecord.run(store, String(id), rec?.blockNumber ?? null, enc(rec));
        if (lastBlock != null) q.setCheckpoint.run(store, Number(lastBlock));
      });
    },

    /* ── ordered log stream (createLogIndex) ─────────────────────────────── */
    loadLogs(store) {
      return q.allLogs.all(store).map((r) => JSON.parse(r.json));
    },
    saveLogs(store, rows, lastBlock) {
      tx(() => {
        for (const r of rows) q.putLog.run(store, Number(r.blockNumber), Number(r.li ?? 0), r.name ?? null, r.txHash ?? null, enc(r));
        if (lastBlock != null) q.setCheckpoint.run(store, Number(lastBlock));
      });
    },
    advance(store, lastBlock) {
      if (lastBlock != null) q.setCheckpoint.run(store, Number(lastBlock));
    },

    /* ── block timestamps (immutable, so cached forever) ─────────────────── */
    loadBlockTimes() {
      const m = new Map();
      for (const row of q.getBlockTimes.all()) m.set(Number(row.block), Number(row.ts));
      return m;
    },
    saveBlockTimes(pairs) {
      if (!pairs.length) return;
      tx(() => {
        for (const [block, ts] of pairs) q.putBlockTime.run(Number(block), Number(ts));
      });
    },

    /**
     * One-time fold of an existing JSON checkpoint into the tables, so upgrading
     * doesn't discard a warm index. `kind` is "records" or "logs". Returns true if
     * anything was imported.
     *
     * Imported logs have no on-chain log index recorded, so `li` becomes the
     * position within its block in the file's order — faithful to the order the
     * array was written in, and collision-free.
     */
    importJson(store, jsonFile, kind) {
      try {
        const already = kind === "logs" ? q.countLogs.get(store).n : q.countRecords.get(store).n;
        if (already > 0) return false;
        if (!fs.existsSync(jsonFile)) return false;
        const s = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
        if (kind === "logs") {
          if (!Array.isArray(s?.logs)) return false;
          const perBlock = new Map();
          const rows = s.logs.map((l) => {
            const b = Number(l.blockNumber);
            const li = perBlock.get(b) ?? 0;
            perBlock.set(b, li + 1);
            return { ...l, li };
          });
          this.saveLogs(store, rows, s.lastBlock ?? null);
          console.log(`[indexStore:${chainId}] imported ${rows.length} logs for ${store} from ${path.basename(jsonFile)}`);
        } else {
          if (!s?.byId || typeof s.byId !== "object") return false;
          const entries = Object.entries(s.byId);
          this.saveRecords(store, entries, s.lastBlock ?? null);
          console.log(`[indexStore:${chainId}] imported ${entries.length} records for ${store} from ${path.basename(jsonFile)}`);
        }
        return true;
      } catch (e) {
        console.error(`[indexStore:${chainId}] import of ${store} failed (starting empty): ${e.message}`);
        return false;
      }
    },
  };
}
