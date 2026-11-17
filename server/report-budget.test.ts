import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp, type AppOptions, type TransferApp } from "./app";
import { loadConfig } from "./config";
import { listReports, reviewReport } from "./review";
import type { CreatedTransfer } from "../lib/shared/types";

const ORIGIN = "https://reports.invalid";
const COMMENT = "Please review this dummy file for the report test.";
const UNKNOWN = "f".repeat(32);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const apps: TransferApp[] = [];
const dirs: string[] = [];

async function fixture(options: AppOptions = {}) {
  let clock = 1_800_000_000_000;
  const now = options.now ?? (() => clock);
  const dataDir =
    options.dataDir ?? (await mkdtemp(path.join(tmpdir(), "report-budget-")));
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const app = await createApp({
    env: {
      NODE_ENV: "production",
      PASSING_PUBLIC_ORIGIN: ORIGIN,
      PASSING_TRUST_PROXY: "none",
    },
    cleanupIntervalMs: 0,
    ...options,
    limits: {
      storageBytes: 1_024,
      headroomBytes: 0,
      reportsPerHour: 1,
      globalReportsPerHour: 1,
      ...options.limits,
    },
    dataDir,
    now,
  });
  apps.push(app);
  return {
    app,
    dataDir,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of dirs.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function create(app: TransferApp, ttlSeconds = 604_800) {
  const response = await app.inject({
    method: "POST",
    url: "/api/transfers",
    headers: { origin: ORIGIN },
    payload: { size: 0, encryptedSize: 64, ttlSeconds },
  });
  expect(response.statusCode).toBe(201);
  return response.json<CreatedTransfer>();
}

async function ready(app: TransferApp, ttlSeconds = 604_800) {
  const transfer = await create(app, ttlSeconds);
  const response = await app.inject({
    method: "PUT",
    url: `/api/transfers/${transfer.id}/content`,
    headers: {
      origin: ORIGIN,
      authorization: `Bearer ${transfer.uploadToken}`,
      "content-type": "application/octet-stream",
    },
    payload: Buffer.alloc(64),
  });
  expect(response.statusCode).toBe(200);
  return transfer;
}

function report(
  app: TransferApp,
  id: string,
  network: number,
  payload: string | Record<string, unknown> = { comment: COMMENT },
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/transfers/${id}/report`,
    remoteAddress: `192.0.2.${network}`,
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    payload,
  });
}

function metadata(app: TransferApp, id: string) {
  return app.inject(`/api/transfers/${id}`);
}

describe("report attempt and new-hold budgets", () => {
  it("keeps new-hold capacity after unknown IDs and malformed JSON", async () => {
    const { app, dataDir, now } = await fixture({
      limits: { globalReportsPerHour: 2 },
    });
    const first = await ready(app);
    const second = await ready(app);
    const unknown = await report(app, UNKNOWN, 1);
    expect(unknown.statusCode).toBe(202);
    expect((await report(app, first.id, 2, "{")).statusCode).toBe(400);
    expect(await listReports(dataDir, now())).toEqual([]);

    const accepted = await report(app, first.id, 3);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual(unknown.json());
    expect((await metadata(app, first.id)).statusCode).toBe(404);
    expect((await report(app, second.id, 4)).statusCode).toBe(202);
    expect(await listReports(dataDir, now())).toHaveLength(2);
  });

  it.each([
    {
      name: "invalid ID",
      id: "bad-id",
      payload: { comment: COMMENT },
      status: 404,
    },
    { name: "short comment", payload: { comment: "short" }, status: 400 },
    {
      name: "extra field",
      payload: { comment: COMMENT, extra: true },
      status: 400,
    },
    { name: "malformed JSON", payload: "{", status: 400 },
    {
      name: "large body",
      payload: { comment: "x".repeat(9_000) },
      status: 413,
    },
  ])(
    "charges $name only to attempt budgets",
    async ({ id, payload, status }) => {
      const { app, dataDir, now } = await fixture();
      const transfer = await ready(app);
      expect(
        (await report(app, id ?? transfer.id, 1, payload)).statusCode,
      ).toBe(status);
      expect((await report(app, transfer.id, 1)).statusCode).toBe(429);
      expect(await listReports(dataDir, now())).toEqual([]);
      expect((await metadata(app, transfer.id)).statusCode).toBe(200);
      expect((await report(app, transfer.id, 2)).statusCode).toBe(202);
      expect((await metadata(app, transfer.id)).statusCode).toBe(404);
    },
  );

  it("does not charge expired files or pending uploads past their deadline", async () => {
    const { app, dataDir, now, advance } = await fixture();
    const expired = await ready(app, 3_600);
    const pending = await create(app);
    advance(HOUR);
    expect((await report(app, expired.id, 1)).statusCode).toBe(202);
    expect((await report(app, pending.id, 2)).statusCode).toBe(202);
    expect(await listReports(dataDir, now())).toEqual([]);
    const live = await ready(app);
    expect((await report(app, live.id, 3)).statusCode).toBe(202);
    expect((await listReports(dataDir, now())).map((row) => row.id)).toEqual([
      live.id,
    ]);
  });

  it("bounds attempts before parsing and recovers after one minute", async () => {
    const { app, dataDir, now, advance } = await fixture({
      limits: { globalReportAttemptsPerMinute: 3 },
    });
    const transfer = await ready(app);
    expect((await report(app, UNKNOWN, 1)).statusCode).toBe(202);
    expect((await report(app, transfer.id, 2, "{")).statusCode).toBe(400);
    expect((await report(app, "invalid-id", 3)).statusCode).toBe(404);
    const denied = await report(app, transfer.id, 4);
    expect(denied.statusCode).toBe(429);
    expect(denied.headers["retry-after"]).toBe("60");
    expect(await listReports(dataDir, now())).toEqual([]);
    expect((await metadata(app, transfer.id)).statusCode).toBe(200);
    advance(MINUTE);
    expect((await report(app, transfer.id, 5)).statusCode).toBe(202);
    expect((await metadata(app, transfer.id)).statusCode).toBe(404);
  });

  it("does not spend shared attempt capacity on a network rejection", async () => {
    const { app } = await fixture({
      limits: { globalReportAttemptsPerMinute: 2 },
    });
    const transfer = await ready(app);
    expect((await report(app, UNKNOWN, 1)).statusCode).toBe(202);
    expect((await report(app, UNKNOWN, 1)).statusCode).toBe(429);
    expect((await report(app, transfer.id, 2)).statusCode).toBe(202);
  });

  it("checks Origin and content type before either report budget", async () => {
    const { app } = await fixture({
      limits: { globalReportAttemptsPerMinute: 1 },
    });
    const transfer = await ready(app);
    for (const origin of [undefined, "https://other.invalid"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/transfers/${transfer.id}/report`,
            remoteAddress: "192.0.2.1",
            headers: origin ? { origin } : {},
            payload: { comment: COMMENT },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await report(app, transfer.id, 1, "not JSON", {
          "content-type": "text/plain",
        })
      ).statusCode,
    ).toBe(415);
    expect((await report(app, transfer.id, 1)).statusCode).toBe(202);
  });

  it("counts concurrent duplicate reports once and keeps the first comment", async () => {
    const { app, dataDir, now } = await fixture({
      limits: { globalReportsPerHour: 2 },
    });
    const first = await ready(app);
    const second = await ready(app);
    const comments = [COMMENT, "Another comment for the same dummy file."];
    const responses = await Promise.all(
      comments.map((comment, index) =>
        report(app, first.id, index + 1, { comment }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([
      202, 202,
    ]);
    const original = await listReports(dataDir, now());
    expect(original).toHaveLength(1);
    expect(comments).toContain(original[0]!.comment);
    expect((await report(app, first.id, 3)).statusCode).toBe(202);
    expect(await listReports(dataDir, now())).toEqual(original);
    expect((await report(app, second.id, 4)).statusCode).toBe(202);
    expect(await listReports(dataDir, now())).toHaveLength(2);
    expect((await report(app, UNKNOWN, 5)).statusCode).toBe(429);
  });

  it("allows only one concurrent new hold when one slot remains", async () => {
    const { app, dataDir, now } = await fixture();
    const transfers = [await ready(app), await ready(app)];
    const responses = await Promise.all(
      transfers.map((transfer, index) => report(app, transfer.id, index + 1)),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      202, 429,
    ]);
    expect(await listReports(dataDir, now())).toHaveLength(1);
    for (const [index, transfer] of transfers.entries()) {
      expect((await metadata(app, transfer.id)).statusCode).toBe(
        responses[index]!.statusCode === 202 ? 404 : 200,
      );
    }
  });

  it("rejects all well-formed reports at hold capacity and recovers after one hour", async () => {
    const { app, dataDir, now, advance } = await fixture();
    const held = await ready(app);
    const next = await ready(app);
    // No-op attempts must not start the new-hold window.
    expect((await report(app, UNKNOWN, 1)).statusCode).toBe(202);
    advance(MINUTE);
    expect((await report(app, held.id, 2)).statusCode).toBe(202);
    const denied = await Promise.all(
      [held.id, UNKNOWN, next.id].map((id, index) =>
        report(app, id, index + 3),
      ),
    );
    for (const response of denied) {
      expect(response.statusCode).toBe(429);
      expect(response.headers["retry-after"]).toBe("3600");
      expect(response.json()).toEqual(denied[0]!.json());
    }
    expect((await metadata(app, held.id)).statusCode).toBe(404);
    expect((await metadata(app, next.id)).statusCode).toBe(200);
    advance(HOUR - 1);
    const stillFull = await report(app, next.id, 6);
    expect(stillFull.statusCode).toBe(429);
    expect(stillFull.headers["retry-after"]).toBe("1");
    advance(1);
    expect((await report(app, next.id, 7)).statusCode).toBe(202);
    expect((await metadata(app, held.id)).statusCode).toBe(404);
    expect((await metadata(app, next.id)).statusCode).toBe(404);
    expect(await listReports(dataDir, now())).toHaveLength(2);
  });

  it("does not spend hold capacity when SQLite rejects the insert", async () => {
    const { app, dataDir, now } = await fixture();
    const transfer = await ready(app);
    const db = new DatabaseSync(path.join(dataDir, "metadata.sqlite"));
    try {
      db.exec(`CREATE TRIGGER fail_report BEFORE INSERT ON reports BEGIN
        SELECT RAISE(ABORT, 'Test report write failure'); END;`);
      expect((await report(app, transfer.id, 1)).statusCode).toBe(503);
      expect(await listReports(dataDir, now())).toEqual([]);
      expect((await metadata(app, transfer.id)).statusCode).toBe(200);
      db.exec("DROP TRIGGER fail_report");
      expect((await report(app, transfer.id, 2)).statusCode).toBe(202);
      expect((await metadata(app, transfer.id)).statusCode).toBe(404);
    } finally {
      db.close();
    }
  });

  it("does not refund a saved hold on approval or release a newer hold", async () => {
    const { app, dataDir, now, advance } = await fixture();
    const transfer = await ready(app);
    expect((await report(app, transfer.id, 1)).statusCode).toBe(202);
    const original = (await listReports(dataDir, now()))[0]!;
    await reviewReport(
      dataDir,
      transfer.id,
      original.reportId,
      "approve",
      now(),
    );
    expect((await metadata(app, transfer.id)).statusCode).toBe(200);
    expect((await report(app, transfer.id, 2)).statusCode).toBe(429);
    advance(HOUR);
    expect((await report(app, transfer.id, 3)).statusCode).toBe(202);
    const current = (await listReports(dataDir, now()))[0]!;
    expect(current.reportId).not.toBe(original.reportId);
    await expect(
      reviewReport(dataDir, transfer.id, original.reportId, "approve", now()),
    ).rejects.toThrow("no longer open");
    expect((await metadata(app, transfer.id)).statusCode).toBe(404);
  });

  it("keeps saved holds after restart without charging them again", async () => {
    const first = await fixture();
    const held = await ready(first.app);
    const next = await ready(first.app);
    expect((await report(first.app, held.id, 1)).statusCode).toBe(202);
    const original = (await listReports(first.dataDir, first.now()))[0]!;
    await first.app.close();
    const { app, dataDir, now } = await fixture({
      dataDir: first.dataDir,
      now: first.now,
    });
    expect((await metadata(app, held.id)).statusCode).toBe(404);
    expect((await report(app, held.id, 1)).statusCode).toBe(202);
    expect(await listReports(dataDir, now())).toEqual([original]);
    expect((await report(app, next.id, 2)).statusCode).toBe(202);
    expect(await listReports(dataDir, now())).toHaveLength(2);
  });

  it("loads a separate positive integer limit for shared report attempts", () => {
    expect(loadConfig({}).limits.globalReportAttemptsPerMinute).toBe(100);
    expect(
      loadConfig({ PASSING_GLOBAL_REPORT_ATTEMPTS_PER_MINUTE: "2" }).limits
        .globalReportAttemptsPerMinute,
    ).toBe(2);
    for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"]) {
      expect(() =>
        loadConfig({ PASSING_GLOBAL_REPORT_ATTEMPTS_PER_MINUTE: value }),
      ).toThrow("PASSING_GLOBAL_REPORT_ATTEMPTS_PER_MINUTE");
    }
  });
});
