export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message = "The request failed. Try again.",
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function abortError(): DOMException {
  return new DOMException("The transfer was cancelled.", "AbortError");
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  checkAbort(signal);
  if (!signal) return promise;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
