# Agent mailhook

A small, configurable Cloudflare Email Worker template: receive email on your domain, parse MIME, and POST the message and binary attachments to your own authenticated webhook.

```text
Your email address → Cloudflare Email Routing → this Worker → your HTTP receiver
```

Use it for an inbox integration, agent input, support ingestion, or another email-driven workflow. The adapter handles MIME and transport; your receiver owns routing, deduplication, attachment policy, and persistence. It has no mailbox, database, queue, raw-message storage, or automatic replies.

## Try it locally

Install Node.js 22 or newer, then fork or copy this repository and run:

```sh
npm ci
cp .dev.vars.example .dev.vars.development
npm run check
```

Start the example receiver in one terminal:

```sh
npm run receiver
```

In a second terminal, start the email Worker:

```sh
npm run dev -- --env development
```

In a third terminal, submit the synthetic message:

```sh
curl --request POST \
  'http://localhost:8787/cdn-cgi/local/email?from=sender%40example.com&to=ingest%40example.com' \
  --data-binary @examples/sample.eml
```

The receiver listens on `127.0.0.1:8788` and acknowledges the multipart request. The Worker logs `mailhook.delivered` with its stable message identity. This exercises Cloudflare's [local email event endpoint](https://developers.cloudflare.com/email-service/observability/local-development/routing/); it does not send an actual email or deploy anything. The example receiver is for local development, and uses the synthetic key in `.dev.vars.example`.

## Configuration

Set non-secret values in your deployment's Wrangler environment or use `--var` overrides. For local development, the copied `.dev.vars.development` file supplies bindings to `--env development`. Keep actual addresses, receiver endpoints, and credentials in your deployment project rather than a public template.

| Binding | Required / default | Meaning |
| --- | --- | --- |
| `MAILHOOK_RECIPIENT` | Required for incoming email events | One exact recipient or a comma-separated list. Matching ignores case and surrounding whitespace; there are no wildcards. Every accepted address uses the same receiver. |
| `BACKEND_WEBHOOK_URL` | Required | Your receiver's HTTPS endpoint. The historical name does not require a particular backend. HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` during local development. URL credentials and fragments are rejected. |
| `EMAIL_WEBHOOK_API_KEY` | Required secret | Authentication value shared with the receiver. |
| `WEBHOOK_AUTH_HEADER` | `X-Api-Key` | `Authorization` or an `X-*` header name. |
| `WEBHOOK_AUTH_PREFIX` | Empty string | Text prepended to the secret, such as `Bearer ` including its trailing space. |
| `WEBHOOK_TIMEOUT_MS` | `60000` | Whole milliseconds, from `1` through `60000`. |
| `MAILHOOK_MAX_BYTES` | `26214400` (25 MiB) | Maximum raw MIME bytes, from `1` through `26214400`. Lower it to match your receiver's request limit. |

For bearer authentication, set these non-secret variables and store the token in `EMAIL_WEBHOOK_API_KEY`:

```json
{
  "WEBHOOK_AUTH_HEADER": "Authorization",
  "WEBHOOK_AUTH_PREFIX": "Bearer "
}
```

The original `X-Api-Key` contract remains the default. Invalid configuration fails before delivery. Replay uses the same endpoint, authentication, timeout, and size settings.

## Webhook contract

The Worker makes one `POST` with a `multipart/form-data` body. Let the HTTP client generate its boundary and `Content-Type` header. Authenticate the request before processing it.

| Form field | Content |
| --- | --- |
| `senderAddress` | Decoded original `From` address. Required. |
| `replyTo` | First decoded `Reply-To` address, if present. |
| `subject` | Decoded subject, or an empty string. |
| `html` | HTML body, if present. |
| `text` | Text body, if present. |
| `date` | Parser-provided date, if present. |
| `externalId` | Stable `mailhook.` identity described below. |
| `attachments` | Repeated binary file parts in MIME order, including inline parts. Each retains its MIME type and bytes. |

Files are anonymous multipart parts; original filenames, content IDs, and inline disposition are not forwarded. HTML is passed through, so `cid:` image references are not resolved. Remote content is never fetched. Sender identity comes from the message header rather than a forwarding server's SMTP envelope; it is message data, not proof of identity. The receiver should treat body content and attachments as untrusted input.

