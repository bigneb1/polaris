import { useState, useCallback } from "react";
import { toast } from "sonner";
import type { Hash } from "viem";
import { explorerTx } from "../lib/chain";

type TxError = { code?: number; shortMessage?: string; message?: string };

/**
 * Standard transaction runner: drives the pending → confirmed → explorer-link
 * toast flow used by every write in the app, and exposes a `loading` flag.
 * Handles user-rejection (code 4001) quietly.
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
        toast.success(opts.success, {
          id: toastId,
          action: { label: "View tx", onClick: () => window.open(explorerTx(hash), "_blank") },
        });
        opts.onDone?.(hash);
        return hash;
      } catch (err) {
        const e = err as TxError;
        if (e.code === 4001 || /reject|denied/i.test(e.shortMessage ?? e.message ?? "")) {
          toast.error("Cancelled by user", { id: toastId });
        } else {
          toast.error(e.shortMessage || "Transaction failed", { id: toastId });
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
