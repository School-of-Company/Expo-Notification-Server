# 알림 서버 이벤트 계약 / 설정 키

## Kafka 이벤트

공통: JSON, UTF-8. `eventId`(멱등키)는 필수. `version: 1`은 `notification.sms.requested`에 필수이며, `user.participant.registered`에는 요구하지 않는다. 스키마가 틀린 메시지는 값 없이 검증 사유만 로그에 남기고 건너뛴다.

### `user.participant.registered` — 등록 완료 (User 발행, QR 문자)

```json
{ "eventId": "…", "expoId": "…", "participationType": "STANDARD", "id": 42, "phoneNumber": "010-1234-5678", "representativeId": 42, "participants": [{ "id": 42, "code": "abcdefghijklmnopqrstuv" }, { "id": 43, "code": "ABCDEFGHIJKLMNOPQRSTUV" }] }
```

User 서비스가 일반 PRE/FIELD 신규 등록, 허용된 QR 재발송(어드민 재발송 포함), 연수 FIELD 신규 등록 때 아웃박스로 발행한다 (연수 PRE는 발행하지 않음).
전화번호는 하이픈이 있어도 받고 숫자만 남겨 정규화한다. 처리 순서:

1. `eventId` 선점 (이미 끝낸 이벤트면 문자는 건너뛰고 발행만 이어서 시도. 다른 곳에서 처리 중이면 버리지 않고 던져서, 선점이 풀린 뒤 다시 받는다)
2. 이벤트 목록만큼 프론트 `/qr` 링크를 만들고, STANDARD는 User `POST /internal/standard-participants/names`로 이름을 한 번 조회한다 (`X-Internal-Token`)
3. 대표자 번호로 줄바꿈한 링크들을 한 통 발송한다 (일반/연수 발신번호와 문의 번호는 기존 설정 사용)
4. 완료 마커로 승격하고, **일반 참가자만** `notification.qr-sms.sent` 이벤트를 발행

`participants`는 이번 문자 대상(1~5명)이다. 새 동행자 추가는 새 동행자만, 재발송은 기존 전체다. 대표자는 `representativeId ?? id`로 판별하고 존재할 때만 먼저 표시한다. 나머지는 이벤트 순서를 유지하며 목록에 없는 대표자를 추가하지 않는다. 완료 이벤트의 `id`도 `representativeId ?? id`다.

이름은 이벤트에서 읽지 않는다. 이름 조회 요청은 `{expoId, participantIds}`, 응답은 요청 순서대로 `[{participantId,name}]`다. 이름이 있으면 `이름(대표자): 링크` / `이름: 링크`, 없으면 `대표자: 링크` / `동행자 1: 링크`를 사용한다. 이름 API 미설정, 404/401/5xx, 연결/JSON 실패, 잘못된 ID/순서/이름 응답은 전체 이름을 역할 라벨로 대체하고 발송을 계속한다. 선택 조회가 발송을 오래 막지 않게 공통 HTTP 기본 10초 대신 2초 timeout을 적용한다. 이름/전화번호/code/완성 링크나 원문 응답/오류는 QR 처리 로그에 남기지 않는다.

### QR 링크 설정과 미발송 정책

- STANDARD: `sms.qrUrlTemplate` / `SMS_QR_URL_TEMPLATE`
  `https://<Client 도메인>/qr?expoId={expoId}&type={participationType}&id={id}&code={code}`
- TRAINEE FIELD: `sms.traineeQrUrlTemplate` / `SMS_TRAINEE_QR_URL_TEMPLATE`
  `https://<Client 도메인>/qr?expoId={expoId}&type={participationType}&id={id}&phoneNumber={phoneNumber}`
- 두 형식은 다르므로 연수자에 STANDARD 템플릿을 대신 사용하지 않는다. 연수자는 Client의 기존 `{traineeId,phoneNumber}` QR를 유지하며 전화번호가 URL에 남는다. 일행 페이지/token 발급이나 일반 code 생성은 하지 않는다.
- 치환 값은 URI 인코딩한다. HTTPS, 정확한 `/qr` 경로와 쿼리 이름/값/개수, 필수 placeholder를 검증한다. ID는 positive safe integer, STANDARD code는 영문·숫자·`_`·`-` 22자다. 자격증명/fragment/추가 쿼리를 허용하지 않는다.
- 두 템플릿은 필수다. 없거나 비어 있으면 부팅을 실패시킨다. 미설정 상태로 이벤트를 소비해 커밋하면 그 등록의 QR 문자가 영구히 유실되기 때문이다.
- 비어 있지 않은 잘못된 템플릿, STANDARD의 누락된 participants/code, 한 통 길이 상한 초과는 발송 없이 실패하며 선점을 해제한다. 기존 최대 재시도 후 DLQ 정책을 사용한다. 성공을 거짓 기록하지 않는다.
- code 형식 오류/중복 ID/빈 목록/6명 이상/잘못된 ID 등 스키마 오류는 기존 소비 정책대로 로그 후 건너뛰며 미발송한다. 원본을 복구하려면 운영 원본 이벤트 보관이 필요하다.
- 구버전 STANDARD 이벤트에 code/목록이 없으면 번호로 QR를 생성하거나 code를 추측하지 않는다. 현재 User resolve API는 ID만 반환하고 names API도 code를 반환하지 않는다. User에서 현재 저장된 QR로 새 등록/재발송 이벤트를 생산하거나, 원본 outbox 목록이 있는 경우 공급자가 복구한 이벤트를 재생해야 한다. 구버전의 `done-v2`는 이미 발송한 문자이므로 완료 발행만 이어가고 `done`은 모두 건너뛴다.

