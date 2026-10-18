# 관리자 그룹 발송 Notification 계약 (#10)

## 책임과 신뢰 경계

Application은 관리자 JWT, 박람회 접근 권한, 선택/현재 필터 전체 대상 조회, 대표자 번호 조회,
전화번호 정규화, 문구 치환을 소유한다. Notification은 외부 공개 API를 제공하지 않는다.
Application이 `X-Internal-Token`으로 호출한 immutable preview를 Redis에 보관하고 공급자 발송 상태를
추적한다. Client가 내부 토큰이나 원본 전화번호를 받지 않도록 preview/status 응답은 번호를 마스킹한다.

Application은 preview 직전과 job 실행 직전, 실패 재시도 직전에 권한과 대상을 다시 조회한다.
fingerprint는 정렬된 대상 membership/status, target/application/participant ID, 정규화 번호,
program type, channel/template, 렌더링 문구, template variables, missing reason 등 실제 발송에 영향을 주는
모든 값으로 계산한다. Notification은 requester, expo, fingerprint가 저장된 preview/job과 다르면 409를
반환한다.

공통 안내는 Application이 동일 정규화 번호마다 한 target만 만든다. `{이름}` 등 개인 치환 안내는
participant별 target과 렌더링 문구를 유지하며 같은 번호라는 이유로 첫 참가자만 남기지 않는다.
일반/연수 모두 Application이 조회한 신청 대표자 번호를 사용하고, Notification은 개인 번호 fallback을
하지 않는다. 번호가 없으면 `recipientPhone`과 `content`를 빼고 `missingReason`을 전달한다.

## 내부 HTTP API

모든 경로 prefix는 `/internal/admin-group-messages`이다. `requesterUserId`는 positive safe integer,
`expoId`, `requestId`, `idempotencyKey`, `previewId`는 UUID다. `jobId`는 preview ID에서 결정적으로 만든
소문자 SHA-256 64 hex다. optional 필드는 JSON `null` 대신 생략한다.

- `GET /config` (200): SMS/Kakao 사용 가능 여부와 승인 Kakao template의 `id`, `name`, `content`,
  `variableMapping`, 의미 변수 목록을 반환한다. 공급자 profile/template ID는 반환하지 않는다.
- `POST /previews` (201): requester/expo/requestId/applicationCount/fingerprint/channel/targets를 저장한다.
  같은 requestId와 같은 body는 같은 preview를 반환하고 다른 body는 409다.
- `POST /previews/{previewId}/jobs` (202): requester/expo/fingerprint/idempotencyKey를 다시 받고 job을
  생성한다. job은 preview당 하나라 서로 다른 idempotency key의 중복 실행도 새 job을 만들지 않는다.
  preview가 만료된 뒤에도 이미 생성된 job의 아직 보내지 않은 target은 이 호출로 권한 시간을 갱신할 수 있다.
- `GET /jobs/{jobId}?requesterUserId=&expoId=` (200): 진행 수와 target별 실패 사유를 반환한다.
- `POST /jobs/{jobId}/retries` (202): fresh fingerprint 확인 후 `FAILED` target만 `PENDING`으로 바꾼다.
  같은 idempotencyKey의 상태 변경은 Redis에서 한 번만 적용한다.
