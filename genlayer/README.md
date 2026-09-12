# Polaris GenLayer adjudication

`PolarisAdjudicator.py` moves the subjective trust boundary out of the Polaris
backend and into GenLayer validator consensus. It handles:

- task quality scoring and pass/fail settlement decisions;
- original-task disputes and AI-jury decisions;
- recurring-delivery verification and advisory recurring disputes.

Arc remains the USDC custody chain. Because GenLayer, Arc, and BOT Chain are
separate networks, the Railway runtime waits for a **finalized** GenLayer
decision and mirrors its bound receipt on both EVM testnets before continuing
Arc settlement. Until those EVM contracts can verify a GenLayer proof or
authenticated message, the relay can still censor or lie about the referenced
result. This is an explicit interim trust boundary.

Live mirror deployments:

- Arc Testnet: `0xc342dEEbB3cbF8cf761e26a94B46ddb28847460F`
- BOT Chain Testnet: `0xe98650A2d1007df7013379B49AdFC03A3E8C1589`

## Deploy

Polaris currently targets the latest stable Studionet (chain `61999`). The live
Intelligent Contract is `0xe7ef55c5bb399876119F4FBeAc8D98e0Ceb2ACD5`.

The repository's deployment helper uses the current `genlayer-js` SDK and
passes the operator as a typed GenLayer address (the CLI's plain string form
is not sufficient for this constructor):

```bash
npm install
GENLAYER_PRIVATE_KEY=0x... node server/deploy-genlayer.mjs
```

Set the resulting address as `GENLAYER_CONTRACT_ADDRESS` on the backend. The
operator address must correspond to `GENLAYER_PRIVATE_KEY`.

For local development, use `genlayer network set localnet` and set
`GENLAYER_NETWORK=localnet`.

The live Studionet deployment was finalized at
`0xe7ef55c5bb399876119F4FBeAc8D98e0Ceb2ACD5` (transaction
`0x7282c5069b94e259ad956ce9e90faab8f7fd2d0eb9f3b11c0be999a59a6582c5`).
