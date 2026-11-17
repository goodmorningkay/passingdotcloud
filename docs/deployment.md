# Deploy with Docker Compose

This setup runs Next.js, Fastify, and Nginx on one Linux server. Nginx serves
HTTPS and forwards `/api/` to Fastify. SQLite and encrypted files share a
local Docker volume. Use one API process per data directory.

If Caddy already serves HTTPS on the host, follow the
[Caddy guide](deployment-caddy.md).

## Prepare the host

1. Install Docker Engine and the Compose plugin.
2. Check out a release that passed CI. Run the commands from that directory.
3. Point your domain at the server and allow TCP ports 80 and 443. Keep ports
   3000 and 4000 private.
4. Copy `deploy/nginx.conf` to a host configuration directory. Replace every
   `files.example.com` in the copy with your domain.
5. Create a private `.env` with mode `0600`. Use an absolute path for the copied
   Nginx configuration.

   ```dotenv
   PASSING_PUBLIC_ORIGIN=https://files.example.com
   PASSING_NGINX_CONFIG=/etc/passing-cloud/nginx-v1.conf
   PASSING_RELEASE=<full-commit-id>
   ```

Compose requires `PASSING_PUBLIC_ORIGIN` and `PASSING_NGINX_CONFIG`. Use the
exact HTTPS origin of your site without a path or final slash. Set a new
image tag with `PASSING_RELEASE` for each release.

The internal Docker network uses `172.30.48.0/28`. If it overlaps another
network, update the subnet, the fixed container addresses, and
`PASSING_TRUST_PROXY` in the Compose file together. The proxy replaces
forwarded address headers before it contacts the app.

Allow disk space for the storage budget, SQLite, and Docker images.

## Get a certificate

Free port 80 before the first certificate request. Use your domain and an
email address you control.

```sh
docker compose --profile tools run --rm --service-ports certbot certonly --standalone --non-interactive --agree-tos --email admin@example.com -d files.example.com
```

Certbot stores certificates and account keys in `deploy/certs/`. Set
`PASSING_CERTS_DIR` to an absolute directory to share the same certificates
across releases. Keep that directory private.

## Start and verify

```sh
docker compose config --quiet
docker compose build web api
docker compose pull proxy
docker compose up -d --no-build --wait --wait-timeout 120
docker compose exec -T proxy nginx -t
curl --fail https://files.example.com/api/health
```

Send a test file through public HTTPS. Download it, compare the bytes, and
delete it from the upload tab. Check a 100 MB file before you rely on a
separate proxy or CDN. Keep request and response buffering off for file
transfers. Preserve the app's CSP, cache headers, and no-log settings.

If a CDN fronts the app, verify HTTPS to the origin. Limit origin access to
the CDN's proxy addresses and trust client-address headers only from those
addresses. Disable access logging, analytics, and email rewriting for the
app at the CDN.

## Optional settings

| Setting                            | Use                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| `PASSING_ADMIN_KEY`                | Enable `/admin`. Compose passes the key only to the API.                                       |
| `PASSING_FEEDBACK_EMAIL`           | Add a public feedback email address.                                                           |
| `PASSING_BITCOIN_DONATION_ADDRESS` | Enable donations to a public Bitcoin address. The app uses it for the QR code and wallet link. |

Set these values in the deployment `.env`. To generate the admin key and
verify sign-in, follow the [admin guide](admin.md). For storage, rate, and
stream settings, see the [API reference](../server/README.md#environment).

## Renew the certificate

Use the shared ACME webroot so Nginx can continue to serve the app.

```sh
docker compose --profile tools run --rm certbot renew --webroot -w /var/www/acme --dry-run
```

Schedule the commands below on the host. Reload Nginx after the renewal
command succeeds.

```sh
docker compose --profile tools run --rm certbot renew --webroot -w /var/www/acme --quiet && docker compose exec -T proxy nginx -s reload
```

## Update and recover

For an upgrade from a release with a built-in origin, copy the working Nginx
configuration for your domain. Set `PASSING_NGINX_CONFIG` to the absolute
path of that copy and `PASSING_PUBLIC_ORIGIN` to the existing site origin in
the new release's `.env`. Keep the existing certificate directory and transfer
volume. Run `docker compose config --quiet` before you replace containers.

When you change Nginx settings, use a new configuration file and keep the
previous file for recovery. Keep the previous checkout, environment file,
and images. After the build, run
`docker compose up -d --no-build --wait --wait-timeout 120` and verify HTTPS
and a test transfer. An API restart ends active streams and admin sessions.
Complete files remain available until expiry.

To recover, check storage schema compatibility first. Start the previous
checkout with its saved environment, Nginx configuration, and images. Keep
the same transfer volume.
`docker compose down -v` deletes it. Exclude transfer storage from backups
and snapshots.

For manual release deployment and recovery over SSH, see
[Deploy from GitHub Actions](deployment-actions.md).

## Monitor transfers

Run this check from a separate host with Node.js 24 and the production npm
dependencies.

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm run monitor:transfer -- https://files.example.com
```

The monitor sends 1 KiB of test bytes through the API. It compares the
downloaded bytes and deletes the test transfer. It reports the result and
failure stage. Browser tests cover encryption and decryption.

To schedule this check on a Linux host, use the service and timer in
`deploy/`. Set `PASSING_MONITOR_ORIGIN` in the private environment file from
the service definition and check its Node and checkout paths. Monitor free
disk separately.
