# Google Workspace setup

Two ways to deliver through Google. Pick one per destination.

## Option A: SMTP relay service (`smtp-relay.gmail.com`)

Google's relay for devices and apps. Configure it in the **Admin console › Apps › Google Workspace ›
Gmail › Routing › SMTP relay service › Configure**:

- **Allowed senders**: “Only addresses in my domains” (typical).
- **Authentication**, choose one or both:
  - *Require SMTP Authentication.* The relay logs in with a Workspace user and an
    [app password](https://support.google.com/accounts/answer/185833). The user needs 2-Step Verification.
    In the relay, set *Relay authentication = SMTP AUTH* and enter the user + app password.
  - *Only accept mail from the specified IP addresses.* Add the relay's **static public egress IP**.
    In the relay, set *Relay authentication = IP allowlist only*. This doesn't work from platforms
    with shared or changing egress IPs (most serverless and container platforms) unless you add a NAT
    gateway with a fixed IP.
- **Require TLS encryption**: on. The relay uses STARTTLS on 587.

Set **EHLO name** to a real hostname in your domain (e.g. `relay.contoso.com`). Google's relay rejects
generic names.

## Option B: OAuth2 (XOAUTH2) with a service account

The relay connects to `smtp.gmail.com:587` and authenticates **as the sending user** with an access
token minted through domain-wide delegation. No passwords, and no IP allowlist.

1. In Google Cloud console, create a project, then **IAM & Admin › Service accounts › Create**.
2. Open the service account, go to **Keys › Add key › JSON**, and download the key file.
3. Copy the service account's **Client ID** (numeric).
4. In the Workspace Admin console, go to **Security › Access and data control › API controls › Domain-wide
   delegation › Add new**. Enter the Client ID with scope `https://mail.google.com/`.
5. In the relay, use **Add Google Workspace**, *Mode = OAuth2 with service account*, and paste the JSON key.

Mail is sent as the MAIL FROM address, or the fixed sender from Settings. That user must exist in your
Workspace domain. Use **Test** with a mailbox address to confirm the delegation works.

## Errors and limits

- 4xx SMTP replies (e.g. `421`, `450`, `451`) are retried with backoff. 5xx replies fail permanently.
- Message size limit: 25 MB.
- Gmail sending limits apply per user and per relay. See Google's “SMTP relay service limits”.
