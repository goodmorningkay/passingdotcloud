export const MAX_FILE_BYTES = 100_000_000;
export const MAX_ENCRYPTION_OVERHEAD = 65_536;
export const MAX_ENCRYPTED_BYTES = MAX_FILE_BYTES + MAX_ENCRYPTION_OVERHEAD;
export const CHUNK_BYTES = 1_048_576;
export const MAX_MANIFEST_BYTES = 4_096;
export const FORMAT_MAGIC = "PASSCLD1";
export const DEFAULT_TTL_SECONDS = 3_600;
export const TTL_OPTIONS = [
  { seconds: 1_800, label: "30 minutes" },
  { seconds: 3_600, label: "1 hour" },
  { seconds: 21_600, label: "6 hours" },
  { seconds: 43_200, label: "12 hours" },
  { seconds: 86_400, label: "24 hours" },
  { seconds: 604_800, label: "7 days" },
] as const;
export type TtlSeconds = (typeof TTL_OPTIONS)[number]["seconds"];
export const TRANSFER_ID_PATTERN = /^[a-f0-9]{32}$/;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
