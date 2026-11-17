import { TOKEN_PATTERN, TRANSFER_ID_PATTERN } from "../shared/constants";
import { ApiError } from "./errors";

export function encodeKey(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error("Invalid key length.");
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  if (typeof key !== "string" || !TOKEN_PATTERN.test(key)) {
    throw new Error("The link key is missing or invalid.");
  }
  const bytes = Uint8Array.from(
    atob(key.replace(/-/g, "+").replace(/_/g, "/") + "="),
    (c) => c.charCodeAt(0),
  );
  if (bytes.length !== 32 || encodeKey(bytes) !== key) {
    bytes.fill(0);
    throw new Error("The link key is missing or invalid.");
  }
  return bytes;
}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  try {
    return encodeKey(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function parseShareKey(fragment: string): string {
  const key = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const bytes = decodeKey(key);
  bytes.fill(0);
  return key;
}

export function assertTransferId(id: string): void {
  if (typeof id !== "string" || !TRANSFER_ID_PATTERN.test(id)) {
    throw new ApiError(400, "INVALID_ID", "The transfer link is invalid.");
  }
}

export function createShareUrl(
  id: string,
  key: string,
  origin?: string,
): string {
  assertTransferId(id);
  parseShareKey(key);
  const base = new URL(origin ?? window.location.origin);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) {
    throw new Error("The link address is invalid.");
  }
  return `${base.origin}/t/${id}#${key}`;
}
