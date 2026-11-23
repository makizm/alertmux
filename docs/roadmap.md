# Roadmap

Planned work, roughly in priority order. Nothing here is implemented yet.

## Inbound TLS
- STARTTLS on the SMTP listener, and SMTPS (implicit TLS, usually port 465), with certificate upload in Settings.
- Several listen ports at once (for example 25 plus 587).

## TODO: Offload attachments and images to an S3 bucket

Store attachments and embedded images in an AWS S3 bucket, and deliver a lighter message that links to them.

**Why**
- Microsoft Graph `sendMail` caps raw messages at about 3 MB. Large scans and reports fail today
  unless Graph's upload-session flow is added.
- Teams and Slack cards can't carry files at all. Today they only list attachment names.
- Smaller messages mean faster delivery and lower mailbox storage. Recipients download files only when they need them.

**Behaviour**
- Per-destination setting: *Offload attachments* = off / over N MB / always, plus a choice of
  *attachments only* or *attachments and embedded images*.
- When it applies, the relay uploads each MIME part to `s3://<bucket>/<prefix>/<message-id>/<filename>` before delivery.
- Mail destinations (Graph, Google): rewrite the MIME message. Attachment parts are removed. An
  "Attachments" section with download links and sizes is added to both the HTML and text bodies.
  `cid:` images become `https://` image URLs, or stay embedded when they're small.
- Teams: attachment names become links. Embedded images can be shown with an Adaptive Card `Image` element.
- Slack: attachment links in the context block. Images can be shown as `image` blocks.
- The message log records the uploaded objects, so the retry button and the message detail view can find them.

**Settings**
- Bucket, region and key prefix.
- Credentials: an access key or the platform's IAM role (ECS task role, EC2 instance profile). Use the role when there is one.
- Partitions: commercial or AWS GovCloud (`s3.us-gov-west-1.amazonaws.com`). These follow the
  Microsoft gov cloud presets for agencies that need both.
- Encryption: SSE-S3 or SSE-KMS (key ARN).
- Link type:
  - **Pre-signed URLs**: at most 7 days with SigV4, and shorter when signed with temporary role credentials.
  - **Relay redirect links** (`/files/<token>`): the relay re-signs the URL on each click, so links can live
    longer. This needs the admin host to be reachable by recipients, or a separate public download host.
  - **CloudFront** signed URLs or cookies.
- Retention: delete objects after N days. This is set as a lifecycle rule on the bucket, and also enforced
  by the relay's retention job.

**Open questions**
- Recipients outside the organization: should links be public-with-token, or require sign-in (for
  example CloudFront with an identity provider)?
- Malware scanning before links go out (GuardDuty Malware Protection for S3, or ClamAV)?
- DLP: some tenants forbid moving attachments out of the mail system. Offloading should be off by default.
- Other stores behind the same interface: S3-compatible stores (MinIO, Cloudflare R2), Azure Blob Storage (for Azure-hosted
  installs) and Google Cloud Storage.
- Upload cost and latency on the delivery path: upload once per message and share the objects across fan-out destinations.

## Other ideas
- A generic JSON webhook destination.
- Graph upload sessions for messages over 3 MB, as an alternative to offloading.
- Routing matches on subject (regex) and client IP.
- Admin accounts with roles instead of a single password, and SSO through Entra ID.
