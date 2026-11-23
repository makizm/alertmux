# Teams and Slack destinations

Chat destinations post a **summary of each email** into a channel:

- subject
- sender, recipients and date
- attachment names and sizes
- the readable body, where HTML is converted to text and the length is capped

The relay doesn't upload attachments. Chat destinations are typically used for device alerts (UPS, NAS, backup jobs,
printers) where people want a notification rather than an email.

Add them under **Destinations & routing › Add destination › Chat channel**. Then send mail to them with a
routing rule. A rule can deliver to several destinations at once, e.g. `ups3@contoso.com` → Microsoft 365
mailbox **and** Teams **and** Slack. Each destination is retried and logged separately. If one fails while
the others succeed, the message shows as `partial`.

## Microsoft Teams (Workflows webhook)

Teams channels accept posts through a **Workflows** (Power Automate) webhook:

1. In Teams, open the channel and select **••• › Workflows**.
2. Choose **“Post to a channel when a webhook request is received”**, then pick the team and channel.
3. Copy the webhook URL it shows, and paste it into the relay. The URL is stored encrypted and never shown again.

Why not the alternatives:
- **Office 365 connector webhooks** (`*.webhook.office.com`) are retired.
- **Graph `POST /teams/{id}/channels/{id}/messages`** with app-only permissions is only allowed for
  migration imports. Normal channel posts need a signed-in user.

**GCC / GCC High / DoD.** Workflows is available in the government clouds. The URL host differs
(e.g. `*.logic.azure.us` or a `*.powerplatform` gov domain). The relay just posts to whatever HTTPS URL
you paste, so no cloud setting is needed. Your tenant's DLP policies for Power Automate apply to the flow.

The relay posts an Adaptive Card (v1.4) in the envelope the Workflows trigger expects:
`{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{…}}]}`.
`429` and `5xx` responses are retried. Other `4xx` responses (bad or deleted flow URL) fail permanently.

## Slack

There are two ways to connect.

**Incoming webhook.** Simplest. Each URL posts to one fixed channel.
1. Go to https://api.slack.com/apps › Create New App › **Incoming Webhooks** › On › **Add New Webhook to Workspace** › pick the channel.
2. Paste the `https://hooks.slack.com/services/…` URL into the relay.

**Bot token.** One app can post to any channel the bot is in.
1. In your Slack app › **OAuth & Permissions**, add the bot scope **`chat:write`**, then install the app to the workspace.
2. Copy the **Bot User OAuth Token** (`xoxb-…`).
3. Invite the bot to the channel with `/invite @YourApp`. Use the channel ID (`C0123…`, from channel details) or `#name`.
4. **GovSlack** workspaces: set *Slack workspace type* to **GovSlack**. The relay then calls `https://slack-gov.com/api`.

Errors:
- `ratelimited`, `429` and `5xx` responses are retried.
- `channel_not_found`, `not_in_channel`, `invalid_auth`, `channel_is_archived` and similar errors fail permanently. The message log
  shows the Slack error code with a hint.

## Security notes

- Webhook URLs and bot tokens are credentials. Anyone holding one can post to your channel. They're encrypted
  at rest with `SECRET_KEY` and are write-only in the UI.
- Message bodies go to Microsoft or Slack. Turn off **Include the message body** for destinations where
  only the subject should be shared.
- Outbound: the relay needs HTTPS egress to the webhook host (`*.logic.azure.com`, `*.powerplatform.com`,
  `hooks.slack.com`, `slack.com` or `slack-gov.com`).

## Testing locally

`scripts/mock-graph.ts` also mocks both services:

- **Teams:** webhook URL `http://127.0.0.1:4010/teams/alerts`
- **Slack webhook:** `http://127.0.0.1:4010/slack/alerts`
- **Slack bot:** API base `http://127.0.0.1:4010/slack-api` (enter it through the API), token `xoxb-mock`

Posted payloads are printed by the mock. A path containing `/gone` returns 404, and the bot channel `missing`
returns `channel_not_found`.
