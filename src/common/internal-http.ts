export class InternalCallError extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;

export async function postInternal(
  service: string,
  baseUrl: string,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new InternalCallError(`${service} unreachable`);
  }
  if (!response.ok) {
    throw new InternalCallError(`${service} responded ${response.status}`);
  }
  return response;
}
