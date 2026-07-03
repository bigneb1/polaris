import { useState, useCallback } from "react";
import { toast } from "sonner";
import type { Hash } from "viem";
import { explorerTx } from "../lib/chain";
import { humanizeError, isUserRejection } from "../lib/errors";

/**
 * Standard transaction runner: drives the pending → confirmed → explorer-link
 * toast flow used by every write in the app, and exposes a `loading` flag.
 * Wallet/RPC errors are humanized; user rejection is handled quietly.
 */
export function useTx() {
  const [loading, setLoading] = useState(false);

  const run = useCallback(
    async (
      fn: () => Promise<Hash>,
      opts: { pending: string; success: string; onDone?: (hash: Hash) => void },
    ) => {
      setLoading(true);
      const toastId = toast.loading(opts.pending);
      try {
        const hash = await fn();
        // PIN-wallet writes settle async and return no single hash ("0x").
        const hasHash = typeof hash === "string" && hash.length > 2;
        toast.success(opts.success, {
          id: toastId,
          ...(hasHash
            ? { action: { label: "View tx", onClick: () => window.open(explorerTx(hash), "_blank") } }
            : {}),
        });
        opts.onDone?.(hash);
        return hash;
      } catch (err) {
        if (isUserRejection(err)) {
          toast.error("Cancelled.", { id: toastId });
        } else {
          toast.error(humanizeError(err, "Transaction failed. Please try again."), { id: toastId });
          // eslint-disable-next-line no-console
          console.error(err);
        }
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { run, loading };
}
