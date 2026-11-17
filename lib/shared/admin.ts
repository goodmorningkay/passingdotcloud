export const ADMIN_STATUSES = [
  "all",
  "ready",
  "pending",
  "uploading",
  "reported",
  "expired",
  "deleting",
] as const;

export type AdminStatus = (typeof ADMIN_STATUSES)[number];

export interface AdminSession {
  csrfToken: string;
  expiresAt: number;
}

export interface AdminFile {
  id: string;
  size: number;
  encryptedSize: number;
  expiresAt: string;
  state: "pending" | "uploading" | "ready" | "deleting";
  status: Exclude<AdminStatus, "all">;
  attempts: number;
  report: { id: string; comment: string; reportedAt: string } | null;
}

export interface AdminFiles {
  items: AdminFile[];
  page: number;
  pageSize: number;
  total: number;
  summary: {
    files: number;
    reservedBytes: number;
    storageLimitBytes: number;
    openReports: number;
    downloadLimit: number;
  };
}

export const ADMIN_STATUS_LABELS: Record<AdminStatus, string> = {
  all: "All files",
  ready: "Available",
  pending: "Waiting for upload",
  uploading: "Uploading",
  reported: "Reported",
  expired: "Expired",
  deleting: "Deletion pending",
};
