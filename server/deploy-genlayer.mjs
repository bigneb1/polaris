import fs from "node:fs";
import { ethers } from "ethers";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { CalldataAddress, ExecutionResult, TransactionResult, TransactionStatus } from "genlayer-js/types";

const privateKey = process.env.GENLAYER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey) throw new Error("GENLAYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY is required");

const account = createAccount(privateKey);
const client = createClient({ chain: studionet, account });
const code = fs.readFileSync(new URL("../genlayer/contracts/PolarisAdjudicator.py", import.meta.url), "utf8");

console.log(`Deploying PolarisAdjudicator to Studionet from ${account.address}`);
const operator = new CalldataAddress(ethers.getBytes(account.address));
const hash = await client.deployContract({ account, code, args: [operator] });
console.log(`Deployment transaction: ${hash}`);
const receipt = await client.waitForTransactionReceipt({
  hash,
  status: TransactionStatus.FINALIZED,
  interval: 3000,
  retries: 400,
});
const transaction = await client.getTransaction({ hash });
const execution = transaction.txExecutionResultName || transaction.tx_execution_result_name || receipt.txExecutionResultName;
const consensus = transaction.resultName || transaction.result_name || receipt.resultName;
const executionFailed = transaction.consensus_data?.leader_receipt?.some((item) => item.execution_result === "ERROR");
if (executionFailed) throw new Error("Deployment reached consensus on a GenVM execution error");
if (execution === ExecutionResult.FINISHED_WITH_ERROR || (execution && execution !== ExecutionResult.FINISHED_WITH_RETURN)) {
  throw new Error(`Deployment failed: ${execution}`);
}
if (!execution && consensus !== TransactionResult.MAJORITY_AGREE && consensus !== TransactionResult.AGREE && consensus !== TransactionResult.SUCCESS) {
  throw new Error(`Deployment failed: ${consensus || transaction.statusName || "unknown result"}`);
}
const address = transaction.data?.contract_address || transaction.recipient || transaction.to_address || receipt.recipient || receipt.to_address;
if (!address) throw new Error("Deployment finalized without a contract address");
console.log(`PolarisAdjudicator: ${address}`);
