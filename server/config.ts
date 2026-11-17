import { isIP } from "node:net";
import { createHash } from "node:crypto";
import ipaddr from "ipaddr.js";

export interface Limits {
  storageBytes: number;
  headroomBytes: number;
  maxTransfers: number;
  maxStreams: number;
  maxUploads: number;
  maxDownloads: number;
  uploadsPerNetwork: number;
  downloadsPerNetwork: number;
  downloadsPerTransfer: number;
  downloadAttempts: number;
  sessionsPerMinute: number;
  requestsPerMinute: number;
  globalRequestsPerMinute: number;
  reportsPerHour: number;
  globalReportAttemptsPerMinute: number;
  globalReportsPerHour: number;
  networkBytesPerHour: number;
  networkDownloadBytesPerHour: number;
  globalBytesPerHour: number;
  maxRateEntries: number;
  maxRequests: number;
  requestsPerNetwork: number;
  streamTimeoutMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  origin: string;
  production: boolean;
  adminKeyHash: string | null;
  trustProxy: false | string[];
  limits: Limits;
}

export type ServerEnv = Record<string, string | undefined>;
function integer(env: ServerEnv, name: string, fallback: number, min = 1) {
  const value = env[name];
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min
  )
    throw new Error(`Invalid configuration: ${name}`);
  return Number(value);
}

export function loadConfig(env: ServerEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === "production";
  const adminKey = env.PASSING_ADMIN_KEY;
  if (adminKey && !/^[a-f0-9]{64}$/.test(adminKey))
    throw new Error("Invalid configuration: PASSING_ADMIN_KEY");
  const origin = env.PASSING_PUBLIC_ORIGIN ?? "http://localhost:3000";
  try {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !["https:", "http:"].includes(url.protocol) ||
      (production && url.protocol !== "https:")
    )
      throw new Error();
  } catch {
    throw new Error("Invalid configuration: PASSING_PUBLIC_ORIGIN");
  }
  if (production && (!env.PASSING_PUBLIC_ORIGIN || !env.PASSING_TRUST_PROXY))
    throw new Error(
      "Production requires PASSING_PUBLIC_ORIGIN and PASSING_TRUST_PROXY",
    );
  const proxy = env.PASSING_TRUST_PROXY ?? "none";
  let trustProxy: false | string[] = false;
  if (proxy !== "none") {
    trustProxy = proxy.split(",").map((part) => part.trim());
    if (
      !trustProxy.length ||
      trustProxy.some((part) => {
        try {
          return part.includes("/")
            ? ipaddr.parseCIDR(part)[1] === 0
            : !isIP(part);
        } catch {
          return true;
        }
      })
    )
      throw new Error("Invalid configuration: PASSING_TRUST_PROXY");
  }
  const port = integer(env, "PASSING_API_PORT", 4000);
  if (port > 65535) throw new Error("Invalid configuration: PASSING_API_PORT");
  const limits: Limits = {
    storageBytes: integer(env, "PASSING_STORAGE_BYTES", 10_000_000_000),
    headroomBytes: integer(env, "PASSING_DISK_HEADROOM_BYTES", 512_000_000, 0),
    maxTransfers: integer(env, "PASSING_MAX_TRANSFERS", 10_000),
    maxStreams: integer(env, "PASSING_MAX_STREAMS", 32),
    maxUploads: integer(env, "PASSING_MAX_UPLOADS", 8),
    maxDownloads: integer(env, "PASSING_MAX_DOWNLOADS", 24),
    uploadsPerNetwork: 2,
    downloadsPerNetwork: 4,
    downloadsPerTransfer: 2,
    downloadAttempts: integer(env, "PASSING_DOWNLOAD_ATTEMPTS", 10),
    sessionsPerMinute: 5,
    requestsPerMinute: 120,
    globalRequestsPerMinute: 3_000,
    reportsPerHour: integer(env, "PASSING_REPORTS_PER_HOUR", 3),
    globalReportAttemptsPerMinute: integer(
      env,
      "PASSING_GLOBAL_REPORT_ATTEMPTS_PER_MINUTE",
      100,
    ),
    globalReportsPerHour: integer(env, "PASSING_GLOBAL_REPORTS_PER_HOUR", 100),
    networkBytesPerHour: 1_000_000_000,
    networkDownloadBytesPerHour: 2_000_000_000,
    globalBytesPerHour: integer(
      env,
      "PASSING_GLOBAL_BYTES_PER_HOUR",
      100_000_000_000,
    ),
    maxRateEntries: 20_000,
    maxRequests: 256,
    requestsPerNetwork: 16,
    streamTimeoutMs: integer(env, "PASSING_STREAM_TIMEOUT_MS", 300_000),
  };
  return {
    host: env.PASSING_API_HOST ?? "127.0.0.1",
    port,
    dataDir: env.PASSING_DATA_DIR ?? "./data",
    origin,
    production,
    adminKeyHash: adminKey
      ? createHash("sha256").update(adminKey).digest("hex")
      : null,
    trustProxy,
    limits,
  };
}
