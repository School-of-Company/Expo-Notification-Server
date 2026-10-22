# Notification #110 신청·취소·회차 추가·기한 만료 문자 (Application #308)

Application이 상태 변경을 커밋한 뒤 `notification.sms.requested`(v1)로 보내는 신청 결과를 유형별 SMS/LMS로 발송한다. 기존 Solapi 이벤트 발송·Redis 중복 방지·UNKNOWN 처리·DLQ를 그대로 쓴다. 새 토픽·브로커·관리자 화면은 없다.

## 이벤트

공통 필드: `eventId`(작업별 안정 키, 재시도·복구에도 유지), `version: 1`, `type`, `phoneNumber`(**대표자 번호**, `01XXXXXXXXX`), `expoId`, `senderType`(`STANDARD`|`TRAINEE`, 기본 `STANDARD`), `occurredAt`(상태가 바뀐 ISO 시각), 선택 `applicationUrl`(https), `items[1..10]`.

`items[]`: `participantName`, `title`(프로그램명 또는 사전등록 회차명), 선택 `startedAt`+`endedAt`(둘 다 있거나 둘 다 없음), 선택 `location`.

| type | 추가 필드 | 안내 |
|---|---|---|
| `PROGRAM_CONFIRMED` | | 신청 확정 (승급 확정은 기존 승급 문자이므로 보내지 않는다) |
| `PROGRAM_WAITLISTED` | | 대기 접수. 아직 확정이 아님을 밝힌다 |
| `PROGRAM_CANCELLED` | `cancelledBy: USER\|ADMIN` | 목록의 신청만 취소. `ADMIN`이면 관리자에 의한 취소로 안내 |
| `PREREGISTER_CANCELLED` | `cancelledBy`, `scope: ALL\|PARTIAL` | `PARTIAL`이면 목록에 없는 등록은 유지된다고 안내 |
| `PREREGISTER_SESSION_ADDED` | `items[].result: CONFIRMED\|WAITLISTED` | 회차마다 최종 확정/대기 결과 |
| `OFFER_EXPIRED` | | 참여 의사 확인 기한 만료로 확정되지 않음 |

문구·변수(`#{행사명}` `#{안내문구}` `#{신청내역}` `#{URL}`)는 `src/sms/application-result-message.ts`. 카카오 전환 전 내부 계약일 뿐 승인된 알림톡 템플릿이 아니므로 **문자로만** 나가고, 기존 알림톡 자동 발송 경로에는 편입되지 않는다.

## 처리 규칙

- `eventId`로 중복을 막는다. 접수 결과 불명(UNKNOWN)은 자동 재발송하지 않고 DLQ(`x-sms-delivery: UNKNOWN`)에 보관한다. 영구 exactly-once는 아니며 7일 TTL 이후 replay는 중복될 수 있다.
- 스키마 불일치는 건너뛴다. 본문이 2000바이트를 넘으면 재시도해도 같으므로 발송하지 않고 `eventId`·type만 오류 로그로 남긴다.
- `occurredAt`이 `sms.applicationResult.maxAgeSeconds`(기본 24시간)보다 오래됐으면 소급 발송하지 않고 버린다.
- 순서 검증(확정 알림 전에 이미 취소됨 등)은 상태를 가진 Application이 발행 직전에 한다. Notification은 상태를 조회하지 않는다.
- 로그에는 `eventId`와 type만 남기고 전화번호·이름·본문·URL은 남기지 않는다.

## 설정 (테스트 박람회 한정)

```yaml
sms:
  applicationResult:
    expoIds: ["<테스트 expoId>"]   # SMS_APPLICATION_RESULT_EXPO_IDS (쉼표 구분). 없으면 전체 박람회
    maxAgeSeconds: 86400           # SMS_APPLICATION_RESULT_MAX_AGE_SECONDS
```

`expoIds`에 없는 박람회의 이벤트는 선점 없이 건너뛴다.

## 배포 순서

1. Notification(소비자)을 먼저 배포한다. 이벤트가 없으므로 아무것도 나가지 않는다.
2. `expoIds`를 테스트 박람회로 제한하고 Application 생산자를 같은 박람회에만 켠다.
3. 신청→문자→취소→문자를 실제 단말로 QA한다. Solapi 접수(`customFields.eventId`)와 단말 수신은 구분해 기록한다.
4. 제한을 풀고 전체 박람회로 확대한다. 과거 이력은 수집하지 않는다.
