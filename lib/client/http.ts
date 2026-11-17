import { ApiError, abortError, checkAbort } from "./errors";

export const JSON_LIMIT = 16_384;

export function retryAfter(value: string | null): number | undefined {
  if (!value || value.length > 80) return undefined;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : (Date.parse(value) - Date.now()) / 1_000;
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(604_800, Math.max(0, Math.ceil(seconds)));
}

export function httpError(
  status: number,
  body?: unknown,
  retry?: string | null,
): ApiError {
  let code = "REQUEST_FAILED";
  if (body && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    )
      code = error.code;
  }
  const message =
    status === 404
      ? "The file is not available. Its time limit can have expired."
      : status === 429
        ? "Too many requests. Wait and try again."
        : status === 413
          ? "The file is too large."
          : status === 401 || status === 403
            ? "This action is not permitted."
            : status >= 500
              ? "The service is not available. Try again later."
              : "The request failed. Try again.";
  return new ApiError(status, code, message, retryAfter(retry ?? null));
}

export function parseJson(text: string): unknown {
  if (text.length > JSON_LIMIT)
    throw new ApiError(
      502,
      "INVALID_RESPONSE",
      "The server response is invalid.",
    );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(
      502,
      "INVALID_RESPONSE",
      "The server response is invalid.",
    );
  }
}

export async function fetchApi(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  checkAbort(init.signal ?? undefined);
  try {
    return await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    if (init.signal?.aborted) throw abortError();
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "The service could not be reached. Try again.",
    );
  }
}

export async function responseJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new ApiError(
      502,
      "INVALID_RESPONSE",
      "The server response is invalid.",
    );
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let complete = false;
  try {
    checkAbort(signal);
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      checkAbort(signal);
      if (next.done) break;
      size += next.value.length;
      if (size > JSON_LIMIT)
        throw new ApiError(
          502,
          "INVALID_RESPONSE",
          "The server response is invalid.",
        );
      parts.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    complete = true;
    return parseJson(new TextDecoder().decode(bytes));
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!complete) {
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

export async function requireOk(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  if (response.ok) return;
  let body: unknown;
  try {
    body = await responseJson(response, signal);
  } catch {
    checkAbort(signal);
  }
  throw httpError(response.status, body, response.headers.get("Retry-After"));
}
