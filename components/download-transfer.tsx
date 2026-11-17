"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Download,
  File,
  Link2Off,
  LoaderCircle,
} from "lucide-react";
import {
  ApiError,
  downloadTransfer,
  getTransfer,
  parseShareKey,
  warmDownloadCrypto,
} from "@/lib/client";
import { TRANSFER_ID_PATTERN } from "@/lib/shared/constants";
import type { TransferMetadata, TransferProgress } from "@/lib/shared/types";
import { TransferProgressView } from "./transfer-progress";
import {
  formatBytes,
  formatExpiry,
  isCancelled,
  transferError,
} from "./transfer-utils";

type Phase =
  | "loading"
  | "invalid"
  | "unavailable"
  | "ready"
  | "working"
  | "downloaded"
  | "error"
  | "cancelled";

export function DownloadTransfer({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [metadata, setMetadata] = useState<TransferMetadata | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [downloadName, setDownloadName] = useState("");
  const [expired, setExpired] = useState(false);
  const [downloadLimitReached, setDownloadLimitReached] = useState(false);
  const shareKey = useRef<string | null>(null);
  const metadataRequest = useRef<AbortController | null>(null);
  const operation = useRef<AbortController | null>(null);
  const downloadUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const loadLink = useCallback(async () => {
    metadataRequest.current?.abort();
    operation.current?.abort();
    operation.current = null;
    const controller = new AbortController();
    metadataRequest.current = controller;
    shareKey.current = null;
    // Keep browser-only fragment parsing out of server rendering.
    await Promise.resolve();
    if (controller.signal.aborted) return;
    setPhase("loading");
    setError("");
    setMetadata(null);
    setProgress(null);
    setExpired(false);
    setDownloadLimitReached(false);
    if (!TRANSFER_ID_PATTERN.test(id)) {
      setError("This link is not valid. Ask the sender for the full link.");
      setPhase("invalid");
      return;
    }
    try {
      shareKey.current = parseShareKey(window.location.hash);
    } catch {
      setError(
        "The encryption key is missing or not valid. Ask the sender for the full link, including the part after #.",
      );
      setPhase("invalid");
      return;
    }
    try {
      const transfer = await getTransfer(id, controller.signal);
      if (controller.signal.aborted) return;
      warmDownloadCrypto();
      setMetadata(transfer);
      setPhase("ready");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(transferError(cause, "metadata"));
      setPhase("unavailable");
    }
  }, [id]);

  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) void loadLink();
    });
    const refreshKey = () => {
      void loadLink();
    };
    window.addEventListener("hashchange", refreshKey);
    const urls = downloadUrls.current;
    return () => {
      mounted = false;
      metadataRequest.current?.abort();
      operation.current?.abort();
      window.removeEventListener("hashchange", refreshKey);
      for (const [url, timer] of urls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, [loadLink]);

  useEffect(() => {
    if (!metadata) return;
    const controller = new AbortController();
    let refreshing = false;
    let checkedExpiry = false;
    const refreshExpiry = async () => {
      if (refreshing || operation.current) return;
      refreshing = true;
      checkedExpiry = Date.now() >= Date.parse(metadata.expiresAt);
      try {
        const latest = await getTransfer(id, controller.signal);
        if (controller.signal.aborted) return;
        setMetadata((current) =>
          current?.expiresAt === latest.expiresAt ? current : latest,
        );
        setExpired(false);
      } catch (cause) {
        if (!controller.signal.aborted)
          setExpired(
            (cause instanceof ApiError &&
              (cause.status === 404 || cause.status === 410)) ||
              Date.now() >= Date.parse(metadata.expiresAt),
          );
      } finally {
        refreshing = false;
      }
    };
    const checkExpiry = () => {
      // The sender may have extended the time while this tab was open.
      if (!checkedExpiry && Date.now() >= Date.parse(metadata.expiresAt))
        void refreshExpiry();
    };
    const timer = window.setInterval(checkExpiry, 1_000);
    window.addEventListener("focus", refreshExpiry);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshExpiry);
    };
  }, [id, metadata]);

  async function startDownload() {
    if (
      !metadata ||
      !shareKey.current ||
      operation.current ||
      expired ||
      downloadLimitReached
    )
      return;
    const controller = new AbortController();
    operation.current = controller;
    setPhase("working");
    setError("");
    setProgress(null);
    try {
      const downloaded = await downloadTransfer(
        id,
        shareKey.current,
        setProgress,
        controller.signal,
      );
      if (operation.current !== controller) return;
      if (controller.signal.aborted) {
        setPhase("cancelled");
        return;
      }
      const url = URL.createObjectURL(downloaded.blob);
      // Delay revocation so browsers can start the download before it is released.
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadUrls.current.delete(url);
      }, 10_000);
      downloadUrls.current.set(url, timer);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloaded.name;
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
      setDownloadName(downloaded.name);
      setPhase("downloaded");
    } catch (cause) {
      if (operation.current !== controller) return;
      if (controller.signal.aborted || isCancelled(cause)) {
        setPhase("cancelled");
      } else {
        if (cause instanceof ApiError && cause.code === "DOWNLOAD_LIMIT") {
          setDownloadLimitReached(true);
        }
        setError(transferError(cause, "download"));
        setPhase("error");
      }
    } finally {
      if (operation.current === controller) operation.current = null;
    }
  }

  const failed = phase === "invalid" || phase === "unavailable";
  return (
    <main id="main" className="transfer-layout receiver-layout">
      <section className="transfer-surface" aria-label="Receive a file">
        <div className="surface-content">
          <div className="surface-heading">
            <p className="site-name">passing.cloud</p>
            <h1>Receive a file</h1>
          </div>
          {phase === "loading" ? (
            <div className="loading-state" role="status">
              <LoaderCircle
                size={29}
                className="spinner blue"
                aria-hidden="true"
              />
              <h2>Checking the link…</h2>
            </div>
          ) : failed ? (
            <div className="unavailable-state">
              <span className="unavailable-symbol">
                <Link2Off size={30} strokeWidth={1.5} aria-hidden="true" />
              </span>
              <h2 className="state-title">
                {phase === "invalid" ? "Check your link" : "File unavailable"}
              </h2>
              <p className="error-message plain-error" role="alert">
                {error}
              </p>
              <button
                type="button"
                className="button button-secondary full-width"
                onClick={() => {
                  void loadLink();
                }}
              >
                Try again
              </button>
              <Link prefetch={true} href="/" className="text-link another-file">
                Send a file <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>
          ) : phase === "working" ? (
            <TransferProgressView
              progress={progress}
              direction="download"
              onCancel={() => operation.current?.abort()}
            />
          ) : (
            metadata && (
              <>
                <div
                  className={`receive-file${phase === "downloaded" ? " receive-done" : ""}`}
                >
                  <span className="receive-symbol">
                    {phase === "downloaded" ? (
                      <Check size={34} strokeWidth={1.5} aria-hidden="true" />
                    ) : (
                      <File size={38} strokeWidth={1.3} aria-hidden="true" />
                    )}
                  </span>
                  <h2
                    className="state-title"
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    {phase === "downloaded"
                      ? "Download started"
                      : downloadLimitReached
                        ? "Download limit reached"
                        : expired
                          ? "File expired"
                          : "Ready to download"}
                  </h2>
                  {phase === "downloaded" ? (
                    <p className="download-name" dir="auto">
                      {downloadName}
                    </p>
                  ) : (
                    <p className="muted">{formatBytes(metadata.size)}</p>
                  )}
                </div>
                {phase === "cancelled" && (
                  <p className="notice" role="status">
                    Download cancelled.
                  </p>
                )}
                {error && (
                  <p className="error-message" role="alert">
                    {error}
                  </p>
                )}
                <p className="receive-expiry">
                  <span>
                    {expired ? "Expired" : "Expires"}{" "}
                    <strong>{formatExpiry(metadata.expiresAt)}</strong>
                  </span>
                </p>
                {phase === "downloaded" && (
                  <Link
                    prefetch={true}
                    href="/"
                    className="button button-primary full-width receive-next-action"
                  >
                    Send your own file
                    <ArrowRight size={16} aria-hidden="true" />
                  </Link>
                )}
                {expired ? (
                  <>
                    <p className="error-message" role="status">
                      Ask the sender for a new link.
                    </p>
                    <button
                      type="button"
                      className="button button-secondary full-width"
                      onClick={() => void loadLink()}
                    >
                      Check again
                    </button>
                  </>
                ) : (
                  !downloadLimitReached && (
                    <button
                      type="button"
                      className={`button full-width ${phase === "downloaded" ? "button-secondary" : "button-primary"}`}
                      onClick={startDownload}
                    >
                      <Download size={18} aria-hidden="true" />
                      {phase === "downloaded"
                        ? "Download again"
                        : phase === "error" || phase === "cancelled"
                          ? "Try download again"
                          : "Download file"}
                    </button>
                  )
                )}
              </>
            )
          )}
          {TRANSFER_ID_PATTERN.test(id) && (
            <Link
              href={`/report?id=${id}`}
              className="text-link report-link"
              prefetch={false}
            >
              Report this file
            </Link>
          )}
        </div>
      </section>
    </main>
  );
}
