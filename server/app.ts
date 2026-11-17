import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import {
  MAX_ENCRYPTED_BYTES,
  MAX_ENCRYPTION_OVERHEAD,
  MAX_FILE_BYTES,
  TOKEN_PATTERN,
  TRANSFER_ID_PATTERN,
  TTL_OPTIONS,
} from "../lib/shared/constants";
import { loadConfig, type Limits, type ServerEnv } from "./config";
import { ApiFailure, limited, missing, unavailable } from "./errors";
import { RateCounters, type Network } from "./rates";
import { hashToken, metadata, tokenMatches, TransferStore } from "./store";
import { reportCommentError } from "../lib/shared/reports";
import { registerAdmin } from "./admin";

export interface AppOptions {
  /** Environment source. Defaults to process.env. */
  env?: ServerEnv;
  /** Private storage path. Tests should use a new temporary directory. */
  dataDir?: string;
  /** Millisecond clock. Does not replace real stream deadline timers. */
  now?: () => number;
  /** Resource limits. Intended for small test budgets. */
  limits?: Partial<Limits>;
  /** Cleanup interval. Defaults to one minute. Zero disables the timer in tests. */
  cleanupIntervalMs?: number;
}
export type TransferApp = FastifyInstance & {
  cleanupTransfers: () => Promise<void>;
};
type Active = {
  kind: "upload" | "download";
  network: string;
  abort: () => void;
  setDeadline: (deadline: number) => void;
  done: Promise<void>;
};
const MINUTE = 60_000;
const HOUR = 3_600_000;
const PENDING_MS = 30 * MINUTE;
const bad = () =>
  new ApiFailure(400, "INVALID_REQUEST", "The request is not valid.");
const unauthorized = () =>
  new ApiFailure(401, "UNAUTHORIZED", "Authorization is required.");
const tooLarge = () =>
  new ApiFailure(413, "TOO_LARGE", "The upload is too large.");
function bearer(request: FastifyRequest) {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer "))
    return undefined;
  const token = value.slice(7);
  return TOKEN_PATTERN.test(token) ? token : undefined;
}
function idOf(request: FastifyRequest) {
  const id = (request.params as { id: string }).id;
  if (!TRANSFER_ID_PATTERN.test(id)) throw missing();
  return id;
}

