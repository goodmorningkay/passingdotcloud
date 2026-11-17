"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy, Pencil, Trash2 } from "lucide-react";
import { deleteTransfer, updateTransferExpiry } from "@/lib/client";
import { TTL_OPTIONS } from "@/lib/shared/constants";
import type { TransferMetadata, UploadedTransfer } from "@/lib/shared/types";
import { formatBytes, formatExpiry, transferError } from "./transfer-utils";

export function UploadedFile({
  id,
  file,
  result,
  shareUrl,
  showSendMore,
  ttlSeconds,
  onExpiryChanged,
  onDeleted,
}: {
  id: number;
  file: File;
  result?: UploadedTransfer;
  shareUrl: string;
  showSendMore: boolean;
  ttlSeconds: number;
  onExpiryChanged: (updated: TransferMetadata, ttlSeconds: number) => void;
  onDeleted: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [editingExpiry, setEditingExpiry] = useState(false);
  const [expiryTtl, setExpiryTtl] = useState(ttlSeconds);
  const [savingExpiry, setSavingExpiry] = useState(false);
  const [expiryError, setExpiryError] = useState("");
  const [expiryStatus, setExpiryStatus] = useState("");
  const expirySelect = useRef<HTMLSelectElement>(null);
  const expiryButton = useRef<HTMLButtonElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const deletedMessage = useRef<HTMLParagraphElement>(null);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => () => operation.current?.abort(), []);

  async function copyLink() {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopyStatus("Link copied");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setCopyStatus("Link selected. Use your device’s Copy command.");
    }
  }

  async function removeTransfer() {
    if (!result || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setDeleting(true);
    setError("");
    try {
      await deleteTransfer(result.id, result.deleteToken, controller.signal);
      onDeleted();
      setCopyStatus("");
      requestAnimationFrame(() => deletedMessage.current?.focus());
    } catch (cause) {
      if (!controller.signal.aborted) setError(transferError(cause, "delete"));
    } finally {
      setDeleting(false);
      if (operation.current === controller) operation.current = null;
    }
  }

  function closeExpiryEditor() {
    setEditingExpiry(false);
    setExpiryError("");
    requestAnimationFrame(() => expiryButton.current?.focus());
  }

  async function saveExpiry(event: FormEvent) {
    event.preventDefault();
    if (!result || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setSavingExpiry(true);
    setExpiryError("");
    setExpiryStatus("");
    try {
      const updated = await updateTransferExpiry(
        result.id,
        result.deleteToken,
        expiryTtl,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      onExpiryChanged(updated, expiryTtl);
      closeExpiryEditor();
      setExpiryStatus("Expiry changed.");
    } catch (cause) {
      if (!controller.signal.aborted)
        setExpiryError(transferError(cause, "expiry"));
    } finally {
      setSavingExpiry(false);
      if (operation.current === controller) operation.current = null;
    }
  }

  return (
    <section className="upload-result" aria-label={file.name}>
      <div className="receipt">
        <h2 className="file-name receipt-name" dir="auto">
          {file.name}
        </h2>
        <span>{formatBytes(file.size)}</span>
      </div>
      {!result ? (
        <p
          className="muted state-copy"
          role="status"
          ref={deletedMessage}
          tabIndex={-1}
        >
          File deleted. The link no longer works.
        </p>
      ) : (
        <>
          <label className="visually-hidden" htmlFor={`share-link-${id}`}>
            Share link
          </label>
          <div className="share-field">
            <input
              id={`share-link-${id}`}
              ref={linkInput}
              type="text"
              readOnly
              value={shareUrl}
              onFocus={(event) => event.currentTarget.select()}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <button
            type="button"
            className="button button-primary full-width"
            onClick={copyLink}
          >
            {copyStatus === "Link copied" ? (
              <Check size={17} aria-hidden="true" />
            ) : (
              <Copy size={17} aria-hidden="true" />
            )}
            {copyStatus === "Link copied" ? "Copied" : "Copy link"}
          </button>
          <p
            className={
              copyStatus === "Link copied"
                ? "visually-hidden"
                : "copy-feedback small"
            }
            role="status"
          >
            {copyStatus}
          </p>
          <p className="expiry-note">
            <span>
              Expires{" "}
              <strong>{result && formatExpiry(result.expiresAt)}</strong>
            </span>
            <button
              type="button"
              className="icon-button expiry-edit-button"
              ref={expiryButton}
              aria-label="Change expiry"
              title="Change expiry"
              aria-expanded={editingExpiry}
              aria-controls={`expiry-editor-${id}`}
              disabled={savingExpiry || deleting || confirmDelete}
              onClick={() => {
                if (editingExpiry) {
                  closeExpiryEditor();
                  return;
                }
                setExpiryTtl(ttlSeconds);
                setExpiryError("");
                setExpiryStatus("");
                setEditingExpiry(true);
                requestAnimationFrame(() => expirySelect.current?.focus());
              }}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          </p>
          <form
            id={`expiry-editor-${id}`}
            className="expiry-editor"
            hidden={!editingExpiry}
            onSubmit={saveExpiry}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !savingExpiry) {
                event.preventDefault();
                closeExpiryEditor();
              }
            }}
          >
            <div className="retention-field">
              <label className="field-label" htmlFor={`expiry-retention-${id}`}>
                Link expires after
              </label>
              <select
                id={`expiry-retention-${id}`}
                ref={expirySelect}
                value={expiryTtl}
                disabled={savingExpiry}
                aria-describedby={`expiry-hint-${id}`}
                onChange={(event) => setExpiryTtl(Number(event.target.value))}
              >
                {TTL_OPTIONS.map((option) => (
                  <option key={option.seconds} value={option.seconds}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <p id={`expiry-hint-${id}`} className="field-hint">
              The new time starts when you save.
            </p>
            {expiryError && (
              <p className="error-message small" role="alert">
                {expiryError}
              </p>
            )}
            <div className="button-row">
              <button
                type="submit"
                className="button button-secondary"
                disabled={savingExpiry}
              >
                {savingExpiry ? "Saving…" : "Save expiry"}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={savingExpiry}
                onClick={closeExpiryEditor}
              >
                Cancel
              </button>
            </div>
          </form>
          <p className="copy-feedback small" role="status">
            {expiryStatus}
          </p>
          <div className="delete-area">
            {error && (
              <p className="error-message small" role="alert">
                {error}
              </p>
            )}
            <div className="upload-actions">
              {!confirmDelete && (
                <button
                  type="button"
                  className="text-button danger-text"
                  disabled={savingExpiry}
                  onClick={() => {
                    setEditingExpiry(false);
                    setExpiryError("");
                    setExpiryStatus("");
                    setConfirmDelete(true);
                    setError("");
                  }}
                >
                  <Trash2 size={15} aria-hidden="true" />
                  Delete file early
                </button>
              )}
              {showSendMore && (
                <Link
                  prefetch={false}
                  href="/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link"
                >
                  Send more files <ArrowRight size={15} aria-hidden="true" />
                </Link>
              )}
            </div>
            {confirmDelete && (
              <div className="delete-confirm">
                <p>The link will stop working.</p>
                <div className="button-row">
                  <button
                    type="button"
                    className="button button-danger"
                    disabled={deleting}
                    onClick={removeTransfer}
                  >
                    {deleting ? "Deleting…" : "Delete file"}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={deleting}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep file
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
