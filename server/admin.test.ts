import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createApp, type AppOptions, type TransferApp } from "./app";
import { loadConfig } from "./config";
import { TransferStore } from "./store";
import { listReports, reviewReport } from "./review";
import type { AdminFiles, AdminSession } from "../lib/shared/admin";
import type { CreatedTransfer } from "../lib/shared/types";

const KEY = "a".repeat(64); // Synthetic test key only.
const ORIGIN = "http://localhost:3000";
const apps: TransferApp[] = [];
const dirs: string[] = [];
async function fixture(options: AppOptions = {}) {
  const dataDir =
    options.dataDir ?? (await mkdtemp(path.join(tmpdir(), "passing-admin-")));
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const app = await createApp({
    env: { PASSING_ADMIN_KEY: KEY },
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
async function signIn(
  app: TransferApp,
  origin = ORIGIN,
  remoteAddress?: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    remoteAddress,
    headers: { origin },
    payload: { key: KEY },
  });
  expect(response.statusCode).toBe(200);
  const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  return {
    cookie,
    origin,
    "x-admin-csrf": response.json<AdminSession>().csrfToken,
  };
}
async function create(app: TransferApp, ready = true) {
  const response = await app.inject({
    method: "POST",
    url: "/api/transfers",
    headers: { origin: ORIGIN },
    payload: { size: 3, encryptedSize: 64, ttlSeconds: 3600 },
  });
  expect(response.statusCode).toBe(201);
  const transfer = response.json<CreatedTransfer>();
  if (ready)
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/transfers/${transfer.id}/content`,
          headers: {
            authorization: `Bearer ${transfer.uploadToken}`,
            "content-type": "application/octet-stream",
          },
          payload: Buffer.alloc(64),
        })
      ).statusCode,
    ).toBe(200);
  return transfer;
}
async function report(app: TransferApp, id: string) {
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/transfers/${id}/report`,
        headers: { origin: ORIGIN },
        payload: { comment: "Please review this reported test file." },
      })
    ).statusCode,
  ).toBe(202);
}
async function files(
  app: TransferApp,
  headers: Record<string, string>,
  query = "",
) {
  const response = await app.inject({
    url: `/api/admin/files${query}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json<AdminFiles>();
}

describe("admin access", () => {
  it("is disabled by default and rejects malformed server keys", async () => {
    const { app } = await fixture({ env: {} });
    for (const url of ["/api/admin/session", "/api/admin/files"])
      expect((await app.inject(url)).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/login",
          headers: { origin: ORIGIN },
          payload: { key: KEY },
        })
      ).statusCode,
    ).toBe(404);
    for (const value of [
      "password",
      "a".repeat(63),
      "z".repeat(64),
      "a".repeat(65),
    ])
      expect(() => loadConfig({ PASSING_ADMIN_KEY: value })).toThrow(
        "PASSING_ADMIN_KEY",
      );
    expect(loadConfig({ PASSING_ADMIN_KEY: "" }).adminKeyHash).toBeNull();
    expect(loadConfig({ PASSING_ADMIN_KEY: KEY }).adminKeyHash).not.toBe(KEY);
  });

  it("requires a session for every data and action endpoint", async () => {
    const { app } = await fixture();
    const transfer = await create(app);
    const headers = {
      origin: ORIGIN,
      authorization: `Bearer ${transfer.deleteToken}`,
    };
    for (const url of ["/api/admin/session", "/api/admin/files"])
      expect((await app.inject({ url, headers })).statusCode).toBe(401);
    for (const url of [
      "/api/admin/logout",
      `/api/admin/files/${transfer.id}/delete`,
      `/api/admin/files/${transfer.id}/review`,
    ])
      expect(
        (await app.inject({ method: "POST", url, headers, payload: {} }))
          .statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/admin/files",
          headers: { cookie: `passing_admin=${"x".repeat(43)}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      200,
    );
  });

  it("requires exact origin at login and sets a private production cookie", async () => {
    const origin = "https://passing.example";
    const { app } = await fixture({
      env: {
        NODE_ENV: "production",
        PASSING_ADMIN_KEY: KEY,
        PASSING_PUBLIC_ORIGIN: origin,
        PASSING_TRUST_PROXY: "none",
      },
    });
    for (const headers of [
      {},
      { origin: "https://attacker.example" },
      { origin, "sec-fetch-site": "same-site" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/login",
            headers,
            payload: { key: KEY },
          })
        ).statusCode,
      ).toBe(403);
    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { origin },
      payload: { key: KEY },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]);
    expect(cookie).toMatch(/^__Host-passing_admin=[A-Za-z0-9_-]{43};/);
    for (const part of [
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Secure",
      "Max-Age=3600",
    ])
      expect(cookie).toContain(part);
    expect(cookie).not.toContain("Domain=");
    expect(login.body).not.toContain(KEY);
    expect(login.headers["cache-control"]).toContain("no-store");
    expect(login.headers["x-robots-tag"]).toContain("noindex");
  });

  it("evicts the oldest session when the session limit is reached", async () => {
    const { app } = await fixture();
    const first = await signIn(app, ORIGIN, "192.0.2.1");
    for (let i = 2; i <= 17; i++) await signIn(app, ORIGIN, `192.0.2.${i}`);
    expect(
      (await app.inject({ url: "/api/admin/session", headers: first }))
        .statusCode,
    ).toBe(401);
  });

  it("rejects missing or incorrect request tokens and cross-origin changes", async () => {
    const { app } = await fixture();
    const headers = await signIn(app);
    const second = await signIn(app);
    const transfer = await create(app);
    for (const invalidHeaders of [
      { cookie: headers.cookie, origin: ORIGIN },
      { ...headers, "x-admin-csrf": "x".repeat(43) },
      { ...headers, "x-admin-csrf": second["x-admin-csrf"] },
      { cookie: headers.cookie, "x-admin-csrf": headers["x-admin-csrf"] },
      { ...headers, origin: "https://attacker.example" },
      { ...headers, "sec-fetch-site": "cross-site" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/admin/files/${transfer.id}/delete`,
            headers: invalidHeaders,
            payload: { confirmation: transfer.id },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          url: "/api/admin/files",
          headers: {
            ...headers,
            cookie: `${headers.cookie}; ${headers.cookie}`,
          },
        })
      ).statusCode,
    ).toBe(401);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      200,
    );
  });

  it("ends sessions on logout, expiry, replacement login, and API restart", async () => {
    let clock = Date.now();
    const { app, dataDir } = await fixture({ now: () => clock });
    const headers = await signIn(app);
    const logout = await app.inject({
      method: "POST",
      url: "/api/admin/logout",
      headers,
      payload: {},
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    expect(
      (await app.inject({ url: "/api/admin/files", headers })).statusCode,
    ).toBe(401);
    const old = await signIn(app);
    const replacement = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: old,
      payload: { key: KEY },
    });
    expect(replacement.statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/admin/session", headers: old }))
        .statusCode,
    ).toBe(401);
    const expired = await signIn(app);
    clock += 3_600_001;
    expect(
      (await app.inject({ url: "/api/admin/session", headers: expired }))
        .statusCode,
    ).toBe(401);
    const beforeRestart = await signIn(app);
    await app.close();
    const { app: restarted } = await fixture({ dataDir, now: () => clock });
    expect(
      (
        await restarted.inject({
          url: "/api/admin/session",
          headers: beforeRestart,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("admin file management", () => {
  it("lists only safe fields with bounded pages, ID search, and status filters", async () => {
    const { app } = await fixture({ limits: { sessionsPerMinute: 100 } });
    const headers = await signIn(app);
    const ready = await create(app);
    const held = await create(app);
    await report(app, held.id);
    for (let i = 0; i < 26; i++) await create(app, false);
    const first = await files(app, headers);
    expect(first.total).toBe(28);
    expect(first.items).toHaveLength(25);
    expect(first.summary).toEqual({
      files: 28,
      reservedBytes: 28 * 64,
      storageLimitBytes: 10_000_000_000,
      openReports: 1,
      downloadLimit: 10,
    });
    const second = await files(app, headers, "?page=2");
    expect(second.items).toHaveLength(3);
    expect(
      new Set([...first.items, ...second.items].map((row) => row.id)).size,
    ).toBe(28);
    const available = await files(app, headers, "?status=ready");
    expect(available.items.map((row) => row.id)).toEqual([ready.id]);
    expect(Object.keys(available.items[0]!).sort()).toEqual([
      "attempts",
      "encryptedSize",
      "expiresAt",
      "id",
      "report",
      "size",
      "state",
      "status",
    ]);
    const searched = await files(
      app,
      headers,
      `?query=${held.id.slice(0, 12)}&page=99`,
    );
    expect(searched.page).toBe(1);
    expect(searched.items[0]?.report?.comment).toBe(
      "Please review this reported test file.",
    );
    expect(JSON.stringify(searched)).not.toMatch(
      /upload_hash|delete_hash|deleteToken|uploadToken/,
    );
    for (const query of [
      "?page=0",
      "?page=1.5",
      "?page=9999999",
      "?query=%25",
      "?query=%27",
      "?status=invalid",
      "?extra=x",
      "?page=1&page=2",
    ])
      expect(
        (await app.inject({ url: `/api/admin/files${query}`, headers }))
          .statusCode,
      ).toBe(400);
  });

  it("uses the current report ID and keeps expiry and download limits on approval", async () => {
    const { app, dataDir } = await fixture();
    const headers = await signIn(app);
    const transfer = await create(app);
    const metadata = (await app.inject(`/api/transfers/${transfer.id}`)).json();
    await app.inject(`/api/transfers/${transfer.id}/content`);
    await report(app, transfer.id);
    const old = (await files(app, headers, "?status=reported")).items[0]!
      .report!;
    const url = `/api/admin/files/${transfer.id}/review`;
    const payload = {
      confirmation: transfer.id,
      reportId: old.id,
      decision: "approve",
    };
    // A local owner command can resolve the report while the page is open.
    await reviewReport(dataDir, transfer.id, old.id, "approve");
    await report(app, transfer.id);
    for (const decision of ["approve", "delete"])
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers,
            payload: { ...payload, decision },
          })
        ).statusCode,
      ).toBe(409);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      404,
    );
    const current = (await files(app, headers, "?status=reported")).items[0]!;
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: { ...payload, reportId: current.report!.id },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(`/api/transfers/${transfer.id}`)).json()).toEqual(
      metadata,
    );
    expect((await files(app, headers)).items[0]?.attempts).toBe(1);
    expect(await listReports(dataDir)).toEqual([]);
  });

  it("does not restore expired files or expose expired report comments", async () => {
    let clock = Date.now();
    const { app } = await fixture({ now: () => clock });
    const transfer = await create(app);
    await report(app, transfer.id);
    const headers = await signIn(app);
    const reportId = (await files(app, headers)).items[0]!.report!.id;
    clock += 3_600_001;
    const current = await signIn(app);
    const expired = await files(app, current, "?status=expired");
    expect(expired.items[0]?.report).toBeNull();
    expect(expired.summary.openReports).toBe(0);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/files/${transfer.id}/review`,
          headers: current,
          payload: { confirmation: transfer.id, reportId, decision: "approve" },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("requires an exact confirmation and retains failed deletions until cleanup succeeds", async () => {
    const { app, dataDir } = await fixture();
    const headers = await signIn(app);
    const transfer = await create(app);
    const url = `/api/admin/files/${transfer.id}/delete`;
    for (const payload of [
      {},
      { confirmation: "b".repeat(32) },
      { confirmation: transfer.id, extra: true },
    ])
      expect(
        (await app.inject({ method: "POST", url, headers, payload }))
          .statusCode,
      ).toBe(400);
    vi.spyOn(TransferStore.prototype, "removeFiles").mockRejectedValueOnce(
      new Error("synthetic disk failure"),
    );
    const result = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { confirmation: transfer.id },
    });
    expect(result.statusCode).toBe(202);
    expect(result.json()).toEqual({ deleted: false });
    expect((await app.inject(`/api/transfers/${transfer.id}`)).statusCode).toBe(
      404,
    );
    const pending = await files(app, headers, "?status=deleting");
    expect(pending.items[0]?.id).toBe(transfer.id);
    expect(pending.summary.reservedBytes).toBe(64);
    await app.cleanupTransfers();
    expect((await files(app, headers)).summary.reservedBytes).toBe(0);
    expect(
      (await readdir(dataDir)).some((name) => name.startsWith(transfer.id)),
    ).toBe(false);
  });

  it("deletes a reported file and removes its comment", async () => {
    const { app, dataDir } = await fixture();
    const headers = await signIn(app);
    const transfer = await create(app);
    await report(app, transfer.id);
    const reportId = (await files(app, headers)).items[0]!.report!.id;
    const result = await app.inject({
      method: "POST",
      url: `/api/admin/files/${transfer.id}/review`,
      headers,
      payload: { confirmation: transfer.id, reportId, decision: "delete" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ deleted: true });
    expect(await listReports(dataDir)).toEqual([]);
    expect((await files(app, headers)).items).toEqual([]);
  });

  it("stops an active upload before it removes the file", async () => {
    const { app, dataDir } = await fixture();
    const headers = await signIn(app);
    const transfer = await create(app, false);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = http.request(
      `${origin}/api/transfers/${transfer.id}/content`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${transfer.uploadToken}`,
          "content-type": "application/octet-stream",
          "transfer-encoding": "chunked",
        },
      },
    );
    const stopped = new Promise<void>((resolve) => {
      request.once("error", () => resolve());
      request.once("close", () => resolve());
    });
    try {
      request.write(Buffer.alloc(20));
      await vi.waitFor(async () =>
        expect(await readdir(dataDir)).toContain(`${transfer.id}.part`),
      );
      const result = await app.inject({
        method: "POST",
        url: `/api/admin/files/${transfer.id}/delete`,
        headers,
        payload: { confirmation: transfer.id },
      });
      expect(result.statusCode).toBe(200);
      await stopped;
      expect(
        (await readdir(dataDir)).some((name) => name.startsWith(transfer.id)),
      ).toBe(false);
      expect((await files(app, headers)).items).toEqual([]);
    } finally {
      request.destroy();
    }
  });
});
