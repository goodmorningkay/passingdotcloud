import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { responseJson } from "../lib/client/http";
import {
  TOKEN_PATTERN,
  TRANSFER_ID_PATTERN,
  TTL_OPTIONS,
} from "../lib/shared/constants";
import type { CreatedTransfer, TransferMetadata } from "../lib/shared/types";

export class TransferCheckError extends Error {}

interface CheckOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function checkOrigin(value: string): URL {
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    )
      throw new Error();
    return url;
  } catch {
    throw new TransferCheckError(
      "Use an HTTPS origin without a path, query, or credentials. HTTP is permitted only on loopback addresses.",
    );
  }
}

async function readPayload(response: Response, size: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const bytes = Buffer.alloc(size);
  let offset = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.length > size) throw new Error();
      bytes.set(next.value, offset);
      offset += next.value.length;
    }
    if (offset !== size) throw new Error();
    return bytes;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function checkTransfer(
  origin: string,
  { fetcher = fetch, timeoutMs = 15_000 }: CheckOptions = {},
): Promise<void> {
  const url = checkOrigin(origin);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new TransferCheckError("The request timeout must be 1 to 60000 ms.");

  // Random test bytes contain no user data. The API stores opaque payloads.
  // Browser encryption is checked separately by the browser tests.
  const payload = randomBytes(1_024);
  let stage = "creation";
  let transfer: Pick<CreatedTransfer, "id" | "deleteToken"> | undefined;
  let failure: TransferCheckError | undefined;

  async function request(
    route: string,
    status: number,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Origin", url.origin);
    const response = await fetcher(new URL(route, url), {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== status) {
      await response.body?.cancel().catch(() => {});
      throw new TransferCheckError(
        `Transfer check failed during ${stage} (HTTP ${response.status}).`,
      );
    }
    return response;
  }

  try {
    const created = (await responseJson(
      await request("/api/transfers", 201, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          size: 0,
          encryptedSize: payload.length,
          ttlSeconds: TTL_OPTIONS[0].seconds,
        }),
      }),
    )) as Partial<CreatedTransfer> | null;
    if (
      !created ||
      typeof created.id !== "string" ||
      !TRANSFER_ID_PATTERN.test(created.id) ||
      typeof created.deleteToken !== "string" ||
      !TOKEN_PATTERN.test(created.deleteToken)
    )
      throw new Error();
    transfer = { id: created.id, deleteToken: created.deleteToken };
    if (
      typeof created.uploadToken !== "string" ||
      !TOKEN_PATTERN.test(created.uploadToken) ||
      created.uploadToken === created.deleteToken
    )
      throw new Error();

    const route = `/api/transfers/${transfer.id}`;
    stage = "upload";
    const uploaded = await request(`${route}/content`, 200, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${created.uploadToken}`,
      },
      body: payload,
    });
    await uploaded.body?.cancel();

    stage = "metadata check";
    const metadata = (await responseJson(
      await request(route, 200),
    )) as TransferMetadata | null;
    if (
      metadata?.id !== transfer.id ||
      metadata.size !== 0 ||
      metadata.encryptedSize !== payload.length
    )
      throw new Error();

    stage = "download";
    const downloaded = await readPayload(
      await request(`${route}/content`, 200),
      payload.length,
    );
    stage = "byte comparison";
    if (!payload.equals(downloaded)) throw new Error();
  } catch (error) {
    failure =
      error instanceof TransferCheckError
        ? error
        : new TransferCheckError(`Transfer check failed during ${stage}.`);
  }
  if (transfer) {
    // Each cleanup request has a new timeout, including after an upload timeout.
    stage = "deletion";
    try {
      const route = `/api/transfers/${transfer.id}`;
      await request(route, 204, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${transfer.deleteToken}` },
      });
      stage = "deletion check";
      for (const target of [route, `${route}/content`]) {
        const response = await request(target, 404);
        await response.body?.cancel();
      }
    } catch (error) {
      failure =
        error instanceof TransferCheckError
          ? error
          : new TransferCheckError(`Transfer check failed during ${stage}.`);
    }
  }
  if (failure) throw failure;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [argument, ...extra] = process.argv.slice(2);
  const origin = argument ?? process.env.PASSING_MONITOR_ORIGIN;
  const usage = "Use: npm run monitor:transfer -- https://your-app.example\n";
  if (argument === "--help" && !extra.length) {
    process.stdout.write(usage);
  } else {
    try {
      if (!origin || extra.length) throw new TransferCheckError(usage.trim());
      await checkTransfer(origin);
      process.stdout.write(
        "Transfer check passed. The test file was deleted.\n",
      );
    } catch (error) {
      process.stderr.write(
        (error instanceof TransferCheckError
          ? error.message
          : "Transfer check failed.") + "\n",
      );
      process.exitCode = 1;
    }
  }
}
