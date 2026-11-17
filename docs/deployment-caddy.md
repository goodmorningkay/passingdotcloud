# Deploy behind Caddy

Use this setup when Caddy already serves HTTPS on the host. Caddy sends
requests to Nginx through a Unix socket. The containers have no public ports.

## Prepare the host

1. Install Docker Engine and the Compose plugin. Check out a release that
   passed CI.
2. Copy `deploy/nginx.caddy.conf` and `deploy/Caddyfile.test` to host
   configuration directories. Replace every `files.example.com` in both copies
   with your domain.
3. Install `deploy/passing-cloud-test.tmpfiles.conf` in `/etc/tmpfiles.d/`.
   Check the Caddy group in that file, then run `sudo systemd-tmpfiles --create`.
   The Caddy user must have access to `/run/passing-cloud-test/proxy.sock`.
4. Create a private `.env` with mode `0600`.

   ```dotenv
   PASSING_PUBLIC_ORIGIN=https://files.example.com
   PASSING_NGINX_CONFIG=/etc/passing-cloud/nginx-caddy-v1.conf
   PASSING_RELEASE=<full-commit-id>
   ```

Compose requires the HTTPS origin of your Caddy site and the path of your
Nginx configuration. See [optional web and API settings](deployment.md#optional-settings).

## Preserve proxy and privacy settings

- Keep `PASSING_TRUST_PROXY` set to the Nginx address `172.30.48.2`. Caddy
  replaces the forwarded headers. Nginx trusts the client address from its
  Unix socket and replaces the headers again for the API.
- If a CDN supplies a client-address header, configure Caddy to trust only
  that CDN's proxy addresses. Restrict direct access to the origin when you
  rely on CDN filtering.
- Keep the app's CSP and cache headers. Leave Caddy access logs and request
  error logs off for this site. Use the log name from `deploy/Caddyfile.test`
  in the global block.

  ```caddyfile
  log default {
      exclude http.log.error.passing_cloud_test
  }
  log app_request_errors {
      include http.log.error.passing_cloud_test
      output discard
  }
  ```

- Set Caddy's total `read_body` and `write` timeouts to at least `310s` for
  five-minute transfers. Preserve the app's request, stream, and size limits.
- Keep the transfer volume out of backups and snapshots. Use one API
  process per data directory.

The app network is internal. If the host filters bridge packets, permit
traffic within `br-passing-test` and `172.30.48.0/28`. Keep the socket
directory private.

## Start and verify

```sh
docker compose -f compose.caddy.yaml config --quiet
docker compose -f compose.caddy.yaml build web api
docker compose -f compose.caddy.yaml pull proxy
docker compose -f compose.caddy.yaml up -d --no-build --wait --wait-timeout 120
docker compose -f compose.caddy.yaml exec -T proxy nginx -t
```

Import your copy of the site configuration outside the global block in
Caddyfile. Check and reload the Caddy configuration.

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://files.example.com/api/health
```

Caddy obtains and renews the public certificate. If you use systemd to start
the app, set the checkout path in `deploy/passing-cloud-test.service`.

Verify upload, download, and early deletion over HTTPS, including a 100 MB
file. Check that the other sites on Caddy still work. Use the
[transfer monitor](deployment.md#monitor-transfers) for an API check.

## Update and recover

When you upgrade from a release with a built-in origin, keep the existing
Caddy site origin and Unix socket. Follow the
[upgrade steps](deployment.md#update-and-recover) with `-f compose.caddy.yaml`
after `docker compose`. Start the new release with the same Compose project
and transfer volume.

To recover, start the previous release with its saved images after you check
storage schema compatibility. For GitHub Actions release automation, see
[Deploy from GitHub Actions](deployment-actions.md).
