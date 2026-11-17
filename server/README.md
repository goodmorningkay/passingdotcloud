# Transfer API

`createApp(options?)` in `server/app.ts` returns a ready Fastify instance.
`server/index.ts` starts the API. Run `npm run start:api`.

## Environment

| Variable                        | Default                 | Function                                                                                                                                                                                            |
| ------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                      | unset                   | Use `production` on the server.                                                                                                                                                                     |
| `PASSING_API_HOST`              | `127.0.0.1`             | Listen address. Use `0.0.0.0` in a container.                                                                                                                                                       |
| `PASSING_API_PORT`              | `4000`                  | Listen port.                                                                                                                                                                                        |
| `PASSING_DATA_DIR`              | `./data`                | Private data directory. Mount persistent local storage here.                                                                                                                                        |
| `PASSING_PUBLIC_ORIGIN`         | `http://localhost:3000` | Exact browser origin. Set the same origin for the web and API processes. Use HTTPS in production, without a path or final slash.                                                                    |
| `PASSING_TRUST_PROXY`           | `none`                  | Use `none`, or a comma-separated list of trusted proxy IP addresses or CIDR networks. Production requires an explicit value. Boolean values, hop counts, hostnames, and `/0` networks are rejected. |
| `PASSING_STORAGE_BYTES`         | `10000000000`           | Maximum sum of all transfer storage reservations.                                                                                                                                                   |
| `PASSING_DISK_HEADROOM_BYTES`   | `512000000`             | Disk space to keep free after pending reservations.                                                                                                                                                 |
| `PASSING_MAX_TRANSFERS`         | `10000`                 | Maximum number of stored transfer records, including failed deletes.                                                                                                                                |
| `PASSING_MAX_STREAMS`           | `32`                    | Maximum number of active upload and download streams together.                                                                                                                                      |
| `PASSING_MAX_UPLOADS`           | `8`                     | Maximum number of active uploads.                                                                                                                                                                   |
| `PASSING_MAX_DOWNLOADS`         | `24`                    | Maximum number of active downloads.                                                                                                                                                                 |
| `PASSING_DOWNLOAD_ATTEMPTS`     | `10`                    | Download attempts per transfer. Failed and cancelled accepted attempts count.                                                                                                                       |
| `PASSING_GLOBAL_BYTES_PER_HOUR` | `100000000000`          | Shared hourly budget for accepted uploads and downloads.                                                                                                                                            |
| `PASSING_STREAM_TIMEOUT_MS`     | `300000`                | Maximum duration of one stream. Transfer expiry can stop a stream earlier.                                                                                                                          |

The following limits are fixed: 100 MB plaintext, the shared encrypted size limit,
five sessions per network per minute, two active uploads per network, 1 GB of
accepted uploads per network per hour, four active downloads per network,
2 GB of accepted downloads per network per hour, and two downloads per transfer
at the same time. Each network has 120 requests per minute and 16 requests at
the same time. The API has 3,000 requests per minute, 256 requests at the same
time, and 512 open connections. Rate memory has at most 20,000 network entries.

The API checks the network request limit before the shared request limit.
Requests rejected by the network limit or a full network entry table do not
use the shared request allowance. The shared limit applies to requests that
pass the network check, including malformed router requests. A request
rejected by the shared limit still counts toward the network limit.

## Storage and cleanup

Reports use three additional configurable limits:

| Variable                                    | Default | Function                                                                      |
| ------------------------------------------- | ------- | ----------------------------------------------------------------------------- |
| `PASSING_REPORTS_PER_HOUR`                  | `3`     | Report attempts per network per hour, including repeats and invalid requests. |
| `PASSING_GLOBAL_REPORT_ATTEMPTS_PER_MINUTE` | `100`   | Report attempts per minute across the API, after the network check.           |
| `PASSING_GLOBAL_REPORTS_PER_HOUR`           | `100`   | Saved new holds per hour across the API.                                      |

`POST /api/transfers/:id/report` accepts only `{comment:string}`. Comments must
have 10–1000 characters. The route has an 8 KiB JSON body limit and rejects
control characters, standard share-key strings, and extra fields. Production
requires the configured Origin. The reply is `202 {accepted:true}` for both
known and unknown IDs when capacity is available. When new-hold capacity is
full, all well-formed reports return the same `429`. Reports that create no
hold spend only attempt budgets. A failed database write spends no hold
capacity. An accepted report for
a live transfer commits a persistent hold before it cancels active streams.
Public metadata and content return generic `404` responses while held.

The owner can use the optional [browser admin page](../docs/admin.md), or local
commands to list comments and approve or delete a report.
These commands use SQLite transactions while the API runs. They do not start a
second API, bypass file ownership, or remove files outside the API cleanup.
Read [the review guide](../docs/reports.md) for commands and retention rules.

Set `PASSING_ADMIN_KEY` to 64 lowercase hex characters from 32 random bytes to
enable `/api/admin/*`. An unset or empty key disables these endpoints. A
malformed nonempty key stops startup. Keep this setting on the API only.
The web page at `/admin` contains no record data before sign-in. See the
[admin guide](../docs/admin.md) for session limits and endpoint details.

