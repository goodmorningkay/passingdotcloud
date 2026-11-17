import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  rm,
  statfs,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { TRANSFER_ID_PATTERN, TOKEN_PATTERN } from "../lib/shared/constants";
import type { TransferMetadata } from "../lib/shared/types";
import type { AdminFile, AdminFiles, AdminStatus } from "../lib/shared/admin";
import type { Limits } from "./config";
import { ApiFailure, limited, unavailable } from "./errors";
import { applyReportDecision } from "./review";

export type Transfer = {
  id: string;
  size: number;
  encrypted_size: number;
  ttl: number;
  upload_hash: string | null;
  delete_hash: string;
  upload_expires: number;
  expires: number | null;
  state: "pending" | "uploading" | "ready" | "deleting";
  attempts: number;
};
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function tokenMatches(token: string | undefined, hash: string | null) {
  // Hash even an absent capability. Never compare the bearer string to DB text.
  const actual = Buffer.from(hashToken(token ?? ""), "hex");
  const expected = Buffer.from(hash ?? "0".repeat(64), "hex");
  return (
    timingSafeEqual(actual, expected) &&
    !!token &&
    TOKEN_PATTERN.test(token) &&
    !!hash
  );
}
export const metadata = (row: Transfer): TransferMetadata => ({
  id: row.id,
  size: row.size,
  encryptedSize: row.encrypted_size,
  expiresAt: new Date(row.expires!).toISOString(),
});

export class TransferStore {
  private readyRevision = 0;
  private reportBudget: { count: number; until: number } | undefined;
  private constructor(
    public root: string,
    private db: DatabaseSync,
    private limits: Limits,
    private ownership: DatabaseSync,
  ) {}

