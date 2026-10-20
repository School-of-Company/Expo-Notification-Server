# Notification #20 프로그램 대기 승급 계약

2026-10-12 기준. **Notification 쪽 구현 계약이며 Application에 연결된 계약이 아니다.**
Application 저장소는 이 작업에서 수정하지 않는다. 실제 공급자 연결과 공동 계약 테스트 전에는
`promotion.enabled=false`를 유지하고 #20을 닫지 않는다. 운영 배포·유료 발송은 수행하지 않는다.

## 조사한 실제 공급자

Application develop `88819e75bdb028a8968db1764aa39ca02366ac6b`를 원격에서 읽었다.
#43은 종료됐으며 #44와 PR #66의 미전송 기록은 다음과 같다.

- [V10 저장 기록](https://github.com/School-of-Company/Expo-Application-Server/blob/88819e75bdb028a8968db1764aa39ca02366ac6b/src/main/resources/db/migration/V10__program_session_waitlist.sql):
  `tb_program_session_event(application_id UUID, status, created_at, delivered_at)`.
  PK는 `(application_id,status)`이고 별도 eventId, 발행 시도, 공급자 접수/전달 상태가 없다.
- [ProgramWaitlistRepository](https://github.com/School-of-Company/Expo-Application-Server/blob/88819e75bdb028a8968db1764aa39ca02366ac6b/src/main/kotlin/team/startup/application/domain/application/repository/ProgramWaitlistRepository.kt):
  `transition()`은 신청·이력·이벤트를 기록하고 `event()`는 ON CONFLICT DO NOTHING이다.
  최초 확정도 CONFIRMED 이벤트를 갖는다. CONFIRMED 행 전체를 승급으로 발행하면 안 된다.
- [ProgramWaitlist](https://github.com/School-of-Company/Expo-Application-Server/blob/88819e75bdb028a8968db1764aa39ca02366ac6b/src/main/kotlin/team/startup/application/domain/application/service/impl/ProgramWaitlist.kt):
  FIFO 승급당 최대 10명, 연수 연결은 승급 시 생성하며 공급자 장애 시 선두를 건너뛰지 않는다.
- [신청 DTO](https://github.com/School-of-Company/Expo-Application-Server/blob/88819e75bdb028a8968db1764aa39ca02366ac6b/src/main/kotlin/team/startup/application/domain/application/presentation/dto/ProgramSessionApplicationDto.kt):
  회차 식별자는 `programType=STANDARD|TRAINING`, `programId=Long`이다. 별도 sessionId는 없다.
  신청 ID는 UUID, participantId는 Long, traineeId는 nullable이다.
  프로그램 정의는 title/startedAt/endedAt이 nullable이며 장소·신청 조회 링크는 없다.
- 조사한 develop에는 프로그램 승급 Kafka 발행기나 아래 check API가 없다.
  기존 applied 불리언 API는 신청 UUID와 승급 동일성을 증명하지 못한다.

## Application에서 추가해야 할 계약

1. 미전송 CONFIRMED 기록 중 **동일 신청의 WAITING→CONFIRMED 이력이 있는 승급만** 발행한다.
   최초 확정·WAITING·CANCELLED는 승급 안내 대상이 아니다.
2. 신청 상태 전환과 안내 식별자를 같은 DB 트랜잭션에 저장한다.
   eventId는 UUID로 영구 저장하거나, UUIDv5 namespace
   `203395ab-1468-40fe-8a06-0d5295c81827`와 name
   `${applicationId}:WAITING->CONFIRMED`로 결정한다. 어느 방법이든 재시도에 바뀌지 않는다.
   취소 후 재신청은 **새 applicationId와 새 eventId**를 사용한다.
3. Kafka topic `application.program-session.promoted`, key=eventId,
   다음 JSON을 UTF-8로 발행한다. 한 메시지에 한 승급, 배열이나 묶음 문자는 사용하지 않는다.
   숫자 ID는 JS 안전 정수 범위 이내여야 하며 이를 넘는 공급자는 문자열 ID 버전 계약이 필요하다.

```json
{
  "version": 1,
  "eventId": "65893f93-aa70-4667-9aaa-cbdb17c2dd00",
  "applicationId": "599310cc-4e72-481e-8821-d5eb568bbf01",
  "expoId": "cf22c389-eeb4-462f-9c9a-b216bc046f10",
  "participantId": 2,
  "programType": "TRAINING",
  "programId": 3
}
```

4. Kafka broker ACK 뒤에만 outbox 발행 완료를 기록한다. ACK 유실은 같은 eventId로 재발행한다.
   기존 `delivered_at`을 사용한다면 **Kafka 발행 완료**로만 정의하고 SMS 전달로 해석하지 않는다.
   공급자 장애 시 재시도/backoff와 작업자 선점을 구현하고 발행 성공 기록 실패도 검증한다.
5. `POST /internal/program-promotions/check`, `X-Internal-Token`, body=위 이벤트를 제공한다.
   실제 신청 UUID, participant/expo/type/program ID, 현재 상태 CONFIRMED와 해당 승급 eventId를
   원장에서 검증한다. 대표자 번호·참가자 이름은 신청 대표자 소유 관계로 User에서 조회한다.
   일반 동행자 자신의 번호나 연수 trainee.phoneNumber로 대체하지 않는다.
   프로그램명/시간은 실제 회차 정보로 채운다. 필수 정보 조회 실패·User/Expo 일시장애는 5xx이며
   eligible=false나 번호 null로 위장하지 않는다. `null` 번호는 조회에 성공했으나 실제 없는 경우만이다.

```json
{
  "eligible": true,
  "eventId": "65893f93-aa70-4667-9aaa-cbdb17c2dd00",
  "applicationId": "599310cc-4e72-481e-8821-d5eb568bbf01",
  "expoId": "cf22c389-eeb4-462f-9c9a-b216bc046f10",
  "participantId": 2,
  "programType": "TRAINING",
  "programId": 3,
  "status": "CONFIRMED",
  "representativePhoneNumber": "01000000000",
  "participantName": "참가자",
  "programName": "미래 수업",
  "startedAt": "2026-10-13T10:00:00+09:00",
  "endedAt": "2026-10-13T11:00:00+09:00",
  "location": null,
  "applicationLookupUrl": null
}
```

취소·회차 교체·옛 승급은 HTTP 200
`{"eligible":false,"reason":"CANCELLED"}` 또는
`REPLACED` / `NOT_CURRENT_PROMOTION`으로 응답한다.
모호한 404, 401/403, 잘못된 JSON·식별자 불일치는 Notification에서 조회 장애로 보존한다.
시간은 offset 있는 ISO8601이며 종료가 시작보다 뒤여야 한다. 장소와 HTTPS 조회 링크는 nullable이다.
대표 번호는 숫자만, 이름/프로그램명/장소는 줄바꿈 없이 최대 100자다.
이 POST 계약과 대표자 조회를 위해 Application이 User/Expo 계약을 추가해야 할 가능성이 남아 있다.
해당 저장소 변경 범위는 공급자가 확정해야 하며 Notification이 임의로 존재를 가정하지 않는다.

## Notification 처리 및 운영 조회

- 별도 PromotionModule이다. 기존 등록 QR/CUSTOM 흐름과 키·실패 횟수를 공유하지 않는다.
- 행사명은 `sms.expoName` / `SMS_EXPO_NAME` 설정, 기본 `AI 미래교육 페스타`다.
  대표자에게 승급마다 즉시 한 통, 참가자 이름·프로그램명·한국시간 회차 일시를 넣는다.
  장소/조회 링크는 있을 때만 넣으며 추가 확정 버튼·QR 문자는 넣지 않는다.
- STANDARD/TRAINING 모두 representativePhoneNumber로 발송하고 발신번호만 기존 타입별 설정을 쓴다.
- 전송 전에 매번 check API를 호출한다. 조회와 공급자 발송 사이 취소가 발생하는 분산 경쟁은
  원자적이지 않다. Application이 취소와 발송까지 원자적 보장을 요구한다면 별도 발송권 예약/완료
  프로토콜이 필요하다. 현재 보장은 **발송 직전 조회에서의 현재 확정/동일 승급**이다.
- Redis intake JSON과 due ZSET을 원자적으로 저장한 후 Kafka ACK한다. 최초 그룹은 backlog를 읽는다.
  신규 전용 topic/group을 준비하고 이전 CUSTOM offset 정책과 혼용하지 않는다.
- `PENDING`: 조회 장애는 발송 실패 횟수를 소모하지 않고 5초 간격으로 재시도한다.
  확실한 접수 거절 또는 공급자 최종 실패는 최대 5회 실패 후 `OPERATIONS`다.
- `SENDING`: 새 attemptId/시각을 **발송 전** 영구 저장한다. 프로세스 종료·결과 저장 실패로
  이 상태가 남으면 자동 재발송하지 않는다. 30초 선점 lease와 별개로 이 기록은 만료되지 않는다.
- `UNKNOWN`: timeout, 네트워크 오류, 5xx, 해석할 수 없는 접수 응답. 자동 재발송하지 않는다.
- `ACCEPTED`: groupId/messageId를 받았지만 전달 완료는 아니다. 30초 간격 결과 조회만 한다.
- `DELIVERED`: 공급자 COMPLETE+4000 확인. `SKIPPED`: 취소/교체/옛 승급.
- `OPERATIONS`: 실제 대표 번호 없음, 메시지 2000 byte 초과, check 응답 계약 위반(`INVALID_CHECK_RESPONSE`, #95) 또는 5회 확실한 실패.
  자동 재시도하지 않는다. 개인정보(번호·이름·본문)는 Redis 원장에 저장하지 않는다.
- `GET /internal/promotion-notifications/:eventId`는 전용 내부 토큰으로 상태/원인/시도 식별자를 조회한다.
  `POST .../:eventId/reconciliation` body `{"messageId":"공급자 ID"}`는 공급자 GET 결과의
  customFields.eventId+attemptId를 검증한다. 운영자가 입력한 성공/실패 주장을 신뢰하지 않는다.
  접수 불명에서 결과 pending이면 ACCEPTED, 완료4000이면 DELIVERED, 확실한 최종 실패이면
  PENDING/OPERATIONS로 바꾼다. PENDING에 reconciliation을 보내도 추가 발송하지 않는다.
  결과 없음·불일치·조회 장애는 상태를 유지한다. 조회 실패는 HTTP 500이며 비밀/PII를 반환하지 않는다.
- 조회 가능 messageId가 없는 접수 불명은 Solapi 콘솔/지원으로 eventId+attemptId/시각을 확인한다.
  **목록에 없음만으로 미접수를 판정하지 않는다.** 공급자가 확실한 미접수를 증명했지만 messageId가
  없는 경우 자동 복구 API는 제공하지 않는다. 증거를 남긴 별도 운영 복구 절차가 필요하며,
  현재 구현은 보수적으로 재발송을 막는다. 번호 없음/5회 실패 재개도 운영 절차로 별도 합의한다.

## Solapi 실제 기능과 한계

설치 버전 6.0.1의 `dist/index.js`를 조사했다. `send()`는
POST `/messages/v4/send-many/detail`, `getMessages()`는 GET `/messages/v4/list`다.
메시지 customFields, 반환 groupId/messageId, 목록 조회 messageId/groupId/date 범위/페이지네이션을
지원하지만 입력 messageId/eventId를 발송 멱등 키로 사용하는 API나 customFields 검색 옵션은 없다.
allowDuplicates=false는 한 요청의 수신번호 중복 정책이며 요청 간 멱등 보장이 아니다.
SDK requestEffect는 네트워크 일부 오류/503을 최대 3번 내부 재시도하고 send 설정으로 끌 수 없다.
따라서 승급 전용 provider는 Node fetch+10초 AbortSignal+HMAC 인증으로 공식 REST를 단 한 번 호출한다.
SDK 버전이나 기존 SMS provider는 변경하지 않는다.

공식 근거: [발송/접수 응답](https://solapi.com/developers/api/messages),
[목록 조회와 검색 필드](https://solapi.com/developers/api/msg-getList),
[4000 전달 완료](https://solapi.com/developers/api/msg-groups-getGroupMessageList),
[SDK 소스](https://github.com/solapi/solapi-nodejs).
customFields는 상관관계 식별자이며 공급자 멱등성으로 주장하지 않는다.
오류 응답 본문·번호·비밀키·토큰은 로그에 출력하지 않는다.

## 설정과 활성화 전 조건

Config server의 선택 `promotion` 객체:

```json
{
  "promotion": {
    "enabled": false,
    "application": { "baseUrl": "http://application-service", "internalToken": "<32자 이상 비밀>" },
    "internalToken": "<운영 조회용 32자 이상 비밀>",
    "topic": "application.program-session.promoted",
    "groupId": "expo-notification-server.promotion"
  },
  "sms": { "expoName": "AI 미래교육 페스타" }
}
```

환경 변수: `PROMOTION_ENABLED=true|false`, `PROMOTION_APPLICATION_URL`,
`PROMOTION_APPLICATION_INTERNAL_TOKEN`, `PROMOTION_INTERNAL_TOKEN`,
선택 `KAFKA_PROMOTION_TOPIC`, `KAFKA_PROMOTION_GROUP_ID`.
객체가 없으면 기능은 비활성이며 새 consumer/발송 작업을 시작하지 않는다.
객체를 설정하면 토큰과 주소가 모두 필요하다. 비밀값은 문서/PR에 넣지 않는다.

Redis는 TTL 없는 `promotion:{notifications}:record:<eventId>`와 due ZSET을 사용한다.
영속 저장/AOF·백업·noeviction·접근 제한이 활성화 전 필요하다. Redis 유실/복구로 기록이 사라지면
중복 방지가 사라지므로 공급자 이력 대조 없이 backlog를 재처리하지 않는다.
기록은 임의로 삭제하지 않으며 데이터 보존/아카이빙은 공급자 재발행 수명과 함께 합의해야 한다.
한 번에 due 100건, 한 replica에서 순차 처리하므로 장기 조회 장애가 많으면 지연될 수 있다.

#8의 배포 SHA/consumer 준비 증거는 아직 남아 있다. 요청된 순서 #8→#20→#10을 지킨다.
#20의 로컬 구현을 운영 완료로 해석하지 않으며 #10은 시작하지 않는다.

## #20을 닫기 전에 남은 실제 연동

- Application 발행기와 check API, 대표자 User 조회, 실제 프로그램 시각/이름 계약 구현.
- 공급자 테스트에서 최초 확정 제외, 승급 eventId 영구 유지, 재신청 새 ID, ACK 유실 재발행 검증.
- 양 저장소의 실제 HTTP/Kafka DTO 계약 테스트 및 취소/교체 확인. 본 저장소 가짜 HTTP는 그 증거가 아니다.
- 운영 담당자 Redis 영속성·보존/복구와 UNKNOWN/OPERATIONS의 증거 기반 복구 절차 확정.
- 승인된 운영 담당자가 #8 선행 조건 및 배포/구독/공급자 결과 조회 준비를 확인.
  본 작업은 운영 배포·머지·유료 발송을 하지 않는다.
