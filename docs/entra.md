# Microsoft 365 setup (Entra ID app + Graph `Mail.Send`)

The relay delivers through Microsoft Graph `POST /users/{sender}/sendMail` using the OAuth2
client-credentials flow (app-only). The mailboxes don't need SMTP AUTH or any per-user password.

## 1. Pick your cloud

| Tenant type | Admin portal | Cloud setting in the relay |
|---|---|---|
| Commercial | https://entra.microsoft.com | Commercial / GCC |
| GCC (moderate) | https://entra.microsoft.com | Commercial / GCC |
| GCC High | https://entra.microsoft.us (or portal.azure.us) | US Government GCC High |
| DoD | https://entra.microsoft.us (or portal.azure.us) | US Government DoD |
| China (21Vianet) | https://portal.azure.cn | China (21Vianet) |

The relay uses the following endpoints for each setting:

| Setting | Token endpoint | Graph |
|---|---|---|
| Commercial / GCC | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` | `https://graph.microsoft.com` |
| GCC High | `https://login.microsoftonline.us/{tenant}/oauth2/v2.0/token` | `https://graph.microsoft.us` |
| DoD | `https://login.microsoftonline.us/{tenant}/oauth2/v2.0/token` | `https://dod-graph.microsoft.us` |
| China | `https://login.chinacloudapi.cn/{tenant}/oauth2/v2.0/token` | `https://microsoftgraph.chinacloudapi.cn` |

“Custom endpoints” lets you enter any authority and Graph URL. Use it for sovereign clouds not listed
here, or for a local mock (`scripts/mock-graph.ts`).

## 2. Register the app

1. **Entra ID › App registrations › New registration**. Name it e.g. `Alertmux`, single tenant, no redirect URI.
2. Copy the **Application (client) ID** and **Directory (tenant) ID**.
3. **API permissions › Add a permission › Microsoft Graph › Application permissions › `Mail.Send`**,
   then **Grant admin consent**.
   - Optional: `User.Read.All` (application). It's only used by the destination “Test” button to confirm a mailbox exists.
4. **Certificates & secrets**, choose one:
   - **Client secret.** Copy the value (not the ID). Remember that it expires.
   - **Certificate.** Recommended, and often required by Gov tenant policy. Generate one:
     ```bash
     openssl req -x509 -newkey rsa:2048 -nodes -days 730 -subj "/CN=alertmux" \
       -keyout relay-key.pem -out relay-cert.pem
     ```
     Upload `relay-cert.pem` to the app registration. Paste both `relay-cert.pem` and `relay-key.pem`
     into the relay's destination form.

## 3. Restrict which mailboxes the app can send as (strongly recommended)

`Mail.Send` (application) lets the app send as **any** mailbox in the tenant. Limit it with
**RBAC for Applications** in Exchange Online. It replaces the older Application Access Policies.

```powershell
Connect-ExchangeOnline   # GCC High: -ExchangeEnvironmentName O365USGovGCCHigh ; DoD: O365USGovDoD

# A mail-enabled security group holding the mailboxes the relay may send as
New-DistributionGroup -Name "Alertmux Senders" -Type Security -Members scanner@contoso.com,noreply@contoso.com

# Service principal pointer for the app (AppId = client ID, ObjectId = the Enterprise application's object ID)
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Alertmux"

New-ManagementScope -Name "Alertmux Senders" -RecipientRestrictionFilter "MemberOfGroup -eq '<group DN>'"
New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" -CustomResourceScope "Alertmux Senders"
```

With RBAC for Applications in place, you can remove the tenant-wide `Mail.Send` Graph permission
from the app registration. The Exchange role assignment grants it for the scoped mailboxes only.

## 4. Configure the relay

**Destinations & routing › Add Microsoft 365**: pick the cloud, enter the tenant ID, client ID and secret
(or certificate + key), then save and click **Test**.

## How messages are sent

- The relay sends the original MIME message (base64) to `sendMail`, so attachments, HTML and headers stay
  intact. A copy is saved to the sender's *Sent Items*.
- **Sender.** The message is sent from the mailbox in MAIL FROM, or from the fixed sender (Settings ›
  Sender). The `From:` header must be that mailbox, or one it has *Send As* rights on. Otherwise Graph returns
  `ErrorSendAsDenied`. In fixed mode, turn on *Rewrite the From header*.
- **Recipients.** Graph takes recipients from the MIME headers. Envelope recipients that are missing from
  To/Cc/Bcc (blind copies some devices add) are added as `Bcc` automatically. Header recipients that
  aren't in the envelope are still delivered by Graph.
- **Size.** `sendMail` accepts about 4 MB per request after base64, which is about 3 MB of raw message. Larger
  messages are refused at the SMTP stage with `552` when routed to Microsoft.
- **Errors.** 429/5xx are retried (honoring `Retry-After`). 400/403/404 fail permanently, and the Graph error
  code and request-id are shown in the message log.
