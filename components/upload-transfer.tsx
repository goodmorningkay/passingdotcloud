"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import Link from "next/link";
import { ArrowRight, File, Upload, X } from "lucide-react";
import { createShareUrl, uploadFile } from "@/lib/client";
import {
  warmEncryptionWorker,
  clearWarmedEncryptionWorker,
} from "@/lib/client/worker";
import {
  DEFAULT_TTL_SECONDS,
  MAX_FILE_BYTES,
  TTL_OPTIONS,
} from "@/lib/shared/constants";
import type { TransferProgress, UploadedTransfer } from "@/lib/shared/types";
import { TransferProgressView } from "./transfer-progress";
import { UploadedFile } from "./uploaded-file";
import {
  formatBytes,
  isCancelled,
  transferError,
  validateSelection,
} from "./transfer-utils";

type Phase = "ready" | "working" | "error" | "cancelled";
type UploadEntry = {
  id: number;
  file: File;
  result?: UploadedTransfer;
  shareUrl?: string;
  ttlSeconds?: number;
  deleted?: boolean;
};

export function UploadTransfer() {
  const [files, setFiles] = useState<UploadEntry[]>([]);
  const [ttl, setTtl] = useState<number>(DEFAULT_TTL_SECONDS);
  const [phase, setPhase] = useState<Phase>("ready");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const dropButton = useRef<HTMLButtonElement>(null);
  const retention = useRef<HTMLSelectElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const operation = useRef<AbortController | null>(null);
  const dragDepth = useRef(0);
  const nextId = useRef(0);

  useEffect(() => {
    return () => {
      operation.current?.abort();
      clearWarmedEncryptionWorker();
    };
  }, []);

  const pending = files.filter((entry) => !entry.result && !entry.deleted);
  const completed = files.filter((entry) => entry.result || entry.deleted);
  const lastAvailable = completed.filter((entry) => entry.result).at(-1)?.id;
  const activeIndex = files.findIndex((entry) => entry.id === activeId);
  const active = files[activeIndex];
  const finished = files.length > 0 && pending.length === 0;
  const allDeleted = finished && files.every((entry) => entry.deleted);

  function selectFiles(selection: readonly File[]) {
    if (operation.current) return;
    const problem = validateSelection(selection);
    setError(problem ?? "");
    if (!problem) {
      warmEncryptionWorker();
      const entries = selection.map((file) => ({ id: nextId.current++, file }));
      setFiles((current) => [...current, ...entries]);
    }
    setPhase(problem ? "error" : "ready");
    requestAnimationFrame(() => {
      if (problem) feedback.current?.focus();
      else retention.current?.focus();
    });
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const selection = Array.from(event.target.files ?? []);
    if (selection.length) selectFiles(selection);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    dragDepth.current = 0;
    if (operation.current) return;
    if (
      Array.from(event.dataTransfer.items).some(
        (item) => item.webkitGetAsEntry?.()?.isDirectory,
      )
    ) {
      setError("Choose files. Folders cannot be sent.");
      setPhase("error");
      requestAnimationFrame(() => feedback.current?.focus());
      return;
    }
    selectFiles(Array.from(event.dataTransfer.files));
  }

  async function startUpload(event: FormEvent) {
    event.preventDefault();
    if (!pending.length || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setPhase("working");
    setError("");
    let current = pending[0]!;
    try {
      // Keep only one encryption worker and upload active. Completed entries
      // stay in the list, so retrying never uploads them a second time.
      for (const entry of pending) {
        current = entry;
        controller.signal.throwIfAborted();
        setActiveId(entry.id);
        setProgress(null);
        const uploaded = await uploadFile(entry.file, {
          ttlSeconds: ttl,
          onProgress: setProgress,
          signal: controller.signal,
        });
        const shareUrl = createShareUrl(
          uploaded.id,
          uploaded.key,
          window.location.origin,
        );
        setFiles((entries) =>
          entries.map((item) =>
            item.id === entry.id
              ? { ...item, result: uploaded, shareUrl, ttlSeconds: ttl }
              : item,
          ),
        );
      }
      setPhase("ready");
      requestAnimationFrame(() =>
        results.current?.querySelector("button")?.focus(),
      );
    } catch (cause) {
      if (controller.signal.aborted || isCancelled(cause)) {
        setPhase("cancelled");
      } else {
        setError(`${current.file.name}: ${transferError(cause, "upload")}`);
        setPhase("error");
      }
      requestAnimationFrame(() => feedback.current?.focus());
    } finally {
      setActiveId(null);
      if (operation.current === controller) operation.current = null;
    }
  }

  function removeFile(id: number) {
    if (operation.current) return;
    if (pending.length === 1 && pending[0]?.id === id)
      clearWarmedEncryptionWorker();
    setFiles((entries) => entries.filter((entry) => entry.id !== id));
    setError("");
    setPhase("ready");
    requestAnimationFrame(() => dropButton.current?.focus());
  }

  return (
    <div className="surface-content">
      <div className="surface-heading upload-heading">
        <p className="site-name">passing.cloud</p>
        <h1 aria-live="polite" aria-atomic="true">
          {finished
            ? allDeleted
              ? files.length === 1
                ? "File deleted"
                : "Files deleted"
              : files.length === 1
                ? "Link ready"
                : "Links ready"
            : phase === "working"
              ? "Sending files"
              : "Send files without an account"}
        </h1>
        {!finished && phase !== "working" && (
          <p className="transfer-intro">Your browser encrypts each file.</p>
        )}
      </div>
      {!finished && (
        <form onSubmit={startUpload}>
          {phase === "working" ? (
            <>
              <div className="file-row working-file">
                <File size={23} aria-hidden="true" />
                <div>
                  <span className="file-name" dir="auto">
                    {active?.file.name}
                  </span>
                  <span className="small muted">
                    {active && formatBytes(active.file.size)}
                  </span>
                  <p className="small muted" role="status">
                    File {activeIndex + 1} of {files.length}
                  </p>
                </div>
              </div>
              <TransferProgressView
                progress={progress}
                direction="upload"
                onCancel={() => operation.current?.abort()}
              />
            </>
          ) : (
            <>
              <input
                className="visually-hidden"
                ref={picker}
                type="file"
                multiple
                id="file-picker"
                aria-label="Choose files to send"
                tabIndex={-1}
                onChange={onPick}
              />
              {pending.length > 0 && (
                <ul className="selected-files" aria-label="Selected files">
                  {pending.map(({ id, file }) => (
                    <li className="selected-file" key={id}>
                      <span className="file-symbol">
                        <File size={26} strokeWidth={1.5} aria-hidden="true" />
                      </span>
                      <div className="file-details">
                        <span className="file-name" dir="auto">
                          {file.name}
                        </span>
                        <span className="small muted">
                          {formatBytes(file.size)}
                        </span>
                      </div>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => removeFile(id)}
                      >
                        <X size={18} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                ref={dropButton}
                className={`drop-zone${pending.length ? " add-files" : ""}${dragging ? " is-dragging" : ""}`}
                onClick={() => picker.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault();
                  dragDepth.current += 1;
                  setDragging(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  dragDepth.current = Math.max(0, dragDepth.current - 1);
                  if (dragDepth.current === 0) setDragging(false);
                }}
                onDrop={onDrop}
                aria-describedby="file-limit"
              >
                {!pending.length && (
                  <span className="upload-symbol">
                    <Upload size={24} strokeWidth={1.5} aria-hidden="true" />
                  </span>
                )}
                <span className="drop-title">
                  {dragging
                    ? "Drop files here"
                    : pending.length
                      ? "Add more files"
                      : "Drop your files here"}
                </span>
                {!dragging && (
                  <span className="drop-browse">
                    {pending.length
                      ? "Drop or choose files"
                      : "or choose files"}
                  </span>
                )}
                <span className="drop-limit" id="file-limit">
                  Up to {formatBytes(MAX_FILE_BYTES)} per file
                </span>
              </button>
              {error && (
                <p
                  className="error-message"
                  role="alert"
                  ref={feedback}
                  tabIndex={-1}
                >
                  {error}
                </p>
              )}
              {phase === "cancelled" && (
                <p
                  className="notice"
                  role="status"
                  ref={feedback}
                  tabIndex={-1}
                >
                  Upload cancelled.
                </p>
              )}
              <div className="retention-field">
                <label className="field-label" htmlFor="retention">
                  Link expires after
                </label>
                <select
                  id="retention"
                  ref={retention}
                  value={ttl}
                  onChange={(event) => setTtl(Number(event.target.value))}
                >
                  {TTL_OPTIONS.map((option) => (
                    <option key={option.seconds} value={option.seconds}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="button button-primary full-width"
                type="submit"
                disabled={!pending.length}
              >
                {(phase === "error" || phase === "cancelled") && pending.length
                  ? "Try again"
                  : pending.length > 1
                    ? "Create links"
                    : "Create link"}
              </button>
            </>
          )}
        </form>
      )}
      {completed.length > 0 && (
        <div className="upload-results" ref={results}>
          {!allDeleted && (
            <p className="small muted state-copy">
              Closing or reloading this tab removes the expiry and delete
              controls.
            </p>
          )}
          {completed.map((entry) => (
            <UploadedFile
              key={entry.id}
              id={entry.id}
              file={entry.file}
              result={entry.result}
              shareUrl={entry.shareUrl ?? ""}
              showSendMore={finished && entry.id === lastAvailable}
              ttlSeconds={entry.ttlSeconds ?? DEFAULT_TTL_SECONDS}
              onExpiryChanged={(updated, ttlSeconds) =>
                setFiles((entries) =>
                  entries.map((item) =>
                    item.id === entry.id && item.result
                      ? {
                          ...item,
                          result: { ...item.result, ...updated },
                          ttlSeconds,
                        }
                      : item,
                  ),
                )
              }
              onDeleted={() =>
                setFiles((entries) =>
                  entries.map((item) =>
                    item.id === entry.id
                      ? { id: item.id, file: item.file, deleted: true }
                      : item,
                  ),
                )
              }
            />
          ))}
        </div>
      )}
      {allDeleted && (
        <Link
          prefetch={false}
          href="/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-link another-file"
        >
          Send more files <ArrowRight size={15} aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}
