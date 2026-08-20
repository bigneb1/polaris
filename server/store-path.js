import fs from "node:fs";
import path from "node:path";

let dataDirAvailable = null;
function hasDataDir() {
  if (dataDirAvailable === null) {
    try {
      dataDirAvailable = fs.existsSync("/data") && fs.statSync("/data").isDirectory();
    } catch {
      dataDirAvailable = false;
    }
  }
  return dataDirAvailable;
}

/**
 * Where local runtime state lives when there is no /data volume.
 *
 * NOT the working directory, which is what this used to be. A locally running
 * backend continuously rewrites its index checkpoints and SQLite WAL, and those
 * files landing in the repo root and `server/` broke a Railway deploy: the uploader
 * tars the working tree, a file changed size while it was being read, and the
 * snapshot truncated at 629 kB with `package.json` and `railway.json` missing. The
 * build then failed with "Railpack could not determine how to build the app", and
 * `railway up` had already reported success.
 *
 * Keeping state in one directory outside the build context means the class of
 * problem cannot recur, whatever new state file someone adds later. `.state/` is
 * both gitignored and railwayignored; override with POLARIS_STATE_DIR.
 */
const REPO_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
let stateDirReady = false;
function localStateDir() {
  const dir = process.env.POLARIS_STATE_DIR || path.join(REPO_ROOT, ".state");
  if (!stateDirReady) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* fall through; the caller's write will surface any real problem */
    }
    stateDirReady = true;
  }
  return dir;
}

/**
 * Resolve an off-chain store path. An explicit env var always wins; then the
 * Railway volume at /data (so deliverables, ratings and hosted-agent keys survive a
 * redeploy); then the local state directory.
 *
 * A file already sitting at the old working-directory path keeps being used, so
 * upgrading does not abandon a warm local index. Those legacy paths are excluded
 * from uploads, so they are safe where they are, just untidy.
 */
export function storePath(envVar, filename) {
  if (process.env[envVar]) return process.env[envVar];
  if (hasDataDir()) return `/data/${filename}`;
  const legacy = `./${filename}`;
  try {
    if (fs.existsSync(legacy)) return legacy;
  } catch {
    /* treat as absent */
  }
  return path.join(localStateDir(), filename);
}

/**
 * Per-network variant: `sub-index.json` becomes `sub-index-968.json` so two
 * chains never share a checkpoint or a cache.
 *
 * `legacyEnvVar`/`legacyFilename` describe the pre-multi-chain path. When that
 * file already exists (only true for the original Arc deployment) it is reused,
 * so an existing deployment doesn't throw away a warm index and re-scan the whole
 * chain on first boot after this upgrade.
 */
export function networkStorePath(envVar, filename, { chainId, legacyEnvVar, legacyFilename }) {
  if (process.env[envVar]) return process.env[envVar];
  if (legacyFilename) {
    const legacy = storePath(legacyEnvVar ?? "__none__", legacyFilename);
    try {
      if (fs.existsSync(legacy)) return legacy;
    } catch {
      /* fall through */
    }
  }
  const dot = filename.lastIndexOf(".");
  const scoped = dot > 0 ? `${filename.slice(0, dot)}-${chainId}${filename.slice(dot)}` : `${filename}-${chainId}`;
  return storePath("__none__", scoped);
}

/**
 * Write JSON so a crash can never destroy what was already there.
 *
 * `fs.writeFileSync` truncates the target before it writes, so a process that dies mid-write
 * leaves a half-file. Every `loadX()` helper in this server catches the resulting parse error
 * and returns `{}`, which means the failure is not just a corrupt file: it silently reads as
 * "there was never any data". Ratings, flags, agent endpoints, hosted agents and the
 * deliverable store, which backs settlement evidence, all sat behind that.
 *
 * `indexStore.js` already documents this hazard, and the index was moved to SQLite because of
 * it. The remaining JSON stores kept the unsafe pattern. Writing to a sibling temp file and
 * renaming over the target closes it: rename is atomic on POSIX, so a reader sees either the
 * old file or the new one, never a partial one.
 */
export function writeJsonAtomic(file, value, { pretty = false } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    // Never leave the temp file behind to accumulate on the volume.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing more to do */
    }
    throw e;
  }
}

/**
 * Read-modify-write a JSON map without losing a concurrent writer's entry.
 *
 * The plain pattern (read whole map, add one key, write whole map back) drops entries when two
 * writers interleave. That is not theoretical here: four swarm agents share one process and
 * one file, and it already cost three ERC-8004 mintability verdicts in production.
 */
export function updateJsonAtomic(file, mutate, { pretty = false } = {}) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* first write, or an unreadable file we are about to replace wholesale */
  }
  const next = mutate(current) ?? current;
  writeJsonAtomic(file, next, { pretty });
  return next;
}
