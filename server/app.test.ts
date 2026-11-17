import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp, type AppOptions, type TransferApp } from "./app";
import { TransferStore } from "./store";
import { listReports, reviewReport } from "./review";
import {
  MAX_ENCRYPTED_BYTES,
  MAX_FILE_BYTES,
  TTL_OPTIONS,
} from "../lib/shared/constants";
import type { CreatedTransfer } from "../lib/shared/types";

const ORIGIN = "http://localhost:3000";
const apps: TransferApp[] = [];
const dirs: string[] = [];
async function fixture(options: AppOptions = {}) {
  const dataDir =
    options.dataDir ?? (await mkdtemp(path.join(tmpdir(), "passing-api-")));
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const app = await createApp({
    env: {},
    cleanupIntervalMs: 0,
    ...options,
    dataDir,
  });
  apps.push(app);
  return { app, dataDir };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function create(
  app: TransferApp,
  encryptedSize = 64,
  remoteAddress?: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/transfers",
    remoteAddress,
    headers: { origin: ORIGIN },
    payload: { size: 0, encryptedSize, ttlSeconds: 3600 },
  });
  expect(response.statusCode).toBe(201);
  return response.json<CreatedTransfer>();
}
function put(
  app: TransferApp,
  transfer: CreatedTransfer,
  payload = Buffer.alloc(64),
) {
  return app.inject({
    method: "PUT",
    url: `/api/transfers/${transfer.id}/content`,
    headers: {
      authorization: `Bearer ${transfer.uploadToken}`,
      "content-type": "application/octet-stream",
    },
    payload,
  });
}
function del(app: TransferApp, transfer: CreatedTransfer) {
  return app.inject({
    method: "DELETE",
    url: `/api/transfers/${transfer.id}`,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${transfer.deleteToken}`,
    },
  });
}
function changeExpiry(
  app: TransferApp,
  transfer: CreatedTransfer,
  ttlSeconds = 3600,
) {
  return app.inject({
    method: "POST",
    url: `/api/transfers/${transfer.id}/expiry`,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${transfer.deleteToken}`,
    },
    payload: { ttlSeconds },
  });
}
function storedTransfer(dataDir: string, id: string) {
  const db = new DatabaseSync(path.join(dataDir, "metadata.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare("SELECT * FROM transfers WHERE id=?").get(id)!;
  } finally {
    db.close();
  }
}
const reportComment =
  "This file contains a suspicious program. Please review it.";
function report(
  app: TransferApp,
  id: string,
  comment = reportComment,
  remoteAddress = "192.0.2.50",
) {
  return app.inject({
    method: "POST",
    url: `/api/transfers/${id}/report`,
    remoteAddress,
    headers: { origin: ORIGIN },
    payload: { comment },
  });
}
async function ownerCommand(dataDir: string, ...args: string[]) {
  return promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "server/reports.ts", ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, PASSING_DATA_DIR: dataDir },
      windowsHide: true,
    },
  );
}
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The expected state was not reached.");
}
async function listening(app: TransferApp) {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  return new URL(origin);
}
function rawUpload(origin: URL, transfer: CreatedTransfer) {
  const request = http.request(
    new URL(`/api/transfers/${transfer.id}/content`, origin),
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${transfer.uploadToken}`,
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
      },
    },
  );
  const result = new Promise<number>((resolve) => {
    request.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode!));
    });
    request.once("error", () => resolve(0));
  });
  return { request, result };
}
async function largeReady(app: TransferApp) {
  const response = await app.inject({
    method: "POST",
    url: "/api/transfers",
    payload: {
      size: 32_000_000,
      encryptedSize: 32_000_064,
      ttlSeconds: 3600,
    },
  });
  expect(response.statusCode).toBe(201);
  const transfer = response.json<CreatedTransfer>();
  expect((await put(app, transfer, Buffer.alloc(32_000_064))).statusCode).toBe(
    200,
  );
  return transfer;
}
function stalledDownload(origin: URL, transfer: CreatedTransfer) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get(
      new URL(`/api/transfers/${transfer.id}/content`, origin),
      (response) => {
        response.on("error", () => {});
        response.pause();
        resolve(response);
      },
    );
    request.once("error", reject);
  });
}

describe("transfer API", () => {
  it("stores opaque bytes, starts TTL at completion, and stores only token hashes", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const transfer = await create(app);
    expect(transfer.id).toMatch(/^[a-f0-9]{32}$/);
    expect(transfer.uploadToken).not.toBe(transfer.deleteToken);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      404,
    );
    clock += 600_000;
    const uploaded = await put(app, transfer);
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().expiresAt).toBe(
      new Date(clock + 3_600_000).toISOString(),
    );
    const response = await app.inject(`/api/transfers/${transfer.id}/content`);
    expect(response.rawPayload).toEqual(Buffer.alloc(64));
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    const db = new DatabaseSync(path.join(dataDir, "metadata.sqlite"), {
      readOnly: true,
    });
    const row = db.prepare("SELECT * FROM transfers").get()!;
    db.close();
    expect(Object.keys(row).sort()).toEqual(
      [
        "id",
        "size",
        "encrypted_size",
        "ttl",
        "upload_hash",
        "delete_hash",
        "upload_expires",
        "expires",
        "state",
        "attempts",
      ].sort(),
    );
    expect(row.upload_hash).toBeNull();
    expect(row.delete_hash).toMatch(/^[a-f0-9]{64}$/);
    const dbBytes = await readFile(path.join(dataDir, "metadata.sqlite"));
    expect(dbBytes.includes(transfer.uploadToken)).toBe(false);
    expect(dbBytes.includes(transfer.deleteToken)).toBe(false);
    expect((await readdir(dataDir)).join()).not.toContain(transfer.uploadToken);
  });

  it("checks capabilities and never publishes pending or expired data", async () => {
    let clock = Date.now();
    const { app } = await fixture({ now: () => clock });
    const transfer = await create(app);
    const wrong = {
      ...transfer,
      uploadToken: "A".repeat(43),
      deleteToken: "B".repeat(43),
    };
    expect((await put(app, wrong)).statusCode).toBe(401);
    expect((await del(app, wrong)).statusCode).toBe(401);
    expect((await put(app, transfer)).statusCode).toBe(200);
    expect((await put(app, transfer)).statusCode).toBe(401);
    clock += 3_600_001;
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
    ).toBe(404);
    await app.cleanupTransfers();
    expect((await del(app, transfer)).statusCode).toBe(401);
  });

  it("reserves the full 100 MB limit independently for each file", async () => {
    const { app } = await fixture();
    const ids = new Set<string>();
    for (let index = 0; index < 2; index++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/transfers",
        headers: { origin: ORIGIN },
        payload: {
          size: MAX_FILE_BYTES,
          encryptedSize: MAX_ENCRYPTED_BYTES,
          ttlSeconds: 3600,
        },
      });
      expect(response.statusCode).toBe(201);
      ids.add(response.json<CreatedTransfer>().id);
    }
    expect(ids.size).toBe(2);
    const oversized = await app.inject({
      method: "POST",
      url: "/api/transfers",
      headers: { origin: ORIGIN },
      payload: {
        size: MAX_FILE_BYTES + 1,
        encryptedSize: MAX_ENCRYPTED_BYTES,
        ttlSeconds: 3600,
      },
    });
    expect(oversized.statusCode).toBe(400);
  });

  it("rejects invalid fields, maximum violations, unsafe paths, and wrong origins", async () => {
    const { app } = await fixture();
    for (const payload of [
      {
        size: MAX_FILE_BYTES + 1,
        encryptedSize: MAX_ENCRYPTED_BYTES,
        ttlSeconds: 3600,
      },
      { size: 0, encryptedSize: MAX_ENCRYPTED_BYTES + 1, ttlSeconds: 3600 },
      { size: -1, encryptedSize: 64, ttlSeconds: 3600 },
      { size: 0.5, encryptedSize: 64, ttlSeconds: 3600 },
      { size: 0, encryptedSize: 64, ttlSeconds: 30 },
      { size: 0, encryptedSize: 64, ttlSeconds: 3600, filename: "secret" },
    ])
      expect(
        (await app.inject({ method: "POST", url: "/api/transfers", payload }))
          .statusCode,
      ).toBe(400);
    for (const id of [
      "A".repeat(32),
      "__proto__",
      "..%2fmetadata.sqlite",
      "x".repeat(150),
    ]) {
      const response = await app.inject(`/api/transfers/${id}`);
      expect(response.statusCode).toBe(id.length > 80 ? 414 : 404);
      expect(response.json()).toHaveProperty("error.code");
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/transfers",
          headers: { origin: "https://evil.example" },
          payload: { size: 0, encryptedSize: 64, ttlSeconds: 3600 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/transfers",
          headers: { "content-type": "text/plain" },
          payload: "{}",
        })
      ).statusCode,
    ).toBe(415);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/transfers",
      headers: { "content-type": "application/json" },
      payload: '{"token":"DO_NOT_ECHO"',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain("DO_NOT_ECHO");
  });

  it("uses the upload capability once and rejects the wrong actual size", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    const results = await Promise.all([put(app, transfer), put(app, transfer)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const short = await create(app);
    expect((await put(app, short, Buffer.alloc(63))).statusCode).toBe(400);
    expect((await put(app, short)).statusCode).toBe(401);
    expect(
      (await readdir(dataDir)).filter((name) => name.startsWith(short.id)),
    ).toEqual([]);
  });

  it("enforces ten attempts, rejects ranges, and deletes early", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    await put(app, transfer);
    expect(
      (
        await app.inject({
          url: `/api/transfers/${transfer.id}/content`,
          headers: { range: "bytes=0-1" },
        })
      ).statusCode,
    ).toBe(416);
    expect(
      (
        await app.inject({
          method: "HEAD",
          url: `/api/transfers/${transfer.id}/content`,
        })
      ).statusCode,
    ).toBe(404);
    for (let i = 0; i < 10; i++)
      expect(
        (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
      ).toBe(200);
    const exhausted = await app.inject(`/api/transfers/${transfer.id}/content`);
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json().error.code).toBe("DOWNLOAD_LIMIT");
    expect(exhausted.headers["retry-after"]).toBeUndefined();
    expect((await del(app, transfer)).statusCode).toBe(204);
    expect(
      (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
    ).toBe(404);
    expect(
      (await readdir(dataDir)).filter((name) => name.startsWith(transfer.id)),
    ).toEqual([]);
  });

  it("limits session creation and all invalid and public lookups", async () => {
    const { app } = await fixture({ limits: { requestsPerMinute: 9 } });
    for (let i = 0; i < 5; i++) await create(app);
    const exhausted = await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload: { size: 0, encryptedSize: 64, ttlSeconds: 3600 },
    });
    expect(exhausted.statusCode).toBe(429);
    for (let i = 0; i < 3; i++)
      expect(
        (await app.inject(`/api/transfers/${"a".repeat(32)}`)).statusCode,
      ).toBe(404);
    expect((await app.inject("/api/health")).statusCode).toBe(429);
    expect(
      (await app.inject({ url: "/unknown", remoteAddress: "192.0.2.100" }))
        .statusCode,
    ).toBe(404);
  });

  it("does not trust spoofed forwarding headers", async () => {
    const { app } = await fixture({ limits: { requestsPerMinute: 1 } });
    expect(
      (
        await app.inject({
          url: "/api/health",
          headers: { "x-forwarded-for": "192.0.2.1" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/health",
          headers: { "x-forwarded-for": "192.0.2.2" },
        })
      ).statusCode,
    ).toBe(429);
  });

  it("requires the production origin for creation and checks browser mutation origins", async () => {
    const origin = "https://passing.cloud";
    const { app } = await fixture({
      env: {
        NODE_ENV: "production",
        PASSING_PUBLIC_ORIGIN: origin,
        PASSING_TRUST_PROXY: "none",
      },
    });
    const payload = { size: 0, encryptedSize: 64, ttlSeconds: 3600 };
    expect(
      (await app.inject({ method: "POST", url: "/api/transfers", payload }))
        .statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: "POST",
      url: "/api/transfers",
      payload,
      headers: { origin },
    });
    expect(response.statusCode).toBe(201);
    const transfer = response.json<CreatedTransfer>();
    expect((await put(app, transfer)).statusCode).toBe(200);
    const headers = { authorization: `Bearer ${transfer.deleteToken}` };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/transfers/${transfer.id}/expiry`,
          headers,
          payload: { ttlSeconds: 1800 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/transfers/${transfer.id}/expiry`,
          headers: { ...headers, origin },
          payload: { ttlSeconds: 1800 },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/transfers/${transfer.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/transfers/${transfer.id}`,
          headers: { ...headers, origin, "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/transfers/${transfer.id}`,
          headers: { ...headers, "content-type": "application/octet-stream" },
        })
      ).statusCode,
    ).toBe(204);
  });

  it("rejects unexpected bodies and limits malformed router requests", async () => {
    const { app } = await fixture({ limits: { requestsPerMinute: 2 } });
    const body = await app.inject({
      method: "GET",
      url: "/api/health",
      payload: "unneeded",
    });
    expect(body.statusCode).toBe(400);
    expect(body.headers.connection).toBe("close");
    expect(
      (await app.inject(`/api/transfers/${"x".repeat(100)}`)).statusCode,
    ).toBe(414);
    expect(
      (await app.inject(`/api/transfers/${"x".repeat(100)}`)).statusCode,
    ).toBe(429);
  });

  it("reserves the storage ceiling atomically", async () => {
    const { app } = await fixture({ limits: { storageBytes: 64 } });
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({
          method: "POST",
          url: "/api/transfers",
          payload: { size: 0, encryptedSize: 64, ttlSeconds: 3600 },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 503, 503]);
  });

  it("enforces physical disk headroom at creation and byte budgets at upload", async () => {
    const full = (
      await fixture({ limits: { headroomBytes: Number.MAX_SAFE_INTEGER } })
    ).app;
    expect(
      (
        await full.inject({
          method: "POST",
          url: "/api/transfers",
          payload: {
            size: 0,
            encryptedSize: 64,
            ttlSeconds: 3600,
          },
        })
      ).statusCode,
    ).toBe(503);
    const { app } = await fixture({ limits: { networkBytesPerHour: 64 } });
    const transfer = await create(app, 64, "192.0.2.1");
    const other = await create(app, 64, "192.0.2.2");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/transfers/${other.id}/content`,
          remoteAddress: "192.0.2.2",
          headers: {
            authorization: `Bearer ${other.uploadToken}`,
            "content-type": "application/octet-stream",
          },
          payload: Buffer.alloc(64),
        })
      ).statusCode,
    ).toBe(200);
    const response = await app.inject({
      method: "PUT",
      url: `/api/transfers/${transfer.id}/content`,
      remoteAddress: "192.0.2.2",
      headers: {
        authorization: `Bearer ${transfer.uploadToken}`,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(64),
    });
    expect(response.statusCode).toBe(429);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      404,
    );
    expect((await put(app, transfer)).statusCode).toBe(200);
  });

  it("fails closed and returns disk reservations after write and publish failures", async () => {
    const { app } = await fixture({ limits: { storageBytes: 64 } });
    const first = await create(app);
    vi.spyOn(TransferStore.prototype, "createPart").mockRejectedValueOnce(
      new Error("private path and token"),
    );
    const failed = await put(app, first);
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("private path");
    const second = await create(app);
    vi.spyOn(TransferStore.prototype, "publish").mockRejectedValueOnce(
      new Error("failure"),
    );
    expect((await put(app, second)).statusCode).toBe(503);
    await create(app);
  });

  it("keeps a failed delete denied and reserved until cleanup can retry", async () => {
    const { app } = await fixture({ limits: { storageBytes: 64 } });
    const transfer = await create(app);
    await put(app, transfer);
    const remove = vi
      .spyOn(TransferStore.prototype, "removeFiles")
      .mockRejectedValueOnce(new Error("EBUSY"));
    expect((await del(app, transfer)).statusCode).toBe(503);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/transfers",
          payload: { size: 0, encryptedSize: 64, ttlSeconds: 3600 },
        })
      ).statusCode,
    ).toBe(503);
    await app.cleanupTransfers();
    expect(remove).toHaveBeenCalledTimes(2);
    await create(app);
  });

  it("removes abandoned uploads and orphans before serving after restart", async () => {
    const { app, dataDir } = await fixture();
    const abandoned = await create(app);
    const ready = await create(app);
    await put(app, ready);
    await app.close();
    const db = new DatabaseSync(path.join(dataDir, "metadata.sqlite"));
    db.prepare(
      "UPDATE transfers SET state='uploading',upload_hash=NULL WHERE id=?",
    ).run(abandoned.id);
    db.close();
    await writeFile(path.join(dataDir, `${abandoned.id}.part`), "partial");
    const orphan = `${"f".repeat(32)}.bin`;
    await writeFile(path.join(dataDir, orphan), "orphan");
    const next = (await fixture({ dataDir })).app;
    expect(
      (await next.inject(`/api/transfers/${abandoned.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await next.inject(`/api/transfers/${ready.id}/content`)).statusCode,
    ).toBe(200);
    expect(
      (await readdir(dataDir)).filter(
        (name) => name === orphan || name.startsWith(abandoned.id),
      ),
    ).toEqual([]);
  });

  it("blocks a second process owner and denies corrupt stored files", async () => {
    const { app, dataDir } = await fixture();
    await expect(createApp({ env: {}, dataDir })).rejects.toThrow();
    const transfer = await create(app);
    await put(app, transfer);
    await writeFile(path.join(dataDir, `${transfer.id}.bin`), "truncated");
    expect(
      (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
    ).toBe(503);
  });
});

