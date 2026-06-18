import { useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { fileToDataUri } from "../lib/api";
import { toast } from "sonner";

/**
 * Square image picker. Reads + downscales the chosen file to a webp data URI and
 * hands it to the parent via onChange. The parent uploads it to the asset store
 * after the on-chain action succeeds (keyed by taskId / agent wallet).
 */
export default function ImagePicker({
  value,
  onChange,
  label = "Image",
  hint,
}: {
  value: string | null;
  onChange: (dataUri: string | null) => void;
  label?: string;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      onChange(await fileToDataUri(file));
    } catch {
      toast.error("Could not read that image");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="eyebrow mb-2">{label}</div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="relative grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-border2 bg-deep text-grey transition-colors hover:border-blue hover:text-blue-l"
        >
          {value ? (
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus size={20} />
          )}
        </button>
        <div className="min-w-0">
          <button type="button" onClick={() => inputRef.current?.click()} className="btn-ghost !py-1.5 !text-xs">
            {busy ? "Reading…" : value ? "Replace" : "Upload image"}
          </button>
          {value && (
            <button type="button" onClick={() => onChange(null)} className="mono ml-2 inline-flex items-center gap-1 text-[11px] text-grey hover:text-red">
              <X size={12} /> remove
            </button>
          )}
          {hint && <div className="mono mt-1.5 text-[11px] text-grey">{hint}</div>}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0])}
      />
    </div>
  );
}
