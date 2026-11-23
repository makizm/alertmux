<img src="docs/brand/alertmux-mark.svg" alt="Alertmux logo" width="80" height="80" align="right">

# Alertmux

Alertmux is an SMTP relay for printers, scanners, NAS boxes, UPSes and legacy apps that can only speak plain SMTP.
It accepts mail on port 25 (or any port) and delivers it upstream with **OAuth2**:

- **Microsoft 365** via Graph `sendMail`, with a client secret or certificate. Mailboxes don't need
  SMTP AUTH or Basic auth.
- **Google Workspace** via the SMTP relay service (`smtp-relay.gmail.com`, app password or IP allowlist)
  or `smtp.gmail.com` with XOAUTH2 using a service account with domain-wide delegation.

It can also post a summary of each email (subject, sender, readable body, attachment names) to a chat
channel, which suits device alerts:

- **Microsoft Teams** via a Workflows webhook.
- **Slack** via an incoming webhook or a bot token (`chat:write`).

It replaces a Postfix VM and config files with a **web admin UI**:

- destinations
- routing rules
- SMTP listener settings
- relay users
- a live **message log** with per-attempt upstream errors and a retry button
- a live **event log**, streamed over Server-Sent Events

Runtime: Node 24, two dependencies (`smtp-server`, `nodemailer`). There's no build step: TypeScript runs through Node's
type stripping, and the UI is plain HTML/CSS/JS.

## Install (Docker)

Images for `linux/amd64` and `linux/arm64` are published to GitHub Container Registry:
`ghcr.io/makizm/alertmux` (tags `latest`, `1`, `1.2`, `1.2.3`, and `edge` for the main branch).

**With Docker Compose** (recommended):

```bash
mkdir alertmux && cd alertmux
curl -fsSLO https://raw.githubusercontent.com/makizm/alertmux/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/makizm/alertmux/main/.env.example -o .env
```

Edit `.env`: set `ADMIN_PASSWORD`, and set `SECRET_KEY` to the output of `openssl rand -base64 32`. Then start it:

```bash
docker compose up -d
```

**With plain Docker:**

```bash
docker run -d --name alertmux --restart unless-stopped \
  -e ADMIN_PASSWORD='a-long-admin-password' -e SECRET_KEY="$(openssl rand -base64 32)" \
  -p 25:25 -p 8080:8080 -v alertmux-data:/data \
  ghcr.io/makizm/alertmux:latest
```

With `docker run`, save the `SECRET_KEY` you used: without it, the stored credentials can't be decrypted
after you recreate the container.

**First steps**

1. Open http://localhost:8080 and sign in with `ADMIN_PASSWORD`.
2. Go to **Destinations & routing**, add Microsoft 365 or Google Workspace, then click **Test**.
3. In **Settings**, set the allowed client networks, the sender policy and the hostname.
4. Point devices at `<host>:25`, with no TLS and no auth (or a relay user if you require AUTH).
5. Use **Test send** to verify, then watch **Messages**.

**Upgrading:** `docker compose pull && docker compose up -d`. Settings, credentials and queued mail live in
the `/data` volume and are kept. Pin a version (for example `RELAY_IMAGE=ghcr.io/makizm/alertmux:1.0`
in `.env`) to choose when upgrades happen.

**From source:** clone the repo, `cp .env.example .env`, then `docker compose up -d --build`.

Setup guides: [Microsoft Entra / Graph](docs/entra.md) · [Google Workspace](docs/google.md) · [Teams & Slack](docs/teams-slack.md) · [Hosting options](docs/hosting.md) · [Roadmap](docs/roadmap.md)

## How it works

```
device ──SMTP:25──▶ listener ──▶ policy (IP allowlist, AUTH, allowed senders, size)
                                   │
                                   ▼
                     routing rules → destination(s)  ──▶ SQLite queue + spool (/data)
                                                              │ worker (retries, backoff, Retry-After)
                  ┌──────────────────────┬────────────────────┴──────┬─────────────────────────┐
                  ▼                      ▼                           ▼                         ▼
       Microsoft Graph sendMail   Google SMTP (587)        Teams channel             Slack channel
       (client credentials,       (app password / IP /     (Workflows webhook,       (incoming webhook or
        per cloud)                 XOAUTH2)                 Adaptive Card)            bot chat.postMessage)
```

