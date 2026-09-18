import { localnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";

/**
 * GenLayer Studio Next — chain 61997, the preview Studio deployment.
 *
 * The installed `genlayer-js` (1.1.8, the current npm `latest`) does not export this
 * chain; only the unreleased 2.0.0-rc.1 does, as `studioDevnet`. Taking an RC major
 * upgrade for one chain constant would put the whole adjudication path — client
 * construction, finality polling, transaction-status enums — on a prerelease, to gain
 * nothing else.
 *
 * So it is defined here exactly as 2.0.0-rc.1 defines it: Studionet with a different
 * id and RPC. That spread is what carries `isStudio`, the formatters/serializers and
 * the consensus contract handles, which is why this is a two-field override rather
 * than a chain definition written from scratch. Verified live: `eth_chainId` on the
 * endpoint below returns `0xf22d` (61997).
 *
 * Swap to the SDK's own export whenever 2.x ships stable; the shape is identical.
 */
export const studioNext = {
  ...studionet,
  id: 61997,
  name: "GenLayer Studio Next",
  rpcUrls: {
    default: { http: [process.env.GENLAYER_STUDIO_NEXT_RPC_URL || "https://studio-dev.genlayer.com/api"] },
  },
  // The stable Studio explorer does not index this preview deployment.
  blockExplorers: undefined,
};

/**
 * Networks selectable via `GENLAYER_NETWORK`. `studioDevnet` is accepted as an alias
 * so a value copied from the SDK or from GenLayer's own docs resolves rather than
 * silently disabling adjudication.
 */
export const GENLAYER_NETWORKS = {
  localnet,
  studionet,
  studioNext,
  studioDevnet: studioNext,
  testnetAsimov,
  testnetBradbury,
};

/**
 * The network Polaris adjudicates on unless `GENLAYER_NETWORK` says otherwise.
 *
 * Studio Next is wired and selectable, but is NOT the default yet: as of 2026-09-18
 * its GenVM cannot load any published py-genlayer runner, so no intelligent contract
 * can be deployed there at all (verified against a three-line contract, with the same
 * SDK and header that deploy cleanly on Studionet). Switch this to "studioNext" the
 * day that network can host a contract — that one line plus
 * GENLAYER_STUDIO_NEXT_ADDRESS is the whole migration.
 */
export const DEFAULT_GENLAYER_NETWORK = "studionet";
