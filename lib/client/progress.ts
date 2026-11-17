import type { TransferProgress } from "../shared/types";

export type ProgressHandler = (progress: TransferProgress) => void;

export function reportProgress(
  callback: ProgressHandler | undefined,
  stage: TransferProgress["stage"],
  loaded: number,
  total: number,
): void {
  // A view callback must not interrupt encryption or leave a worker promise open.
  try {
    callback?.({
      stage,
      loaded,
      total,
      percent: total === 0 ? 100 : Math.min(100, (loaded / total) * 100),
    });
  } catch {}
}
