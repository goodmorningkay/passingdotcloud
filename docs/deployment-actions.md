# Deploy from GitHub Actions

The **Deploy production** workflow deploys one full commit ID from `main` over
SSH. The latest push run of `ci.yml` for that commit must pass both `check` and
`containers`. A pull request check or a successful check for another commit does
not qualify. The workflow must be on `main` before **Run workflow** is available.

The host keeps its production configuration, credentials, and transfer storage.
The runner sends only a `git archive` of the selected commit. It builds images on
the host while the existing release runs. Container replacement causes a short
interruption. An API restart ends active transfers and admin sessions. Complete
files remain in the same storage location until expiry.

## Prepare the host once

Use an existing, checked deployment from the [standalone guide](deployment.md)
or [Caddy guide](deployment-caddy.md). Install Python 3.11 or later, Docker Engine
with Compose, and systemd. Keep one API container for each data directory.

The examples use `/srv/passing-cloud`. Keep the server address, mount path,
and private operations records outside this repository.

1. Keep source directories under `releases/<full-commit-id>` and point `current`
   at the running source directory. The directories must be owned by root.
2. Create `/etc/passing-cloud/production.env`, owned by root with mode `0600`.
   Set `PASSING_PUBLIC_ORIGIN` to the HTTPS origin from `deploy.json`. Copy
   the existing admin key and capacity settings into this file. The
   deployment script sets `PASSING_RELEASE` for each command.
3. Keep host-specific Compose overrides outside the releases. For standalone
   HTTPS, set `PASSING_CERTS_DIR` to an absolute shared certificate directory.
   Set `PASSING_NGINX_CONFIG` to the absolute path of the Nginx
   configuration for your domain. For Caddy, retain the Unix socket and host
   service. Leave files that your Nginx configuration includes at their
   release paths for recovery.
4. Copy `deploy/deploy.example.json` to `/etc/passing-cloud/deploy.json`. Set its
   paths, project name, public origin, and **existing** data mount. For a named
   volume, `source` is the Docker volume name, such as `passing-cloud_transfers`.
   For a bind mount, set `type` to `bind` and `source` to its absolute path. The
   script refuses a release that changes this mount. It does not create or copy
   transfer storage. Use root ownership and mode `0600` for this file.
5. Install the commands and save the running image IDs:

   ```sh
   sudo install -d -m 0755 /usr/local/libexec
   sudo install -o root -g root -m 0755 scripts/deploy-release.py /usr/local/libexec/passing-cloud-deploy
   sudo install -o root -g root -m 0755 deploy/passing-cloud-deploy-ssh /usr/local/libexec/passing-cloud-deploy-ssh
   sudo /usr/local/libexec/passing-cloud-deploy adopt
   sudo /usr/local/libexec/passing-cloud-deploy info
   ```

   Check public HTTPS and run the transfer monitor before adopting the existing
   release. Adoption records its images and configuration, including the
   main Nginx file from the bind mount. Keep the saved images.

6. If systemd starts this app, install `deploy/passing-cloud-deploy.service.conf`
   as a drop-in for its existing service, then run `sudo systemctl daemon-reload`.
   Keep the existing working directory and any socket setup commands. The new
   start and stop commands use the active release's saved settings and images.
   Installing the drop-in does not require a restart.

Before the first upgrade with this workflow, install the updated
`passing-cloud-deploy` command from step 5. While the current release is still
running and before you edit its Nginx file, run
`sudo /usr/local/libexec/passing-cloud-deploy adopt`. It saves the running
proxy's Nginx file and keeps the recorded image IDs.

Set `PASSING_PUBLIC_ORIGIN` and `PASSING_NGINX_CONFIG` for the next deployment.
Use a new path for changes to Nginx. Keep the original files at the saved
paths for older releases without a copy.

`deploy-state/` contains private configuration snapshots, saved image IDs, and
deployment status. Keep it owned by root with mode `0700`. It contains no transfer
records. Do not add it to Git or to a source archive. Keep `current`,
`last-successful`, `previous`, and their images when removing old releases. Do not
snapshot or back up transfer storage.

## Configure SSH and GitHub once

Create a dedicated `passing-deploy` system account with a locked password. It
needs no Docker group membership. Install `deploy/passing-cloud-deploy.sudoers`
as `/etc/sudoers.d/passing-cloud-deploy`, owned by root with mode `0440`, and check
it with `sudo visudo -cf /etc/sudoers.d/passing-cloud-deploy`.

Create a dedicated Ed25519 key. Add its public key to the account's authorized
keys with this prefix:

```text
restrict,command="/usr/local/libexec/passing-cloud-deploy-ssh" ssh-ed25519 <public-key>
```

Keep the home directory, `.ssh` directory, and authorized keys owned by root and
readable by the account, with modes `0755`, `0755`, and `0644`. The account must
not be able to change the forced command. It can request deployment, status,
confirmation, and recovery. It cannot start a shell or forward connections.

If SSH uses `AllowUsers`, add the deployment account and retain the existing
administrator accounts. Validate the complete SSH configuration with `sshd -t`
before reloading the SSH service.

Use the host's approved SSH network route. Do not widen a restricted firewall
rule merely to admit changing GitHub runner addresses. Confirm the server host
key through the existing trusted SSH connection. Do not accept a key from an
unverified scan during a workflow run.

Create a GitHub environment named `production`. Permit the `main` branch only,
and add these environment secrets:

