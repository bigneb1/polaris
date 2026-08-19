import { useNetwork } from "../context/NetworkProvider";
import { ErrorNotice } from "./ui/primitives";

/**
 * Shown where a page needs the core market contracts and the active network has none.
 *
 * Polaris fails closed rather than falling back to another chain's contracts, so this
 * is the honest end state for an undeployed network, not an error.
 */
export default function ContractsNotice() {
  const { network } = useNetwork();
  return (
    <ErrorNotice
      message={`Polaris is not deployed on ${network.label} yet. Switch to a network where it is, and nothing here will point at another chain's contracts in the meantime.`}
    />
  );
}