  static async create(directory: string, limits: Limits) {
    const absolute = path.resolve(directory);
    const assertPrivatePath = (target: string) => {
      for (const publicRoot of [
        path.resolve("public"),
        path.resolve(".next/static"),
      ]) {
        const relative = path.relative(publicRoot, target);
        if (
          !relative ||
          (!relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative))
        )
          throw unavailable();
      }
    };
    assertPrivatePath(absolute);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(absolute);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      throw unavailable();
    const root = await realpath(absolute);
    assertPrivatePath(root);
    await chmod(root, 0o700);
    const dbPath = path.join(root, "metadata.sqlite");
    const ownerPath = path.join(root, "owner.sqlite");
    for (const file of [
      dbPath,
      ownerPath,
      `${dbPath}-journal`,
      `${ownerPath}-journal`,
    ]) {
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw unavailable();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // The OS releases this separate SQLite lock after a crash, including on
    // Windows. A second process must not clean up the first process's streams.
    const ownership = new DatabaseSync(ownerPath);
    try {
      ownership.exec(
        "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (guard INTEGER); BEGIN EXCLUSIVE; SELECT * FROM owner;",
      );
      await chmod(ownerPath, 0o600);
    } catch (error) {
      ownership.close();
      throw error;
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath);
    } catch (error) {
      ownership.close();
      throw error;
    }
    try {
      await chmod(dbPath, 0o600);
      db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS transfers (
          id TEXT PRIMARY KEY, size INTEGER NOT NULL, encrypted_size INTEGER NOT NULL,
          ttl INTEGER NOT NULL, upload_hash TEXT, delete_hash TEXT NOT NULL,
          upload_expires INTEGER NOT NULL, expires INTEGER, state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS reports (
          transfer_id TEXT PRIMARY KEY REFERENCES transfers(id) ON DELETE CASCADE,
          report_id TEXT NOT NULL UNIQUE,
          comment TEXT NOT NULL CHECK(length(comment) BETWEEN 1 AND 1000),
          reported_at INTEGER NOT NULL
        );`);
      return new TransferStore(root, db, limits, ownership);
    } catch (error) {
      db.close();
      ownership.close();
      throw error;
    }
  }

  file(id: string, suffix: "part" | "bin") {
    if (!TRANSFER_ID_PATTERN.test(id)) throw unavailable();
    const target = path.resolve(this.root, `${id}.${suffix}`);
    if (path.dirname(target) !== this.root) throw unavailable();
    return target;
  }

  get(id: string) {
    return this.db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as
      Transfer | undefined;
  }
  all() {
    return this.db.prepare("SELECT * FROM transfers").all() as Transfer[];
  }
  reported(id: string) {
    return !!this.db
      .prepare("SELECT 1 FROM reports WHERE transfer_id=?")
      .get(id);
  }
  adminFiles(
    query: string,
    status: AdminStatus,
    page: number,
    now: number,
  ): AdminFiles {
    const pageSize = 25;
    // Select safe fields explicitly. Capability hashes never cross this API.
    const source = `WITH files AS (
      SELECT t.id, t.size, t.encrypted_size AS encryptedSize, t.state, t.attempts,
        COALESCE(t.expires,t.upload_expires) AS deadline,
        CASE WHEN t.state='deleting' THEN 'deleting'
          WHEN COALESCE(t.expires,t.upload_expires)<=? THEN 'expired'
          WHEN r.report_id IS NOT NULL THEN 'reported'
          ELSE t.state END AS status,
        r.report_id AS reportId, r.comment, r.reported_at AS reportedAt
      FROM transfers t LEFT JOIN reports r ON r.transfer_id=t.id
    )`;
    const where = "WHERE id LIKE ? AND (?='all' OR status=?)";
    const parameters = [now, `${query}%`, status, status];
    this.db.exec("BEGIN");
    try {
      const { total } = this.db
        .prepare(`${source} SELECT COUNT(*) AS total FROM files ${where}`)
        .get(...parameters) as { total: number };
      // Clamp after deletion so the last page cannot remain empty by accident.
      const currentPage = Math.min(
        page,
        Math.max(1, Math.ceil(total / pageSize)),
      );
      const rows = this.db
        .prepare(
          `${source} SELECT * FROM files ${where}
        ORDER BY deadline, id LIMIT ? OFFSET ?`,
        )
        .all(
          ...parameters,
          pageSize,
          (currentPage - 1) * pageSize,
        ) as unknown as Array<
        Omit<AdminFile, "expiresAt" | "report"> & {
          deadline: number;
          reportId: string | null;
          comment: string | null;
          reportedAt: number | null;
        }
      >;
      const usage = this.usage();
      const { count: openReports } = this.db
        .prepare(
          `${source}
        SELECT COUNT(*) AS count FROM files WHERE status='reported'`,
        )
        .get(now) as { count: number };
      this.db.exec("COMMIT");
      return {
        items: rows.map((row) => ({
          id: row.id,
          size: row.size,
          encryptedSize: row.encryptedSize,
          state: row.state,
          status: row.status,
          attempts: row.attempts,
          expiresAt: new Date(row.deadline).toISOString(),
          // Expired or deleting records do not expose closed report comments.
          report:
            row.status === "reported" && row.reportId
              ? {
                  id: row.reportId,
                  comment: row.comment!,
                  reportedAt: new Date(row.reportedAt!).toISOString(),
                }
              : null,
        })),
        page: currentPage,
        pageSize,
        total,
        summary: {
          files: usage.count,
          reservedBytes: usage.bytes,
          storageLimitBytes: this.limits.storageBytes,
          openReports,
          downloadLimit: this.limits.downloadAttempts,
        },
      };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  reviewReport(
    id: string,
    reportId: string,
    decision: "approve" | "delete",
    now: number,
  ) {
    applyReportDecision(this.db, id, reportId, decision, now);
  }
  report(id: string, comment: string, now: number) {
    const budget = this.reportBudget;
    // Check before the lookup so full capacity gives the same response for
    // live, unknown, and already held files. No-op reports spend no capacity.
    if (
      budget &&
      budget.until > now &&
      budget.count >= this.limits.globalReportsPerHour
    )
      throw limited(Math.max(1, Math.ceil((budget.until - now) / 1_000)));
    // Commit the hold before stopping streams. One report per live transfer.
    // Repeat reports cannot replace the comment or extend the retention time.
    const inserted = this.db
      .prepare(
        `INSERT INTO reports (transfer_id, report_id, comment, reported_at)
      SELECT id, ?, ?, ? FROM transfers WHERE id=? AND (
        (state='ready' AND expires>?) OR
        (state IN ('pending','uploading') AND upload_expires>?)
      ) ON CONFLICT(transfer_id) DO NOTHING`,
      )
      .run(randomBytes(16).toString("hex"), comment, now, id, now, now);
    if (inserted.changes === 1) {
      // This check, durable insert, and charge are synchronous. The ownership
      // lock permits only one API process. Failed inserts spend no capacity.
      if (budget && budget.until > now) budget.count++;
      else this.reportBudget = { count: 1, until: now + 3_600_000 };
      return true;
    }
    return this.reported(id);
  }
  usage() {
    return this.db
      .prepare(
        `SELECT COALESCE(SUM(encrypted_size),0) AS bytes,
      COALESCE(SUM(CASE WHEN state != 'ready' THEN encrypted_size ELSE 0 END),0) AS pending,
      COUNT(*) AS count FROM transfers`,
      )
      .get() as { bytes: number; pending: number; count: number };
  }
  async reserve(row: Transfer) {
    let revision = this.readyRevision;
    let disk = await statfs(this.root);
    // A completion moves its full reservation out of the pending total. If it
    // raced statfs, repeat the disk snapshot so the bytes cannot disappear from
    // both the physical and pending accounting at the same time.
    while (revision !== this.readyRevision) {
      revision = this.readyRevision;
      disk = await statfs(this.root);
    }
    const free = disk.bavail * disk.bsize;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const used = this.usage();
      if (
        used.count >= this.limits.maxTransfers ||
        used.bytes + row.encrypted_size > this.limits.storageBytes ||
        free - used.pending - row.encrypted_size < this.limits.headroomBytes
      )
        throw new ApiFailure(503, "STORAGE_FULL", "Storage is not available.");
      this.db
        .prepare(
          `INSERT INTO transfers
        (id,size,encrypted_size,ttl,upload_hash,delete_hash,upload_expires,expires,state,attempts)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          row.id,
          row.size,
          row.encrypted_size,
          row.ttl,
          row.upload_hash,
          row.delete_hash,
          row.upload_expires,
          row.expires,
          row.state,
          row.attempts,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  claimUpload(id: string, now: number) {
    return (
      this.db
        .prepare(
          `UPDATE transfers SET state='uploading', upload_hash=NULL
      WHERE id=? AND state='pending' AND upload_expires>?
      AND NOT EXISTS (SELECT 1 FROM reports WHERE transfer_id=transfers.id)`,
        )
        .run(id, now).changes === 1
    );
  }
  complete(id: string, expires: number, now: number) {
    const changed =
      this.db
        .prepare(
          `UPDATE transfers SET state='ready',expires=?
      WHERE id=? AND state='uploading' AND upload_expires>?
      AND NOT EXISTS (SELECT 1 FROM reports WHERE transfer_id=transfers.id)`,
        )
        .run(expires, id, now).changes === 1;
    if (changed) this.readyRevision++;
    return changed;
  }
  claimDownload(id: string, now: number) {
    return (
      this.db
        .prepare(
          `UPDATE transfers SET attempts=attempts+1
      WHERE id=? AND state='ready' AND expires>? AND attempts<?
      AND NOT EXISTS (SELECT 1 FROM reports WHERE transfer_id=transfers.id)`,
        )
        .run(id, now, this.limits.downloadAttempts).changes === 1
    );
  }
  updateExpiry(id: string, ttlSeconds: number, now: number) {
    return this.db
      .prepare(
        `UPDATE transfers SET ttl=?, expires=?
      WHERE id=? AND state='ready' AND expires>?
      AND NOT EXISTS (SELECT 1 FROM reports WHERE transfer_id=transfers.id)
      RETURNING *`,
      )
      .get(ttlSeconds, now + ttlSeconds * 1000, id, now) as
      Transfer | undefined;
  }
  deny(id: string) {
    this.db
      .prepare(
        "UPDATE transfers SET state='deleting',upload_hash=NULL WHERE id=?",
      )
      .run(id);
  }
  forget(id: string) {
    this.db
      .prepare("DELETE FROM transfers WHERE id=? AND state='deleting'")
      .run(id);
  }
  healthy() {
    this.db.prepare("SELECT 1").get();
  }
  async storageHealthy() {
    await statfs(this.root);
  }
  close() {
    try {
      this.db.close();
    } finally {
      this.ownership.close();
    }
  }

  async createPart(id: string) {
    return open(
      this.file(id, "part"),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  }
  async publish(id: string) {
    await rename(this.file(id, "part"), this.file(id, "bin"));
  }
  async openContent(row: Transfer) {
    const handle = await open(
      this.file(row.id, "bin"),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== row.encrypted_size
      )
        throw unavailable();
      // On Windows O_NOFOLLOW is zero. lstat also prevents serving a symlink there.
      if ((await lstat(this.file(row.id, "bin"))).isSymbolicLink())
        throw unavailable();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async removeFiles(id: string) {
    // rm without recursive never follows a symlink or deletes a directory tree.
    await rm(this.file(id, "part"), { force: true });
    await rm(this.file(id, "bin"), { force: true });
  }
  async removeOrphans() {
    for (const entry of await readdir(this.root)) {
      const match = /^([a-f0-9]{32})\.(part|bin)$/.exec(entry);
      if (!match) continue;
      const row = this.get(match[1]!);
      if (!row || row.state !== "ready" || match[2] !== "bin")
        await rm(this.file(match[1]!, match[2] as "part" | "bin"), {
          force: true,
        });
    }
  }
}
