export const ADMIN_SIGN_IN_RETRY_MESSAGE =
  "The request did not complete. Try again.";

export class AdminRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function adminRequest<T>(
  path: string,
  options: { body?: unknown; csrfToken?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const beforeSignIn = path === "/session" || path === "/login";
  let response: Response;
  try {
    response = await fetch(`/api/admin${path}`, {
      method: options.body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers:
        options.body === undefined
          ? undefined
          : {
              "Content-Type": "application/json",
              ...(options.csrfToken
                ? { "X-Admin-CSRF": options.csrfToken }
                : {}),
            },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AdminRequestError(
      0,
      "NETWORK",
      beforeSignIn
        ? ADMIN_SIGN_IN_RETRY_MESSAGE
        : "The request did not complete. Refresh the list before you try again.",
    );
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    let message = beforeSignIn
      ? ADMIN_SIGN_IN_RETRY_MESSAGE
      : "The request failed. Refresh the list and try again.";
    if (response.status === 401) message = "Sign in with the admin key.";
    else if (response.status === 403)
      message = "The request was blocked. Reload this page and sign in again.";
    else if (response.status === 409)
      message = "This report is no longer open. Refresh the list.";
    else if (response.status === 429) {
      const delay = Number(response.headers.get("Retry-After"));
      message =
        Number.isSafeInteger(delay) && delay > 0
          ? `Too many requests. Try again in ${delay} seconds.`
          : "Too many requests. Try again later.";
    }
    throw new AdminRequestError(
      response.status,
      data?.error?.code ?? "REQUEST_FAILED",
      message,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}
