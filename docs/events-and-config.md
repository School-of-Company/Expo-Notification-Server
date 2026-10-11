# 알림 서버 이벤트 계약 / 설정 키

## Kafka 이벤트

공통: JSON, UTF-8. `eventId`(멱등키)는 필수. `version: 1`은 `notification.sms.requested`와 `expo.applicant-count.updated`에 필수이며, `user.participant.registered`와 `attention.entry.recorded`에는 요구하지 않는다. 스키마가 틀린 메시지는 로그만 남기고 건너뛴다.

### `user.participant.registered` — 등록 완료 (User 발행, QR 문자)

```json
{ "eventId": "…", "expoId": "…", "participationType": "STANDARD", "id": 42, "phoneNumber": "010-1234-5678" }
```

User 서비스가 일반 PRE/FIELD 신규 등록, 허용된 QR 재발송(어드민 재발송 포함), 연수 FIELD 신규 등록 때 아웃박스로 발행한다 (연수 PRE는 발행하지 않음).
전화번호는 하이픈이 있어도 받고 숫자만 남겨 정규화한다. 처리 순서:

1. `eventId` 선점 (이미 처리했거나 처리 중이면 무시)
2. Attention `POST /internal/qr-images`로 QR 이미지 URL을 받는다 (`X-Internal-Token`)
3. 일반/연수 발신번호로 QR 문자 발송 (문의 번호는 `sms.contactStandardNumber`/`contactTraineeNumber`)
4. 완료 마커로 승격하고, **일반 참가자만** User `POST /internal/participants/sms-try` 호출

`sms-try`는 `eventId`를 받지 않아 재시도하면 발송 횟수가 중복 증가하므로(Expo-User-Server#38) **한 번만 호출하고 실패해도 재시도하지 않는다**(로그만 남김).
User가 `eventId` 멱등을 지원하면 재시도로 바꾼다.

### `attention.entry.recorded` — 일반 참가자 입장 (Attention 발행, 설문 문자)

위와 같은 형태의 이벤트. 일반 참가자(`STANDARD`)에게만 설문 링크 문자를 보낸다. 링크는 `sms.surveyUrlTemplate`의 `{expoId}`를 채워 만들고, 템플릿이 없으면 보내지 않는다.

> 두 토픽의 이름과 필드는 User #38, Notification #3의 설명을 기준으로 가정한 것이다. 발행 측과 확정되면 `kafka.topics.*`와 `participant-event.schema.ts`를 맞춘다.

### `notification.sms.requested` — 일반 문자 발송 요청

`type`으로 구분한다. 전화번호는 하이픈 없는 `01XXXXXXXXX`. `senderType`은 `STANDARD`(일반 참가자 발신번호) / `TRAINEE`(연수생 발신번호).

| type | 필드 | 설명 |
|---|---|---|
| `DRAW_RESULT` | `phoneNumber`, `drawNumber` | 설문 행운 번호 당첨 (일반 참가자 발신번호 고정) |
| `CUSTOM` | `phoneNumbers[1..1000]`, `senderType`, `text` | 본문을 호출 측이 만든 일반/대량 문자 (연수 일정 안내 포함) |

같은 `eventId`는 24시간 동안 한 번만 발송한다. 발송이 전부 실패하면 consumer가 던져 Kafka가 재전달하고, 일부 수신자만 실패하면 재전달하지 않는다(성공한 수신자 중복 발송 방지).

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

**DLQ** (세 SMS 토픽 공통): 같은 이벤트 처리가 `sms.eventMaxAttempts`(기본 5)번 실패하면 원본 메시지를 `notification.sms.requested.dlq`로 옮기고(`x-source-topic` 헤더에 출처 토픽) 다음 메시지로 넘어간다.
DLQ 메시지는 원인을 해결한 뒤 수동으로 원 토픽에 다시 넣는다. DLQ 발행까지 실패하면 던져서 이벤트를 잃지 않는다.

### `expo.applicant-count.updated` — 박람회 등록 인원 변경

```json
{ "eventId": "…", "version": 1, "expoId": "…", "expoTitle": "…", "applicationPerson": 120 }
```

`applicationPerson`은 증감분이 아니라 **현재 총 인원(절대값)** 이다. 알림 서버가 박람회별로 보관하고,
매 정각(KST)에 Discord 웹훅으로 리포트, 매일 00:00:30(KST)에 "어제 인원"으로 스냅샷한다.
크론은 Redis 락(`alarm:lock:*`, 55초)으로 인스턴스가 여러 개여도 한 번만 실행된다.

## HTTP

| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/sms` | `{ phoneNumber }` — 4자리 인증번호 발송. 번호별 상한 초과 또는 **전체 시간당 상한(`authMaxSendCountPerHour`, 기본 300) 초과 시 429**, 게이트웨이 실패 시 502 |
| `POST` | `/sms/verify` | `{ phoneNumber, code }` — 인증번호 검증 (없으면 404, 불일치 400, 시도 상한 초과 429 — 맞고 틀리고와 무관하게 시도마다 횟수가 오른다) |
| `GET` | `/sms?phoneNumber=&code=` | deprecated. 위와 동일하지만 코드가 URL/접근 로그에 남는다 |

> Gateway: `/sms`가 `publicPaths`에 없으면 가입 전 인증번호 발송이 JWT에 막힌다. Eureka 서비스 이름은 `expo-notification-server`이므로 Gateway 라우팅(`/sms: expo-sms-server`)도 이 이름으로 바꿔야 한다. Gateway 전역 rate limit(IP당 100/분)은 문자 비용 방어로는 느슨해서 알림 서버에 전체 시간당 상한을 따로 두었다.

## 설정 키 (config-server `notification-{profile}.yml` + Vault `secret/notification`)

서비스 식별자는 `notification` (`CONFIG_SERVICE_NAME`으로 변경 가능). 조회 경로: `GET {CONFIG_SERVER_URL}/configs/notification/{profile}`.
config-server 값이 env 값보다 우선하고, config-server 호출이 실패하면 부팅을 실패시킨다.

```yaml
port: 3000
kafka:
  brokers: ["<KAFKA_HOST>:9092"]      # 문자열 "a:9092,b:9092"도 허용
  clientId: expo-notification-server
  smsGroupId: expo-notification-server.sms
  alarmGroupId: expo-notification-server.alarm
  topics:
    smsRequested: notification.sms.requested
    participantRegistered: user.participant.registered
    entryRecorded: attention.entry.recorded
    smsDeadLetter: notification.sms.requested.dlq
    expoApplicantCount: expo.applicant-count.updated
redis:
  host: "<REDIS_HOST>"
  port: 6379
sms:                                   # 비밀 값은 Vault
  fromStandardNumber: "…"
  fromTraineeNumber: "…"
  authCodeTtlSeconds: 180
  authMaxSendCount: 5
  authMaxSendCountPerHour: 300
  eventMaxAttempts: 5
  authMaxVerifyAttemptCount: 5
```

| 위치 | 키 |
|---|---|
| Vault `secret/notification` | `sms.apiKey`, `sms.apiSecret`, `discord.participantNumberUrl`, `redis.password`, `attention.internalToken`, `user.internalToken` (둘 다 32자 이상, 받는 서비스의 `INTERNAL_TOKEN` 사본) |

config-server 쪽에서 해야 할 일: `configs/notification-{local,dev,prod}.yml` 추가, `docs/service-configs.md` 표와
`src/config/configs-files.spec.ts`의 `SERVICES`에 `notification` 추가.
