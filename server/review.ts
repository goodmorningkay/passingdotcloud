import { DatabaseSync } from "node:sqlite";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { TRANSFER_ID_PATTERN } from "../lib/shared/constants";

export class ReviewError extends Error {}

async function openReviewDatabase(directory: string) {
  const root = path.resolve(directory);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new ReviewError("Use the private API data directory.");
  const resolved = await realpath(root);
  const database = path.join(resolved, "metadata.sqlite");
  const file = await lstat(database);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1)
    throw new ReviewError(
      "The metadata database is not a private regular file.",
    );
  // The operator's filesystem permissions authorize these local commands.
  // This connection never owns file handles, creates transfers, or removes files.
  const db = new DatabaseSync(database);
  try {
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL;",
    );
    db.prepare("SELECT transfer_id FROM reports LIMIT 0").all();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

interface ReportRow {
  id: string;
  reportId: string;
  comment: string;
  reportedAt: number;
  expiresAt: number;
  size: number;
  state: string;
}

export async function listReports(directory: string, now = Date.now()) {
  const db = await openReviewDatabase(directory);
  try {
    const rows = db
      .prepare(
        `SELECT t.id, r.report_id AS reportId, r.comment,
      r.reported_at AS reportedAt, COALESCE(t.expires,t.upload_expires) AS expiresAt,
      t.size, t.state FROM reports r JOIN transfers t ON t.id=r.transfer_id
      WHERE t.state != 'deleting' AND COALESCE(t.expires,t.upload_expires)>?
      ORDER BY r.reported_at, t.id`,
      )
      .all(now) as unknown as ReportRow[];
    return rows.map((row) => ({
      ...row,
      reportedAt: new Date(row.reportedAt).toISOString(),
      expiresAt: new Date(row.expiresAt).toISOString(),
    }));
  } finally {
    db.close();
  }
}

export async function reviewReport(
  directory: string,
  id: string,
  reportId: string,
  decision: "approve" | "delete",
  now = Date.now(),
) {
  const db = await openReviewDatabase(directory);
  try {
    applyReportDecision(db, id, reportId, decision, now);
  } finally {
    db.close();
  }
}

// The web API uses its existing connection. Both interfaces use the same
// transaction and report ID check, including when they run at the same time.
export function applyReportDecision(
  db: DatabaseSync,
  id: string,
  reportId: string,
  decision: "approve" | "delete",
  now: number,
) {
  if (
    !TRANSFER_ID_PATTERN.test(id) ||
    !TRANSFER_ID_PATTERN.test(reportId) ||
    !["approve", "delete"].includes(decision)
  )
    throw new ReviewError("Use a valid file ID, report ID, and decision.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        `SELECT t.id FROM reports r JOIN transfers t ON t.id=r.transfer_id
        WHERE t.id=? AND r.report_id=? AND t.state IN ('ready','pending')
        AND COALESCE(t.expires,t.upload_expires)>?`,
      )
      .get(id, reportId, now);
    if (!row)
      throw new ReviewError(
        "This report is no longer open. List the reports again.",
      );
    if (decision === "delete") {
      // The running API owns stream cancellation and physical deletion.
      // Deny first, retain the disk reservation, and let cleanup remove files.
      db.prepare(
        "UPDATE transfers SET state='deleting',upload_hash=NULL WHERE id=?",
      ).run(id);
    }
    db.prepare("DELETE FROM reports WHERE transfer_id=? AND report_id=?").run(
      id,
      reportId,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