| Secret                       | Value                                            |
| ---------------------------- | ------------------------------------------------ |
| `PASSING_DEPLOY_HOST`        | Server hostname or IPv4 address                  |
| `PASSING_DEPLOY_USER`        | Dedicated SSH account                            |
| `PASSING_DEPLOY_KEY`         | Dedicated private key                            |
| `PASSING_DEPLOY_KNOWN_HOSTS` | Verified OpenSSH known-hosts entry for that host |

In the same GitHub environment, set the variable `PASSING_PRODUCTION_ORIGIN`
to the HTTPS origin in `deploy.json` and `production.env`. The runner checks
this value with the host before it sends the release and as it checks deployment
status. Set `PASSING_DEPLOY_PORT` if SSH uses a port other than 22.

## Deploy a release

1. Merge the approved change into `main`.
2. Wait for CI to pass for the full commit ID you want to deploy.
3. Open **Actions → Deploy production → Run workflow**. Select `main`, enter the
   full lowercase commit ID, and run the workflow.
4. Check the run summary. Success requires container health, matching image IDs,
   public HTTPS, and the upload, download, byte comparison, and deletion monitor.

The run summary records the selected commit. The workflow does not create an
automatic GitHub deployment record, because that record would use the workflow's
commit on `main`, which can differ from the selected release.

The monitor runs from Actions and checks the public origin. A proxy challenge
counts as failure. Browser encryption remains covered by CI browser tests.

For Cloudflare's Free plan, keep **Bot Fight Mode** off when using GitHub-hosted
runners for these checks. It can challenge the runner, and WAF custom rules cannot
skip it. This setting applies to the whole zone. See Cloudflare's
[Bot Fight Mode limitations](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/#limitations).
Keep the other security controls in place. With **Super Bot Fight Mode**, use a
skip rule scoped to the approved monitor instead.

Both GitHub concurrency and a server lock prevent concurrent changes. A detached
systemd job continues if SSH or Actions stops. The host waits for explicit public
verification before updating `last-successful`. A pending deployment blocks
another deployment and recovery. GitHub keeps at most one pending run in this
concurrency group; a newer request can replace that pending run.

## Check a failure and recover

Check status through the existing administrator SSH connection:

```sh
sudo /usr/local/libexec/passing-cloud-deploy info
sudo /usr/local/libexec/passing-cloud-deploy status <deployment-id>
```

If preparation or build fails, the current containers keep running. A failure
after activation leaves the candidate selected and retains the previous successful
release. There is no automatic rollback. A cancelled workflow can leave a healthy
candidate awaiting verification; run the public checks before confirming success.

If `info` shows a pending deployment, wait for its worker to finish. Then either
repeat the public checks and confirm success, or record failure:

```sh
sudo /usr/local/libexec/passing-cloud-deploy finish <deployment-id> success
sudo /usr/local/libexec/passing-cloud-deploy finish <deployment-id> failure
```

Use only one of those commands. `finish ... success` checks the active commit,
image IDs, and container health again. It must follow successful public checks.

Before recovery, review changes to the SQLite schema and stored file format.
The script cannot prove database compatibility. The required flag records your
confirmation; it does not perform a database migration or restore.

```sh
sudo /usr/local/libexec/passing-cloud-deploy recover <saved-commit-id> --database-compatible
```

Use `last_successful` from `info` after a failed switch, or `previous` after a
successful deployment. Recovery returns a new deployment ID. Check that ID until
it reaches `awaiting-verification`, repeat the public checks and transfer monitor,
and confirm it with `finish ... success`. Recovery uses the saved configuration
and local image IDs, with pulls and builds disabled. The current transfer data
and expiry times stay in effect.

If a saved Nginx snapshot is incomplete, restore the missing file from the
same release before starting it.

Keep failed job IDs for diagnosis. Status reports contain stages and operational
errors, not expanded Compose settings, credentials, transfer IDs, or tokens.
Detailed Docker build output is discarded. To diagnose a failed build, reproduce
the build in an isolated environment from the same commit.

## Test changes

```sh
python3 -B -m unittest discover -s scripts -p 'test_*.py'
npm test -- scripts/deploy-production.test.ts server/monitor.test.ts
python3 -B scripts/rehearse-deployment.py
```

The container rehearsal builds the committed source in a temporary project. It
uses a separate Docker volume, a loopback port, and HTTP with development API
settings. Builds use Docker's default network. It checks container replacement,
public-check failure, image and Nginx recovery, transfer retention, and deletion.
It removes its containers, volume, and image tags when finished. CI runs this
check in the container job. Set
`PASSING_REHEARSAL_SUBNET` to another free IPv4 `/28` subnet if its default
`172.31.86.0/28` overlaps a local network. `PASSING_KEEP_REHEARSAL=1` retains the
temporary source and diagnostic files after cleanup.

If the CI container rehearsal fails, download the
`container-rehearsal-docker-log` artifact from the workflow run. CI retains this
artifact for seven days. It contains only the Docker command log from the
isolated test. Containers, transfer volumes, and image tags are still removed.

For another isolated deployment, use a separate project, private test storage,
network addresses, and configuration file. Root can select that file with
`passing-cloud-deploy --config <absolute-path> <command>`. The deployment SSH key
cannot select another configuration file. Test deployment, verification failure,
and recovery before enabling a new host. Never use live transfer data for tests.
