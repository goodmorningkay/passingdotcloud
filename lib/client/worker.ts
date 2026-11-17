import { abortError, checkAbort } from "./errors";
import { encodeManifest } from "./manifest";
import { reportProgress, type ProgressHandler } from "./progress";
import type { EncryptRequest, EncryptResponse } from "./worker-types";

let warmedWorker: Worker | undefined;

function createEncryptionWorker(): Worker {
  // Keep the literal URL beside the constructor for the Next.js worker bundle.
  return new Worker(new URL("./encryption.worker.ts", import.meta.url), {
    type: "module",
  });
}

export function warmEncryptionWorker(): void {
  if (warmedWorker || typeof Worker === "undefined") return;
  try {
    const worker = createEncryptionWorker();
    warmedWorker = worker;
    worker.onerror = (event) => {
      event.preventDefault();
      if (warmedWorker === worker) warmedWorker = undefined;
      worker.terminate();
    };
  } catch {
    // A warm-up failure must not prevent a later upload attempt.
  }
}

export function clearWarmedEncryptionWorker(): void {
  warmedWorker?.terminate();
  warmedWorker = undefined;
}

export function encryptInWorker(
  file: File,
  options: { signal?: AbortSignal; onProgress?: ProgressHandler },
): Promise<{ blob: Blob; key: string }> {
  checkAbort(options.signal);
  // Fail before starting a worker when the file details are not valid.
  encodeManifest(file).fill(0);
  return new Promise((resolve, reject) => {
    const worker = warmedWorker ?? createEncryptionWorker();
    warmedWorker = undefined;
    let settled = false;
    const finish = (error?: Error, result?: { blob: Blob; key: string }) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => finish(abortError());
    worker.onerror = (event) => {
      event.preventDefault();
      finish(new Error("The file could not be encrypted. Try again."));
    };
    worker.onmessageerror = () =>
      finish(new Error("The file could not be encrypted. Try again."));
    worker.onmessage = (event: MessageEvent<EncryptResponse>) => {
      if (options.signal?.aborted) return onAbort();
      const response = event.data;
      if (response.type === "progress") {
        reportProgress(
          options.onProgress,
          "encrypting",
          response.progress.loaded,
          response.progress.total,
        );
      } else if (response.type === "complete") {
        finish(undefined, { blob: response.blob, key: response.key });
      } else {
        finish(new Error("The file could not be encrypted. Try again."));
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    try {
      worker.postMessage({ type: "encrypt", file } satisfies EncryptRequest);
    } catch {
      finish(new Error("The file could not be encrypted. Try again."));
    }
  });
}
