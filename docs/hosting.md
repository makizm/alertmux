# Hosting

The relay is one long-running container that needs:

1. **Inbound raw TCP** on port 25 (or a custom port) from your devices or networks.
2. **A persistent volume** at `/data` (SQLite database, message spool, generated `secret.key`).
3. **Outbound HTTPS** to Microsoft login/Graph and to Teams Workflows / Slack (`hooks.slack.com`, `slack.com`, `slack-gov.com`) if used, and outbound TCP **587** to Google if used.
   Port 25 outbound is never used, so cloud blocks on outbound 25 don't matter.
4. The admin UI on HTTP 8080, ideally behind HTTPS and not exposed to the internet.

Function-style serverless (AWS Lambda, Google Cloud Run, Azure Functions, Cloudflare Workers) cannot
listen on TCP 25 and isn't supported.

| Platform | TCP 25 ingress | Persistent `/data` | Notes |
|---|---|---|---|
| Docker / VM (self-hosted) | yes | volume | `docker compose up -d` |
| AWS ECS on Fargate | yes, via a **Network Load Balancer** TCP listener | EFS | Enable NLB *proxy protocol v2* and turn on “Expect PROXY protocol header” in Settings to see real client IPs. |
| Azure Container Apps | yes, **TCP ingress** (needs a VNet-integrated environment) | Azure Files | Set `exposedPort: 25`, `targetPort: 25`. Keep `minReplicas: 1`. |
| GCP | GKE (Autopilot) `LoadBalancer` Service, or Compute Engine VM | Persistent Disk | Cloud Run can't accept raw TCP. |
| Kubernetes (any) | `Service` of type `LoadBalancer`/`NodePort` | PVC | Pods can't bind <1024 as non-root, so set `SMTP_PORT=2525` and map Service port 25 → 2525. |
| Cloudflare Containers | not practical yet. Public inbound TCP to Workers/Containers is beta-only, and custom TCP ports through Spectrum need an **Enterprise plan + Spectrum add-on** (as does PROXY protocol for the client IP). | container disk is ephemeral | Not supported. |

## Single replica

Run **one** replica. The queue lives in SQLite on the volume, and two replicas sharing one database
over a network filesystem can corrupt it. For high availability, use a fast restart policy. Devices
retry SMTP on 4xx and connection errors, so a short outage only delays mail.

## Securing it

- Keep the SMTP allowlist (Settings) as tight as possible, plus network firewall rules or security groups.
  An empty allowlist without SMTP AUTH is an open relay.
- Inbound SMTP is plain text for now (no STARTTLS/SMTPS). Use it on trusted networks, a VPN or private link,
  or a TLS-terminating TCP proxy until TLS support lands.
- Put the admin UI behind HTTPS (reverse proxy, ALB, Container Apps HTTP ingress) and set `TRUST_PROXY=true`.
  Don't publish 8080 to the internet.
- Set `SECRET_KEY` explicitly and back it up together with `/data`. Without it, stored credentials can't be decrypted.

## Backups

Stop the container, or use `sqlite3 /data/relay.db ".backup /backup/relay.db"`, then copy `/data/relay.db`,
`/data/secret.key` (if you didn't set `SECRET_KEY`) and, optionally, `/data/spool/` (queued message bodies).
