/**
 * Kafka가 재전달하되 DLQ 실패 횟수에는 세지 않는 에러.
 * - 발행 실패: 문자는 이미 나갔으니 DLQ로 보내면 발송 완료 이벤트가 영영 발행되지 않는다.
 * - 처리 중: 다른 곳이 쥔 선점이 풀리거나 끝나기를 기다리는 것이라 이벤트 자체의 실패가 아니다.
 */
export class RetryableWithoutDeadLetterError extends Error {
  readonly countsTowardDeadLetter = false;
}

export class SentEventPublishError extends RetryableWithoutDeadLetterError {}

export class EventInProgressError extends RetryableWithoutDeadLetterError {}

export function countsTowardDeadLetter(error: unknown): boolean {
  return (
    (error as { countsTowardDeadLetter?: boolean } | null)
      ?.countsTowardDeadLetter !== false
  );
}
