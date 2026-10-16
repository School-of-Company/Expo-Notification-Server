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

export class QrLinkError extends Error {}

/** 공급자가 한 건도 접수하지 않았음이 확실한 실패. 선점을 풀고 제한 재시도한다. */
export class SmsDeliveryRejectedError extends Error {}

/**
 * 공급자 접수 여부를 알 수 없다 (timeout·연결 끊김·성공 후 상태 기록 실패 등).
 * 자동 재발송하지 않는다: consumer가 원본을 DLQ에 보관하고 다음 이벤트로 넘어간다.
 */
export class SmsDeliveryUnknownError extends Error {}

export function countsTowardDeadLetter(error: unknown): boolean {
  return (
    (error as { countsTowardDeadLetter?: boolean } | null)
      ?.countsTowardDeadLetter !== false
  );
}