- A message is accepted (`250 queued as <id>`) only once it is stored. Delivery happens asynchronously,
  and the queue survives restarts.
- Temporary failures (429/5xx, SMTP 4xx, network errors) are retried with exponential backoff up to
  *Max attempts*. Permanent failures (bad credentials, access denied, 5xx) fail right away.
- Rejections at SMTP time:
  - `554` client IP not allowed
  - `530` AUTH required
  - `550` sender not allowed
  - `552` too large for the routed destination
  - `451` no destination configured (a temporary error, so devices retry after you fix it)
- **Routing**: ordered rules match on sender, sender domain and recipient domain. All matching rules' destinations
  get a copy (fan-out) until a *Stop here* rule matches. Otherwise the default destination is used.
  For example, `ups@contoso.com` can go to a mailbox *and* a Teams channel *and* Slack. Each destination
  is retried and logged on its own. A message where some destinations succeeded and others failed shows as `partial`.
- Adding a destination type is one entry in `src/destinations/index.ts` plus a class implementing
  `deliver()` and `test()`.

## Configuration

Environment variables (everything else is set in the UI):

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | (required) | Admin UI password, min 8 chars |
| `SECRET_KEY` | generated into `/data/secret.key` | Encrypts stored credentials (AES-256-GCM) and signs sessions |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite DB + message spool |
| `HTTP_PORT` / `HTTP_HOST` | `8080` / `0.0.0.0` | Admin UI |
| `SMTP_PORT` | `25` | Initial SMTP port; change it later in Settings |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For/Proto` from a reverse proxy |
| `COOKIE_SECURE` | `auto` | `auto` / `always` / `never` |

Logs: system events also go to stdout as JSON lines for your log collector.

## Current limits

- **Inbound SMTP is plaintext only.** No STARTTLS or SMTPS yet, so SMTP AUTH passwords are sent in clear text. Restrict by
  network. TLS is next on the roadmap.
- Microsoft Graph caps messages at about 3 MB raw. Larger messages would need Graph's upload-session flow, or
  offloading attachments to S3 (see the [roadmap](docs/roadmap.md)).
- Teams and Slack posts list attachment names but don't carry the files.
- Single replica (SQLite).
- One admin password, with no per-user admin accounts.

## Development

```bash
npm install
npm test            # node:test suites (unit + end-to-end against mock upstreams)
npm run typecheck   # tsc --noEmit
node scripts/mock-graph.ts 4010 &   # fake Microsoft login + Graph
DATA_DIR=./data/dev ADMIN_PASSWORD=devpassword123 SMTP_PORT=2525 npm run dev
node scripts/send-test.ts --port 2525 --to someone@contoso.com
node scripts/send-test.ts --port 2525 --sample rich --name "UPS Rack 4"   # HTML, embedded images, CSV + PDF
```

With the mock, add a Microsoft destination with *Custom endpoints*, setting both URLs to `http://127.0.0.1:4010`.
Recipients containing `throttle` get a 429, and recipients containing `denied` get a 403.

### Releasing

CI (`.github/workflows/ci.yml`) typechecks, runs the tests and builds and smoke-tests the image on every push and pull request.
`.github/workflows/release.yml` publishes the image: every push to `main` updates `:edge`, and a version tag publishes a release:

```bash
git tag v1.0.0
```
```bash
git push origin v1.0.0
```

The first time, make the package public: GitHub › your profile or organization › **Packages** › `alertmux` ›
**Package settings** › **Change visibility** › Public. Images carry SBOM and build-provenance attestations
(`gh attestation verify oci://ghcr.io/makizm/alertmux:1.0.0 --owner makizm`).

Layout: `src/smtp` (listener) · `src/relay` (policy, routing, queue, MIME) · `src/destinations`
(Microsoft, Google, Teams, Slack) · `src/http` (router, auth, JSON API, SSE) · `public` (UI) · `test`.

## License

Copyright 2026 Max Leychenko. Licensed under the [Apache License 2.0](LICENSE).
