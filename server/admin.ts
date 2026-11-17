import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ADMIN_STATUSES, type AdminSession } from "../lib/shared/admin";
import { TOKEN_PATTERN, TRANSFER_ID_PATTERN } from "../lib/shared/constants";
import type { ServerConfig } from "./config";
import { ApiFailure, missing } from "./errors";
import type { Network, RateCounters } from "./rates";
import { ReviewError } from "./review";
import { hashToken, type TransferStore } from "./store";

const SESSION_MS = 60 * 60_000;
const MAX_SESSIONS = 16;
const invalid = () =>
  new ApiFailure(400, "INVALID_REQUEST", "The request is not valid.");
const unauthorized = () =>
  new ApiFailure(401, "ADMIN_UNAUTHORIZED", "Sign in with the admin key.");
const forbidden = () =>
  new ApiFailure(403, "ADMIN_FORBIDDEN", "The admin request is not allowed.");

const loginBody = z
  .object({ key: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const listQuery = z
  .object({
    query: z
      .string()
      .regex(/^[a-f0-9]{0,32}$/)
      .default(""),
    status: z.enum(ADMIN_STATUSES).default("all"),
    page: z
      .string()
      .regex(/^[1-9][0-9]{0,5}$/)
      .default("1"),
  })
  .strict();
const deleteBody = z
  .object({
    confirmation: z.string().regex(TRANSFER_ID_PATTERN),
  })
  .strict();
const reviewBody = deleteBody
  .extend({
    reportId: z.string().regex(TRANSFER_ID_PATTERN),
    decision: z.enum(["approve", "delete"]),
  })
  .strict();

function sameSecret(actual: string, expectedHash: string) {
  return timingSafeEqual(
    Buffer.from(hashToken(actual), "hex"),
    Buffer.from(expectedHash, "hex"),
  );
}

export function registerAdmin(
  app: FastifyInstance,
  options: {
    config: ServerConfig;
    store: TransferStore;
    rates: RateCounters;
    network: (request: FastifyRequest) => Network;
    now: () => number;
    retire: (id: string) => Promise<void>;
  },
) {
  const { config, store, rates, network, now, retire } = options;
  const sessions = new Map<string, AdminSession>();
  const requestSessions = new WeakMap<FastifyRequest, AdminSession>();
  const cookieName = config.production
    ? "__Host-passing_admin"
    : "passing_admin";
  const cookie = (token: string, maxAge = SESSION_MS / 1000) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.production ? "; Secure" : ""}`;

  function sessionHash(request: FastifyRequest) {
    // Reject duplicate cookies instead of choosing between ambiguous values.
    const values = (request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`));
    if (values.length !== 1) return undefined;
    const token = values[0]!.slice(cookieName.length + 1);
    return TOKEN_PATTERN.test(token) ? hashToken(token) : undefined;
  }

  function sweep() {
    for (const [hash, session] of sessions)
      if (session.expiresAt <= now()) sessions.delete(hash);
  }

  async function deleteFile(id: string) {
    // A database failure must not be reported as a queued disk deletion.
    store.deny(id);
    try {
      await retire(id);
      return { deleted: true };
    } catch {
      // retire already stopped access and streams. Cleanup retries disk work.
      return { deleted: false };
    }
  }

  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (request, reply) => {
        reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
        reply.header("Vary", "Cookie");
        if (!config.adminKeyHash)
          throw new ApiFailure(
            404,
            "ADMIN_DISABLED",
            "Admin access is not enabled.",
          );
        sweep();
        const changing = request.method !== "GET";
        const origin = request.headers.origin;
        const site = request.headers["sec-fetch-site"];
        if (
          (changing && origin !== config.origin) ||
          (origin !== undefined && origin !== config.origin) ||
          (site !== undefined && site !== "same-origin")
        )
          throw forbidden();

        if (
          request.routeOptions.url === "/api/admin/login" &&
          request.method === "POST"
        ) {
          // Charge malformed and unsuccessful attempts too. IP grouping and
          // rotating network identifiers are shared with the transfer API.
          rates.consume(network(request), "admin-login", 5, 15 * 60_000);
          return;
        }
        const hash = sessionHash(request);
        const session = hash ? sessions.get(hash) : undefined;
        if (!session) {
          reply.header("Set-Cookie", cookie("", 0));
          throw unauthorized();
        }
        if (changing) {
          const csrf = request.headers["x-admin-csrf"];
          if (
            typeof csrf !== "string" ||
            !TOKEN_PATTERN.test(csrf) ||
            !sameSecret(csrf, hashToken(session.csrfToken))
          )
            throw forbidden();
        }
        requestSessions.set(request, session);
      });

      admin.post("/login", async (request, reply) => {
        const result = loginBody.safeParse(request.body);
        // Do not echo submitted keys or parser details in errors.
        if (
          !result.success ||
          !sameSecret(result.data.key, config.adminKeyHash!)
        )
          throw unauthorized();
        // Only a verified key can use the shared session creation allowance.
        // Check it before replacing or removing an existing session.
        rates.consumeGlobal("admin-login", 50, 15 * 60_000);
        const old = sessionHash(request);
        if (old) sessions.delete(old);
        if (sessions.size >= MAX_SESSIONS)
          sessions.delete(sessions.keys().next().value!);
        const token = randomBytes(32).toString("base64url");
        const session = {
          csrfToken: randomBytes(32).toString("base64url"),
          expiresAt: now() + SESSION_MS,
        };
        sessions.set(hashToken(token), session);
        reply.header("Set-Cookie", cookie(token));
        return session;
      });
      admin.get("/session", async (request) => requestSessions.get(request)!);
      admin.post("/logout", async (request, reply) => {
        if (!z.object({}).strict().safeParse(request.body).success)
          throw invalid();
        sessions.delete(sessionHash(request)!);
        reply.header("Set-Cookie", cookie("", 0));
        return reply.code(204).send();
      });
      admin.get("/files", async (request) => {
        const result = listQuery.safeParse(request.query);
        if (!result.success) throw invalid();
        return store.adminFiles(
          result.data.query,
          result.data.status,
          Number(result.data.page),
          now(),
        );
      });
      admin.post("/files/:id/delete", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        const result = deleteBody.safeParse(request.body);
        if (
          !TRANSFER_ID_PATTERN.test(id) ||
          !result.success ||
          result.data.confirmation !== id
        )
          throw invalid();
        if (!store.get(id)) throw missing();
        const outcome = await deleteFile(id);
        return reply.code(outcome.deleted ? 200 : 202).send(outcome);
      });
      admin.post("/files/:id/review", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        const result = reviewBody.safeParse(request.body);
        if (
          !TRANSFER_ID_PATTERN.test(id) ||
          !result.success ||
          result.data.confirmation !== id
        )
          throw invalid();
        try {
          store.reviewReport(
            id,
            result.data.reportId,
            result.data.decision,
            now(),
          );
        } catch (error) {
          if (error instanceof ReviewError)
            throw new ApiFailure(
              409,
              "REPORT_CHANGED",
              "This report is no longer open. Refresh the list.",
            );
          throw error;
        }
        if (result.data.decision === "approve") return { approved: true };
        const outcome = await deleteFile(id);
        return reply.code(outcome.deleted ? 200 : 202).send(outcome);
      });
      admin.addHook("onClose", async () => sessions.clear());
    },
    { prefix: "/api/admin" },
  );
}
