# Browser admin

The owner page is `/admin`. It lists stored file records and open reports.
You can delete a file or close a report and restore access. File names and
contents remain encrypted. There is no file preview or decryption control.

## Enable sign-in once

The admin password is stored as `PASSING_ADMIN_KEY` in the deployment `.env`.
The sign-in form calls this password the **Admin key**. It is required to use
`/admin`; there is no default password.

1. Create a random key with 64 lowercase hex characters. You can use a password
   manager that can generate a 256-bit hex key. You can also run this command:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

2. Save the key in your password manager. Set `PASSING_ADMIN_KEY` to that value
   in the API's private environment. For local development, use `.env`. For the
   supplied Docker deployment, use the deployment `.env`. Do not commit the
   key. Do not use a `NEXT_PUBLIC_` setting.
3. Restart the local app, or recreate the API container after deployment:

   ```sh
   docker compose up -d --no-deps api
   ```

   For the Caddy deployment, add `-f compose.caddy.yaml` after `compose`.
   An API restart stops active transfers and ends all admin sessions.

4. Open `/admin` on the same origin as the app and sign in with the key. For
   local development, use `http://127.0.0.1:3000/admin`. Bookmark this address.

An empty or absent key disables the admin API. A malformed key stops API
startup. Production requires HTTPS. There is no default key or reset page.
To replace a lost key, set a new random key on the API and restart it.

The key gives full owner access to file records and deletion. This version is
for one owner. It has no separate reviewer accounts or multi-factor sign-in.

## Use the page

- **Files** lists current records. Search with a full file ID or its first
  characters. Do not paste a share link. Use **Status** to filter the list.
- **Reports** shows files with open report holds. Select **Details** to read
  the comment as text. The server cannot verify the reported contents.
- **Approve file** closes the report and restores access. Confirm the action.
  Expiry and download limits stay the same. A stale report cannot be approved.
- **Delete file** stops access and removes the file. Confirm the action. If
  disk removal fails, the page shows **Deletion pending**. Cleanup retries each
  minute. You can also select **Retry deletion**.
- **Refresh** reads the current records. The page does not poll in the
  background. **Sign out** ends the current session.

The list has 25 rows per page, ordered by the soonest expiry or upload deadline.
File size is the size declared by the sender. Encrypted size is the storage
reservation. The counts cover current records only. Pending uploads and pending
deletions use storage. Download attempts include cancelled or failed attempts.
There is no historical usage chart, file history, or saved report history.

New uploads, deletion, and expiry can move records between pages. Refresh before
an action if the list has been open for some time. Every change is checked again
by the API. A lost response can leave the result unknown; refresh before retry.

## Access and retention

Sign-in lasts one hour. The browser holds an `HttpOnly` session cookie. In
production it also has `Secure`, `SameSite=Strict`, and the `__Host-` prefix.
The API stores session token hashes in memory, with at most 16 sessions. A new
session at this limit removes the oldest one. Logout, expiry, an API restart,
or key replacement ends the applicable sessions.

Sign-in allows 5 attempts per network per 15 minutes. Correct keys, wrong keys,
and malformed or oversized JSON bodies count after the Origin and content-type
checks. A network at this limit must wait, even with the correct key.

The service also allows 50 successful sign-ins per 15 minutes. This shared limit
is checked after key verification and before any session change. Wrong keys and
invalid bodies do not use this shared login allowance. Thus, failed attempts
from other networks cannot use it to block an owner with the correct key.
The shared window starts with the first successful sign-in. Both limits return
`429` with `Retry-After` until their window ends. Active sessions stay valid
when either login limit is reached.

The shared limit bounds session creation. It does not limit key guesses across
all networks. General API request and connection limits still apply, and JSON
bodies are limited to 1 KiB. An API restart clears memory counters. No raw
network address is saved.

Every admin API route checks the session. Changes require the configured Origin
and a session-bound request token. File records, keys, and comments are not
saved in browser storage. Responses are not cached. The admin cookie is the
only added browser storage. Transfer users do not need it.

Report comments keep the existing retention rules. Approval removes the comment.
File removal also removes its report. Expired or deleting records do not show
comments in the admin list. No lasting activity log is added. The local report
commands still work and use the same report decision transaction.

## API routes

| Route                              | Function                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `POST /api/admin/login`            | Exchange `{key}` for a session cookie and request token.                      |
| `GET /api/admin/session`           | Read the current session expiry and request token.                            |
| `POST /api/admin/logout`           | End the session; accepts `{}`.                                                |
| `GET /api/admin/files`             | Read records and totals; accepts `query`, `status`, and `page`.               |
| `POST /api/admin/files/:id/delete` | Delete a file; requires `{confirmation: id}`.                                 |
| `POST /api/admin/files/:id/review` | Review the current report; requires `{confirmation: id, reportId, decision}`. |

`decision` is `approve` or `delete`. All changes after login require the
`X-Admin-CSRF` header. Delete replies are `200 {deleted:true}` after removal or
`202 {deleted:false}` when access is blocked and disk cleanup is pending.
Stale report decisions return `409`. Invalid sessions return `401`.
