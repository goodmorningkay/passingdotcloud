"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { reportTransfer } from "@/lib/client/reports";
import { TRANSFER_ID_PATTERN } from "@/lib/shared/constants";
import {
  REPORT_COMMENT_MAX_LENGTH,
  REPORT_COMMENT_MIN_LENGTH,
  reportCommentError,
} from "@/lib/shared/reports";
import { transferError } from "./transfer-utils";

export function ReportTransfer({ initialId = "" }: { initialId?: string }) {
  const [id, setId] = useState(initialId);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => operation.current?.abort(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (operation.current) return;
    const fileId = id.trim().toLowerCase();
    const problem = !TRANSFER_ID_PATTERN.test(fileId)
      ? "Enter the 32-character file ID."
      : reportCommentError(comment);
    if (problem) {
      setError(problem);
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      await reportTransfer(fileId, comment, controller.signal);
      if (controller.signal.aborted) return;
      setComment("");
      setSent(true);
      requestAnimationFrame(() => confirmation.current?.focus());
    } catch (cause) {
      if (!controller.signal.aborted) setError(transferError(cause, "report"));
    } finally {
      if (operation.current === controller) operation.current = null;
      setBusy(false);
    }
  }

  if (sent)
    return (
      <div className="surface-content">
        <h1
          className="state-title"
          tabIndex={-1}
          ref={confirmation}
          aria-live="polite"
        >
          Report received
        </h1>
        <p className="muted state-copy">
          If the file exists, access stays blocked until review or expiry.
        </p>
        <Link prefetch={true} href="/" className="text-link">
          Send files
        </Link>
      </div>
    );

  return (
    <form className="surface-content report-form" onSubmit={submit}>
      <div className="surface-heading">
        <h1>Report a file</h1>
      </div>
      <label className="field-label" htmlFor="report-id">
        File ID
      </label>
      <input
        id="report-id"
        className="report-input"
        value={id}
        onChange={(event) => setId(event.target.value)}
        required
        maxLength={32}
        pattern="[a-fA-F0-9]{32}"
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        aria-describedby="report-id-hint"
      />
      <p id="report-id-hint" className="field-hint">
        The part of the link between /t/ and #
      </p>
      <label className="field-label" htmlFor="report-comment">
        Reason
      </label>
      <textarea
        id="report-comment"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        required
        minLength={REPORT_COMMENT_MIN_LENGTH}
        maxLength={REPORT_COMMENT_MAX_LENGTH}
        rows={4}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        aria-describedby="report-comment-hint"
      />
      <p id="report-comment-hint" className="field-hint">
        {REPORT_COMMENT_MIN_LENGTH}–{REPORT_COMMENT_MAX_LENGTH} characters. The
        owner can read this. Omit personal details and share keys.
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="button button-primary full-width"
        disabled={busy}
      >
        {busy ? "Sending report…" : "Report and block file"}
      </button>
      <p className="small muted">Review can restore access before expiry.</p>
    </form>
  );
}
