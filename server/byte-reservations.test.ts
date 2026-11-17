import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp, type AppOptions, type TransferApp } from "./app";
import { RateCounters } from "./rates";
import { TransferStore } from "./store";
import type { CreatedTransfer } from "../lib/shared/types";

const ORIGIN = "https://bytes.invalid";
const A = "192.0.2.1";
const B = "198.51.100.2";
const C = "203.0.113.3";
const HOUR = 3_600_000;
const apps: TransferApp[] = [];
const dirs: string[] = [];

async function fixture(limits: AppOptions["limits"] = {}) {
  let clock = 1_800_000_000_000;
  const dataDir = await mkdtemp(path.join(tmpdir(), "passing-bytes-"));
  dirs.push(dataDir);
  const start = async () => {
    const app = await createApp({
      dataDir,
      now: () => clock,
      cleanupIntervalMs: 0,
      env: {
        NODE_ENV: "production",
        PASSING_PUBLIC_ORIGIN: ORIGIN,
        PASSING_TRUST_PROXY: "none",
      },
      limits: { storageBytes: 100, headroomBytes: 0, ...limits },
    });
    apps.push(app);
    return app;
  };
  return {
    app: await start(),
    dataDir,
    start,
    advance: (ms: number) => (clock += ms),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function reserve(app: TransferApp, network = A, encryptedSize = 10) {
  return app.inject({
    method: "POST",
    url: "/api/transfers",
    remoteAddress: network,
    headers: { origin: ORIGIN },
    payload: { size: encryptedSize - 1, encryptedSize, ttlSeconds: 604800 },
  });
}
async function create(app: TransferApp, network = A, encryptedSize = 10) {
  const response = await reserve(app, network, encryptedSize);
  expect(response.statusCode).toBe(201);
  return response.json<CreatedTransfer>();
}
function upload(
  app: TransferApp,
  transfer: CreatedTransfer,
  network = A,
  size = 10,
) {
  return app.inject({
    method: "PUT",
    url: `/api/transfers/${transfer.id}/content`,
    remoteAddress: network,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${transfer.uploadToken}`,
      "content-type": "application/octet-stream",
    },
    payload: Buffer.alloc(size, 7),
  });
}
function remove(app: TransferApp, transfer: CreatedTransfer, network = A) {
  return app.inject({
    method: "DELETE",
    url: `/api/transfers/${transfer.id}`,
    remoteAddress: network,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${transfer.deleteToken}`,
    },
  });
}
function download(app: TransferApp, transfer: CreatedTransfer, network = C) {
  return app.inject({
    url: `/api/transfers/${transfer.id}/content`,
    remoteAddress: network,
  });
}
function rows(dataDir: string) {
  const db = new DatabaseSync(path.join(dataDir, "metadata.sqlite"), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT id, state, attempts, upload_hash FROM transfers")
      .all();
  } finally {
    db.close();
  }
}
async function cycle(app: TransferApp, network: string) {
  const pending = await create(app, network);
  expect((await remove(app, pending, network)).statusCode).toBe(204);
}

describe("pending storage and transfer byte accounting", () => {
  it("does not charge repeated declarations and deletions", async () => {
    const { app, dataDir } = await fixture({
      networkBytesPerHour: 20,
      globalBytesPerHour: 40,
      storageBytes: 10,
      sessionsPerMinute: 2,
    });
    for (const network of [A, B]) {
      await cycle(app, network);
      await cycle(app, network);
      expect((await reserve(app, network, 1)).statusCode).toBe(429);
    }
    expect(rows(dataDir)).toEqual([]);
    const next = await create(app, C, 1);
    expect((await upload(app, next, C, 1)).statusCode).toBe(200);
  });

  it("keeps a ready file downloadable after unused declaration cycles", async () => {
    const { app, dataDir, advance } = await fixture({
      networkBytesPerHour: 20,
      globalBytesPerHour: 40,
      storageBytes: 20,
      sessionsPerMinute: 2,
    });
    const ready = await create(app, C);
    expect((await upload(app, ready, C)).statusCode).toBe(200);
    advance(HOUR + 1);
    for (const network of [A, B]) {
      await cycle(app, network);
      await cycle(app, network);
    }
    const response = await download(app, ready);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.alloc(10, 7));
    expect(rows(dataDir)).toMatchObject([{ id: ready.id, attempts: 1 }]);
  });

  it("does not charge a failed storage reservation", async () => {
    const { app, dataDir } = await fixture({
      storageBytes: 5,
      networkBytesPerHour: 10,
      globalBytesPerHour: 10,
    });
    expect((await reserve(app)).statusCode).toBe(503);
    expect(rows(dataDir)).toEqual([]);
    const small = await create(app, A, 1);
    expect((await upload(app, small, A, 1)).statusCode).toBe(200);
    expect((await download(app, small)).statusCode).toBe(200);
  });

  it.each([{ storageBytes: 10 }, { maxTransfers: 1 }])(
    "keeps pending capacity bounded and releases it on expiry: %j",
    async (limit) => {
      const { app, dataDir, advance } = await fixture({
        ...limit,
        networkBytesPerHour: 10,
        globalBytesPerHour: 10,
      });
      const expired = await create(app);
      expect((await reserve(app, B, 1)).statusCode).toBe(503);
      advance(30 * 60_000 + 1);
      expect((await upload(app, expired)).statusCode).toBe(404);
      await app.cleanupTransfers();
      await app.cleanupTransfers();
      expect(rows(dataDir)).toEqual([]);
      const next = await create(app);
      expect((await upload(app, next)).statusCode).toBe(200);
    },
  );

  it("charges an upload to its current network once, even when creation used another network", async () => {
    const { app } = await fixture({
      networkBytesPerHour: 10,
      globalBytesPerHour: 20,
    });
    const moved = await create(app, A);
    expect((await upload(app, moved, B)).statusCode).toBe(200);
    expect((await upload(app, moved, B)).statusCode).toBe(401);
    const same = await create(app, A);
    expect((await upload(app, same, A)).statusCode).toBe(200);
    const next = await create(app, C, 1);
    expect((await upload(app, next, C, 1)).statusCode).toBe(429);
  });

  it("keeps completed work charged after deletion and rejects without charging the other budget", async () => {
    const { app, dataDir, advance } = await fixture({
      networkBytesPerHour: 10,
      globalBytesPerHour: 20,
    });
    const first = await create(app);
    expect((await upload(app, first)).statusCode).toBe(200);
    expect((await remove(app, first)).statusCode).toBe(204);
    await app.cleanupTransfers();
    const retry = await create(app, A, 1);
    expect((await upload(app, retry, A, 1)).statusCode).toBe(429);
    expect(rows(dataDir)).toMatchObject([{ id: retry.id, state: "pending" }]);
    const other = await create(app, B);
    expect((await upload(app, other, B)).statusCode).toBe(200);
    expect((await download(app, other)).statusCode).toBe(429);
    expect(rows(dataDir).find((row) => row.id === other.id)?.attempts).toBe(0);
    advance(HOUR + 1);
    expect((await download(app, other)).statusCode).toBe(200);
  });

  it("keeps a byte-rejected upload pending and allows retry when the shared window ends", async () => {
    const { app, dataDir, advance } = await fixture({
      networkBytesPerHour: 10,
      globalBytesPerHour: 10,
    });
    const first = await create(app);
    expect((await upload(app, first)).statusCode).toBe(200);
    advance(HOUR - 10_000);
    const retry = await create(app, B);
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await upload(app, retry, B);
      expect(rejected.statusCode).toBe(429);
      expect(rejected.headers["retry-after"]).toBe("10");
    }
    expect(rows(dataDir).find((row) => row.id === retry.id)).toMatchObject({
      state: "pending",
      upload_hash: expect.any(String),
    });
    expect(
      (await readdir(dataDir)).some((name) => name.startsWith(retry.id)),
    ).toBe(false);
    advance(10_001);
    expect((await upload(app, retry, B)).statusCode).toBe(200);
    expect((await upload(app, retry, B)).statusCode).toBe(401);
  });

  it("checks capacity before opening files and permits only one concurrent upload", async () => {
    const { app, dataDir } = await fixture({ globalBytesPerHour: 10 });
    const first = await create(app);
    const second = await create(app, B);
    const open = vi.spyOn(TransferStore.prototype, "createPart");
    const results = await Promise.all([
      upload(app, first),
      upload(app, first),
      upload(app, second, B),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([
      200, 401, 429,
    ]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(rows(dataDir).find((row) => row.id === second.id)?.state).toBe(
      "pending",
    );
  });

  it.each(["claimUpload", "claimDownload"] as const)(
    "does not charge when %s rejects the state change",
    async (method) => {
      const { app } = await fixture({ globalBytesPerHour: 20 });
      const transfer = await create(app);
      if (method === "claimDownload")
        expect((await upload(app, transfer)).statusCode).toBe(200);
      vi.spyOn(TransferStore.prototype, method).mockReturnValueOnce(false);
      const attempt = () =>
        method === "claimUpload"
          ? upload(app, transfer)
          : download(app, transfer);
      expect((await attempt()).statusCode).toBe(404);
      expect((await attempt()).statusCode).toBe(200);
      if (method === "claimUpload")
        expect((await download(app, transfer)).statusCode).toBe(200);
    },
  );

  it.each(["length", "file", "publish"])(
    "keeps the full charge after an accepted upload fails: %s",
    async (failure) => {
      const { app, dataDir } = await fixture({ globalBytesPerHour: 10 });
      const transfer = await create(app);
      if (failure !== "length")
        vi.spyOn(
          TransferStore.prototype,
          failure === "file" ? "createPart" : "publish",
        ).mockRejectedValueOnce(new Error("Dummy write failure"));
      expect(
        (await upload(app, transfer, A, failure === "length" ? 4 : 10))
          .statusCode,
      ).toBe(failure === "length" ? 400 : 503);
      expect(rows(dataDir)).toEqual([]);
      expect((await upload(app, transfer)).statusCode).toBe(401);
      const next = await create(app, B, 1);
      expect((await upload(app, next, B, 1)).statusCode).toBe(429);
    },
  );

  it("charges uploads and downloads to the same global budget and separate network budgets", async () => {
    const { app, dataDir } = await fixture({
      networkBytesPerHour: 10,
      networkDownloadBytesPerHour: 10,
      globalBytesPerHour: 30,
    });
    const transfer = await create(app);
    expect((await upload(app, transfer)).statusCode).toBe(200);
    expect((await download(app, transfer, A)).statusCode).toBe(200);
    expect((await download(app, transfer, A)).statusCode).toBe(429);
    expect((await download(app, transfer, B)).statusCode).toBe(200);
    expect((await download(app, transfer, C)).statusCode).toBe(429);
    expect(rows(dataDir)).toMatchObject([{ attempts: 2 }]);
  });

  it("requires a fresh upload charge after restart and keeps persistent pending storage", async () => {
    const { app, start, dataDir } = await fixture({
      networkBytesPerHour: 10,
      globalBytesPerHour: 10,
      storageBytes: 20,
    });
    const ready = await create(app);
    expect((await upload(app, ready)).statusCode).toBe(200);
    const pending = await create(app);
    expect((await upload(app, pending)).statusCode).toBe(429);
    await app.close();
    const restarted = await start();
    expect((await reserve(restarted, B, 1)).statusCode).toBe(503);
    expect((await upload(restarted, pending)).statusCode).toBe(200);
    expect((await download(restarted, ready)).statusCode).toBe(429);
    expect(rows(dataDir).every((row) => row.state === "ready")).toBe(true);
    await restarted.close();
    const again = await start();
    expect((await download(again, ready)).statusCode).toBe(200);
    expect((await download(again, pending)).statusCode).toBe(429);
    expect(rows(dataDir).find((row) => row.id === ready.id)?.attempts).toBe(1);
  });
});

async function eventually(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The expected stream state was not reached.");
}

describe("partial transfer charges", () => {
  it.each(["delete", "disconnect", "expiry"])(
    "keeps the charge after a partial upload stops: %s",
    async (stop) => {
      const { app, dataDir, advance } = await fixture({
        globalBytesPerHour: 10,
      });
      const transfer = await create(app);
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const request = http.request(
        `${origin}/api/transfers/${transfer.id}/content`,
        {
          method: "PUT",
          headers: {
            origin: ORIGIN,
            authorization: `Bearer ${transfer.uploadToken}`,
            "content-type": "application/octet-stream",
            "transfer-encoding": "chunked",
          },
        },
      );
      const closed = new Promise<void>((resolve) => {
        request.on("error", () => {});
        request.once("close", resolve);
      });
      try {
        request.write(Buffer.alloc(4));
        await eventually(
          async () =>
            (
              await stat(path.join(dataDir, `${transfer.id}.part`)).catch(
                () => null,
              )
            )?.size === 4,
        );
        if (stop === "delete")
          expect((await remove(app, transfer)).statusCode).toBe(204);
        else if (stop === "expiry") {
          advance(30 * 60_000 + 1);
          await app.cleanupTransfers();
        } else request.destroy();
        await closed;
        await eventually(async () => rows(dataDir).length === 0);
        const next = await create(app, B, 1);
        expect((await upload(app, next, B, 1)).statusCode).toBe(429);
        expect((await upload(app, transfer)).statusCode).toBe(401);
      } finally {
        request.destroy();
      }
    },
  );

  it("keeps the full download charge when the client disconnects after four bytes", async () => {
    const { app, dataDir } = await fixture({ globalBytesPerHour: 20 });
    const transfer = await create(app);
    expect((await upload(app, transfer)).statusCode).toBe(200);
    const open = TransferStore.prototype.openContent;
    vi.spyOn(TransferStore.prototype, "openContent").mockImplementation(
      async function (this: TransferStore, row) {
        const file = await open.call(this, row);
        const read = file.createReadStream.bind(file);
        vi.spyOn(file, "createReadStream").mockImplementation(() => {
          const stream = read({ autoClose: true, highWaterMark: 4 });
          stream.once("data", () => stream.pause());
          return stream;
        });
        return file;
      },
    );
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      const request = http.get(
        `${origin}/api/transfers/${transfer.id}/content`,
        (response) => {
          response.on("error", () => {});
          response.once("data", (chunk: Buffer) => {
            expect(chunk.length).toBe(4);
            response.destroy();
            resolve();
          });
        },
      );
      request.on("error", reject);
    });
    expect((await download(app, transfer)).statusCode).toBe(429);
    expect(rows(dataDir)).toMatchObject([{ attempts: 1 }]);
    expect((await remove(app, transfer)).statusCode).toBe(204);
    const next = await create(app, B, 1);
    expect((await upload(app, next, B, 1)).statusCode).toBe(429);
  });
});

describe("byte counter bounds", () => {
  it("keeps charges across HMAC rotation and rejects before claim when memory is full", () => {
    let clock = 0;
    const rates = new RateCounters(() => clock, 2);
    const claim = vi.fn();
    clock = HOUR - 1;
    rates.admitTransfer(rates.identify(A), "upload", 10, 100, 10, claim);
    clock = HOUR + 1;
    expect(() =>
      rates.admitTransfer(rates.identify(A), "upload", 10, 100, 1, claim),
    ).toThrow();
    rates.admitTransfer(rates.identify(B), "download", 10, 100, 10, claim);
    expect(() =>
      rates.admitTransfer(rates.identify(C), "upload", 10, 100, 1, claim),
    ).toThrow();
    expect(claim).toHaveBeenCalledTimes(2);
    clock += HOUR + 1;
    rates.admitTransfer(rates.identify(C), "upload", 10, 100, 10, claim);
    expect(claim).toHaveBeenCalledTimes(3);
    rates.clear();
  });
});
