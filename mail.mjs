import PostalMime from 'postal-mime';
import { deliveryConfiguration } from './config.mjs';
export { MAX_EMAIL_BYTES } from './limits.mjs';

export class DeliveryError extends Error {
  constructor(reason, externalId) {
    super(reason);
    this.externalId = externalId;
  }
}

export class InvalidEmailError extends Error {}

async function digest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Also used by operator replay; all business decisions belong to the backend. */
export async function deliver(raw, env) {
  const config = deliveryConfiguration(env);
  if (!raw.byteLength || raw.byteLength > config.maximumBytes)
    throw new InvalidEmailError('mailhook-size');
  const mail = await PostalMime.parse(raw, {
    maxHeadersSize: 65536,
    maxNestingDepth: 32,
    maxRfc822NestingDepth: 0,
    maxPartCount: 1000,
  });
  if (!mail.from?.address) throw new InvalidEmailError('mailhook-sender');
  if (mail.attachments.length > 100)
    throw new InvalidEmailError('mailhook-attachment-count');
  if (
    (mail.subject?.length ?? 0) > 1000 ||
    (mail.html?.length ?? 0) > 100000 ||
    (mail.text?.length ?? 0) > 50000
  )
    throw new InvalidEmailError('mailhook-fields');
  const identity = mail.messageId
    ? new TextEncoder().encode(
        `${mail.from.address.trim().toLowerCase()}\0${mail.messageId}`,
      )
    : raw;
  const externalId = `mailhook.${await digest(identity)}`;
  const body = new FormData();
  body.set('senderAddress', mail.from.address);
  if (mail.replyTo?.[0]?.address) body.set('replyTo', mail.replyTo[0].address);
  body.set('subject', mail.subject ?? '');
  if (mail.html !== undefined) body.set('html', mail.html);
  if (mail.text !== undefined) body.set('text', mail.text);
  if (mail.date) body.set('date', mail.date);
  body.set('externalId', externalId);
  for (const part of mail.attachments)
    body.append(
      'attachments',
      new Blob([part.content], { type: part.mimeType }),
    );
  let response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: config.headers,
      body,
      // Workers support follow/manual; rejecting non-2xx below also refuses redirects.
      redirect: 'manual',
      signal: AbortSignal.timeout(config.timeout),
    });
  } catch {
    throw new DeliveryError('mailhook-transport', externalId);
  }
  await response.body?.cancel();
  if (!response.ok)
    throw new DeliveryError(`mailhook-backend-${response.status}`, externalId);
  return externalId;
}
