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
