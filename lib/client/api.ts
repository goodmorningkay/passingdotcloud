import {
  MAX_ENCRYPTED_BYTES,
  MAX_ENCRYPTION_OVERHEAD,
  TTL_OPTIONS,
} from "../shared/constants";
import type {
  CreatedTransfer,
  TransferMetadata,
  TransferProgress,
  UploadedTransfer,
} from "../shared/types";
import { ApiError, abortable, abortError, checkAbort } from "./errors";
import {
  fetchApi,
  httpError,
  JSON_LIMIT,
  parseJson,
  requireOk,
  responseJson,
} from "./http";
import { assertTransferId, decodeKey, parseShareKey } from "./keys";
import { validateFileSize } from "./manifest";
import { reportProgress, type ProgressHandler } from "./progress";
import { encryptInWorker } from "./worker";

export function warmDownloadCrypto(): void {
  void import("./crypto").catch(() => {
    // The download action reports a load failure if it also fails then.
  });
}

function invalidResponse(): never {
  throw new ApiError(
    502,
    "INVALID_RESPONSE",
    "The server response is invalid.",
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidResponse();
  return value as Record<string, unknown>;
}

function isoDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalidResponse();
  return value;
}

function capability(value: unknown): string {
  if (typeof value !== "string") invalidResponse();
  try {
    decodeKey(value).fill(0);
  } catch {
    invalidResponse();
  }
  return value;
}

function metadata(value: unknown, expectedId: string): TransferMetadata {
  const data = object(value);
  if (data.id !== expectedId) invalidResponse();
  try {
    validateFileSize(data.size as number);
  } catch {
    invalidResponse();
  }
  if (
    typeof data.encryptedSize !== "number" ||
    !Number.isSafeInteger(data.encryptedSize) ||
    data.encryptedSize < (data.size as number) + 74 ||
    data.encryptedSize > MAX_ENCRYPTED_BYTES ||
    data.encryptedSize > (data.size as number) + MAX_ENCRYPTION_OVERHEAD
  )
    invalidResponse();
  return {
    id: expectedId,
    size: data.size as number,
    encryptedSize: data.encryptedSize,
    expiresAt: isoDate(data.expiresAt),
  };
}

function createdTransfer(value: unknown): CreatedTransfer {
  const data = object(value);
  try {
    assertTransferId(data.id as string);
  } catch {
    invalidResponse();
  }
  const uploadToken = capability(data.uploadToken);
  const deleteToken = capability(data.deleteToken);
  if (uploadToken === deleteToken) invalidResponse();
  return {
    id: data.id as string,
    uploadToken,
    deleteToken,
    uploadExpiresAt: isoDate(data.uploadExpiresAt),
  };
}

export async function getTransfer(
  id: string,
  signal?: AbortSignal,
): Promise<TransferMetadata> {
  assertTransferId(id);
  const response = await fetchApi(`/api/transfers/${id}`, { signal });
  await requireOk(response, signal);
  return metadata(await responseJson(response, signal), id);
}

export async function deleteTransfer(
  id: string,
  deleteToken: string,
  signal?: AbortSignal,
): Promise<void> {
  assertTransferId(id);
  try {
    decodeKey(deleteToken).fill(0);
  } catch {
    throw new ApiError(400, "INVALID_TOKEN", "The deletion key is invalid.");
  }
  const response = await fetchApi(`/api/transfers/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${deleteToken}` },
    signal,
  });
  await requireOk(response, signal);
  if (response.status !== 204) invalidResponse();
}

export async function updateTransferExpiry(
  id: string,
  deleteToken: string,
  ttlSeconds: number,
  signal?: AbortSignal,
): Promise<TransferMetadata> {
  assertTransferId(id);
  try {
    decodeKey(deleteToken).fill(0);
  } catch {
    throw new ApiError(400, "INVALID_TOKEN", "The deletion key is invalid.");
  }
  if (!TTL_OPTIONS.some((ttl) => ttl.seconds === ttlSeconds))
    throw new ApiError(400, "INVALID_TTL", "Choose a valid time limit.");
  const response = await fetchApi(`/api/transfers/${id}/expiry`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deleteToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttlSeconds }),
    signal,
  });
  await requireOk(response, signal);
  return metadata(await responseJson(response, signal), id);
}

