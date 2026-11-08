# Git-based VPS deployment

The public Compose stack checks episodes daily and refreshes recommendations once per UTC ISO week. Successful job dates live under `data/scheduler`, so restarting a container preserves the schedule. Failed commands retry on the next hourly wake-up. The first run executes both jobs. The existing episode checker uses the TMDB air date and UTC, so it can alert only when TMDB returns an episode airing that day.

## Shared reverse proxy

For a VPS with its own Caddy or another reverse proxy, copy `deploy/compose.shared-proxy.example.yml` to `docker-compose.override.yml`. Attach your proxy to the existing Compose network and route to `addon:7000`. The optional host mapping binds to loopback. Keep the same Compose project name during upgrades because the proxy references its network.

Existing overrides with a `cron.entrypoint` must have that field removed to use the tracked scheduler. Keep any unrelated host customizations. Back up the override before editing it. To preserve the current recommendation week when migrating, write its ISO week to `data/scheduler/weekly`, for example `date -u +%G-%V > data/scheduler/weekly`.

## One-time administrator setup

Use a dedicated deployment SSH key. Its private key will be a GitHub Actions secret. Keep the regular administrator key for interactive maintenance.

1. Install `deploy/stremio-deploy` as `/usr/local/sbin/stremio-deploy` and `deploy/stremio-deploy-request` as `/usr/local/bin/stremio-deploy-request`, owned by root and mode `755`. Install updates to these helpers explicitly during administrator maintenance.
2. Create `/etc/stremio-deploy.conf`, owned by root and mode `600`. Set these values for your clone and fork.

   ```sh
   REPO_DIR=/root/stremio-tracker
   REPO_URL=https://github.com/YOUR_USERNAME/stremio-tracker.git
   DEPLOY_BRANCH=main
   COMPOSE_PROJECT=stremio-tracker
   ```

3. Create `/var/lib/stremio-deploy` and `/var/backups/stremio-tracker`, owned by root and mode `700`.
4. Add a sudoers rule for your SSH user, replacing `deploy` if needed. Validate it with `visudo -cf` before installing it as `/etc/sudoers.d/stremio-deploy`, mode `440`.

   ```text
   deploy ALL=(root) NOPASSWD: /usr/local/sbin/stremio-deploy *
   ```

5. Add the deployment public key to that user's `~/.ssh/authorized_keys` with the following forced-command prefix.

   ```text
   restrict,command="/usr/local/bin/stremio-deploy-request" ssh-ed25519 PUBLIC_KEY github-stremio-deploy
   ```

The forced command accepts `deploy <40-character-commit-sha>`. The root helper verifies that commit against the configured repository's branch head, locks deployments, refuses tracked server edits, and uses SQLite's online backup API before building. It builds one application image and updates only addon and cron. The addon health check and cron running state must pass. On failure, it restores the previous checkout and container images. Application recreation can briefly interrupt requests.

Backups include the SQLite database, environment file, previous commit, and host override. They are private and retained for administrator-managed cleanup. Rollback restores code and images. Review the database backup separately if a future update introduces incompatible schema or data changes.

## GitHub configuration

Under repository Settings → Secrets and variables → Actions, configure these repository secrets.

| Secret | Value |
| --- | --- |
| `VPS_HOST` | Server hostname or address |
| `VPS_USERNAME` | SSH account containing the restricted deployment public key |
| `VPS_PORT` | SSH port, defaults to `22` |
| `VPS_SSH_KEY` | Complete dedicated deployment private key |
| `VPS_KNOWN_HOSTS` | Verified OpenSSH known-hosts entry for the server and SSH port |

Obtain and verify the host key through an existing trusted SSH connection or your VPS console. The runner uses strict host-key checking. For a non-default port the entry must name `[host]:port`.

Set the repository **variable** `VPS_DEPLOY_ENABLED` to `true` once the server and secrets are ready. This explicit opt-in allows public forks to use validation without requiring VPS credentials. The old password secret is no longer used.

Pull requests run script checks, scheduler regression tests, Compose validation, and a Docker build. Pushes to `main` run those checks, then deploy the exact pushed commit. The Actions page also supports a manual run on `main`. A stale queued commit is rejected if the configured branch has moved ahead. Deployment jobs are serialized.

Make changes in a branch, review the pull request, and merge to `main`. Check both the validation and deployment job results. A successful deployment prints the commit and backup directory.