- `GET /expos/{expoId}/history` (200): 행사별 요청/발송/실패/재시도 스냅샷을 기간·유형 필터와
  최신순 커서 페이지로 반환한다. 기존 내부 토큰 대리조회 구조를 사용하며 새 이력 경로의 인증 실패는
  401이다. Application 매 페이지 현재 JWT/행사 권한 검증과 후속 공개 API 접합 요구는
  [#42 이력 계약](notification-42-admin-message-history.md)을 따른다.

미리보기 target은 최대 5,000건이다. 발송 가능한 target에는 `targetId`, `applicationId`, optional
`participantId`, `programType`, `recipientPhone`, `content`가 필요하다. Kakao만 optional
`templateVariables`를 받는다. 현재 의미 이름은 `expoName`, `name`, `programName`, `sessionName`, `location`, `status`이다.
이 이름은 Application/Client와 승인 template을 연결하는 최소 계약이며 최종 문구나 필수 변수 정책을
임의로 고정하지 않는다.

preview count는 원본 신청 행 수 `applicationCount`, 고유 수신 번호 수 `recipientCount`, 실제 outgoing
target 수 `messageCount`/`sendableCount`, 누락 target 수 `missingCount`를 분리한다. 개인 치환에서는 한
신청의 여러 참가자 target이 있을 수 있어 applicationCount와 messageCount가 같다고 가정하지 않는다.

## 상태와 재발송 안전성

target 상태는 `PENDING -> SENDING -> ACCEPTED -> DELIVERED|FAILED`다. 공급자 HTTP 직전에
`SENDING`을 Redis에 먼저 저장한다. timeout, malformed 응답, SENDING 상태에서 process crash는
`UNKNOWN`으로 남기고 자동 또는 즉시 재발송하지 않는다. `ACCEPTED`는 공급자 접수일 뿐 최종 성공으로
세지 않으며 조회 결과가 성공 코드일 때만 `DELIVERED`가 된다.

명시적 재시도는 공급자가 확정 실패한 `FAILED`만 대상으로 한다. `SENDING`, `UNKNOWN`, `ACCEPTED`,
`DELIVERED`는 재시도에서 제외되어 성공 건이나 접수 불명 건이 다시 발송되지 않는다. 아직 보내지 않은
target의 권한 시간이 만료되거나 channel 설정이 사라지면 job은 `PAUSED`가 되고 fresh execute 검증 전에는
계속 보내지 않는다. preview는 기본 30분, job과 request/retry idempotency 기록은 생성 시점부터 기본
30일 보관해 PII를 무기한 저장하지 않는다. job 보관 기간은 preview 보관 기간보다 짧게 설정할 수 없다.
이미 성공한 job이 먼저 만료되어 같은 preview에서 재생성되는 일을 막기 위한 제약이다.

## Kakao와 공급자 설정

KAKAO 채널은 **카톡과 문자를 항상 둘 다** 보낸다. target마다 렌더링 문구로 문자를 먼저 보내고, 문자가 `ACCEPTED`로 저장되면
같은 문구의 카톡을 따로 한 건 보낸다(`disableSms: true`, Solapi 대체 문자 끔). 수신자마다 문자와 카톡이 각각 과금되어 비용이
약 2배이며 의도된 동작이다. target 상태와 전달 확인(`messageId`)은 문자만 따른다. 카톡 실패는 경고 로그만 남기고 target 상태를
바꾸거나 재시도하지 않는다. 문자가 `FAILED`/`UNKNOWN`이면 카톡은 보내지 않는다.
`fallbackToSms`는 하위 호환으로만 받는 boolean이다. 채널과 값에 상관없이 400을 내지 않으며 job에 저장만 하고 발송에는 쓰지 않는다.
`adminGroupMessaging.kakao`가
없거나 disabled이면 config가 `KAKAO.enabled=false`, `templates=[]`를 반환하고 Kakao preview는 422다.
template 설정은 Solapi `pfId`, 승인 template ID/content, 의미 이름에서 실제 승인 변수 이름
(`#{승인변수명}`)으로 가는 명시적 mapping을 포함한다. preview의 렌더링 문구가 설정된 승인 content를
해당 변수로 치환한 결과와 정확히 같아야 한다. 실제 승인 template/프로필 설정과 운영 연결은 #28 범위다.

Solapi 전송은 message(문자·카톡 각각)마다 `fetch` 한 번만 호출한다. SDK나 애플리케이션 수준의 묵시적 retry는 없고,
SMS는 UTF-8 2,000 bytes, Kakao 승인 본문 치환 결과는 Unicode 1,000 characters 이하여야 한다.
표준/연수 발신번호는 target `programType`과 기존 `sms.fromStandardNumber`/
`sms.fromTraineeNumber` 설정으로 선택한다.

## 개발 검증 하네스

실제 공급자나 유료 발송 없이 Application 계약을 검증하려면 Redis를 띄운 뒤 다음을 실행한다.

```bash
GROUP_HARNESS_REDIS_PORT=6379 \
GROUP_HARNESS_PORT=4100 \
GROUP_HARNESS_TOKEN=gggggggggggggggggggggggggggggggg \
pnpm start:group-message-harness
```

`GROUP_HARNESS_PORT=0`이면 출력된 JSON의 실제 port를 사용한다. 하네스는 production config의 fake mode가
아니라 테스트 모듈에서 sender provider만 교체하며, Redis key namespace도 실행마다 분리한다.
SMS 문구에 `__FAKE_CONFIRMED_FAILURE__` 또는 `__FAKE_UNKNOWN__`을 넣으면 각각 공급자 확정 실패와
접수 불명 상태를 재현하고, 그 외 문구는 접수 후 최종 성공한다.
