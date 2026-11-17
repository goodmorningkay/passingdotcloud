import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type TransferApp } from "./app";
import type { AdminSession } from "../lib/shared/admin";

const KEY = "a".repeat(64); // Synthetic test keys only.
const WRONG_KEY = "b".repeat(64);
const ORIGIN = "https://admin-test.invalid";
const WINDOW_MS = 15 * 60_000;
const OWNER = "198.51.100.1";
const apps: TransferApp[] = [];
const dirs: string[] = [];

async function fixture() {
  let clock = 1_800_000_000_000;
  const dataDir = await mkdtemp(path.join(tmpdir(), "passing-admin-budget-"));
  dirs.push(dataDir);
  const app = await createApp({
    env: {
      NODE_ENV: "production",
      PASSING_ADMIN_KEY: KEY,
      PASSING_PUBLIC_ORIGIN: ORIGIN,
      PASSING_TRUST_PROXY: "none",
    },
    dataDir,
    now: () => clock,
    cleanupIntervalMs: 0,
    limits: {
      storageBytes: 1_000_000,
      headroomBytes: 0,
      maxTransfers: 4,
      maxRateEntries: 128,
    },
  });
  apps.push(app);
  return {
    app,
    advance(ms: number) {
      clock += ms;
    },
  };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function login(
  app: TransferApp,
  remoteAddress: string,
  payload: object | string = { key: KEY },
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/admin/login",
    remoteAddress,
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    payload,
  });
}

function sessionHeaders(response: Awaited<ReturnType<typeof login>>) {
  expect(response.statusCode).toBe(200);
  return {
    origin: ORIGIN,
    cookie: String(response.headers["set-cookie"]).split(";")[0]!,
  };
}

describe("admin login budgets", () => {
  it("allows the correct key from another network after 50 wrong keys", async () => {
    const { app } = await fixture();
    for (let network = 1; network <= 10; network++) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await login(app, `192.0.2.${network}`, {
          key: WRONG_KEY,
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.body).not.toContain(WRONG_KEY);
      }
    }

    const limited = await login(app, "192.0.2.1");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("900");
    const headers = sessionHeaders(await login(app, OWNER));
    expect(headers.cookie).toMatch(/^__Host-passing_admin=[A-Za-z0-9_-]{43}$/);
    expect(
      (await app.inject({ url: "/api/admin/session", headers })).statusCode,
    ).toBe(200);
  });

  it("charges malformed bodies only to their network login allowance", async () => {
    const { app } = await fixture();
    const invalid = [
      { payload: "{", status: 400 },
      { payload: "{}", status: 401 },
      { payload: { key: "short" }, status: 401 },
      { payload: { key: KEY, extra: true }, status: 401 },
      { payload: { key: "b".repeat(1025) }, status: 413 },
    ];
    for (let network = 1; network <= 10; network++) {
      for (const { payload, status } of invalid) {
        const response = await login(app, `192.0.2.${network}`, payload);
        expect(response.statusCode).toBe(status);
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(response.body).not.toContain(KEY);
      }
    }
    const limited = await login(app, "192.0.2.1");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("900");
    expect((await login(app, OWNER)).statusCode).toBe(200);
  });

  it("counts correct and wrong keys per network and recovers at the window end", async () => {
    const { app, advance } = await fixture();
    for (const key of [WRONG_KEY, KEY, WRONG_KEY, KEY, WRONG_KEY]) {
      const response = await login(app, OWNER, { key });
      expect(response.statusCode).toBe(key === KEY ? 200 : 401);
    }
    const limited = await login(
      app,
      OWNER,
      { key: KEY },
      {
        "x-forwarded-for": "192.0.2.99",
      },
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("900");
    expect(limited.headers["set-cookie"]).toBeUndefined();
    expect((await login(app, "203.0.113.1")).statusCode).toBe(200);

    advance(WINDOW_MS - 1);
    const waiting = await login(app, OWNER);
    expect(waiting.statusCode).toBe(429);
    expect(waiting.headers["retry-after"]).toBe("1");
    advance(1);
    expect((await login(app, OWNER)).statusCode).toBe(200);
  });

  it("keeps the IPv6 /64 attempt limit", async () => {
    const { app } = await fixture();
    for (let host = 1; host <= 5; host++)
      expect(
        (await login(app, `2001:db8:1::${host}`, { key: WRONG_KEY }))
          .statusCode,
      ).toBe(401);
    expect((await login(app, "2001:db8:1::6")).statusCode).toBe(429);
    expect((await login(app, "2001:db8:2::1")).statusCode).toBe(200);
  });

  it("keeps an existing session after distributed wrong keys", async () => {
    const { app } = await fixture();
    const signedIn = await login(app, OWNER);
    const headers = sessionHeaders(signedIn);
    for (let attempt = 0; attempt < 49; attempt++)
      expect(
        (
          await login(app, `192.0.2.${1 + Math.floor(attempt / 5)}`, {
            key: WRONG_KEY,
          })
        ).statusCode,
      ).toBe(401);

    const session = await app.inject({ url: "/api/admin/session", headers });
    expect(session.statusCode).toBe(200);
    expect(session.json<AdminSession>()).toEqual(signedIn.json<AdminSession>());
    expect((await login(app, "203.0.113.1")).statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/admin/session", headers })).statusCode,
    ).toBe(200);
  });

  it("starts the shared window at a correct key and preserves sessions at its limit", async () => {
    const { app, advance } = await fixture();
    expect((await login(app, OWNER, { key: WRONG_KEY })).statusCode).toBe(401);
    advance(60_000);

    // Use ten dummy networks to reach the successful-login limit.
    for (let attempt = 0; attempt < 49; attempt++)
      expect(
        (await login(app, `192.0.2.${1 + Math.floor(attempt / 5)}`)).statusCode,
      ).toBe(200);
    const signedIn = await login(app, "192.0.2.10");
    const headers = sessionHeaders(signedIn);
    const limited = await login(app, OWNER, { key: KEY }, headers);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("900");
    expect(limited.headers["set-cookie"]).toBeUndefined();
    expect((await login(app, OWNER, { key: WRONG_KEY })).statusCode).toBe(401);
    expect((await login(app, OWNER, "{")).statusCode).toBe(400);
    const session = await app.inject({ url: "/api/admin/session", headers });
    expect(session.statusCode).toBe(200);
    expect(session.json<AdminSession>()).toEqual(signedIn.json<AdminSession>());

    // The earlier wrong key must not start or shorten the shared window.
    advance(WINDOW_MS - 60_000);
    const waiting = await login(app, "203.0.113.1");
    expect(waiting.statusCode).toBe(429);
    expect(waiting.headers["retry-after"]).toBe("60");
    advance(60_000);
    expect((await login(app, "203.0.113.1")).statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/admin/session", headers })).statusCode,
    ).toBe(200);
  });
});
