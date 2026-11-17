# Security and privacy design

## Data flow

1. The browser creates a random 256-bit key.
2. A local worker encrypts the file name, MIME type, and file contents with libsodium `crypto_secretstream_xchacha20poly1305`.
3. The browser requests a transfer using only the file size, encrypted size, and expiry choice.
4. The API reserves disk space and returns separate upload and deletion capabilities.
5. The browser uploads the encrypted file. The API checks its length, syncs the temporary file, and publishes it. The expiry period starts now.
6. The sender shares `/t/<random-id>#<key>`. The fragment stays in the recipient's browser.
7. The recipient chooses Download. The browser verifies and decrypts every record. It creates a download only after the final authenticated record and length checks pass.

No direct connection exists between the sender and recipient. Users do not receive each other's IP address from the app.

## Encryption format

`PASSCLD1` identifies version 1. It is followed by a 24-byte secretstream header and encrypted records. Each record has a 4-byte big-endian length prefix. The first record contains an encrypted JSON manifest. Data records contain at most 1 MiB of plaintext each. The final data record must have the authenticated final tag. Empty files have one empty final record.

The decoder limits the manifest, record lengths, total encrypted bytes, total plaintext bytes, and file size. It rejects incorrect keys, changed or reordered records, missing final records, extra bytes, unsafe manifest fields, and truncated streams. The library provides the cryptography; this app defines the file container.

`libsodium-wrappers` is pinned to 0.7.16. Its CommonJS export is bundled locally because that release's ESM export refers to a missing file. The state cleanup uses this pinned release's WASM exports. Review and test that code when you update the library. No script, font, tracker, or cryptographic dependency is loaded from an external CDN.

The browser holds the encrypted upload and the final download as bounded Blobs.
Encryption reads plaintext in chunks in a worker. Decryption reads the network
stream in chunks. A 100 MB file can require more than 100 MB of browser memory.

## Stored data

SQLite transfer records store random ids, sizes, expiry and pending deadlines, state, download-attempt counts, and SHA-256 hashes of random capabilities. Files use random ids as names. Transfer records do not contain original file names, MIME types, encryption keys, raw capabilities, IP addresses, or network identifiers.

Open reports add a file ID, random report ID, report time, and a required comment. Comments are readable text for the owner. The form does not attach a share key or reporter identity. It asks users to omit personal details and keys, and rejects standard share-key strings and control characters. User-written comments can still contain sensitive information; the input guard is not a complete content filter. Comments are removed when review closes the report or the transfer is deleted. No report history is retained.

HMAC network counters remain in bounded process memory. Secrets rotate. Old generations remain only while live counters need them. IPv4-mapped IPv6 addresses are normalized; IPv6 addresses are grouped by /64. Raw addresses exist while network requests are processed. They are not retained in application records.

The API disables request and error logging. The supplied Nginx configuration disables access logging and discards error output. Docker log storage is disabled. Operational status checks contain no transfer data. Do not add request tracing, error-reporting SDKs, analytics, or access-log collection without changing the privacy statement.

The isolated CI container test retains Docker command output as a failure
artifact for seven days. This test uses separate storage and synthetic transfer
data.

No cookies, service worker, localStorage, IndexedDB, or sessionStorage are used for transfer secrets. The deletion capability lives only in the sender tab. The share link can remain in browser history, clipboard history, or the service used to send the link. Anyone who obtains the full link can open the file.

## Access and deletion

Creation requires the configured origin in production. Mutations reject other origins. Upload and deletion capabilities are independent and checked against stored hashes. Upload capabilities are single-use. The API trusts only the configured proxy address. Nginx replaces forwarded client-address headers.

The sender can use the deletion capability to change expiry before the file expires. Only the six upload time choices are accepted. Each new period starts when saved. The share link does not include this capability. Pending, expired, deleted, and reported files reject changes. An expiry change keeps the download-attempt count and storage reservation. Active downloads use the new expiry, with the original maximum stream duration.

The API checks expiry before access. Expiry and early deletion stop active streams. Cleanup removes expired and failed files every minute, and before startup accepts requests. A failed disk deletion keeps a denied database record and its storage reservation for a later retry. Expired bytes can therefore remain on disk during a storage failure, but the API will not serve them.

Deletion cannot recall a recipient's copy or guarantee erasure from physical storage. Do not back up the transfer volume or include it in snapshots if you promise the stated retention times. The SQLite `secure_delete` setting clears deleted database cells; it does not provide a physical erasure guarantee.

Reports commit a hold before active streams are stopped. Public metadata, uploads, and downloads check the hold. It survives restart and does not extend expiry. The owner reviews reports through a local CLI protected by filesystem permissions or the optional [admin page](admin.md). Approval needs both the file ID and current report ID, so an old decision cannot approve a later report. Owner deletion marks the transfer denied; the API performs file removal and retains its storage reservation until that succeeds. See [the review guide](reports.md).

Admin endpoints are disabled without a server key. The key is 32 random bytes
encoded as lowercase hex. The API compares key hashes and creates a random
session token. Only its hash is stored in bounded process memory. Sessions end
after one hour, on logout, or on API restart. Production cookies use `Secure`,
`HttpOnly`, `SameSite=Strict`, and the `__Host-` prefix. Each state change also
requires the configured Origin and a session-bound CSRF token. Each admin
endpoint checks the session before data access. Responses use `no-store`.
The admin page never puts keys or file records in browser storage. This is a
single-owner interface; it does not provide individual reviewer accounts.

## Resource controls

The API limits session creation, all requests, upload and download bytes, active requests, active streams, download attempts, pending sessions, transfer count, and disk use. Storage reservations are atomic. Failed writes never publish a transfer. Startup removes unfinished uploads and orphan files. A separate SQLite ownership lock prevents two API processes from using the same data directory.

Nginx adds global request and connection limits. These controls bound normal service use; they do not replace the host's network protection. Configure provider traffic alerts. Do not depend on a request rate limit as an exact invoice limit.

## Trust boundary

The hosting and network providers can see connection addresses. The host can
see encrypted file sizes and transfer times.

Users must trust the JavaScript served by the app. Changes to that code can
expose future keys or plaintext. HTTPS, dependency review, restricted server
access, and CSP reduce this risk. The CSP uses a fresh script nonce on each
page and permits the bundled WebAssembly and inline styles.