[Solapi 공식 발송 계약](https://solapi.com/developers/api/messages)에 따르면 `autoTypeDetect` 기본값은 true이고 type 생략 시 90바이트 초과는 LMS(2,000바이트 상한)로 전환된다. 설치 SDK 6.0.1의 `send`는 타입을 생략한 메시지를 `messages/v4/send-many/detail`에 그대로 전달한다. QR 본문의 UTF-8 크기를 보수적으로 2,000바이트 이하로 제한하며 초과 시 나누어 보내지 않는다. 한글은 통신사 기준 2바이트지만 UTF-8에서는 3바이트여서 실제 LMS에 들어갈 일부 긴 본문도 미발송될 수 있다. 운영 Client 도메인/행사명/문의번호를 반영한 5명 본문으로 최종 길이를 확인해야 한다.

### `notification.qr-sms.sent` — QR 문자 발송 완료 (알림 서버 발행, User 소비)

```json
{ "eventId": "…", "expoId": "…", "participationType": "STANDARD", "id": 42 }
```

파티션 키는 `eventId`. `eventId`는 소비한 등록 완료 이벤트의 `eventId`를 그대로 쓴다. User가 이 값으로 중복을 걸러 문자 발송 횟수(`smsTryTime`)를 한 번만 올린다.
일반 참가자(`STANDARD`)만 발행하고 연수자는 발행하지 않으며, 전화번호는 싣지 않는다. User 컨슈머의 dead letter는 `notification.qr-sms.sent.dlt`.

- 문자 발송 상태와 발행 상태를 분리해 둔다. **발행이 실패하면 던져서 Kafka가 재전달하고, 재전달 때는 문자를 다시 보내지 않고 발행만 다시 시도한다.** 같은 `eventId`가 중복 발행돼도 User가 걸러 준다.
- **발행 실패는 DLQ 실패 횟수에 세지 않는다.** 문자는 이미 나갔으므로 DLQ로 보내면 발송 완료 이벤트가 영영 발행되지 않는다. 토픽이 없거나 브로커에 발행할 수 없다면 성공할 때까지 같은 메시지를 계속 재시도하며 파티션이 막힌다(에러 로그 `qr-sms.sent 발행 실패`로 드러난다). 토픽이 자동 생성되지 않는 환경이라면 배포 전에 `notification.qr-sms.sent`를 만들어 둔다. User 소비자가 아직 배포되지 않아도 Kafka 발행 자체는 성공할 수 있다. 이 경우 횟수 반영은 소비자가 배포되어 이벤트를 소비할 때까지 지연된다.
- 이전의 User `sms-try` HTTP 호출은 제거했다 (Expo-User-Server#38/#50에서 이벤트 방식으로 확정). 배포 순서: User의 소비자를 먼저 배포한 뒤 이 서비스를 배포한다.
- 전환 전 HTTP 방식의 Redis `sms:event:{eventId}=done`은 문자와 완료 이벤트를 모두 건너뛴다. 새 완료 마커는 `done-v2`로 저장해 발행 대기 상태와 구분한다. 기존 HTTP 호출 실패 여부는 마커에 없어 과거 미집계 이벤트를 자동 복구하지 않으며, 기존 마커 만료 이후의 재전달은 구분할 수 없다. 구버전 소비자를 종료하고 처리 중 메시지를 정리한 뒤 전환한다.
- 완료 이벤트 producer는 모듈 초기화에서 연결하고, SMS 소비는 전체 모듈 초기화가 끝난 bootstrap 단계에서 시작한다. 종료 시 소비를 먼저 중지한 후 application shutdown 단계에서 완료 이벤트 producer를 닫는다.

입장 후 설문 SMS는 2026-10-09 요구 폐기로 제거하였다. 설문은 공개 링크 QR로 받는다.
근거: [Attendance #53](https://github.com/School-of-Company/Expo-Attendance-Server/issues/53),
[Notification #3 댓글](https://github.com/School-of-Company/Expo-Notification-Server/issues/3#issuecomment-6075037497).
등록 QR SMS는 유지하며 개인별 QR 링크 전환은 #9 / PR #22로 develop에 반영되었다.

### `notification.sms.requested` — 일반 문자 발송 요청

`type`으로 구분한다. 전화번호는 하이픈 없는 `01XXXXXXXXX`. `senderType`은 `STANDARD`(일반 참가자 발신번호) / `TRAINEE`(연수생 발신번호).

| type | 필드 | 설명 |
|---|---|---|
| `DRAW_RESULT` | `phoneNumber`, `drawNumber`, 선택 `expoId` | 설문 행운 번호 당첨 (일반 참가자 발신번호 고정). `expoId`는 받기만 하고 아직 쓰지 않는다(K4 문구에 행사명이 없음) |
| `CUSTOM` | `phoneNumbers[1..1000]`, `senderType`, `text` | 본문을 호출 측이 만든 일반/대량 문자 (연수 일정 안내 포함) |

완료 시점부터 7일 동안 `done-v2` 마커가 남아 있으면 같은 `eventId`의 문자 재발송을 억제한다. 발송 결과는 세 가지로 나눈다(아래 **접수 결과 불명(UNKNOWN)** 참고).
- 명시적 거부(공급자가 한 건도 접수하지 않음): consumer가 던져 Kafka가 재전달하고, `sms.eventMaxAttempts`번 실패하면 DLQ로 옮긴다.
- 일부 수신자만 실패: 재전달하지 않는다(접수된 수신자 중복 발송 방지). 마스킹된 번호로 경고 로그만 남긴다.
- 접수 결과 불명(timeout·연결 끊김 등): 자동 재발송하지 않는다.

7일 TTL 만료나 Redis 데이터 유실 뒤의 replay는 여전히 중복 가능성이 있어 정확히 한 번 발송을 보장하지 않는다.

#### 연수 신청 CUSTOM 수신 번호 (Notification #11)

Expo producer가 User 연수자 응답에서 `notificationPhoneNumber`를 선택하여 기존
`phoneNumbers` 배열에 넣는다. 기존 응답에서 해당 필드가 없거나 `null`일 때만
`phoneNumber`로 fallback한다. 선택된 번호는 producer에서 하이픈/공백을 제거하고
`^01\d{8,9}$` 형식을 검증한다. 값이 있는 잘못된 `notificationPhoneNumber`를 개인 번호로
대체하지 않는다. 둘 다 없거나 선택한 번호가 유효하지 않으면 SMS 이벤트를 발행하지 않고
producer에서 수신자 확인 실패로 기록/처리한다. Notification에는 빈 배열, `null`, 빈 문자열을
보내지 않는다. 현재 consumer는 스키마 불일치 메시지를 건너뛰므로 이를 재시도 수단으로 쓰면 안 된다.

Notification은 User 연락처를 조회하지 않는다. CUSTOM 계약에 `notificationPhoneNumber`,
`traineeId` 등의 새 필드를 추가할 필요도 없다. 같은 대표 번호를 쓰는 서로 다른 연수자는
producer가 서로 다른 `eventId`를 발급해야 한다. 동일 신청 작업의 재전달은 기존 `eventId`와
payload를 유지한다. 번호만으로 사람이나 이벤트를 합치지 않는다. Notification의 멱등키는
`sms:event:${eventId}`이며, 서로 다른 이벤트의 수신 번호가 같아도 각각 발송한다.
24시간 완료 마커 만료 후 재전달은 다시 발송될 수 있다.

확인한 upstream과 남은 의존성 (2026-10-11 조사 시점):

- [User PR #82](https://github.com/School-of-Company/Expo-User-Server/pull/82),
  head `3bae76c4fbd9395abf3202bbfd1f81ba612e211d`: 연수자 상세 응답은
  `notificationPhoneNumber ?: phoneNumber`를 제공한다. 참가자 연결 생성은 본인 번호,
  없으면 대표자 번호를 저장하며 `phoneNumber`는 `null`일 수 있다.
- [Expo #44](https://github.com/School-of-Company/Expo-Expo-Server/issues/44)는 SMS를
  후속 작업으로 설명하지만, 확인한 develop `cad63429eea3e969eeab4f60f9938e7e15a23358`에는
  이미 producer가 있다.
  [PublishTrainingSmsServiceImpl](https://github.com/School-of-Company/Expo-Expo-Server/blob/cad63429eea3e969eeab4f60f9938e7e15a23358/src/main/kotlin/team/startup/expo/domain/training/service/impl/PublishTrainingSmsServiceImpl.kt)은
  `CUSTOM`, `TRAINEE`, 단일 수신자 배열을 발행하며 outbox payload를 재사용한다.
  [TrainingApplicationSmsServiceImpl](https://github.com/School-of-Company/Expo-Expo-Server/blob/cad63429eea3e969eeab4f60f9938e7e15a23358/src/main/kotlin/team/startup/expo/domain/training/service/impl/TrainingApplicationSmsServiceImpl.kt)은
  연수자 신청 작업마다 UUID를 생성하고 outbox는 그 operationId를 eventId로 저장한다.
- **조사 시점의 blocker ([Expo #72](https://github.com/School-of-Company/Expo-Expo-Server/issues/72)로 후속 등록):**
  [TrainingDependenciesClient.traineePhoneNumber](https://github.com/School-of-Company/Expo-Expo-Server/blob/cad63429eea3e969eeab4f60f9938e7e15a23358/src/main/kotlin/team/startup/expo/domain/training/service/TrainingDependenciesClient.kt)은
  User 상세에서 아직 `phoneNumber`만 읽는다. 번호 없는 연결 연수자는 조회 검증에 실패하며
  relay는 outbox를 재시도한다. Expo에서 위 선택/fallback/번호없음 계약을 구현하고 검증해야 한다.
  SMS 활성화와 `contract-verified` 설정 및 실제 배포 상태는 별도 확인이 필요하다.

Notification 범위는 기존 SmsEventService와 실제 SmsEventGuard를 사용하는 회귀 테스트로
동일 대표 번호/서로 다른 eventId의 두 발송과 각 eventId 재전달 억제를 보장한다.
Solapi와 Redis는 테스트 대역을 사용하므로 실제 발송이나 upstream 통합 검증은 포함하지 않는다.
Redis 키, processing/done 상태 및 TTL 인자는 기존 `sms-stores.spec.ts`가 별도로 검증한다.
실제 Redis의 TTL 만료 동작을 검증한 것은 아니다.

**DLQ** (두 SMS 소비 토픽 공통): 같은 이벤트 처리가 `sms.eventMaxAttempts`(기본 5)번 실패하면 원본 메시지를 `notification.sms.requested.dlq`로 옮기고(`x-source-topic` 헤더에 출처 토픽) 다음 메시지로 넘어간다.
유효한 메시지는 처리 전에 현재 오프셋(다음 오프셋이 아님)을 커밋한다. 첫 메시지가 실패하여 consumer가 재시작되어도 `fromBeginning: false`가 최신 위치로 이동해 해당 메시지를 건너뛰지 않도록 한다. 성공 또는 DLQ 이동 후의 다음 오프셋 커밋은 KafkaJS가 수행한다.
DLQ로 옮길 때 이벤트별 실패 카운터를 지워서, 재처리한 메시지가 첫 실패에 곧바로 다시 DLQ로 가지 않는다. 연수 CUSTOM은 2026-10-12 Expo 담당자 합의에 따라 원인 해결 후 최초 Notification 처리 시도부터 7일 미만에 원본 `eventId`와 JSON을 유지하여 원 토픽으로 수동 재처리한다. 7일 이상 지났거나 최초 처리 시각을 확인할 수 없는 건은 담당자가 발송 이력과 중복 영향을 수동 판단한다. DLQ 보관 기간은 재처리 허용 기간이 아니다. DLQ 발행까지 실패하면 던져서 이벤트를 잃지 않는다.
DLQ 전송이 성공한 뒤 카운터 정리가 실패하면 경고를 남기고 원본 처리를 끝낸다. 정리 실패 시 잔존 카운터 때문에 수동 재처리가 조기에 다시 DLQ로 갈 수 있으므로 재처리 전에 해당 실패 카운터를 확인한다.

processing(선점 5분) 이벤트는 건너뛰거나 DLQ로 보내지 않고 기다려 실제 처리 중 이벤트의 유실을 막는다.

#### 접수 결과 불명(UNKNOWN) — 일반·CUSTOM·QR 공통 (#46)

공급자에 요청하기 직전에 `sms:event:{eventId}=sending`을 완료 마커와 같은 7일 TTL로 기록한다. 이후 결과는 다음처럼 처리한다.

| 결과 | Redis 상태 | 처리 |
|---|---|---|
| 접수(전부 또는 일부) | `done-v2` | 완료. QR은 `qr-sms.sent` 발행 |
| 명시적 거부: 4xx(408 제외), 전 건 `registeredFailed`, 연결 수립 실패(`ECONNREFUSED`·`ENOTFOUND`·`EAI_AGAIN`·`UND_ERR_CONNECT_TIMEOUT`) | 삭제(선점 해제) | 제한 재시도 → DLQ |
| 결과 불명: 응답 timeout(15초), 연결 끊김, 408·5xx, 해석할 수 없는 응답, 호출 뒤 예외 | `unknown` | 자동 재발송 금지 |
| 접수 뒤 완료 기록 3회 실패 / 호출 중 프로세스 종료 | `sending` 유지 | 재전달되면 결과 불명으로 처리 |

- 결과 불명 이벤트는 원본 key/value를 `x-source-topic`과 `x-sms-delivery: UNKNOWN` 헤더로 DLQ에 보관한 뒤 오프셋을 넘겨 다음 이벤트를 처리한다. 실패 카운터에는 세지 않는다. 같은 `eventId`가 다시 오면(재전달, 재시작, replay) 문자를 보내지 않고 다시 DLQ에 보관한다. DLQ 발행이 실패하면 던져서 원본을 잃지 않는다. 재전달되더라도 Redis 상태 때문에 문자는 다시 나가지 않는다.
- QR은 결과 불명이면 문자 발송을 확인할 수 없으므로 `qr-sms.sent`를 발행하지 않는다.
- 이벤트 발송은 Solapi SDK를 거치지 않고 `send-many/detail`을 HTTP로 **한 번만** 호출한다. `solapi@6.0.1`의 기본 fetcher는 `aborted`·`refused`·`reset`·`econn` 네트워크 오류와 503을 내부에서 최대 3회 재시도하고 요청 timeout이 없다. 그래서 한 번의 `send()`가 같은 묶음을 여러 번 접수시킬 수 있다(승급·관리자 그룹 발송과 같은 이유). 메시지마다 `customFields.eventId`를 넣어 Solapi 콘솔에서 이벤트를 대조할 수 있게 했다. 인증번호(OTP) HTTP 발송은 이번 변경 범위가 아니어서 SDK 경로를 그대로 쓴다.
- 새 설정 키는 없다. 이벤트 발송 timeout 15초는 코드 상수다. kafkajs는 메시지를 처리하는 동안 heartbeat를 보내지 않으므로 기본 session timeout(30초)보다 짧게 두었다. Solapi가 이보다 늦게 응답하면 결과 불명으로 처리된다. `allowDuplicates`는 SDK와 마찬가지로 보내지 않는다(서버 기본값). CUSTOM에 같은 번호가 중복되어 응답 건수가 요청 건수와 다르면 결과 불명으로 처리된다(재발송하지 않음).

운영 복구(자동 복구 없음, 권한 있는 담당자만 수행):
1. 로그 `문자 접수 결과 불명`과 DLQ의 `x-sms-delivery: UNKNOWN` 메시지에서 eventId를 확인한다. DLQ 원문에는 전화번호와 본문이 있으므로 로그·이슈·PR에 복사하지 않는다.
2. Solapi 콘솔에서 `customFields.eventId`나 발송 시각으로 실제 접수·전달 여부를 확인한다. 리밸런스나 늦은 응답 때문에 실제로는 접수된 이벤트가 UNKNOWN DLQ에 들어갈 수 있다. 재발송하기 전에 이 단계를 반드시 거친다.
3. 접수된 경우: `sms:event:{eventId}`를 `done-v2`(EX 604800)로 바꾼다. STANDARD QR이면 원본을 원 토픽으로 replay하여 문자 없이 `qr-sms.sent` 발행만 복구한다.
4. 접수되지 않은 경우: `sms:event:{eventId}`를 삭제한 뒤 원본 `eventId`와 JSON을 그대로 원 토픽으로 replay한다. CUSTOM 일부만 접수된 경우 전체 replay는 접수된 수신자에게 중복 발송된다. 미접수 번호만 담은 새 `eventId` 이벤트를 따로 만들어야 한다.
5. 상태 확인 없이 키를 삭제하거나 DLQ 전체를 일괄 replay하지 않는다. 일괄 replay는 `unknown`/`sending` 이벤트를 다시 DLQ로 보낼 뿐 발송하지 않으므로 안전하다. 반면 키를 지운 뒤 replay하면 다시 발송된다.

배포 제약: 구버전 인스턴스는 `sending`/`unknown` 값을 처리 중으로 보고 재전달 대기를 반복한다(발송하지 않음). 혼합 버전 구간에서는 해당 파티션이 대기할 수 있으므로 같은 consumer group의 구버전을 모두 교체한다. 롤백할 때도 남아 있는 `sending`/`unknown` 키는 같은 이유로 해당 파티션을 막는다. 이 경우 위 복구 절차로 키를 먼저 정리한다. 발송 전 단계(이름 조회 등)는 선점 5분 안에 끝나야 한다. 이 시간을 넘기면 다른 인스턴스가 같은 이벤트를 선점할 수 있다(소유자 토큰은 두지 않았다).

## 박람회 등록 인원 리포트 (내부 API 조회, #54)

`expo.applicant-count.updated` 이벤트는 발행하는 서비스가 없어 리포트가 나가지 않았다. 그래서 이벤트를 받지 않고 크론이 직접 조회하도록 바꿨다. 컨슈머와 `kafka.alarmGroupId`·`kafka.topics.expoApplicantCount` 설정은 제거했다. config-server에 남은 두 키는 무시된다.

1. Expo `GET /internal/expo?page=&size=100`(Expo-Expo-Server#134): 삭제 중이 아니고 종료일이 오늘(KST) 이후인 박람회의 `expoId`·`title`을 `hasNext=false`까지 읽는다. 최대 10페이지(1,000개)이고 넘으면 그 회차를 실패로 본다.
2. Application `GET /internal/expos/{expoId}/preregistrations/summary`(Expo-Application-Server#184, #68): `confirmedUniqueParticipants`(행사 전체 고유 확정 인원, 취소 제외)를 "등록 인원"으로, `waitingParticipants`를 "대기 인원"으로, `sessions[].confirmedParticipants`를 회차별 확정 인원으로 쓴다. 여러 회차에 신청한 사람도 전체에선 한 명이라 회차별 합은 전체와 다를 수 있다. 연결은 `promotionOffer.application`, 없으면 `promotion.application`을 재사용한다(`enabled`와 무관).
3. Expo `GET /internal/expo/{expoId}/preregister-sessions`: 회차 `id`→`title`. 이름이 없는 회차는 `회차 {sessionId}`로 표시한다.

- 매 정각(KST)에 위 값으로 Discord 웹훅 리포트를 보낸다. "어제 인원"은 매일 00:00:30(KST)에 같은 조회로 얻은 확정 인원을 `alarm:yesterday:{expoId}`에 저장한 값이다(TTL 2일). 스냅샷이 없으면 0으로 본다. 증감은 취소로 줄면 음수로 표시한다.
- 확정·대기·회차별 인원이 직전 발송(`alarm:last-sent:{expoId}`, TTL 30일)과 다른 박람회만 담는다. 바뀐 박람회가 없으면 보내지 않는다. 어제 인원·증감·날짜만 바뀐 경우는 보내지 않는다. 직전 값은 발송이 성공한 뒤에만 저장한다.
- 조회나 발송이 실패하면 오류를 로그에 남기고 그 회차를 건너뛴다. 일부 박람회만 담은 리포트는 보내지 않는다. 자정 스냅샷이 실패하면 다음 날 리포트의 어제 인원이 이전 스냅샷 값이거나 0이 된다.
- `expo`나 Application 연결 설정, `discord.participantNumberUrl` 중 하나라도 없으면 리포트와 스냅샷을 생략한다. 리포트를 즉시 멈추려면 `discord.participantNumberUrl`을 비운다.
- 크론은 Redis 락(`alarm:lock:*`, 55초)으로 인스턴스가 여러 개여도 한 번만 실행된다.

## HTTP

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/sms` | `{ phoneNumber }` — 4자리 인증번호 발송. 번호별 상한 초과 또는 **전체 시간당 상한(`authMaxSendCountPerHour`, 기본 300) 초과 시 429**, 처리 중 인증 창이 만료되면 409(문자 미발송, 다시 요청), 게이트웨이 실패 시 502 |
| `POST` | `/sms/verify` | `{ phoneNumber, code }` — 인증번호 검증 (없으면 404, 불일치 400, 시도 상한 초과 429 — 맞고 틀리고와 무관하게 시도마다 횟수가 오른다) |
| `GET` | `/sms?phoneNumber=&code=` | deprecated. 위와 동일하지만 코드가 URL/접근 로그에 남는다 |

> 인증 창(`sms:auth:{phoneNumber}` hash): 첫 발송이 Lua로 TTL(`authCodeTtlSeconds`)과 창 토큰을 함께 심고, 창 안의 재발송은 TTL을 늘리지 않으며 검증 시도 횟수도 유지한다. 코드 저장·시도 횟수·인증 표시는 Lua로 같은 창 토큰일 때만 반영하므로, 처리 중 창이 만료되면 TTL 없는 키를 되살리거나 그 사이 열린 새 창을 덮어쓰지 않는다. 발송은 이때 새 창을 열지 않고 409로 실패하고(번호별 상한 우회 방지, 전체 시간당 카운터는 이미 소모), 검증은 404로 본다. 창 토큰이 없는 이전 버전 키는 인증에 쓰지 않고 다음 발송 때 새 창으로 바꾼다.

> Gateway: `/sms`가 `publicPaths`에 없으면 가입 전 인증번호 발송이 JWT에 막힌다. Eureka 서비스 이름은 `expo-notification-server`이므로 Gateway 라우팅(`/sms: expo-sms-server`)도 이 이름으로 바꿔야 한다. Gateway 전역 rate limit(IP당 100/분)은 문자 비용 방어로는 느슨해서 알림 서버에 전체 시간당 상한을 따로 두었다.

## 설정 키 (config-server `notification-{profile}.yml` + Vault `secret/notification`)

메트릭 listener, 신규 환경 변수, Eureka 등록 및 배포 후 확인 조건은 [metrics.md](metrics.md)를 참고합니다.

서비스 식별자는 `notification` (`CONFIG_SERVICE_NAME`으로 변경 가능). 조회 경로: `GET {CONFIG_SERVER_URL}/configs/notification/{profile}`.
config-server 값이 env 값보다 우선하고, config-server 호출이 실패하면 부팅을 실패시킨다.
config-server가 인증을 켜면(Expo-Config-Server#54) `CONFIG_SERVER_PASSWORD`를 env로 준다. Basic 인증으로 보내며
사용자 이름은 위 서비스 식별자다 (config-server는 자기 식별자의 설정만 내려주므로 `CONFIG_SERVICE_NAME`을 바꾸면
그 식별자의 비밀번호가 필요하다). 비밀번호를 `CONFIG_SERVER_URL`에 넣지 않는다. 비어 있으면 헤더 없이 호출한다.

```yaml
port: 3000
metrics:
  enabled: true
  port: 9464
  host: 127.0.0.1
kafka:
  brokers: ["<KAFKA_HOST>:9092"]      # 문자열 "a:9092,b:9092"도 허용
  clientId: expo-notification-server
  smsGroupId: expo-notification-server.sms
  topics:
    smsRequested: notification.sms.requested
    qrSmsSent: notification.qr-sms.sent
    participantRegistered: user.participant.registered
    smsDeadLetter: notification.sms.requested.dlq
redis:
  host: "<REDIS_HOST>"
  port: 6379
sms:                                   # 비밀 값은 Vault
  fromStandardNumber: "…"
  fromTraineeNumber: "…"
  authCodeTtlSeconds: 300
  authMaxSendCount: 5
  authMaxSendCountPerHour: 300
  eventMaxAttempts: 5
  authMaxVerifyAttemptCount: 5
  contactStandardNumber: "…"           # 필수, QR 문자의 (문의) 줄
  contactTraineeNumber: "…"            # 필수
  qrUrlTemplate: "https://<Client 도메인>/qr?expoId={expoId}&type={participationType}&id={id}&code={code}"   # 필수
  traineeQrUrlTemplate: "https://<Client 도메인>/qr?expoId={expoId}&type={participationType}&id={id}&phoneNumber={phoneNumber}"   # 필수
user:                                  # 이름 조회, 통째로 생략하면 역할 라벨
  baseUrl: "http://<USER_HOST>:8080"
  internalToken: "…"                    # Vault, 32자 이상
expo:                                  # 등록 인원 리포트의 박람회 목록과 문자 #{행사명}, 생략하면 리포트 생략·기본 행사명
  baseUrl: "http://<EXPO_HOST>:8080"
  internalToken: "…"                    # Vault, 32자 이상, Expo의 EXPO_INTERNAL_TOKEN과 같은 값
```

| 위치 | 키 |
|---|---|
| Vault `secret/notification` | `sms.apiKey`, `sms.apiSecret`, `discord.participantNumberUrl`, `redis.password`, `user.internalToken` (32자 이상, User의 내부 토큰 사본, 이름 조회), `expo.internalToken` (32자 이상, Expo의 내부 토큰 사본, 박람회 목록·사전등록 회차 조회) |

env 이름 조회 키는 `USER_SERVICE_URL`, `USER_SERVICE_INTERNAL_TOKEN`이다. 둘 다 없으면 fallback하고 일부만 설정되었거나 토큰/URL이 잘못되면 부팅을 실패시킨다. Expo 연결 env 키는 `EXPO_SERVICE_URL`, `EXPO_SERVICE_INTERNAL_TOKEN`이며 규칙은 같다. Attention HTTP 설정은 제거했다. User 이름 API만 사용하며 제거된 `sms-try` HTTP 호출은 복구하지 않는다.

### 카카오 알림톡 (`KAKAO_CONFIG_FILE`)

env `KAKAO_CONFIG_FILE`에 JSON 파일 경로를 주면 env 설정 위에 합친다(config 서버 값이 더 우선). 파일을 읽지 못하거나
JSON 객체가 아니면 경로만 담은 에러로 부팅을 실패시킨다. 모양은 [알림톡 계획 4장](kakao-alimtalk-plan.md)을 따른다.

- `kakao.pfId`, `kakao.auto.{authCode,qrRegistered,promotion,drawResult}`: 자동 메시지 K1~K4의 templateId. 모두 선택이고,
  templateId가 하나라도 있으면 `pfId`가 필요하다. 키가 있으면 **카톡과 문자를 항상 둘 다** 보낸다. 문자를 먼저 보내고,
  문자가 접수되면 같은 본문의 카톡을 따로 한 건 보낸다(`disableSms: true`, Solapi 대체 문자 끔). 카톡이 없는 번호는 카톡만
  실패하고 문자는 받는다. 키가 없으면 문자로만 보낸다. 문구는 `src/sms/sms-message.templates.ts` 상수에 있다.
- **비용**: templateId가 설정된 메시지는 수신자마다 문자와 카톡이 각각 과금되어 비용이 약 2배다. 의도된 동작이다.
- 성공·실패는 문자 기준으로 판정한다(인증번호 502, Kafka 재전달, 승급 원장 상태). 카톡 실패·결과 불명은 마스킹한 번호로
  경고 로그만 남기고 재전달·재시도하지 않는다. 문자가 실패하면 카톡은 보내지 않아서, 재전달 때 카톡이 쌓이지 않는다.
- 본문이 알림톡 한도(1,000자)를 넘는 QR·승급 메시지는 카톡은 빼고 문자로만 보낸다.
- K1 인증번호는 이미 승인된 템플릿 문구를 쓴다. 행사명이 고정이고 `#{인증번호}`만 바꾸며, 문구의 "5분"에 맞춰 `authCodeTtlSeconds` 기본값이 300이다.
  `POST /sms`의 `expoId`는 받기만 한다.
- `#{행사명}`은 이벤트의 박람회 제목이다. Expo `GET /internal/expo` 목록을 10분 캐시해서
  찾고, `expoId`가 없거나 목록에 없거나 조회가 실패하면 `sms.expoName`을 쓴다. 제목을 못 찾아도 발송은 막지 않는다.

config-server 쪽에서 해야 할 일: `configs/notification-{local,dev,prod}.yml` 추가, `docs/service-configs.md` 표와
`src/config/configs-files.spec.ts`의 `SERVICES`에 `notification` 추가.

TRAINEE CUSTOM의 실제 Kafka/Redis 통합 테스트, 7일 완료 마커, DLQ 재처리 및
초기 group offset 준비 절차는 [연수 CUSTOM 운영 문서](trainee-custom-sms-operations.md)를 참고한다.

프로그램 대기 승급은 별도 topic/원장/재시도 흐름을 사용한다.
[Notification #20 계약](notification-20-contract.md)에 수신 JSON, 필요한 Application 검증 API,
Solapi 접수/최종 전달 구분과 설정을 기록했다. Application 발행기/API는 아직 연결되지 않았으며
`promotion.enabled`는 기본 비활성이다. 기존 CUSTOM 이벤트로 승급 안내를 대체하지 않는다.
Redis 복구 보류(`PROMOTION_RECOVERY_HOLD`), 운영 점검 `GET /internal/promotion-notifications/ops/audit`,
승인된 수동 재개, 공동 검증용 가짜 발송 서버(`SMS_API_BASE_URL`)는
[Notification #32 runbook](notification-32-promotion-recovery.md)을 참고한다.

대기 참여 제안(Application #144)은 승급 완료 안내와 다른 topic `application.promotion-offer.requested`·상태·결과 보고를 쓴다.
[Notification #52 계약](notification-52-promotion-offer.md)에 흐름, 실제 공급자 접수 시각 보고, 결과 불명 처리와 설정을 기록했다.
`promotionOffer.enabled`는 기본 비활성이다.

관리자 그룹 발송의 내부 HTTP payload, 상태 전이, 중복/timeout 처리와 Kakao 승인 template 설정은
[Notification #10 계약](notification-10-admin-group-messaging.md)에 기록한다. 기능은
`adminGroupMessaging.enabled`가 true이고 32자 이상의 `internalToken`이 설정된 환경에서만 발송한다.
Kakao 설정이 없으면 SMS만 사용할 수 있다. KAKAO 채널은 같은 렌더링 문구로 카톡과 문자를 항상 둘 다 보낸다(Solapi 자동 대체는 끔).
행사별 문자 처리이력의 기간·유형·커서 페이지, 기존 `retentionSeconds` 사용과 Application 권한 접합은
[Notification #42 계약](notification-42-admin-message-history.md)에 기록한다. 추가 env/config는 없다.
