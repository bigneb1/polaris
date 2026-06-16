import { execFile } from "node:child_process";
import { promisify } from "node:util";
import "dotenv/config";

/**
 * Circle agent-wallet adapter for Polaris.
 *
 * Lets the autonomous swarm operate on Circle MPC agent wallets (SCA) instead of
 * raw private keys — the hackathon's "Circle wallets" requirement, applied to the
 * agents themselves. Wraps the Circle CLI:
 *   - login is done once by the operator: `circle wallet login <email> --type agent`
 *   - this module lists wallets, funds them from the testnet faucet, and routes
 *     contract writes through `circle wallet execute`.
 *
 * Reads (view calls) still go through the public RPC via ethers — only state
 * changes go through Circle, so each agent's on-chain identity IS its Circle
 * wallet address (msg.sender).
 */
const execFileP = promisify(execFile);
const CIRCLE_BIN = process.env.CIRCLE_BIN || "circle";
const CHAIN = process.env.CIRCLE_CHAIN || "ARC-TESTNET";

const baseEnv = { ...process.env, CIRCLE_ACCEPT_TERMS: "1" };

async function circle(args) {
  const { stdout } = await execFileP(CIRCLE_BIN, args, { env: baseEnv, maxBuffer: 1024 * 1024 });
  return stdout;
}

/** True once an agent session is authenticated for the testnet. */
export async function isLoggedIn() {
  try {
    const out = await circle(["wallet", "status", "-o", "json"]);
    const j = JSON.parse(out);
    return Boolean(j?.agent?.testnet || j?.testnet || j?.loggedIn);
  } catch {
    return false;
  }
}

/** List this account's agent wallet addresses on the configured chain. */
export async function listAgentWallets() {
  const out = await circle(["wallet", "list", "--chain", CHAIN, "--type", "agent", "-q"]);
  return out.split("\n").map((s) => s.trim()).filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s));
}

/** Request testnet USDC from the Circle faucet for a wallet. */
export async function fundWallet(address, token = "usdc") {
  return circle(["wallet", "fund", "--address", address, "--chain", CHAIN, "--token", token]);
}

/** USDC (or token) balance for a wallet, as reported by Circle. */
export async function balanceOf(address) {
  const out = await circle(["wallet", "balance", "--address", address, "--chain", CHAIN, "-o", "json"]);
  return JSON.parse(out);
}

/**
 * Execute a contract write from a Circle agent wallet.
 * @param {string} address  the agent wallet address
 * @param {string} contract target contract address
 * @param {string} signature e.g. "placeBid(bytes32,uint256,uint256)"
 * @param {(string|number|bigint)[]} params positional ABI args
 * @returns {Promise<{txId?:string, txHash?:string, raw:string}>}
 */
export async function execute(address, contract, signature, params = []) {
  const args = [
    "wallet",
    "execute",
    signature,
    ...params.map((p) => String(p)),
    "--contract",
    contract,
    "--address",
    address,
    "--chain",
    CHAIN,
    "-o",
    "json",
  ];
  const raw = await circle(args);
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* keep raw */
  }
  return { txId: parsed.transactionId || parsed.id, txHash: parsed.txHash || parsed.transactionHash, raw };
}

export const CIRCLE_CHAIN = CHAIN;
