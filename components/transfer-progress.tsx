import type { TransferProgress } from "@/lib/shared/types";
import { formatBytes, progressPercent } from "./transfer-utils";

const stages = {
  encrypting: "Encrypting…",
  uploading: "Uploading…",
  downloading: "Downloading…",
  decrypting: "Decrypting…",
};

export function TransferProgressView({
  progress,
  direction,
  onCancel,
}: {
  progress: TransferProgress | null;
  direction: "upload" | "download";
  onCancel: () => void;
}) {
  const stage =
    progress?.stage ?? (direction === "upload" ? "encrypting" : "downloading");
  const percent = progressPercent(progress);
  return (
    <div className="progress-section">
      <div className="progress-heading">
        <p role="status">{stages[stage]}</p>
        <span className="progress-percent" aria-hidden="true">
          {percent}%
        </span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={stages[stage]}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className="progress-fill"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      </div>
      <p className="progress-meta">
        {progress
          ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
          : "Preparing…"}
      </p>
      <button
        type="button"
        className="button button-secondary full-width"
        onClick={onCancel}
      >
        Cancel {direction}
      </button>
    </div>
  );
}