Run one API process for each data directory. A separate SQLite ownership lock
rejects a second process. The OS releases this lock after a crash. Use local
disk with SQLite lock support. Do not put the directory in a public web root.
The API rejects the local Next `public` and `.next/static` paths.

SQLite holds transfer state, declared sizes, deadlines, attempt counts,
capability hashes, and open reports. A report stores its file ID, random report
ID, comment, and time. File names contain a random transfer id and a fixed
extension. The API does not add raw capabilities or connection addresses to
stored records. Report comments are user-written text. The API does not parse
or decrypt file content.

Storage is reserved in a SQLite transaction. The disk check includes pending
reservations and free-space headroom. It repeats the disk snapshot if an upload
completion changed the accounting during the check. Each transfer keeps its
full reservation until all data files are deleted. A failed delete denies
access immediately and keeps the record for retry. This prevents a second
refund and prevents new uploads from using space that is still occupied.

An upload consumes its capability when the API accepts it. Invalid length,
stream errors, cancellation, timeout, and write failures cannot publish data.
Uploads use exclusive private temporary files. Completion requires the exact
byte count, file sync, closed file, rename, and a state check. The TTL starts
at completion. Pending sessions expire after 30 minutes.

`POST /api/transfers/:id/expiry` requires the deletion capability as a Bearer
token and accepts only JSON `{ttlSeconds:number}`. Use one of the six upload
time choices. The new expiry is the save time plus that period. The response is
`200 TransferMetadata`. Production requests require the configured Origin.
Pending, expired, deleting, and reported transfers return `404` with a valid
capability. Missing or incorrect capabilities return `401`. Changes survive
restart and keep the download-attempt count and storage reservation.
Active streams use the new expiry without resetting their maximum duration.

Deletion and expiry stop active transfers. Cleanup waits for file handles to
close before it removes files. This also supports Windows delete rules. A stream
keeps its resource slot until both its file and HTTP response are closed.
Range and HEAD downloads are rejected. Each accepted download consumes an
attempt before the file is opened.

When no attempts remain, the API returns `429 DOWNLOAD_LIMIT` without a
`Retry-After` header. This limit does not reset. The recipient needs a new
transfer from the sender. Other temporary rate limits include `Retry-After`.

Cleanup runs every minute. Startup cleanup completes before the API accepts
traffic. It removes expired sessions, interrupted uploads, and orphan files.
It also removes ready records with missing or invalid data files. A startup
cleanup failure stops startup. A later cleanup failure keeps denied records
for the next retry.

## Proxy and origin integration

The public origin must match the browser origin exactly. Production creation
requires that Origin header. Upload and delete requests without Origin need
their capability and `Content-Type: application/octet-stream`. Browser deletes
can omit Content-Type when they send the allowed Origin. Creation accepts only
JSON. Unexpected fields and request bodies are rejected. There is no CORS rule.

The reverse proxy must replace untrusted forwarded headers with the actual
connection address. Set `PASSING_TRUST_PROXY` only for that proxy. If it is
`none`, all requests from one reverse proxy share the same rate budget. The API
groups IPv6 clients by /64 and treats IPv4-mapped IPv6 as IPv4.

Request and error logging are disabled. The entry point prints only a generic
startup failure. Disable access logs at the public proxy and hosting layer too.
Do not expose the data directory through a static file server.

Creation reserves storage and consumes a session allowance. It does not charge
the hourly byte budgets. Pending deletion, pending expiry, and failed storage
reservations therefore do not consume transfer capacity. Storage, disk headroom,
record count, session, and request limits still bound pending transfers.

Each accepted upload or download charges its full encrypted size. The API checks
the current network budget and the shared global budget before it claims the
upload capability or download attempt and before it opens a file. A byte-limit
rejection changes neither byte counter and consumes neither capability nor
download attempt. A pending upload can be retried until its original deadline.
Creation does not guarantee byte capacity for a later upload. An upload from
another network charges only the network that sends the upload, once.

Accepted attempts keep their full charge after failure, cancellation, expiry,
or deletion, even if only part of the file was transferred. This conservative
rule prevents repeated partial transfers from avoiding the byte limit. Storage
release does not refund transfer work. Upload and download network budgets are
separate; their global byte budget is shared.

HMAC network ids and byte charges exist in bounded process memory only. Secrets
rotate hourly. A previous secret remains until its live counters have expired,
so rotation cannot reset a live budget. Byte counters use one-hour windows.
Restart clears this temporary rate state. Persistent storage reservations and
download-attempt counts remain. Every upload after restart must obtain a fresh
byte budget; startup removes interrupted uploads before it accepts requests.

## Tests and test options

Run:

```text
npm test -- server/
```

Options are `env`, `dataDir`, `now`, `limits`, and `cleanupIntervalMs`. See
`AppOptions` for their types. `now` returns milliseconds. Real timers still
enforce stream deadlines. `cleanupIntervalMs: 0` disables periodic cleanup for
tests. `app.cleanupTransfers()` runs one cleanup pass with the test clock.
Each test must use its own private data directory and close the app.

Tests use actual HTTP chunked uploads, disconnected clients, and stalled
downloads. They check exact byte limits, one-use tokens, concurrent uploads,
download attempts, stream cancellation, production origins, proxy trust,
disk limits, reservation races, write failure, failed deletion, restart cleanup,
token hashes, path checks, and bounded HMAC rate state.
