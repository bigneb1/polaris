/** Send native coin to an address. Usage: TO=0x… AMOUNT=0.5 npx hardhat run … */
const { ethers, network } = require("hardhat");
async function main() {
  if (process.env.CONFIRM_DEPLOY !== network.name) throw new Error(`Set CONFIRM_DEPLOY=${network.name}.`);
  const to = process.env.TO;
  const amount = process.env.AMOUNT || "0.5";
  if (!ethers.isAddress(to)) throw new Error("Set TO to a valid address.");
  const [from] = await ethers.getSigners();
  const before = await ethers.provider.getBalance(to);
  await (await from.sendTransaction({ to, value: ethers.parseEther(amount) })).wait();
  console.log(`funded ${to}: ${ethers.formatEther(before)} -> ${ethers.formatEther(await ethers.provider.getBalance(to))}`);
  console.log(`sender left with ${ethers.formatEther(await ethers.provider.getBalance(from.address))}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
