# passing.cloud

Temporary file sharing with browser encryption. No account is required.

Send files up to 100 MB each. Each file gets a share link that expires one
hour after upload by default. The browser encrypts file names and contents
before upload. The key stays in the part of the link after `#`.

## Run locally

Use Node.js 24.13 or later in the Node.js 24 release line.

```sh
npm ci --ignore-scripts
npm run dev
```

Open <http://127.0.0.1:3000>. The command starts Next.js and the API. The API
stores encrypted files and a SQLite database in `data/`. To change the
defaults, copy `.env.example` to `.env`.

## Self-host

Run one API process per data directory. Use local disk and serve the app over
HTTPS. See the [Docker deployment guide](docs/deployment.md) or the
[Caddy guide](docs/deployment-caddy.md).

- [API settings and limits](server/README.md)
- [Encryption and data retention](docs/security.md)
- [Admin setup](docs/admin.md) and [file reports](docs/reports.md)
- [iPhone and iPad Home Screen app](docs/pwa.md)

## Check changes

```sh
npm run check
npx playwright install chromium webkit
npm run test:e2e
```

The browser tests use a production build and separate test data. Stop local
servers on ports 3000 and 4000 first, or run the build and tests on other ports.

```sh
API_ORIGIN=http://127.0.0.1:14000 npm run build
PASSING_E2E_WEB_PORT=13000 PASSING_E2E_API_PORT=14000 npm run test:e2e
```

On Windows, the Chromium tests use installed Chrome by default. Set
`PLAYWRIGHT_CHANNEL=chromium` to use downloaded Chromium.

## License

[MIT](LICENSE)
