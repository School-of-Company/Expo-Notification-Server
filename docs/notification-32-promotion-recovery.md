# Notification #32 승급 Redis 복구·UNKNOWN 대조·공동 연결 검증 runbook

[#32](https://github.com/School-of-Company/Expo-Notification-Server/issues/32)의 저장소 안 범위다.
이 문서와 코드의 병합은 운영 배포·유료 발송·`promotion.enabled` 활성화를 승인하지 않는다.
Kafka ACK는 발행 완료이며 문자 전달 완료가 아니다. 비밀값·전화번호·본문은 이슈/PR/증거에 기록하지 않는다.

## 저장소에 추가된 것

| 항목 | 내용 |
| --- | --- |
| 복구 보류 | `promotion.recoveryHold` / `PROMOTION_RECOVERY_HOLD=true`. Kafka 수신 기록(원장 PENDING)은 계속 남기고 ACK하지만, consumer·스케줄러 모두 신청 조회·발송을 하지 않는다. `POST .../reconciliation`(결과 조회, 발송 없음)과 수동 재개는 동작한다. 부팅 시 경고 로그를 남긴다. |
| 운영 점검 | `GET /internal/promotion-notifications/ops/audit` (내부 토큰). 읽기 전용. 상태별 건수, 대조 대상 목록(eventId·attemptId·시도 시각·messageId·사유·권장 조치), TTL 있는 원장, due ZSET 누락/잔여, Redis AOF·마지막 쓰기·noeviction·loading·원장 TTL 판정(PASS/FAIL/UNVERIFIED)을 반환한다. CONFIG/INFO가 ACL로 막히면 UNVERIFIED로 보고한다. |
| 수동 재개 | `POST /internal/promotion-notifications/:eventId/resumption` body `{"approvalRef":"OPS-..."}`. messageId 없는 `UNKNOWN`/`SENDING` 또는 `OPERATIONS`만 `PENDING`(실패 횟수 0)으로 되돌리고 `resumes[]`에 시각·승인 참조·이전 상태/attemptId/사유를 남긴다. 그 외 상태나 처리 중이면 409. 재개 후 발송은 새 attemptId로 같은 eventId에서 한다. |
| 가짜 SMS 발송 서버 | `sms.apiBaseUrl` / `SMS_API_BASE_URL`. 지정하면 모든 Solapi REST 호출(문자·카톡·승급·그룹)이 그 주소로 간다. 공동 연결 검증 환경 전용이며 운영에는 설정하지 않는다. |

## 1. 배포·구독 확인 (운영 담당자, 읽기 전용)

- Application #71 병합 SHA: `gh pr view 71 -R School-of-Company/Expo-Application-Server --json mergeCommit`.
- Notification 배포 SHA: main의 Deploy workflow 실행(`gh run list -R School-of-Company/Expo-Notification-Server --workflow Deploy`)과 서버 릴리스명(`<SHA 12자리>-<attempt>`)을 대조한다. #25 병합 이후이며 이 PR이 포함된 SHA여야 한다.
- topic `application.program-session.promoted` 존재와 consumer group `expo-notification-server.promotion` 구독: 기존 승인된 접속 환경에서
  `kafka-consumer-groups.sh --describe --group expo-notification-server.promotion`. offset 존재는 문자 성공 증거가 아니다.

## 2. 공동 연결 검증 (가짜 SMS 발송 서버)

운영과 분리된 환경에서 Application·Kafka·Notification을 실제로 연결하고 Notification만 `SMS_API_BASE_URL`을 가짜 서버로 둔다.
가짜 서버는 `POST /messages/v4/send-many/detail`와 `GET /messages/v4/list` 응답을
`test/integration/promotion-fixture.ts` 형식으로 돌려준다. 확인 시나리오:

- 단건·다건(승급마다 한 통), STANDARD/TRAINING, 동행자(대표 번호로만 발송).
- 같은 eventId 중복 수신 → 한 통. 취소 후 재신청 승급 → 새 applicationId·새 eventId로 한 통. 취소/교체 → SKIPPED.
- 최초 CONFIRMED는 발행되지 않는다. Application 재시도(ACK 유실)는 같은 eventId.
- check API 503/timeout → PENDING 유지, 실패 횟수 소모 없음, 복구 후 1통.
- 가짜 서버 timeout/503 → UNKNOWN, 재전달·스케줄러로 추가 발송 없음.
- `ops/audit`에서 위 상태가 분류되는지 확인한다.

## 3. Redis 정책 (운영 담당자)

활성화 전 `ops/audit`의 `redis.result`가 PASS여야 한다. UNVERIFIED면 담당자가 서버에서 직접 확인한 증거를 남긴다.

- `promotion:{notifications}:record:*`와 `promotion:{notifications}:due`에 TTL 없음(`LEDGER_NO_TTL`).
- `appendonly yes`, `maxmemory-policy noeviction`, 최근 AOF 쓰기/RDB 저장 ok.
- 서버 밖에서만 확인 가능한 항목(`redis.manual`): 백업 주기와 복원 연습, 네트워크·ACL 접근 제한,
  복구 정책(아래 4) 합의.

## 4. Redis 복구 절차

1. 복구 전에 모든 replica에 `PROMOTION_RECOVERY_HOLD=true`를 설정하고 재시작한다.
2. Redis를 복원한 뒤 `ops/audit`을 저장한다(PII 없음).
3. `reconcile`의 각 항목을 공급자 이력과 대조한다.
   - `RECONCILE_BY_MESSAGE_ID`: `POST :eventId/reconciliation`에 messageId. 공급자 customFields의 eventId+attemptId가 일치할 때만 상태가 바뀐다.
   - `PROVIDER_LOOKUP_BY_ATTEMPT`: Solapi 콘솔/지원에서 attemptedAt 전후로 customFields eventId+attemptId를 찾는다. 찾으면 그 messageId로 reconciliation. **목록에 없음만으로 미접수를 판정하지 않는다.** 공급자가 미접수를 증명한 경우에만 5의 수동 재개.
   - `VERIFY_PRIOR_ATTEMPT`: 복원본이 오래돼 이후 시도가 공급자에 있을 수 있다. 해당 eventId 이력을 공급자에서 확인하고 이미 접수됐다면 reconciliation, 없다면 그대로 둔다.
   - 복원본에 없는데 Kafka 재전달로 새로 생긴 PENDING도 공급자에서 같은 eventId 발송 이력을 먼저 확인한다.
4. 모든 대조와 승인 기록 뒤에만 `PROMOTION_RECOVERY_HOLD=false`로 재시작한다.

## 5. UNKNOWN(messageId 없음)·OPERATIONS 수동 재개

| 상태 | 필요한 증거 | 승인 |
| --- | --- | --- |
| UNKNOWN/SENDING, messageId 없음 | 공급자가 해당 eventId+attemptId 미접수를 확인한 답변/콘솔 기록(시각 범위 포함) | 운영 승인 담당자 1인 + 기록 |
| OPERATIONS `MISSING_REPRESENTATIVE_PHONE` | Application/User에 대표 번호가 보정된 기록 | 운영 승인 담당자 |
| OPERATIONS `MESSAGE_TOO_LONG` | 회차 정보 보정 기록 | 운영 승인 담당자 |
| OPERATIONS 5회 실패 | 공급자 실패 코드 원인 해소 기록 | 운영 승인 담당자 |

승인 기록 ID를 `approvalRef`로 넣어 `POST :eventId/resumption`을 호출한다. 승인 담당자 지정은 팀이 정한다.

## 6. 활성화 결정 (운영 담당자)

1~5 증거를 확인한 뒤 Notification `promotion.enabled`와 Application `APPLICATION_PROMOTIONS_ENABLED`를 결정한다.
Application `APPLICATION_PROMOTIONS_PUBLISH_FROM`은 최초 활성화의 고정 UTC 시각으로 정하고 모든 replica/재시작에서 유지한다.
cutoff를 과거로 바꿔 backlog를 포함하기 전에는 공급자 결과 대조와 명시적 운영 승인을 기록한다. 새 eventId로 재발행하지 않는다.
