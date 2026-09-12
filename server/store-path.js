import fs from "node:fs";

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
 * Resolve an off-chain JSON store path: an explicit env var always wins;
 * otherwise prefer the Railway persistent volume at /data (so deliverables,
 * ratings, hosted-agent keys, etc. survive a redeploy) if it's mounted, else
 * fall back to the working directory for local development.
 */
export function storePath(envVar, filename) {
  if (process.env[envVar]) return process.env[envVar];
  return hasDataDir() ? `/data/${filename}` : `./${filename}`;
}