function uploadCiphertext(
  session: CreatedTransfer,
  blob: Blob,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<TransferMetadata> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: Error, result?: TransferMetadata) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      xhr.onload =
        xhr.onerror =
        xhr.onabort =
        xhr.ontimeout =
        xhr.onprogress =
          null;
      xhr.upload.onprogress = null;
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => {
      finish(abortError());
      xhr.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    xhr.onload = () => {
      if (signal?.aborted) return onAbort();
      let body: unknown;
      try {
        body = parseJson(xhr.responseText);
      } catch (error) {
        if (xhr.status >= 200 && xhr.status < 300)
          return finish(error as Error);
      }
      if (xhr.status !== 200)
        return finish(
          httpError(xhr.status, body, xhr.getResponseHeader("Retry-After")),
        );
      try {
        const result = metadata(body, session.id);
        if (result.encryptedSize !== blob.size) invalidResponse();
        reportProgress(onProgress, "uploading", blob.size, blob.size);
        finish(undefined, result);
      } catch (error) {
        finish(error as Error);
      }
    };
    xhr.upload.onprogress = (event) =>
      reportProgress(
        onProgress,
        "uploading",
        Math.min(event.loaded, blob.size),
        blob.size,
      );
    xhr.onprogress = (event) => {
      if (event.loaded > JSON_LIMIT) {
        finish(
          new ApiError(
            502,
            "INVALID_RESPONSE",
            "The server response is invalid.",
          ),
        );
        xhr.abort();
      }
    };
    xhr.onerror = () =>
      finish(new ApiError(0, "NETWORK_ERROR", "The upload failed. Try again."));
    xhr.onabort = () => finish(abortError());
    xhr.ontimeout = () =>
      finish(
        new ApiError(0, "TIMEOUT", "The upload took too long. Try again."),
      );
    try {
      xhr.open("PUT", `/api/transfers/${session.id}/content`, true);
      xhr.timeout = 30 * 60 * 1_000;
      xhr.setRequestHeader("Authorization", `Bearer ${session.uploadToken}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      // The browser sets Content-Length from Blob.size. Scripts cannot set it.
      reportProgress(onProgress, "uploading", 0, blob.size);
      checkAbort(signal);
      xhr.send(blob);
    } catch (error) {
      finish(
        signal?.aborted
          ? abortError()
          : new ApiError(0, "NETWORK_ERROR", "The upload failed. Try again."),
      );
      xhr.abort();
      void error;
    }
  });
}

export async function uploadFile(
  file: File,
  options: {
    ttlSeconds: number;
    onProgress?: (p: TransferProgress) => void;
    signal?: AbortSignal;
  },
): Promise<UploadedTransfer> {
  checkAbort(options.signal);
  validateFileSize(file.size);
  if (!TTL_OPTIONS.some(({ seconds }) => seconds === options.ttlSeconds)) {
    throw new ApiError(400, "INVALID_TTL", "Select a valid time limit.");
  }
  const encrypted = await encryptInWorker(file, options);
  let cleanup: { id: string; deleteToken: string } | undefined;
  try {
    checkAbort(options.signal);
    const response = await fetchApi("/api/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: file.size,
        encryptedSize: encrypted.blob.size,
        ttlSeconds: options.ttlSeconds,
      }),
      signal: options.signal,
    });
    await requireOk(response, options.signal);
    const raw = await responseJson(response, options.signal);
    // Preserve a valid deletion capability even if another response field is bad.
    try {
      const record = object(raw);
      assertTransferId(record.id as string);
      cleanup = {
        id: record.id as string,
        deleteToken: capability(record.deleteToken),
      };
    } catch {}
    const session = createdTransfer(raw);
    if (response.status !== 201) invalidResponse();
    checkAbort(options.signal);
    const result = await uploadCiphertext(
      session,
      encrypted.blob,
      options.onProgress,
      options.signal,
    );
    if (result.size !== file.size) invalidResponse();
    checkAbort(options.signal);
    return { ...result, key: encrypted.key, deleteToken: session.deleteToken };
  } catch (error) {
    if (cleanup) {
      // Use a new signal. A cancelled transfer must still attempt deletion.
      try {
        await deleteTransfer(
          cleanup.id,
          cleanup.deleteToken,
          AbortSignal.timeout(5_000),
        );
      } catch {
        /* The API also removes incomplete sessions after 30 minutes. */
      }
    }
    throw error;
  }
}

export async function downloadTransfer(
  id: string,
  key: string,
  onProgress?: (p: TransferProgress) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; name: string }> {
  assertTransferId(id);
  parseShareKey(key);
  checkAbort(signal);
  const [details, { decryptContainer }] = await abortable(
    Promise.all([getTransfer(id, signal), import("./crypto")]),
    signal,
  );
  const response = await fetchApi(`/api/transfers/${id}/content`, { signal });
  await requireOk(response, signal);
  if (!response.body) invalidResponse();
  return decryptContainer(response.body, key, {
    signal,
    onProgress,
    size: details.size,
    encryptedSize: details.encryptedSize,
  });
}
