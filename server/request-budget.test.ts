import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type AppOptions, type TransferApp } from "./app";

const MINUTE = 60_000;
const A = "192.0.2.1";
const B = "198.51.100.2";
const C = "203.0.113.3";
const LONG_URL = `/api/transfers/${"a".repeat(81)}`;
const INVALID_URL = "/api/transfers/%zz";
const apps: TransferApp[] = [];
const dirs: string[] = [];

async function fixture(limits: AppOptions["limits"] = {}) {
  let clock = 1_800_000_000_000;
  const dataDir = await mkdtemp(path.join(tmpdir(), "passing-requests-"));
  dirs.push(dataDir);
  const app = await createApp({
    dataDir,
    now: () => clock,
    cleanupIntervalMs: 0,
    env: {
      NODE_ENV: "production",
      PASSING_PUBLIC_ORIGIN: "https://requests.invalid",
      PASSING_TRUST_PROXY: "none",
    },
    limits: {
      storageBytes: 1_000_000,
      headroomBytes: 0,
      requestsPerMinute: 2,
      globalRequestsPerMinute: 4,
      ...limits,
    },
  });
  apps.push(app);
  return {
    app,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function get(app: TransferApp, remoteAddress: string, url = "/api/health") {
  return app.inject({ method: "GET", url, remoteAddress });
}

function expectLimited(response: Awaited<ReturnType<typeof get>>) {
  expect(response.statusCode).toBe(429);
  expect(response.json()).toEqual({
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Try again later.",
    },
  });
  expect(response.headers["retry-after"]).toBe("60");
  expect(response.headers["cache-control"]).toContain("no-store");
}

describe.each([
  { name: "normal requests", url: "/api/health", status: 200 },
  { name: "long router parameters", url: LONG_URL, status: 414 },
  { name: "invalid URL encoding", url: INVALID_URL, status: 400 },
])("request budgets for $name", ({ url, status }) => {
  it("leaves the shared allowance for other networks after network rejections", async () => {
    const { app } = await fixture();
    for (let i = 0; i < 2; i++)
      expect((await get(app, A, url)).statusCode).toBe(status);
    for (let i = 0; i < 2; i++) expectLimited(await get(app, A, url));

    for (let i = 0; i < 2; i++)
      expect((await get(app, B)).statusCode).toBe(200);
    expectLimited(await get(app, C));
  });

  it("caps admitted requests across networks and restores both expired windows", async () => {
    const { app, advance } = await fixture();
    for (const address of [A, B])
      for (let i = 0; i < 2; i++)
        expect((await get(app, address, url)).statusCode).toBe(status);
    expectLimited(await get(app, C, url));

    advance(MINUTE - 1);
    expect((await get(app, A, url)).statusCode).toBe(429);
    expect((await get(app, C, url)).statusCode).toBe(429);
    advance(2);

    for (const address of [A, B])
      for (let i = 0; i < 2; i++)
        expect((await get(app, address, url)).statusCode).toBe(status);
    expectLimited(await get(app, C, url));
  });

  it("keeps identity storage bounded without spending the shared allowance on rejected identities", async () => {
    const { app, advance } = await fixture({
      maxRateEntries: 1,
      requestsPerMinute: 3,
      globalRequestsPerMinute: 3,
    });
    expect((await get(app, A, url)).statusCode).toBe(status);
    expectLimited(await get(app, B, url));
    expectLimited(await get(app, C, url));
    for (let i = 0; i < 2; i++)
      expect((await get(app, A)).statusCode).toBe(200);
    expectLimited(await get(app, A));

    advance(MINUTE + 1);
    expect((await get(app, B, url)).statusCode).toBe(status);
    expectLimited(await get(app, C, url));
  });

  it("keeps the network charge when the shared allowance is full", async () => {
    const { app, advance } = await fixture({ globalRequestsPerMinute: 2 });
    expect((await get(app, A)).statusCode).toBe(200);
    expect((await get(app, B)).statusCode).toBe(200);
    advance(MINUTE / 2);
    expect((await get(app, C, url)).statusCode).toBe(429);
    advance(MINUTE / 2 + 1);

    expect((await get(app, C, url)).statusCode).toBe(status);
    expect((await get(app, C, url)).statusCode).toBe(429);
    expect((await get(app, A)).statusCode).toBe(200);
    expectLimited(await get(app, B));
  });
});

describe("request admission controls", () => {
  it("shares request counters between normal and framework error paths", async () => {
    const { app } = await fixture();
    expect((await get(app, A)).statusCode).toBe(200);
    expect((await get(app, A, LONG_URL)).statusCode).toBe(414);
    expectLimited(await get(app, A, INVALID_URL));
    expect((await get(app, B)).statusCode).toBe(200);
    expect((await get(app, B, INVALID_URL)).statusCode).toBe(400);
    expectLimited(await get(app, C));
  });

  it.each([
    { name: "network", maxRequests: 2, blocked: A },
    { name: "shared", maxRequests: 1, blocked: B },
  ])(
    "preserves the $name concurrency limit and releases completed requests",
    async ({ maxRequests, blocked }) => {
      const { app } = await fixture({
        maxRequests,
        requestsPerNetwork: 1,
        requestsPerMinute: 10,
        globalRequestsPerMinute: 20,
      });
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      app.get("/held", async () => {
        enter();
        await released;
        return { ok: true };
      });
      const pending = get(app, A, "/held").then((response) => response);
      try {
        await entered;
        expectLimited(await get(app, blocked));
        if (maxRequests > 1) expect((await get(app, B)).statusCode).toBe(200);
      } finally {
        release();
        expect((await pending).statusCode).toBe(200);
      }
      expect((await get(app, A)).statusCode).toBe(200);
      expect((await get(app, B)).statusCode).toBe(200);
    },
  );
});
