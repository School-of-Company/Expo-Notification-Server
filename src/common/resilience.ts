import {
  BrokenCircuitError,
  circuitBreaker,
  ConsecutiveBreaker,
  ConstantBackoff,
  handleWhen,
  retry,
  type CircuitBreakerPolicy,
  type IPolicy,
} from 'cockatiel';

const FAILURE_THRESHOLD = 5;
const HALF_OPEN_MS = 30_000;
const RETRY_DELAY_MS = 200;

/**
 * 하위 서비스 호출이 실패한 이유. 회로 차단기가 장애로 셀지, 재시도할지 판단하는 데 쓴다.
 * - `status`: 응답을 받았을 때의 HTTP 상태. 없으면 연결 실패 또는 타임아웃이다.
 * - `timedOut`: 타임아웃으로 끝났는지.
 */
export interface DownstreamFailure {
  readonly status?: number;
  readonly timedOut?: boolean;
}

/** `AbortSignal.timeout`이 던지는 오류인지. 실행 환경(realm)에 따라 `instanceof Error`가 아닐 수 있어 이름으로 본다. */
export function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  );
}

/** 타임아웃·연결 실패·5xx만 서비스 장애로 센다. 4xx는 서비스가 살아 있다는 증거라 세지 않는다. */
export function isTransientFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status } = error as DownstreamFailure;
  return status === undefined || status >= 500;
}

/** 타임아웃은 이미 한도만큼 기다린 뒤라 다시 시도하면 응답 시간만 두 배가 된다. 곧바로 실패한 것만 재시도한다. */
function isRetryable(error: unknown): boolean {
  return (
    isTransientFailure(error) && (error as DownstreamFailure).timedOut !== true
  );
}

interface ServiceGuard {
  readonly breaker: CircuitBreakerPolicy;
  readonly retryPolicy: IPolicy;
}

const guards = new Map<string, ServiceGuard>();

/** 서비스마다 회로를 따로 둔다 — 한 서비스가 죽어도 다른 서비스 호출은 막지 않는다. */
function guardFor(service: string): ServiceGuard {
  let guard = guards.get(service);
  if (guard === undefined) {
    guard = {
      breaker: circuitBreaker(handleWhen(isTransientFailure), {
        halfOpenAfter: HALF_OPEN_MS,
        breaker: new ConsecutiveBreaker(FAILURE_THRESHOLD),
      }),
      retryPolicy: retry(handleWhen(isRetryable), {
        maxAttempts: 1,
        backoff: new ConstantBackoff(RETRY_DELAY_MS),
      }),
    };
    guards.set(service, guard);
  }
  return guard;
}

/**
 * 하위 서비스 호출을 회로 차단기로 감싼다. 연속 실패가 한도를 넘으면 회로가 열려 한동안 호출하지 않고
 * `openError()`가 만든 오류로 바로 실패한다 — 호출자가 이미 처리하는 오류 타입을 그대로 쓰기 위해서다.
 *
 * `idempotent`일 때만 재시도한다(멱등한 GET). 쓰기·발송은 응답을 못 받았어도 상대가 처리했을 수 있어 재시도하지 않는다.
 * 재시도는 회로 바깥에서 돌므로 시도마다 실패로 세고, 회로가 열리면 재시도하지 않는다.
 */
export async function guardDownstream<T>(
  service: string,
  idempotent: boolean,
  call: () => Promise<T>,
  openError: () => Error,
): Promise<T> {
  const { breaker, retryPolicy } = guardFor(service);
  const guarded = async () => {
    try {
      return await breaker.execute(call);
    } catch (error) {
      throw error instanceof BrokenCircuitError ? openError() : error;
    }
  };
  return idempotent ? retryPolicy.execute(guarded) : guarded();
}

/** 테스트에서 회로 상태를 처음으로 되돌린다. */
export function resetDownstreamGuards(): void {
  guards.clear();
}