`externalId` is `mailhook.` followed by the hexadecimal SHA-256 digest of the normalized sender address, a NUL separator, and Message-ID. With no Message-ID, the digest covers the raw message bytes. Replaying the same original therefore keeps its identity. The receiver must deduplicate this value and tolerate a replay after partial processing. When several allowed recipients feed the same receiver, a message with the same sender and Message-ID shares its identity across them.

Return any `2xx` response after completed processing, including handling supported attachments. The Worker ignores the response body. Redirects, non-`2xx` status codes, transport errors, and timeouts fail the invocation. There is one attempt and no durable retry mechanism.

## Deploy your instance

You need a Cloudflare account, a domain using Cloudflare DNS, and an HTTPS receiver implementing the contract above. Follow Cloudflare's [Email Routing setup](https://developers.cloudflare.com/email-service/get-started/route-emails/) to enable routing for your chosen domain or subdomain. Changing MX records affects mail delivery, so choose a domain whose incoming mail you intend Cloudflare to handle.

1. Copy the template into your own repository. Choose a unique Worker name in your deployment's `wrangler.jsonc`, and replace the example recipient and URL in the intended environment. Optional values must be configured in each environment that uses them.
2. Log in and install the [Worker secret](https://developers.cloudflare.com/workers/configuration/secrets/) for that same environment. Enter the value at the prompt; do not put it in a command argument or source file.

   ```sh
   npx wrangler login
   npx wrangler secret put EMAIL_WEBHOOK_API_KEY --env development
   ```

3. Verify and deploy the selected environment:

   ```sh
   npm run check
   npx wrangler deploy --env development \
     --var MAILHOOK_RECIPIENT:inbox@example.com \
     --var BACKEND_WEBHOOK_URL:https://receiver.example.com/email/webhook
   ```

4. In Cloudflare Email Routing, create a rule for the configured address with the **Send to a Worker** action and select the deployed Worker. Add a rule for each address in the allowlist. The Worker has no public HTTP handler and `workers.dev` is disabled.
5. Send a synthetic email from another account. Verify the receiver accepted it and inspect `mailhook.delivered` in `npx wrangler tail --env development`.

Use `--env production` for a separate production instance, with its own secret and settings. When using `--name`, use the same name for secret installation, deployment, and monitoring. The checked-in configurations contain examples only; local `.dev.vars` files are not a way to provision deployed secrets.

## Limits and operations

Raw MIME is bounded to 25 MiB, or the lower configured maximum. There are also limits of 100 attachments, a 1,000-character subject, 100,000-character HTML, and 50,000-character text. The MIME parser bounds headers to 64 KiB, nesting to 32 levels, and parts to 1,000. These are adapter limits; Cloudflare and your HTTP receiver may impose additional limits. Base64 MIME encoding increases the raw size compared with decoded attachments. Email Workers also share standard Workers CPU and memory limits, especially on the Free plan; the large-message local test does not guarantee that your deployed plan can process every message up to 25 MiB. See [Cloudflare Email Routing limits](https://developers.cloudflare.com/email-service/platform/limits/#email-routing-limits) and test representative synthetic messages on your chosen plan.

Wrong recipients and excessive advertised SMTP sizes are rejected before reading the message. Missing senders and fields or attachment counts beyond the adapter limits receive a permanent SMTP rejection, so retrying an unchanged invalid message does not repeat a temporary failure. These validation failures, parser errors and delivery failures log `mailhook.failed`; successful delivery logs `mailhook.delivered`. Configuration, unexpected parser, HTTP and transport errors still fail the invocation. Application logs contain only identity hashes and failure categories, never message bodies, addresses, or credentials.

Keep originals in an upstream mailbox if you need operator replay. There is no local mail archive. Do not assume SMTP retries will recover a failed webhook. A timeout can occur after the receiver has written some or all of a message: inspect its processing state before replaying, and make processing idempotent.

## Replay an original

Provide `BACKEND_WEBHOOK_URL` and `EMAIL_WEBHOOK_API_KEY` in the process environment, plus any optional delivery settings, then run:

```sh
npm run replay -- /path/to/original.eml
```

To exercise replay with the synthetic local configuration and running example receiver:

```sh
node --env-file=.dev.vars.development replay.mjs examples/sample.eml
```

Replay makes a real POST and does not apply the SMTP recipient allowlist. Keep actual mail and credentials outside this repository.

## Development and license

`npm run check` runs native contract and failure tests, a Wrangler dry run, and synthetic messages in the local Cloudflare runtime, including a large binary attachment. GitHub Actions runs the same gate without Cloudflare credentials or deployment. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

Released under the [MIT License](LICENSE).
