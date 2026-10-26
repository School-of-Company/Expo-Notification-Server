import {
  guardDownstream,
  isTimeoutError,
  type DownstreamFailure,
} from './resilience';

export class InternalCallError extends Error implements DownstreamFailure {
  constructor(
    message: string,
    readonly status?: number,
    readonly timedOut = false,
  ) {
    super(message);
  }
}

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
  return callInternal(
    service,
    baseUrl,
    path,
    timeoutMs,
    {
      method: 'GET',
      headers: { 'X-Internal-Token': token },
    },
    true,
  );
}

// 회로 차단기는 서비스별이고, 재시도는 멱등한 GET만 한다(POST는 상대가 이미 처리했을 수 있다).
async function callInternal(
  service: string,
  baseUrl: string,
  path: string,
  timeoutMs: number,
  init: RequestInit,
  idempotent = false,
): Promise<Response> {
  return guardDownstream(
    service,
    idempotent,
    () => attemptInternal(service, baseUrl, path, timeoutMs, init),
    () => new InternalCallError(`${service} circuit open`),
  );
}

async function attemptInternal(
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
  } catch (error) {
    const timedOut = isTimeoutError(error);
    throw new InternalCallError(`${service} unreachable`, undefined, timedOut);
  }
  if (!response.ok) {
    throw new InternalCallError(
      `${service} responded ${response.status}`,
      response.status,
    );
  }
  return response;
}
