# 사전등록 그룹 발송 계약 (#106)

관련 작업: [Notification #106](https://github.com/School-of-Company/Expo-Notification-Server/issues/106),
[Application #304](https://github.com/School-of-Company/Expo-Application-Server/issues/304).

## 대상과 저장 계약

기존 프로그램 target의 UUID `applicationId`, `STANDARD`/`TRAINING` `programType`,
선택 `participantId`, 최대 100자 `targetId` 계약은 유지한다. 사전등록은 아래 별도 형태다.

| 필드 | APPLICATION | RESERVATION |
| --- | --- | --- |
| `targetId`, `ledgerKey` | 동일한 `APPLICATION:{expoId}:{positiveLong}` | 동일한 `RESERVATION:{expoId}:{requestId}` |
| `applicationId`, `programType` | 생략 | 생략 |
| `participantId` | 실제 User 참가자 ID, positive safe integer 필수 | 생략 |

원장 key는 최대 160자이며 key의 행사 UUID는 envelope `expoId`와 정확히 같아야 한다.
APPLICATION 숫자는 선행 0 없는 `1..9223372036854775807` 십진 문자열로 검증하며 JS number로 변환하지 않는다.
RESERVATION suffix는 공백만 있는 값이 아닌 예약 requestId 문자열이다. 예약 원천은 UUID 타입이 아니므로
UUID로 제한하지 않는다. 별개인 **preview envelope의 `requestId`는 기존대로 UUID**다.
예약 requestId의 앞뒤 공백도 원장 key의 일부로 보존하며 기존 프로그램 targetId만 trim한다.
프로그램 필드와 원장 key 혼합, `targetId != ledgerKey`, 예약의 참가자 ID, 한 preview/job의
프로그램·사전등록 source 혼합, 다른 행사 원장 key는 거절한다. APPLICATION과 RESERVATION은 함께 보낼 수 있다.
JSON null 대신 optional 필드를 생략한다. 가짜 UUID나 참가자 ID를 생성하지 않는다.

`recipientPhone`, `content`, `templateVariables`, `missingReason` 검증과 마스킹은 기존 계약 그대로다.
누락 대상은 번호가 없어야 하며 발송 대상은 번호와 본문이 필요하다. 예약 QR/URL을 만들어 보내지 않는다.
사전등록 발신번호는 기존 `sms.fromStandardNumber`다. 신규 자동 대기 문자는 도입하지 않는다.

preview/job/status/retry items에 `ledgerKey`를 그대로 반환하고 없는 ID는 생략한다.
동일 target schema를 Redis preview/job 파싱에도 적용한다. 기존 프로그램 Redis 레코드는 migration 없이 읽는다.
`applicationCount`는 Application이 계산한 원장 행 수(예약 일행도 1행)이며 수신번호/메시지 수와 구분한다.
공통 문구의 번호 중복 제거는 Application 소유다. Notification이 보낸 targets를 다시 합치지 않는다.
targets 상한 5,000과 관리자·행사·fingerprint binding, request/job/retry 멱등성은 유지한다.
재시도는 확정 `FAILED`만 처리하며 `UNKNOWN`은 다시 보내지 않는다.

## capability와 이력

`GET /internal/admin-group-messages/config`는
`targetContracts: ["PREREGISTRATION_GROUP_MESSAGE_V1"]`를 반환한다.
이는 schema·Redis·preview·job·status·retry·history 전체의 구현 지원 선언이다.
발송 비활성화 상태에서도 계약 지원은 같고 실제 발송 여부는 `enabled` 및 채널별 설정을 함께 확인한다.
Application은 미선언/비활성/공급자 장애 시 사전등록 발송을 503으로 닫고
`targets.messagingSupported=false`를 유지해야 한다.

사전등록 이력의 `targetScope`는 기존 `kind=EXPLICIT_TARGETS`, 행 수 `applicationCount`와 함께
`source=PREREGISTRATION`, `programTypes=[]`를 반환한다. 프로그램 이력에는 source를 추가하지 않아
기존 응답을 유지한다. 기존 source 없는 저장 이력도 계속 읽는다. `programTypes`에 null을 넣지 않는다.
이력에 key/참가자 ID/번호/본문/변수/fingerprint를 추가하지 않는다.

## Application 및 Client 후속 계약

2026-10-22 조사 시 Application develop SHA `67426951648f70fd7d71077f2129a4267e509218`은
아직 프로그램 전용 DTO다. #304 작업 checkout에서는 `AdminGroupMessageTarget`이
`@JsonInclude(NON_NULL)`로 nullable ID와 `ledgerKey`를 직렬화하고,
`AdminGroupMessageConfig.targetContracts` 기본값은 빈 배열이다. 작업 checkout은 merge/배포 증거가 아니다.

Application은 자기 DB의 `tb_preregister_session_state.definition`에 저장된 **현재 회차**
`title`, `startedAt`, `endedAt`, `place`만 변수 원천으로 사용한다. 제출 당시 스냅샷을 회차 정의로
표현하지 않는다. `programName`은 `사전등록 · {title}`이며 필요한 정의/값이 없으면
`TEMPLATE_DATA_MISSING` 처리한다. 상태 표시는 확정/대기/취소/처리 중이다.
APPLICATION 수신번호는 User 현재 대표 번호, RESERVATION은 제출 대표 번호다.
Notification에 다른 서비스 DB 조회나 원천 API를 추가하지 않는다.

Application은 preview·실행·재시도마다 현재 권한, 행 상태, 현재 정의, 대표 번호, 문구를 다시 계산하고
중복 제거로 빠진 행도 fingerprint에 포함한다. 변경 시 409로 새 preview를 요구한다.
history DTO에는 optional `targetScope.source`를 전달하고 기존 enum 배열의 빈 값을 허용해야 한다.
Client는 사전등록 선택 keys/전체 필터, nullable ID/ledgerKey 식별, 사전등록 이력 표시 및
capability 미선언 시 발송 차단을 검증해야 한다. 두 저장소 코드는 이번 변경에서 수정하지 않는다.

환경변수·배포 config key·DB schema 추가/변경은 없다. 추가되는 config는 내부 HTTP **응답 필드**다.
Notification 개발 완료는 로컬 실제 Redis와 fake sender HTTP 검증까지이며,
운영 연동 완료는 Notification 지원 배포 후 Application #304와 Client 모달 및 이력 연결을
운영 권한/실제 데이터로 별도 확인한 상태다. 이번 작업은 배포·머지·유료 발송을 수행하지 않는다.

## 검증

`src/admin-group-message/preregistration-contract.spec.ts`와
`test/integration/preregistration-group-message.integration-spec.ts`가 계약 경계 및
실제 Redis/HTTP에서 APPLICATION·RESERVATION 식별자 보존, 실패 재시도, UNKNOWN 차단,
binding/멱등성, capability/history/기존 프로그램 회귀를 검증한다.

```bash
pnpm test --runInBand
pnpm test:e2e --runInBand
pnpm test:integration
pnpm lint:ci
pnpm exec tsc -p tsconfig.build.json --noEmit
pnpm build
```
