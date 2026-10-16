import { createHmac, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config/app-config';

// SDK 6.0.1 retries transport errors/503 internally. A send must have exactly one HTTP attempt.
export function solapiRequest(
  config: AppConfig,
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<Response> {
  const date = new Date().toISOString();
  const salt = randomBytes(16).toString('hex');
  const signature = createHmac('sha256', config.sms.apiSecret)
    .update(date + salt)
    .digest('hex');
  return fetch(`https://api.solapi.com${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `HMAC-SHA256 apiKey=${config.sms.apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
