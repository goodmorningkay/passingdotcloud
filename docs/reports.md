# File reports and owner review

Anyone who knows a file ID can report it at `/report`. The receiver page also has a **Report this file** link. A report needs a comment of 10 to 1000 characters. The form sends the file ID and comment. It does not attach the share key, a contact address, or any account details.

The API saves the hold before it stops active streams. New metadata and download requests then return the same `404` as an unavailable file. A restart keeps the hold. Reported files still use their storage reservation. The original expiry time applies; a report does not keep a file forever. A report during an active upload stops the upload and removes its incomplete data.

## Report limits

Report attempts and new holds have separate limits:

| Limit                        | Default        | Setting                                     |
| ---------------------------- | -------------- | ------------------------------------------- |
| Attempts per network         | 3 per hour     | `PASSING_REPORTS_PER_HOUR`                  |
| Attempts across the service  | 100 per minute | `PASSING_GLOBAL_REPORT_ATTEMPTS_PER_MINUTE` |
| New holds across the service | 100 per hour   | `PASSING_GLOBAL_REPORTS_PER_HOUR`           |

IPv6 addresses in one /64 share a network budget. Origin and content-type checks run first. All later report attempts count against the network limit, including duplicate reports, unknown IDs, invalid IDs, and malformed JSON. Attempts that pass the network limit also count against the shared attempt limit. The general request, connection, and 8 KiB report body limits also apply.

Only a saved new hold uses the hourly hold allowance. Invalid requests, unknown IDs, expired or deleted files, duplicate reports, and failed database writes do not use this allowance. The API checks capacity, saves the hold, and counts it without an asynchronous gap. The first saved hold starts the one-hour window. Approval or deletion does not refund a saved hold. A new report after approval needs new capacity.

Only the first report for a file creates a record. Repeat reports do not change the first comment, add rows, or extend expiry. Unknown IDs receive the same receipt, but do not create records. When the hold allowance is full, all well-formed reports receive the same `429`, including unknown IDs and repeats. This keeps the response from revealing whether an ID exists. Existing holds stay in force. A rejected request does not create a hold. `429` responses give a `Retry-After` value in seconds.

The shared attempt limit bounds parsing and database work. Attempts that create no hold can still fill this short limit and delay a report until its one-minute window ends. They cannot spend the separate hourly hold allowance. Repeated attempts can also fill their network's one-hour limit. These limits reduce repeated reports; they do not prove that a report is correct.

The counters use bounded memory. Network counters use rotating HMAC identifiers. An API restart clears the counters. It does not clear stored report holds.

## Read the review list

The owner can use the [browser admin page](admin.md) at `/admin` after setup.
Select **Reports**, then **Details** to read a comment and approve or delete
the file. The local commands below remain available.

Run this command as the server owner, from the app directory:

```sh
npm run reports -- list
```

With the supplied Docker deployment:

```sh
docker compose exec -T api npm run reports -- list
```

The output shows each open report's file ID, report ID, comment, report time, file size, state, and expiry. The API can stay running. The command reads the same private SQLite database. Filesystem permissions control access to the command. Browser review requires a separate admin session.

The local command reads `.env` if it exists. Set `PASSING_DATA_DIR` to the API's data directory when it is not `./data`. The Docker command uses the API container's existing setting. Start the updated API once before the first review command so it can add the report table to an existing database.

## Approve or delete

Replace `FILE_ID` and `REPORT_ID` with the values from the review list:

```sh
npm run reports -- approve FILE_ID REPORT_ID
npm run reports -- delete FILE_ID REPORT_ID
```

For Docker:

```sh
docker compose exec -T api npm run reports -- approve FILE_ID REPORT_ID
docker compose exec -T api npm run reports -- delete FILE_ID REPORT_ID
```

Approval removes that report and restores access. It does not extend expiry, reset download attempts, or revive a file that has expired or been deleted. If the file is still a pending upload, its original upload deadline applies.

Deletion blocks access and marks the file for cleanup. A local command leaves file removal to the API's next cleanup pass, normally within one minute. Browser deletion asks the running API to remove the file at once. A failed disk deletion keeps the storage reservation until a retry succeeds. Restart cleanup also processes these deletions.

Use the report ID you reviewed. If another report is made after approval, it gets a new report ID. An old approval command cannot release that newer hold.

## Comments and encrypted contents

Comments are readable text in SQLite. They are not encrypted with the file key. The form asks users to omit personal details and encryption keys. It rejects control characters and standard share-key strings to reduce accidental disclosure. This input guard cannot identify every form of sensitive text.

The service does not add IP addresses or network identifiers to report records. A comment remains only until review closes the report, the sender deletes the file, or expiry cleanup removes it. There is no report-history or reviewer-activity log. Storage failures can delay physical removal, as they can for file deletion.

The stored file ID is not an encryption key. The review list cannot show the original filename or plaintext. To inspect the contents, you need the original full share link from a separate source. No decryption key is collected automatically by the report form. Do not paste one into the comment.

Blocking stops server access. It cannot remove bytes or files that a recipient already received.
