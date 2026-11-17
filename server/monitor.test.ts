import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type AppOptions, type TransferApp } from "./app";
import { checkTransfer } from "../scripts/monitor-transfer";
import type { CreatedTransfer } from "../lib/shared/types";

const ORIGIN = "http://127.0.0.1:3000";
const apps: TransferApp[] = [];
const dirs: string[] = [];

async function fixture(options: AppOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "passing-monitor-"));
  dirs.push(directory);
  const app = await createApp({
    env: { PASSING_PUBLIC_ORIGIN: ORIGIN },
    dataDir: directory,
    cleanupIntervalMs: 0,
    ...options,
  });
  apps.push(app);
  const sessions: CreatedTransfer[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    const response = await app.inject({
      method: (init.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE",
      url: new URL(String(input)).pathname,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      payload: init.body as string | Buffer | undefined,
    });
    if (init.method === "POST" && response.statusCode === 201)
      sessions.push(response.json<CreatedTransfer>());
    return new Response(
      response.statusCode === 204 ? null : new Uint8Array(response.rawPayload),
      { status: response.statusCode },
    );
  };
  async function expectDeleted() {
    expect(sessions).toHaveLength(1);
    const response = await app.inject({
      method: "GET",
      url: `/api/transfers/${sessions[0]!.id}`,
    });
    expect(response.statusCode).toBe(404);
    expect(
      (await readdir(directory)).filter((name) => /\.(bin|part)$/.test(name)),
    ).toEqual([]);
  }
  return { app, fetcher, sessions, expectDeleted };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  const temporaryRoot = await realpath(tmpdir());
  for (const directory of dirs.splice(0)) {
    const target = await realpath(directory);
    if (
      path.dirname(target) !== temporaryRoot ||
      !path.basename(target).startsWith("passing-monitor-")
    )
      throw new Error("Unexpected monitor test directory.");
    await rm(target, { recursive: true, force: true });
  }
});

describe("transfer monitor", () => {
  it("uploads, compares downloaded bytes, and removes the stored file", async () => {
    const state = await fixture();
    await checkTransfer(ORIGIN, { fetcher: state.fetcher });
    await state.expectDeleted();
  });

  it("reports unavailable upload capacity", async () => {
    const state = await fixture({ limits: { storageBytes: 1 } });
    await expect(
      checkTransfer(ORIGIN, { fetcher: state.fetcher }),
    ).rejects.toThrow("creation (HTTP 503)");
    expect(state.sessions).toHaveLength(0);
  });

  it("removes a pending transfer when its upload fails", async () => {
    const state = await fixture();
    await expect(
      checkTransfer(ORIGIN, {
        fetcher: (input, init) =>
          init?.method === "PUT"
            ? Promise.resolve(new Response(null, { status: 503 }))
            : state.fetcher(input, init),
      }),
    ).rejects.toThrow("upload (HTTP 503)");
    await state.expectDeleted();
  });

  it.each(["changed", "oversized", "short"])(
    "fails on a %s download and still deletes the file",
    async (kind) => {
      const state = await fixture();
      await expect(
        checkTransfer(ORIGIN, {
          fetcher: async (input, init) => {
            const response = await state.fetcher(input, init);
            if (
              !init?.method &&
              String(input).endsWith("/content") &&
              response.status === 200
            ) {
              const bytes = Buffer.from(await response.arrayBuffer());
              if (kind === "changed") bytes[0] = bytes[0]! ^ 1;
              return new Response(
                kind === "oversized"
                  ? Buffer.concat([bytes, Buffer.from([0])])
                  : kind === "short"
                    ? bytes.subarray(1)
                    : bytes,
              );
            }
            return response;
          },
        }),
      ).rejects.toThrow(kind === "changed" ? "byte comparison" : "download");
      await state.expectDeleted();
    },
  );

  it("uses a new cleanup timeout after a download timeout", async () => {
    const state = await fixture();
    let timedOut = false;
    await expect(
      checkTransfer(ORIGIN, {
        timeoutMs: 30,
        fetcher: (input, init) => {
          if (!init?.method && String(input).endsWith("/content")) {
            // Only stall the first content request; deletion checks must finish.
            if (state.sessions.length === 1 && !timedOut) {
              return new Promise<Response>((_resolve, reject) => {
                init!.signal!.addEventListener("abort", () => {
                  timedOut = true;
                  reject(new Error("Private transport details"));
                });
              });
            }
          }
          if (init?.method === "DELETE")
            expect(init.signal?.aborted).toBe(false);
          return state.fetcher(input, init);
        },
      }),
    ).rejects.toThrow("Transfer check failed during download.");
    await state.expectDeleted();
  });

  it.each([503, 204])(
    "fails when deletion returns %i without removing the file",
    async (status) => {
      const state = await fixture();
      await expect(
        checkTransfer(ORIGIN, {
          fetcher: (input, init) =>
            init?.method === "DELETE"
              ? Promise.resolve(new Response(null, { status }))
              : state.fetcher(input, init),
        }),
      ).rejects.toThrow(
        status === 503 ? "deletion (HTTP 503)" : "deletion check",
      );
    },
  );

  it("does not expose transport errors or capability tokens", async () => {
    const state = await fixture();
    await expect(
      checkTransfer(ORIGIN, {
        fetcher: (input, init) => {
          if (init?.method === "PUT")
            throw new Error(JSON.stringify(state.sessions[0]));
          return state.fetcher(input, init);
        },
      }),
    ).rejects.toThrow(/^Transfer check failed during upload\.$/);
    await state.expectDeleted();
  });

  it.each([
    "http://example.com",
    "https://example.com/path",
    "https://user:password@example.com",
    "https://example.com?secret=value",
    "https://example.com#secret",
  ])("rejects an unsafe origin: %s", async (origin) => {
    await expect(
      checkTransfer(origin, {
        fetcher: () => {
          throw new Error("No request is permitted.");
        },
      }),
    ).rejects.toThrow("Use an HTTPS origin");
  });
});
