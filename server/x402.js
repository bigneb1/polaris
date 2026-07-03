import "dotenv/config";

/**
 * x402 nanopayments for Polaris (Circle Gateway on Arc).
 *
 * The literal Lepton thesis: agents paying agents tiny, constant amounts. Here an
 * agent can pay for a paywalled sub-service (e.g. a price oracle) with a single
 * sub-cent USDC payment, settled via Circle Gateway and batched on Arc.
 *
 * Buyer side — wraps GatewayClient.pay(url). The seller/paywall lives in
 * server.js via createGatewayMiddleware.
 */
export const X402_FACILITATOR = process.env.X402_FACILITATOR || "https://gateway-api-testnet.circle.com";
export const X402_CHAIN = process.env.X402_CHAIN || "arcTestnet";
export const X402_NETWORK = process.env.X402_NETWORK || "eip155:5042002";

/**
 * Pay for an x402-paywalled service and return its response.
 * @param {string} url        the paywalled endpoint
 * @param {`0x${string}`} privateKey  buyer wallet key (must hold Gateway USDC)
 * @returns {Promise<{status:number, data:any}>}
 */
export async function payForService(url, privateKey) {
  // Imported lazily so the backend doesn't require the buyer SDK unless used.
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const client = new GatewayClient({ chain: X402_CHAIN, privateKey });
  return client.pay(url);
}