export async function createApp(
  options: AppOptions = {},
): Promise<TransferApp> {
  const config = loadConfig(options.env);
  const limits = { ...config.limits, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) ||
      value < (key === "headroomBytes" ? 0 : 1)
    )
      throw new Error("Invalid resource limit");
  }
  const now = options.now ?? Date.now;
  const store = await TransferStore.create(
    options.dataDir ?? config.dataDir,
    limits,
  );
  const rates = new RateCounters(now, limits.maxRateEntries);
  const active = new Map<string, Set<Active>>();
  const deleting = new Map<string, Promise<void>>();
  const requestNetworks = new WeakMap<FastifyRequest, Network>();
  const requests = new Map<string, number>();
  let requestCount = 0;
  let closing = false;
  let cleanupJob: Promise<void> | undefined;

  function register(
    id: string,
    kind: Active["kind"],
    network: Network,
    deadline: number,
    stop: () => void,
  ) {
    const all = [...active.values()].flatMap((set) => [...set]);
    const sameKind = all.filter((item) => item.kind === kind);
    const perNetwork = sameKind.filter((item) =>
      network.ids.includes(item.network),
    ).length;
    if (
      all.length >= limits.maxStreams ||
      sameKind.length >=
        (kind === "upload" ? limits.maxUploads : limits.maxDownloads) ||
      perNetwork >=
        (kind === "upload"
          ? limits.uploadsPerNetwork
          : limits.downloadsPerNetwork) ||
      (kind === "download" &&
        (active.get(id)?.size ?? 0) >= limits.downloadsPerTransfer)
    )
      throw limited();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // An expiry change must not restart the maximum stream duration.
    const streamDeadline = now() + limits.streamTimeoutMs;
    let timer: ReturnType<typeof setTimeout>;
    const setDeadline = (expires: number) => {
      clearTimeout(timer);
      timer = setTimeout(
        stop,
        Math.max(1, Math.min(expires, streamDeadline) - now()),
      );
      timer.unref();
    };
    const item: Active = {
      kind,
      network: network.current,
      abort: stop,
      setDeadline,
      done,
    };
    let set = active.get(id);
    if (!set) {
      set = new Set();
      active.set(id, set);
    }
    set.add(item);
    setDeadline(deadline);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      set.delete(item);
      if (!set.size) active.delete(id);
      finish();
    };
  }

  async function retire(id: string) {
    store.deny(id); // Deny access before any asynchronous deletion work.
    const existing = deleting.get(id);
    if (existing) return existing;
    const job = (async () => {
      const streams = [...(active.get(id) ?? [])];
      for (const item of streams) item.abort();
      await Promise.all(streams.map((item) => item.done));
      await store.removeFiles(id); // A failed delete keeps its storage reservation.
      store.forget(id);
    })();
    deleting.set(id, job);
    try {
      await job;
    } finally {
      deleting.delete(id);
    }
  }

  async function cleanup(restart = false) {
    if (cleanupJob) return cleanupJob;
    cleanupJob = (async () => {
      rates.sweep();
      let failed = false;
      for (const snapshot of store.all()) {
        // Another request can change expiry while cleanup awaits a deletion.
        const row = store.get(snapshot.id);
        if (!row) continue;
        if (
          row.state === "deleting" ||
          (restart && row.state === "uploading") ||
          (row.state !== "ready" && row.upload_expires <= now()) ||
          (row.state === "ready" && row.expires! <= now())
        ) {
          try {
            await retire(row.id);
          } catch {
            failed = true;
          }
        } else if (restart && row.state === "ready") {
          try {
            const file = await store.openContent(row);
            await file.close();
          } catch {
            try {
              await retire(row.id);
            } catch {
              failed = true;
            }
          }
        }
      }
      // On restart there are no active handles. Remove leftover unpublished files.
      if (restart) await store.removeOrphans();
      if (failed) throw unavailable();
    })();
    try {
      await cleanupJob;
    } finally {
      cleanupJob = undefined;
    }
  }

  try {
    await cleanup(true);
  } catch (error) {
    store.close();
    throw error;
  }
  const app = Fastify({
    logger: false,
    genReqId: () => "",
    requestIdHeader: false,
    trustProxy: config.trustProxy,
    bodyLimit: 1024,
    requestTimeout: limits.streamTimeoutMs,
    connectionTimeout: 30_000,
    keepAliveTimeout: 5_000,
    forceCloseConnections: true,
    return503OnClosing: true,
    exposeHeadRoutes: false,
    maxRequestsPerSocket: 100,
    routerOptions: { maxParamLength: 80 },
    frameworkErrors: (error, request, reply) => {
      reply.header("Cache-Control", "no-store, max-age=0");
      try {
        const network = rates.identify(request.ip);
        // Reject this network before spending the shared request allowance.
        rates.consume(network, "requests", limits.requestsPerMinute, MINUTE);
        rates.consumeGlobal("requests", limits.globalRequestsPerMinute, MINUTE);
      } catch {
        reply.raw.writeHead(429, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Retry-After": "60",
        });
        reply.raw.end(
          JSON.stringify({
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests. Try again later.",
            },
          }),
        );
        return;
      }
      reply.raw.writeHead(
        error.code === "FST_ERR_MAX_PARAM_LENGTH" ? 414 : 400,
        { "Content-Type": "application/json", "Cache-Control": "no-store" },
      );
      reply.raw.end(
        JSON.stringify({
          error: {
            code: "INVALID_REQUEST",
            message: "The request is not valid.",
          },
        }),
      );
    },
  });
  app.server.maxConnections = limits.maxRequests * 2;
  app.server.headersTimeout = 10_000;
  app.decorate("cleanupTransfers", () => cleanup());
  // Returning the raw stream prevents Fastify from buffering opaque uploads.
  app.addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => done(null, payload),
  );

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store, max-age=0");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (closing) throw unavailable();
    const network = rates.identify(request.ip);
    requestNetworks.set(request, network);
    // Reject this network before spending the shared request allowance.
    rates.consume(network, "requests", limits.requestsPerMinute, MINUTE);
    rates.consumeGlobal("requests", limits.globalRequestsPerMinute, MINUTE);
    const networkCount = network.ids.reduce(
      (sum, id) => sum + (requests.get(id) ?? 0),
      0,
    );
    if (
      requestCount >= limits.maxRequests ||
      networkCount >= limits.requestsPerNetwork
    )
      throw limited();
    requestCount++;
    requests.set(network.current, (requests.get(network.current) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      requestCount--;
      const count = (requests.get(network.current) ?? 1) - 1;
      if (count) requests.set(network.current, count);
      else requests.delete(network.current);
    };
    reply.raw.once("close", release);
    reply.raw.once("finish", release);
    const hasBody =
      request.headers["transfer-encoding"] !== undefined ||
      Number(request.headers["content-length"] ?? 0) > 0;
    if (hasBody && !["POST", "PUT"].includes(request.method)) {
      reply.header("Connection", "close");
      throw bad();
    }
    if (
      request.method === "POST" &&
      request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
    ) {
      reply.header("Connection", "close");
      throw new ApiFailure(
        415,
        "CONTENT_TYPE",
        "Use the required content type.",
      );
    }
    if (["POST", "PUT", "DELETE"].includes(request.method)) {
      const origin = request.headers.origin;
      const contentType = request.headers["content-type"]
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      const required =
        request.method === "POST"
          ? "application/json"
          : "application/octet-stream";
      if (origin !== undefined && origin !== config.origin)
        throw new ApiFailure(
          403,
          "ORIGIN_REJECTED",
          "The request origin is not allowed.",
        );
      if (
        origin === undefined &&
        ((request.method === "POST" && config.production) ||
          (request.method !== "POST" &&
            (!bearer(request) || contentType !== required)))
      )
        throw new ApiFailure(
          403,
          "ORIGIN_REJECTED",
          "The request origin is not allowed.",
        );
      if (request.headers["sec-fetch-site"] === "cross-site")
        throw new ApiFailure(
          403,
          "ORIGIN_REJECTED",
          "The request origin is not allowed.",
        );
    }
    if (
      request.method === "POST" &&
      request.routeOptions.url === "/api/transfers/:id/report"
    ) {
      // Bound parsing and store work separately from new-hold capacity.
      // Repeats, unknown ids, and bad JSON still spend attempt budgets.
      rates.consume(network, "reports", limits.reportsPerHour, HOUR);
      rates.consumeGlobal(
        "report-attempts",
        limits.globalReportAttemptsPerMinute,
        MINUTE,
      );
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (reply.raw.destroyed || reply.sent) return;
    if (request.method === "PUT" || !request.raw.complete)
      reply.header("Connection", "close");
    if (error instanceof ApiFailure) {
      if (error.status === 429 && error.code !== "DOWNLOAD_LIMIT")
        reply.header("Retry-After", String(error.retryAfter ?? 60));
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The request is not valid.",
        },
      });
    return reply.code(503).send({
      error: {
        code: "UNAVAILABLE",
        message: "The service is not available.",
      },
    });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: { code: "NOT_FOUND", message: "The resource is not available." },
    }),
  );

  registerAdmin(app, {
    config,
    store,
    rates,
    network: (request) => requestNetworks.get(request)!,
    now,
    retire,
  });

  app.get("/api/health", async () => {
    store.healthy();
    await store.storageHealthy();
    return { ok: true };
  });
  app.post("/api/transfers", async (request, reply) => {
    if (
      request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      throw new ApiFailure(
        415,
        "CONTENT_TYPE",
        "Use the required content type.",
      );
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "encryptedSize,size,ttlSeconds"
    )
      throw bad();
    const { size, encryptedSize, ttlSeconds } = body;
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_FILE_BYTES ||
      typeof encryptedSize !== "number" ||
      !Number.isSafeInteger(encryptedSize) ||
      encryptedSize <= size ||
      encryptedSize > MAX_ENCRYPTED_BYTES ||
      encryptedSize - size > MAX_ENCRYPTION_OVERHEAD ||
      !TTL_OPTIONS.some((ttl) => ttl.seconds === ttlSeconds)
    )
      throw bad();
    const network = requestNetworks.get(request)!;
    rates.consume(network, "sessions", limits.sessionsPerMinute, MINUTE);
    // Pending sessions reserve storage only. Charge bytes when a PUT is accepted.
    const id = randomBytes(16).toString("hex");
    const uploadToken = randomBytes(32).toString("base64url");
    const deleteToken = randomBytes(32).toString("base64url");
    const uploadExpires = now() + PENDING_MS;
    await store.reserve({
      id,
      size,
      encrypted_size: encryptedSize,
      ttl: ttlSeconds as number,
      upload_hash: hashToken(uploadToken),
      delete_hash: hashToken(deleteToken),
      upload_expires: uploadExpires,
      expires: null,
      state: "pending",
      attempts: 0,
    });
    return reply.code(201).send({
      id,
      uploadToken,
      deleteToken,
      uploadExpiresAt: new Date(uploadExpires).toISOString(),
    });
  });
  app.get("/api/transfers/:id", async (request) => {
    const row = store.get(idOf(request));
    if (
      !row ||
      row.state !== "ready" ||
      row.expires! <= now() ||
      store.reported(row.id)
    )
      throw missing();
    return metadata(row);
  });

  app.post("/api/transfers/:id/expiry", async (request) => {
    const id = idOf(request);
    const row = store.get(id);
    if (!tokenMatches(bearer(request), row?.delete_hash ?? null))
      throw unauthorized();
    const body = request.body as Record<string, unknown> | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).join(",") !== "ttlSeconds" ||
      !TTL_OPTIONS.some((ttl) => ttl.seconds === body.ttlSeconds)
    )
      throw bad();
    const updated = store.updateExpiry(id, body.ttlSeconds as number, now());
    if (!updated) throw missing();
    for (const stream of active.get(id) ?? [])
      stream.setDeadline(updated.expires!);
    return metadata(updated);
  });

  app.post(
    "/api/transfers/:id/report",
    { bodyLimit: 8_192 },
    async (request, reply) => {
      const id = idOf(request);
      const body = request.body as { comment?: unknown } | null;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).join(",") !== "comment" ||
        typeof body.comment !== "string" ||
        reportCommentError(body.comment)
      )
        throw bad();
      if (store.report(id, body.comment.trim(), now())) {
        const streams = [...(active.get(id) ?? [])];
        for (const item of streams) item.abort();
        await Promise.all(streams.map((item) => item.done));
      }
      // Do not reveal whether an id exists or has already been reported.
      return reply.code(202).send({ accepted: true });
    },
  );

  app.put("/api/transfers/:id/content", async (request) => {
    const id = idOf(request);
    const row = store.get(id);
    if (!tokenMatches(bearer(request), row?.upload_hash ?? null))
      throw unauthorized();
    if (
      !row ||
      row.state !== "pending" ||
      row.upload_expires <= now() ||
      store.reported(id)
    )
      throw missing();
    const network = requestNetworks.get(request)!;
    const controller = new AbortController();
    const payload = request.body as Readable;
    payload?.on?.("error", () => {});
    const finish = register(id, "upload", network, row.upload_expires, () => {
      controller.abort();
      payload?.destroy(new Error("Transfer stopped."));
    });
    let file: Awaited<ReturnType<TransferStore["createPart"]>> | undefined;
    let claimed = false;
    let published = false;
    try {
      rates.admitTransfer(
        network,
        "upload",
        limits.networkBytesPerHour,
        limits.globalBytesPerHour,
        row.encrypted_size,
        () => {
          if (!store.claimUpload(id, now())) throw missing();
          claimed = true;
        },
      );
      if (
        request.headers["content-type"]?.trim().toLowerCase() !==
          "application/octet-stream" ||
        !payload?.iterator
      )
        throw new ApiFailure(
          415,
          "CONTENT_TYPE",
          "Use the required content type.",
        );
      if (
        request.headers["content-encoding"] !== undefined ||
        request.headers.range !== undefined
      )
        throw bad();
      const length = request.headers["content-length"];
      if (
        length !== undefined &&
        (!/^\d+$/.test(length) || Number(length) !== row.encrypted_size)
      )
        throw Number(length) > row.encrypted_size ? tooLarge() : bad();
      file = await store.createPart(id);
      if (controller.signal.aborted) throw bad();
      let received = 0;
      // Do not destroy the socket on a byte-limit error: send a generic 413 and
      // close it after the response. Never drain an unbounded rejected body.
      for await (const value of payload.iterator({ destroyOnReturn: false })) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        received += chunk.length;
        if (received > MAX_ENCRYPTED_BYTES || received > row.encrypted_size)
          throw tooLarge();
        if (controller.signal.aborted || row.upload_expires <= now())
          throw missing();
        let offset = 0;
        while (offset < chunk.length) {
          const result = await file.write(chunk, offset, chunk.length - offset);
          if (!result.bytesWritten) throw unavailable();
          offset += result.bytesWritten;
        }
      }
      if (received !== row.encrypted_size) throw bad();
      await file.sync();
      await file.close();
      file = undefined;
      if (
        controller.signal.aborted ||
        row.upload_expires <= now() ||
        store.get(id)?.state !== "uploading" ||
        store.reported(id)
      )
        throw missing();
      await store.publish(id);
      const completedAt = now();
      if (
        controller.signal.aborted ||
        !store.complete(id, completedAt + row.ttl * 1000, completedAt)
      )
        throw missing();
      published = true;
      return metadata(store.get(id)!);
    } finally {
      let closeFailed = false;
      try {
        await file?.close();
      } catch {
        closeFailed = true;
      } finally {
        finish();
      }
      if (claimed && !published) {
        try {
          await retire(id);
        } catch {
          /* Keep denied row for the next cleanup. */
        }
      }
      if (closeFailed) throw unavailable();
    }
  });

  app.get("/api/transfers/:id/content", async (request, reply) => {
    if (
      request.headers.range !== undefined ||
      request.headers["if-range"] !== undefined
    )
      throw new ApiFailure(
        416,
        "RANGE_UNSUPPORTED",
        "Range requests are not supported.",
      );
    const id = idOf(request);
    const row = store.get(id);
    if (
      !row ||
      row.state !== "ready" ||
      row.expires! <= now() ||
      store.reported(id)
    )
      throw missing();
    if (row.attempts >= limits.downloadAttempts)
      throw new ApiFailure(
        429,
        "DOWNLOAD_LIMIT",
        "No download attempts remain. Ask the sender for a new link.",
      );
    const controller = new AbortController();
    let stream: Readable | undefined;
    const finish = register(
      id,
      "download",
      requestNetworks.get(request)!,
      row.expires!,
      () => {
        controller.abort();
        stream?.destroy(new Error("Transfer stopped."));
        reply.raw.destroy();
      },
    );
    let file: Awaited<ReturnType<TransferStore["openContent"]>> | undefined;
    try {
      const network = requestNetworks.get(request)!;
      rates.admitTransfer(
        network,
        "download",
        limits.networkDownloadBytesPerHour,
        limits.globalBytesPerHour,
        row.encrypted_size,
        () => {
          if (!store.claimDownload(id, now())) throw missing();
        },
      );
      file = await store.openContent(row);
      const latest = store.get(id);
      if (
        controller.signal.aborted ||
        latest?.state !== "ready" ||
        latest.expires! <= now() ||
        store.reported(id)
      )
        throw missing();
      stream = file.createReadStream({ autoClose: true });
      file = undefined;
      let fileClosed = false;
      let responseDone = false;
      const settled = () => {
        if (fileClosed && responseDone) finish();
      };
      stream.once("close", () => {
        fileClosed = true;
        settled();
      });
      reply.raw.once("finish", () => {
        responseDone = true;
        settled();
      });
      reply.raw.once("close", () => {
        responseDone = true;
        stream?.destroy();
        settled();
      });
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Length", row.encrypted_size);
      reply.header(
        "Content-Disposition",
        'attachment; filename="encrypted.bin"',
      );
      reply.header("Accept-Ranges", "none");
      return reply.send(stream);
    } catch (error) {
      try {
        await file?.close();
      } finally {
        finish();
      }
      throw error;
    }
  });

  app.delete("/api/transfers/:id", async (request, reply) => {
    const id = idOf(request);
    const row = store.get(id);
    if (!tokenMatches(bearer(request), row?.delete_hash ?? null))
      throw unauthorized();
    await retire(id);
    return reply.code(204).send();
  });

  const intervalMs = options.cleanupIntervalMs ?? MINUTE;
  const timer =
    intervalMs > 0
      ? setInterval(() => {
          void cleanup().catch(() => {});
        }, intervalMs)
      : undefined;
  timer?.unref();
  // preClose cancels streams before Fastify waits for open connections.
  app.addHook("preClose", async () => {
    closing = true;
    if (timer) clearInterval(timer);
    const streams = [...active.values()].flatMap((set) => [...set]);
    streams.forEach((item) => item.abort());
    await Promise.all(streams.map((item) => item.done));
    await cleanupJob?.catch(() => {});
    await Promise.allSettled([...deleting.values()]);
  });
  app.addHook("onClose", async () => {
    rates.clear();
    store.close();
  });
  return app as unknown as TransferApp;
}
