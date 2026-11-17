# Project instructions

Use ASD-STE100 Simplified Technical English in replies and user-facing text.

## Project and code layout

passing.cloud provides temporary file transfers without user accounts. The
browser encrypts each file. A separate Fastify API stores encrypted bytes on
private local disk and transfer records in SQLite through `node:sqlite`.

- `app/` contains Next.js App Router pages and metadata. `components/` contains
  the React interface. Shared styles are in `app/globals.css`; component styles
  also use CSS modules.
- `lib/client/` contains browser encryption, the encryption worker, and API
  clients. Keep browser operations here and use relative `/api` URLs.
- `lib/shared/` contains shared types, file-format constants, size limits,
  expiry choices, and report validation. Use these definitions in both the
  browser and API. Do not duplicate them in components or routes.
- `server/app.ts` exports `createApp(options?)` for the API and its tests.
  `server/index.ts` starts the API. Keep API routes in `server/`, not in Next.js
  route handlers. Storage, rate limits, admin access, and report review are
  also in this directory.
- `proxy.ts` sets the page Content Security Policy with a new nonce for each
  request. `next.config.ts` sets other headers and forwards local `/api`
  requests. The production Nginx configurations send `/api` directly to Fastify.
- `tests/e2e/` contains Playwright browser tests. Vitest tests are beside the
  code in `server/`, `lib/`, and `components/`.
- `deploy/`, `Dockerfile`, and the two Compose files define deployment.
  Use one API process per data directory. The storage design requires local
  disk and SQLite locks.

## Local development

Use Node.js 24.13 or later within the Node 24 release line. Use npm and keep
`package-lock.json` consistent with dependency changes.

```sh
npm ci --ignore-scripts
npm run dev
```

The dev command starts Next.js and the API. Open `http://127.0.0.1:3000`;
the browser origin must match the API configuration. Copy `.env.example` to
`.env` only to change defaults. Keep credentials and private data out of Git.
The default data directory is `data/`.

## Rules to preserve

- Encrypt file names, MIME types, and file contents in the browser. Do not
  add them to transfer request metadata. Keep the encryption key in the URL
  fragment (`#`), never in a query string or an API request.
- Keep transfer keys and deletion tokens out of persistent browser storage,
  logs, and telemetry. Upload and deletion tokens are separate capabilities;
  the API stores their hashes. Admin sessions use a separate `HttpOnly` cookie.
- Keep the `PASSCLD1` format and its authenticated final-record and size checks
  consistent between encryption and decryption. Encryption uses a bundled
  worker. `lib/client/sodium.ts` depends on the pinned `libsodium-wrappers`
  version for its CommonJS import and WASM state cleanup. Check these parts
  when changing the library or worker build.
- Apply the file-size limit to each file. Encrypt and upload selected files
  one at a time. Keep completed links after a failure or cancellation, and
  retry only files that did not complete.
- Start a download only after the user selects Download. Do not consume a
  download attempt on page load. Verify the complete encrypted file before
  offering the decrypted download. Do not render received files as HTML.
- Start expiry when an upload completes. An expiry change requires the
  deletion token and must preserve download counts and resource limits.
- Deny access and stop active streams on expiry, deletion, or a report hold.
  Keep the storage reservation until file removal succeeds. Preserve cleanup
  retries, startup cleanup, and the checks that prevent incomplete uploads
  from becoming available.
- Report holds survive an API restart and do not extend expiry. Review must
  use the current report ID. Keep share keys out of report requests. Admin file
  changes require a valid session, the allowed Origin, and the session's CSRF
  token. Admin access stays disabled when no admin key is configured.
- Preserve origin checks, explicit proxy trust, bounded rate counters, and
  stream and byte limits. Keep request logging disabled. Read
  `docs/security.md` before changing data collection or retention.
- Preserve dynamic page rendering, CSP nonces, and `no-store` responses for
  private data. The Home Screen app requires a network connection and has no
  service worker or offline transfer cache. Keep transfer secrets out of
  page metadata and shared previews.

When changing an API contract, shared limit, or file format, update its
producers and consumers together. Update the relevant documentation when
behavior or configuration changes.

## Testing

Keep testing proportional to the risk and complexity of the change.

- Add tests for important user behavior, plausible failures, and
  regressions. Each new test should catch a distinct, meaningful bug.
- Prefer extending existing tests. Avoid covering the same behavior
  repeatedly across unit, component, and end-to-end tests unless
  each level addresses a different risk.
- Test observable outcomes. Avoid tests coupled to private functions,
  incidental DOM structure, or mocks that bypass the actual behavior.
- Do not add tests for simple copy, styling, or layout changes by default.
- Do not chase test counts or coverage percentages, or introduce new
  testing infrastructure unless the task warrants it.
- Run relevant existing checks. Once the changed behavior and identified
  risks are verified, stop. Report any verification gaps.

### Existing checks

- `npm test -- <path>` runs selected Vitest tests, for example
  `npm test -- server/request-budget.test.ts` or `npm test -- lib/client/`.
  The root Vitest configuration uses the Node environment.
- API tests use `createApp` with a private temporary data directory. Close
  each app and remove its test directory after use. Use actual HTTP streams
  when checking disconnects, cancellation, or stream limits.
- `npm run lint`, `npm run typecheck`, and `npm run build` are separate checks.
  Use `npx prettier <changed-files> --check` for a focused format check.
- `npm run check` runs the full Prettier, ESLint, TypeScript, Vitest, and
  production-build checks. CI also runs browser and container checks. Choose
  local checks to match the change and the risks above.
- Browser tests require a production build. Run `npm run build`, install
  browsers with `npx playwright install chromium webkit` if needed, then use
  `npm run test:e2e -- <spec-path>` for selected tests. Tests run in Chromium;
  PWA tests also run in WebKit with an iPhone profile.
- Browser setup starts both servers and creates separate data in `.test-data/`.
  Ports 3000 and 4000 must be free. To use other ports, set `API_ORIGIN` during
  the build and set `PASSING_E2E_WEB_PORT` and `PASSING_E2E_API_PORT` for the
  tests, as shown in `README.md`. Do not run tests against live transfer data.

## Further guidance

- `README.md`: local use, current features, and check commands.
- `server/README.md`: API configuration, storage rules, limits, and test options.
- `docs/security.md`: encryption format, privacy, and access rules.
- `docs/reports.md` and `docs/admin.md`: report holds, review, and owner access.
- `docs/pwa.md`: Home Screen behavior, icon generation, and device checks.
- `docs/deployment.md` and `docs/deployment-caddy.md`: hosting and proxy setup.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
