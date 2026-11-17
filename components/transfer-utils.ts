import { MAX_FILE_BYTES } from "@/lib/shared/constants";
import type { TransferProgress } from "@/lib/shared/types";

export function validateSelection(files: readonly File[]): string | null {
  if (!files.length) return "Choose at least one file.";
  const oversized = files.find((file) => file.size > MAX_FILE_BYTES);
  if (oversized)
    return `${oversized.name}: This file is too large. Choose a file of 100 MB or less.`;
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 bytes";
  if (bytes < 1_000) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  const unit = bytes >= 1_000_000 ? "MB" : "KB";
  const value = bytes / (unit === "MB" ? 1_000_000 : 1_000);
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

export function formatExpiry(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function progressPercent(progress: TransferProgress | null): number {
  if (!progress || !Number.isFinite(progress.percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(progress.percent)));
}

export function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// Never display raw service errors. They can contain untrusted text.
export function transferError(
  error: unknown,
  action: "upload" | "download" | "metadata" | "delete" | "report" | "expiry",
): string {
  const details =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown; code?: unknown; retryAfter?: unknown })
      : undefined;
  const status = details?.status;
  if (status === 429 && details?.code === "DOWNLOAD_LIMIT")
    return "This file has no download attempts left. Ask the sender for a new link.";
  if (status === 429) {
    const retry = details?.retryAfter;
    const seconds =
      typeof retry === "number" && Number.isFinite(retry) && retry > 0
        ? Math.ceil(retry)
        : 60;
    return `Too many requests. Wait ${seconds} ${seconds === 1 ? "second" : "seconds"}, then try again.`;
  }
  if (status === 404 || status === 410)
    return "This file is no longer available. The link may have expired, or the file may have been deleted or blocked for review.";
  if (status === 413)
    return "This file is too large. Choose a file of 100 MB or less.";
  if (status === 401 || status === 403) {
    if (action === "expiry")
      return "The expiry could not be changed. This tab may no longer have permission.";
    return action === "delete"
      ? "The file could not be deleted. This tab may no longer have permission."
      : "This transfer could not be completed. Start again with a new link.";
  }
  if (status === 503 || status === 507)
    return "The service is busy. Wait a moment, then try again.";
  if (
    status === 0 ||
    error instanceof TypeError ||
    (typeof status === "number" && status >= 500)
  )
    return "The service could not be reached. Check your connection, then try again.";
  if (action === "download")
    return "The file could not be opened. The key may be wrong, or the file may be damaged. Ask the sender for the full link.";
  if (action === "delete")
    return "The file could not be deleted. Check your connection, then try again.";
  if (action === "expiry")
    return "The expiry could not be changed. Check your connection, then try again.";
  if (action === "report")
    return "The report could not be sent. Check the file ID and reason, then try again.";
  return "The transfer could not be completed. Check your connection, then try again.";
}