describe("real streamed uploads", () => {
  it("limits actual chunked bytes without trusting Content-Length", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    const origin = await listening(app);
    const { request, result } = rawUpload(origin, transfer);
    request.write(Buffer.alloc(40));
    request.end(Buffer.alloc(40));
    expect(await result).toBe(413);
    await eventually(
      async () =>
        !(await readdir(dataDir)).some((name) => name.startsWith(transfer.id)),
    );
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      404,
    );
  });

  it("removes a partial upload when the client disconnects", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    const { request, result } = rawUpload(await listening(app), transfer);
    request.write(Buffer.alloc(20));
    await eventually(async () =>
      (await readdir(dataDir)).includes(`${transfer.id}.part`),
    );
    request.destroy();
    await result;
    await eventually(
      async () =>
        !(await readdir(dataDir)).some((name) => name.startsWith(transfer.id)),
    );
    expect((await put(app, transfer)).statusCode).toBe(401);
  });

  it("cancels an active upload before early deletion completes", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    const { request, result } = rawUpload(await listening(app), transfer);
    request.write(Buffer.alloc(20));
    await eventually(async () =>
      (await readdir(dataDir)).includes(`${transfer.id}.part`),
    );
    expect((await del(app, transfer)).statusCode).toBe(204);
    expect(await result).toBe(0);
    expect(
      (await readdir(dataDir)).filter((name) => name.startsWith(transfer.id)),
    ).toEqual([]);
  });

  it("limits two simultaneous uploads for a network and global stream use", async () => {
    const { app, dataDir } = await fixture({ limits: { maxStreams: 2 } });
    const first = await create(app);
    const second = await create(app);
    const third = await create(app);
    const origin = await listening(app);
    const a = rawUpload(origin, first);
    const b = rawUpload(origin, second);
    a.request.write(Buffer.alloc(1));
    b.request.write(Buffer.alloc(1));
    await eventually(
      async () =>
        (await readdir(dataDir)).filter((name) => name.endsWith(".part"))
          .length === 2,
    );
    expect((await put(app, third)).statusCode).toBe(429);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/transfers/${third.id}/content`,
          remoteAddress: "192.0.2.25",
          headers: {
            authorization: `Bearer ${third.uploadToken}`,
            "content-type": "application/octet-stream",
          },
          payload: Buffer.alloc(64),
        })
      ).statusCode,
    ).toBe(429);
    a.request.destroy();
    b.request.destroy();
    await Promise.all([a.result, b.result]);
  });

  it("cancels an active upload at its pending deadline", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const transfer = await create(app);
    clock += 1_800_000 - 100;
    const { request, result } = rawUpload(await listening(app), transfer);
    request.write(Buffer.alloc(1));
    expect(await result).toBe(0);
    await eventually(
      async () =>
        !(await readdir(dataDir)).some((name) => name.startsWith(transfer.id)),
    );
  });
});

describe("expiry changes", () => {
  it("saves each allowed period from now and keeps counts and storage across restart", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const transfer = await create(app);
    await put(app, transfer);
    await app.inject(`/api/transfers/${transfer.id}/content`);
    const before = storedTransfer(dataDir, transfer.id);
    let expiresAt = "";
    for (const option of TTL_OPTIONS) {
      clock += 60_000;
      const response = await changeExpiry(app, transfer, option.seconds);
      expiresAt = new Date(clock + option.seconds * 1000).toISOString();
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toContain("no-store");
      expect(response.json()).toEqual({
        id: transfer.id,
        size: 0,
        encryptedSize: 64,
        expiresAt,
      });
      expect(storedTransfer(dataDir, transfer.id)).toEqual({
        ...before,
        ttl: option.seconds,
        expires: Date.parse(expiresAt),
      });
    }
    clock += 3_600_000;
    await app.cleanupTransfers();
    await app.close();
    const restarted = (await fixture({ dataDir, now: () => clock })).app;
    expect(
      (await restarted.inject(`/api/transfers/${transfer.id}`)).json()
        .expiresAt,
    ).toBe(expiresAt);
    expect(storedTransfer(dataDir, transfer.id).attempts).toBe(1);
    expect(await readFile(path.join(dataDir, `${transfer.id}.bin`))).toEqual(
      Buffer.alloc(64),
    );
  });

  it("requires the sender capability and rejects invalid choices, fields, and origins", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    await put(app, transfer);
    const before = storedTransfer(dataDir, transfer.id);
    const url = `/api/transfers/${transfer.id}/expiry`;
    for (const token of [
      undefined,
      "bad",
      transfer.uploadToken,
      "B".repeat(43),
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: {
          origin: ORIGIN,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        payload: { ttlSeconds: 3600 },
      });
      expect(response.statusCode).toBe(401);
    }
    for (const payload of [
      {},
      [],
      { ttlSeconds: "3600" },
      { ttlSeconds: 0 },
      { ttlSeconds: -1 },
      { ttlSeconds: 3600.5 },
      { ttlSeconds: 604801 },
      { ttlSeconds: 3600, expiresAt: "2030-01-01T00:00:00.000Z" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: {
              origin: ORIGIN,
              authorization: `Bearer ${transfer.deleteToken}`,
            },
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const headers of [
      { origin: "https://other.example" },
      { origin: ORIGIN, "sec-fetch-site": "cross-site" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: {
              ...headers,
              authorization: `Bearer ${transfer.deleteToken}`,
            },
            payload: { ttlSeconds: 3600 },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: {
            origin: ORIGIN,
            "content-type": "text/plain",
            authorization: `Bearer ${transfer.deleteToken}`,
          },
          payload: '{"ttlSeconds":3600}',
        })
      ).statusCode,
    ).toBe(415);
    expect(storedTransfer(dataDir, transfer.id)).toEqual(before);
  });

  it("rejects pending, expired, reported, and deleting files", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const pending = await create(app);
    expect((await changeExpiry(app, pending)).statusCode).toBe(404);
    const expired = await create(app);
    await put(app, expired);
    const reported = await create(app);
    await put(app, reported);
    await report(app, reported.id);
    expect((await changeExpiry(app, reported)).statusCode).toBe(404);
    const deleting = await create(app);
    await put(app, deleting);
    vi.spyOn(TransferStore.prototype, "removeFiles").mockRejectedValueOnce(
      new Error("EBUSY"),
    );
    expect((await del(app, deleting)).statusCode).toBe(503);
    expect((await changeExpiry(app, deleting)).statusCode).toBe(404);
    const before = storedTransfer(dataDir, expired.id);
    clock += 3_600_000;
    expect((await changeExpiry(app, expired)).statusCode).toBe(404);
    expect(storedTransfer(dataDir, expired.id)).toEqual(before);
    await app.cleanupTransfers();
    expect((await changeExpiry(app, expired)).statusCode).toBe(401);
  });

  it("applies a shorter expiry to access and cleanup", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const transfer = await create(app);
    await put(app, transfer);
    expect((await changeExpiry(app, transfer, 1800)).statusCode).toBe(200);
    clock += 1_800_000;
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
    ).toBe(404);
    await app.cleanupTransfers();
    expect(await readdir(dataDir)).not.toContain(`${transfer.id}.bin`);
  });

  it("uses the latest expiry when cleanup resumes after a deletion", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const first = await create(app);
    const second = await create(app);
    await put(app, second);
    clock += 1_800_000;
    let release!: () => void;
    let started!: () => void;
    const removing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = TransferStore.prototype.removeFiles;
    vi.spyOn(TransferStore.prototype, "removeFiles").mockImplementationOnce(
      async function (this: TransferStore, id) {
        expect(id).toBe(first.id);
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await original.call(this, id);
      },
    );
    const cleanup = app.cleanupTransfers();
    await removing;
    try {
      expect((await changeExpiry(app, second, 86400)).statusCode).toBe(200);
      clock += 1_800_001;
    } finally {
      release();
      await cleanup;
    }
    expect((await app.inject(`/api/transfers/${second.id}`)).statusCode).toBe(
      200,
    );
    expect(await readdir(dataDir)).toContain(`${second.id}.bin`);
  });
});

describe("active download cancellation", () => {
  it.each(["extend", "shorten"] as const)(
    "applies an expiry change to active downloads: %s",
    async (change) => {
      let clock = Date.now();
      const { app } = await fixture({
        now: () => clock,
        limits: {
          streamTimeoutMs: change === "extend" ? 5000 : 7_200_000,
          downloadsPerTransfer: 1,
        },
      });
      const transfer = await largeReady(app);
      const origin = await listening(app);
      if (change === "extend") clock += 3_600_000 - 100;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const response = await stalledDownload(origin, transfer);
      const closed = new Promise<void>((resolve) =>
        response.once("close", resolve),
      );
      try {
        // Leave part of the maximum stream duration used before the change.
        if (change === "extend") {
          clock += 50;
          await vi.advanceTimersByTimeAsync(50);
        }
        expect(
          (await changeExpiry(app, transfer, change === "extend" ? 3600 : 1800))
            .statusCode,
        ).toBe(200);
        if (change === "extend") {
          clock += 150;
          await vi.advanceTimersByTimeAsync(150);
          // The old expiry has passed, but the stream still holds its slot.
          expect(
            (await app.inject(`/api/transfers/${transfer.id}/content`))
              .statusCode,
          ).toBe(429);
        }
        const remaining = change === "extend" ? 4801 : 1_800_001;
        clock += remaining;
        await vi.advanceTimersByTimeAsync(remaining);
        response.resume();
        await closed;
        expect(response.complete).toBe(false);
        if (change === "extend")
          expect(
            (await app.inject(`/api/transfers/${transfer.id}`)).statusCode,
          ).toBe(200);
      } finally {
        response.destroy();
        vi.useRealTimers();
      }
    },
  );

  it("enforces two streams per transfer and closes files before deletion", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await largeReady(app);
    const origin = await listening(app);
    const first = await stalledDownload(origin, transfer);
    const second = await stalledDownload(origin, transfer);
    try {
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(
        (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
      ).toBe(429);
      expect((await del(app, transfer)).statusCode).toBe(204);
      expect(
        (await readdir(dataDir)).filter((name) => name.startsWith(transfer.id)),
      ).toEqual([]);
      expect(
        (await app.inject(`/api/transfers/${transfer.id}`)).statusCode,
      ).toBe(404);
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  it("aborts a stalled download when the transfer expires", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const transfer = await largeReady(app);
    const response = await stalledDownload(await listening(app), transfer);
    const closed = new Promise<void>((resolve) =>
      response.once("close", resolve),
    );
    clock += 3_600_001;
    await app.cleanupTransfers();
    response.resume();
    await closed;
    expect(response.complete).toBe(false);
    expect(
      (await readdir(dataDir)).filter((name) => name.startsWith(transfer.id)),
    ).toEqual([]);
  });

  it("uses a stream expiry timer even when the cleanup worker has not run", async () => {
    let clock = Date.now();
    const { app } = await fixture({ now: () => clock });
    const transfer = await largeReady(app);
    clock += 3_600_000 - 100;
    const response = await stalledDownload(await listening(app), transfer);
    const closed = new Promise<void>((resolve) =>
      response.once("close", resolve),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    response.resume();
    await closed;
    expect(response.complete).toBe(false);
  });
});

describe("reports and owner review", () => {
  it("blocks metadata and bytes across a restart and permits owner review without stopping the API", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    const before = (await put(app, transfer)).json();
    expect((await report(app, transfer.id)).statusCode).toBe(202);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
    ).toBe(404);
    const entries = JSON.parse((await ownerCommand(dataDir, "list")).stdout);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: transfer.id,
      comment: reportComment,
      expiresAt: before.expiresAt,
    });
    expect(Object.keys(entries[0]).sort()).toEqual([
      "comment",
      "expiresAt",
      "id",
      "reportId",
      "reportedAt",
      "size",
      "state",
    ]);
    expect(
      (await readFile(path.join(dataDir, "metadata.sqlite"))).includes(
        Buffer.from("192.0.2.50"),
      ),
    ).toBe(false);
    await app.close();
    const restarted = (await fixture({ dataDir })).app;
    expect(
      (await restarted.inject(`/api/transfers/${transfer.id}/content`))
        .statusCode,
    ).toBe(404);
    expect(await readdir(dataDir)).toContain(`${transfer.id}.bin`);
    await ownerCommand(dataDir, "approve", transfer.id, entries[0].reportId);
    expect(
      (await restarted.inject(`/api/transfers/${transfer.id}`)).json(),
    ).toEqual(before);
    expect(
      (await restarted.inject(`/api/transfers/${transfer.id}/content`))
        .statusCode,
    ).toBe(200);
    expect(await listReports(dataDir)).toEqual([]);
    expect(
      (await readFile(path.join(dataDir, "metadata.sqlite"))).includes(
        Buffer.from(reportComment),
      ),
    ).toBe(false);
  });

  it("cannot approve a newer report using an old report id", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    await put(app, transfer);
    await report(app, transfer.id);
    const old = (await listReports(dataDir))[0]!;
    await reviewReport(dataDir, transfer.id, old.reportId, "approve");
    await report(
      app,
      transfer.id,
      "Another report after the first review was complete.",
    );
    const current = (await listReports(dataDir))[0]!;
    expect(current.reportId).not.toBe(old.reportId);
    await expect(
      reviewReport(dataDir, transfer.id, old.reportId, "approve"),
    ).rejects.toThrow("no longer open");
    expect(
      (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
    ).toBe(404);
    expect((await listReports(dataDir))[0]).toEqual(current);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/transfers/${transfer.id}/approve`,
          headers: { origin: ORIGIN },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
  });

  it("queues owner deletion without releasing storage before physical cleanup", async () => {
    const { app, dataDir } = await fixture({ limits: { storageBytes: 64 } });
    const transfer = await create(app);
    await put(app, transfer);
    await report(app, transfer.id);
    const entry = (await listReports(dataDir))[0]!;
    await ownerCommand(dataDir, "delete", transfer.id, entry.reportId);
    expect(
      (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
    ).toBe(404);
    expect(await listReports(dataDir)).toEqual([]);
    expect(await readdir(dataDir)).toContain(`${transfer.id}.bin`);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/transfers",
          payload: { size: 0, encryptedSize: 64, ttlSeconds: 3600 },
        })
      ).statusCode,
    ).toBe(503);
    await app.cleanupTransfers();
    expect(await readdir(dataDir)).not.toContain(`${transfer.id}.bin`);
    await create(app);
  });

  it("removes report comments on expiry and never restores expired files", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const transfer = await create(app);
    await put(app, transfer);
    await report(app, transfer.id);
    const entry = (await listReports(dataDir, clock))[0]!;
    clock += 3_600_001;
    await expect(
      reviewReport(dataDir, transfer.id, entry.reportId, "approve", clock),
    ).rejects.toThrow();
    await app.cleanupTransfers();
    expect(await listReports(dataDir, clock)).toEqual([]);
    expect(await readdir(dataDir)).not.toContain(`${transfer.id}.bin`);
    const db = new DatabaseSync(path.join(dataDir, "metadata.sqlite"));
    try {
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM reports").get()?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("allows the sender to delete a held file and removes its comment", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    await put(app, transfer);
    await report(app, transfer.id);
    expect((await del(app, transfer)).statusCode).toBe(204);
    expect(await listReports(dataDir)).toEqual([]);
    expect(await readdir(dataDir)).not.toContain(`${transfer.id}.bin`);
  });

  it("blocks a pending upload until reviewed and does not extend its deadline", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    await report(app, transfer.id);
    expect((await put(app, transfer)).statusCode).toBe(404);
    const entry = (await listReports(dataDir))[0]!;
    expect(entry.expiresAt).toBe(transfer.uploadExpiresAt);
    await reviewReport(dataDir, transfer.id, entry.reportId, "approve");
    expect((await put(app, transfer)).statusCode).toBe(200);
  });

  it("stops an active upload on report and never publishes the partial file", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await create(app);
    const upload = rawUpload(await listening(app), transfer);
    upload.request.write(Buffer.alloc(20));
    await eventually(async () =>
      (await readdir(dataDir)).includes(`${transfer.id}.part`),
    );
    expect((await report(app, transfer.id)).statusCode).toBe(202);
    expect(await upload.result).toBe(0);
    await eventually(
      async () =>
        !(await readdir(dataDir)).some((name) => name.startsWith(transfer.id)),
    );
    expect(
      (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
    ).toBe(404);
    expect(await listReports(dataDir)).toEqual([]);
  });

  it("stops a live download on report and keeps the encrypted file for review", async () => {
    const { app, dataDir } = await fixture();
    const transfer = await largeReady(app);
    const response = await stalledDownload(await listening(app), transfer);
    const closed = new Promise<void>((resolve) =>
      response.once("close", resolve),
    );
    try {
      expect((await report(app, transfer.id)).statusCode).toBe(202);
      response.resume();
      await closed;
      expect(response.complete).toBe(false);
      expect(await readdir(dataDir)).toContain(`${transfer.id}.bin`);
      expect(
        (await app.inject(`/api/transfers/${transfer.id}/content`)).statusCode,
      ).toBe(404);
    } finally {
      response.destroy();
    }
  });

  it("rejects bad comments, extra fields, and oversized bodies before a hold is created", async () => {
    const { app, dataDir } = await fixture({ limits: { reportsPerHour: 20 } });
    const transfer = await create(app);
    await put(app, transfer);
    for (const comment of [
      "",
      "short",
      "x".repeat(1001),
      "bad\u001b[2J comment here",
      `The key is ${"A".repeat(43)}`,
    ]) {
      expect((await report(app, transfer.id, comment)).statusCode).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/transfers/${transfer.id}/report`,
          headers: { origin: ORIGIN },
          payload: {
            comment: reportComment,
            email: "not-collected@example.com",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect((await report(app, transfer.id, "x".repeat(9_000))).statusCode).toBe(
      413,
    );
    expect(await listReports(dataDir)).toEqual([]);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      200,
    );
    expect((await report(app, transfer.id, "🙂".repeat(500))).statusCode).toBe(
      202,
    );
    expect((await listReports(dataDir))[0]?.comment).toBe("🙂".repeat(500));
  });

  it("limits unknown ids and repeat reports per network, ignores spoofed IPs, and gives the wait time", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const transfer = await create(app);
    await put(app, transfer);
    for (let index = 0; index < 3; index++) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/transfers/${"a".repeat(32)}/report`,
            remoteAddress: "192.0.2.50",
            headers: {
              origin: ORIGIN,
              "x-forwarded-for": `192.0.2.${index + 1}`,
            },
            payload: { comment: reportComment },
          })
        ).statusCode,
      ).toBe(202);
    }
    clock += 1_000;
    const denied = await report(app, transfer.id);
    expect(denied.statusCode).toBe(429);
    expect(denied.headers["retry-after"]).toBe("3599");
    expect(await listReports(dataDir, clock)).toEqual([]);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      200,
    );
    clock += 3_600_001;
    expect((await report(app, "a".repeat(32))).statusCode).toBe(202);
  });
});
