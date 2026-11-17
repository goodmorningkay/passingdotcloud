"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ADMIN_SIGN_IN_RETRY_MESSAGE,
  adminRequest,
  AdminRequestError,
} from "@/lib/client/admin";
import {
  ADMIN_STATUSES,
  ADMIN_STATUS_LABELS,
  type AdminFile,
  type AdminFiles,
  type AdminSession,
  type AdminStatus,
} from "@/lib/shared/admin";
import styles from "./admin-console.module.css";

const errorText = (error: unknown, beforeSignIn = false) =>
  error instanceof AdminRequestError
    ? error.message
    : beforeSignIn
      ? ADMIN_SIGN_IN_RETRY_MESSAGE
      : "The request failed. Refresh the list and try again.";
const isSignedOut = (error: unknown) =>
  error instanceof AdminRequestError &&
  (error.status === 401 || error.code === "ADMIN_DISABLED");
function bytes(value: number) {
  if (value < 1000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)} KB`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${(value / 1_000_000_000).toFixed(2)} GB`;
}
function date(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function AdminConsole() {
  const [session, setSession] = useState<AdminSession | null>();
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    adminRequest<AdminSession>("/session", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setSession(result);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setSession(null);
        if (
          cause instanceof AdminRequestError &&
          cause.code === "ADMIN_DISABLED"
        )
          setDisabled(true);
        else if (!(cause instanceof AdminRequestError && cause.status === 401))
          setError(errorText(cause, true));
      });
    // Recheck a page restored from the browser's back/forward cache.
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", restore);
    return () => {
      controller.abort();
      window.removeEventListener("pageshow", restore);
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        setSession(null);
        setError("Your session ended. Sign in again.");
      },
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [session]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    const input = event.currentTarget.elements.namedItem(
      "key",
    ) as HTMLInputElement;
    const key = input.value;
    input.value = "";
    try {
      const result = await adminRequest<AdminSession>("/login", {
        body: { key },
      });
      setSession(result);
    } catch (cause) {
      if (cause instanceof AdminRequestError && cause.code === "ADMIN_DISABLED")
        setDisabled(true);
      else setError(errorText(cause, true));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  return (
    <main id="main" className={styles.layout}>
      <header className={styles.heading}>
        <div>
          <Link href="/" className={styles.brand}>
            passing.cloud
          </Link>
          <h1>Admin</h1>
        </div>
        <p className="muted">File records and reports</p>
      </header>
      {session ? (
        <AdminDashboard
          session={session}
          onSignedOut={() => {
            setSession(null);
            setError("");
          }}
        />
      ) : (
        <section
          className={`${styles.signIn} transfer-surface`}
          aria-label="Admin sign-in"
        >
          {session === undefined ? (
            <p role="status">Checking access…</p>
          ) : disabled ? (
            <>
              <h2>Admin access is not enabled</h2>
              <p className="muted">
                The server owner must enable admin access before sign-in.
              </p>
            </>
          ) : (
            <form onSubmit={signIn} className={styles.loginForm}>
              <h2>Sign in</h2>
              <label htmlFor="admin-key">Admin key</label>
              <input
                id="admin-key"
                name="key"
                type="password"
                autoComplete="current-password"
                required
                minLength={64}
                maxLength={64}
                pattern="[a-f0-9]{64}"
                disabled={busy}
                aria-describedby="admin-key-hint"
              />
              <p id="admin-key-hint" className="small muted">
                64 characters. Sign-in lasts one hour.
              </p>
              {error && (
                <p className="error-message" role="alert">
                  {error}
                </p>
              )}
              <button className="button button-primary" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
          )}
        </section>
      )}
    </main>
  );
}

function AdminDashboard({
  session,
  onSignedOut,
}: {
  session: AdminSession;
  onSignedOut: () => void;
}) {
  const [filters, setFilters] = useState<{
    query: string;
    status: AdminStatus;
    page: number;
  }>({ query: "", status: "all", page: 1 });
  const [query, setQuery] = useState("");
  const [data, setData] = useState<AdminFiles | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<AdminFile | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const onSignedOutRef = useRef(onSignedOut);
  useEffect(() => {
    onSignedOutRef.current = onSignedOut;
  }, [onSignedOut]);
  const search = new URLSearchParams({
    ...filters,
    page: String(filters.page),
  }).toString();
  const requestKey = `${search}:${revision}`;
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    const controller = new AbortController();
    adminRequest<AdminFiles>(`/files?${search}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setError("");
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setData(null);
        if (isSignedOut(cause)) onSignedOutRef.current();
        else setError(errorText(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadedKey(requestKey);
      });
    return () => controller.abort();
  }, [search, requestKey]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await adminRequest("/logout", { body: {}, csrfToken: session.csrfToken });
      onSignedOut();
    } catch (cause) {
      if (isSignedOut(cause)) onSignedOut();
      else setError(errorText(cause));
    } finally {
      setSigningOut(false);
    }
  }

  function applySearch(event: FormEvent) {
    event.preventDefault();
    const value = query.trim().toLowerCase();
    if (!/^[a-f0-9]{0,32}$/.test(value)) {
      setError(
        "Enter a file ID or its first characters. Do not enter a share link.",
      );
      return;
    }
    setError("");
    setFilters({ ...filters, query: value, page: 1 });
    setRevision((value) => value + 1);
  }

  return (
    <>
      <div className={styles.toolbar}>
        <p className="muted">
          File names and contents are encrypted. This page cannot read them.
        </p>
        <div className={styles.actions}>
          <button
            className="button button-secondary"
            disabled={loading || signingOut}
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh
          </button>
          <button
            className="button button-secondary"
            disabled={signingOut}
            onClick={signOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
      {data && (
        <dl className={styles.metrics}>
          <div>
            <dt>Stored records</dt>
            <dd>{data.summary.files}</dd>
          </div>
          <div>
            <dt>Reserved storage</dt>
            <dd>
              {bytes(data.summary.reservedBytes)}{" "}
              <small>of {bytes(data.summary.storageLimitBytes)}</small>
            </dd>
          </div>
          <div>
            <dt>Open reports</dt>
            <dd>{data.summary.openReports}</dd>
          </div>
        </dl>
      )}
      <section
        className={`${styles.files} transfer-surface`}
        aria-label="Stored files"
        aria-busy={loading}
      >
        <div className={styles.filters}>
          <div className={styles.actions} aria-label="File view">
            <button
              className={`button ${filters.status === "all" ? "button-primary" : "button-secondary"}`}
              aria-pressed={filters.status === "all"}
              onClick={() => setFilters({ ...filters, status: "all", page: 1 })}
            >
              Files
            </button>
            <button
              className={`button ${filters.status === "reported" ? "button-primary" : "button-secondary"}`}
              aria-pressed={filters.status === "reported"}
              onClick={() =>
                setFilters({ ...filters, status: "reported", page: 1 })
              }
            >
              Reports
            </button>
          </div>
          <form onSubmit={applySearch} className={styles.search}>
            <label htmlFor="admin-search" className="visually-hidden">
              Search by file ID
            </label>
            <input
              id="admin-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by file ID"
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="button button-secondary">Search</button>
          </form>
          <label className={styles.statusFilter} htmlFor="admin-status">
            Status
            <select
              id="admin-status"
              value={filters.status}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  status: event.target.value as AdminStatus,
                  page: 1,
                })
              }
            >
              {ADMIN_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {ADMIN_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className={styles.tableNote}>
          Soonest expiry first. Storage includes pending uploads and pending
          deletions.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {loading ? (
          <p className={styles.empty} role="status">
            Loading files…
          </p>
        ) : data && data.items.length === 0 ? (
          <p className={styles.empty}>No files match this view.</p>
        ) : (
          data && (
            <>
              <div
                className={styles.tableScroll}
                tabIndex={0}
                role="region"
                aria-label="File list"
              >
                <table className={styles.table}>
                  <caption className="visually-hidden">
                    Stored file records
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">File ID</th>
                      <th scope="col">Status</th>
                      <th scope="col">File size</th>
                      <th scope="col">Expiry / upload deadline</th>
                      <th scope="col">Attempts</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((file) => (
                      <tr key={file.id}>
                        <td>
                          <code className={styles.fileId}>{file.id}</code>
                        </td>
                        <td>
                          <span
                            className={styles.badge}
                            data-status={file.status}
                          >
                            {ADMIN_STATUS_LABELS[file.status]}
                          </span>
                        </td>
                        <td>
                          {bytes(file.size)}
                          <span className={styles.secondary}>
                            {bytes(file.encryptedSize)} encrypted
                          </span>
                        </td>
                        <td>
                          <time dateTime={file.expiresAt}>
                            {date(file.expiresAt)}
                          </time>
                        </td>
                        <td>
                          {file.attempts} / {data.summary.downloadLimit}
                        </td>
                        <td>
                          <button
                            className="button button-secondary"
                            aria-label={`Details for ${file.id}`}
                            onClick={() => {
                              setNotice("");
                              setSelected(file);
                            }}
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={styles.pagination}>
                <p>
                  {data.total} {data.total === 1 ? "record" : "records"} · Page{" "}
                  {data.page} of{" "}
                  {Math.max(1, Math.ceil(data.total / data.pageSize))}
                </p>
                <div className={styles.actions}>
                  <button
                    className="button button-secondary"
                    disabled={data.page <= 1}
                    onClick={() =>
                      setFilters({ ...filters, page: data.page - 1 })
                    }
                  >
                    Previous
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={data.page * data.pageSize >= data.total}
                    onClick={() =>
                      setFilters({ ...filters, page: data.page + 1 })
                    }
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )
        )}
      </section>
      {selected && (
        <FileDialog
          file={selected}
          session={session}
          onClose={() => setSelected(null)}
          onSignedOut={onSignedOut}
          onComplete={(message) => {
            setSelected(null);
            setNotice(message);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

function FileDialog({
  file,
  session,
  onClose,
  onComplete,
  onSignedOut,
}: {
  file: AdminFile;
  session: AdminSession;
  onClose: () => void;
  onComplete: (message: string) => void;
  onSignedOut: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const [decision, setDecision] = useState<"delete" | "approve" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef(false);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    if (decision) cancelButton.current?.focus();
  }, [decision]);

  async function act() {
    if (!decision || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await adminRequest<{
        deleted?: boolean;
        approved?: boolean;
      }>(`/files/${file.id}/${file.report ? "review" : "delete"}`, {
        csrfToken: session.csrfToken,
        body: {
          confirmation: file.id,
          ...(file.report ? { reportId: file.report.id, decision } : {}),
        },
      });
      onComplete(
        result.approved
          ? "The report is closed."
          : result.deleted
            ? "The file was deleted."
            : "Access is blocked. Disk deletion is pending. Cleanup will try again.",
      );
    } catch (cause) {
      if (isSignedOut(cause)) onSignedOut();
      else setError(errorText(cause));
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="admin-file-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className={styles.dialogHeading}>
        <h2 id="admin-file-title">File details</h2>
        <button
          className="button button-secondary"
          onClick={onClose}
          disabled={busy}
        >
          Close
        </button>
      </div>
      <code className={styles.detailId}>{file.id}</code>
      <dl className={styles.details}>
        <div>
          <dt>Status</dt>
          <dd>{ADMIN_STATUS_LABELS[file.status]}</dd>
        </div>
        <div>
          <dt>File size</dt>
          <dd>{bytes(file.size)}</dd>
        </div>
        <div>
          <dt>Encrypted size</dt>
          <dd>{bytes(file.encryptedSize)}</dd>
        </div>
        <div>
          <dt>
            {file.state === "ready" ? "Expiry" : "Expiry / upload deadline"}
          </dt>
          <dd>
            <time dateTime={file.expiresAt}>{date(file.expiresAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Download attempts</dt>
          <dd>{file.attempts}</dd>
        </div>
      </dl>
      {file.report && (
        <section className={styles.report} aria-label="Report">
          <h3>Report</h3>
          <p className="small muted">
            <time dateTime={file.report.reportedAt}>
              {date(file.report.reportedAt)}
            </time>
          </p>
          <p className={styles.comment} dir="auto">
            {file.report.comment}
          </p>
        </section>
      )}
      <p className="small muted">
        The server cannot read the file name or contents.
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {decision ? (
        <div className={styles.confirmation}>
          <h3>
            {decision === "delete"
              ? "Delete this file?"
              : "Restore access to this file?"}
          </h3>
          <p>
            {decision === "delete"
              ? "This stops active transfers and removes the stored file. You cannot undo this action. It cannot remove copies already received."
              : "This closes the report and restores access. The original expiry and download limits still apply."}
          </p>
          <div className={styles.actions}>
            <button
              className={`button ${decision === "delete" ? "button-danger" : "button-primary"}`}
              disabled={busy}
              onClick={act}
            >
              {busy
                ? "Saving…"
                : decision === "delete"
                  ? "Confirm deletion"
                  : "Restore access"}
            </button>
            <button
              ref={cancelButton}
              className="button button-secondary"
              disabled={busy}
              onClick={() => setDecision(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          {file.report && (
            <button
              className="button button-primary"
              onClick={() => setDecision("approve")}
            >
              Restore access
            </button>
          )}
          <button
            className="button button-danger"
            onClick={() => setDecision("delete")}
          >
            {file.status === "deleting" ? "Retry deletion" : "Delete file"}
          </button>
        </div>
      )}
    </dialog>
  );
}
