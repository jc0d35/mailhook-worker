import { deliver, DeliveryError, InvalidEmailError } from './mail.mjs';
import { maximumBytes, recipients } from './config.mjs';

export default {
  async email(message, env) {
    try {
      const accepted = recipients(env);
      const sizeLimit = maximumBytes(env);
      if (!accepted.has(message.to.toLowerCase()))
        return message.setReject('Unknown recipient');
      if (
        !Number.isSafeInteger(message.rawSize) ||
        message.rawSize < 1 ||
        message.rawSize > sizeLimit
      )
        return message.setReject('Message exceeds the supported size');
      const externalId = await deliver(
        await new Response(message.raw).arrayBuffer(),
        env,
      );
      console.log(JSON.stringify({ event: 'mailhook.delivered', externalId }));
    } catch (error) {
      // Parser/HTTP errors can contain private data. Never propagate their text into Worker logs.
      console.error(
        JSON.stringify({
          event: 'mailhook.failed',
          ...(error instanceof DeliveryError
            ? { externalId: error.externalId, reason: error.message }
            : { reason: error instanceof InvalidEmailError ? error.message : 'parse-or-configuration' }),
        }),
      );
      if (error instanceof InvalidEmailError)
        return message.setReject('Invalid or unsupported email');
      throw new Error('mailhook-delivery-failed');
    }
  },
};
