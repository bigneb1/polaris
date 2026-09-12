const hre = require("hardhat");

async function main() {
  const signer = process.env.VERIFIER_SIGNER_ADDRESS;
  if (!signer) throw new Error("VERIFIER_SIGNER_ADDRESS not set");
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  console.log("Deployer:", deployer.address);
  console.log("Network chain id:", network.chainId.toString());
  console.log("Relay signer:", signer);
  const mirror = await hre.ethers.deployContract("GenLayerVerdictMirror", [signer]);
  await mirror.waitForDeployment();
  const address = await mirror.getAddress();
  const receipt = await mirror.deploymentTransaction().wait();
  console.log("GenLayerVerdictMirror:", address);
  console.log("Deployment tx:", receipt.hash);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
