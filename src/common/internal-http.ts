export class InternalCallError extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;

export async function postInternal(
  service: string,
  baseUrl: string,
  path: string,
  token: string,
  body: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return callInternal(service, baseUrl, path, timeoutMs, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': token,
    },
    body: JSON.stringify(body),
  });
}

export async function getInternal(
  service: string,
  baseUrl: string,
  path: string,
  token: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  return callInternal(service, baseUrl, path, timeoutMs, {
    method: 'GET',
    headers: { 'X-Internal-Token': token },
  });
}

async function callInternal(
  service: string,
  baseUrl: string,
  path: string,
  timeoutMs: number,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new InternalCallError(`${service} unreachable`);
  }
  if (!response.ok) {
    throw new InternalCallError(`${service} responded ${response.status}`);
  }
  return response;
}
