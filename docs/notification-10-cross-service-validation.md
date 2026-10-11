# 관리자 그룹 발송 개발 검증

이 문서는 Notification #10의 저장소 간 계약과 개발 검증을 기록한다.
실제 카카오 설정·유료 발송 확인은 #28이다. #10은 필요한 개발 PR이 병합된 뒤 종료한다.

## 작업 범위

- Notification: `feat/admin-group-messaging`, 관리자 발송 작업·진행/실패 조회·공급자 어댑터.
- Application: 별도 `origin/develop` 기반 Orca 작업공간에서 권한·전체 대상 조회와 Notification 호출 계약.
- Client: 사용자 후속 지시에 따라 작업을 중단했다. 기존 소스 읽기만 허용되며 연결 완료로 주장하지 않는다.
- Swagger #26: develop에 병합된 PR #30을 반영했다. 새 그룹 발송 내부 경로도 기본 문서에서 제외하고,
  내부 문서 포함 시 토큰 인증과 403 응답을 표시한다.
- 머지·배포·실제 유료 발송은 수행하지 않는다.

## 확인한 원천

- Application `58cee9a00a10f019cb6dec5408091fe3b6f590ac`: 관리자 접수 및 전체 필터 대상 조회 계약.
- User `3552a578f98aac8896724a7be831082dd9b04054`: 일반 참가자 상세 일괄 조회와 연수자 상세 cursor 조회.
- Expo `99a8039d74eec779f4f42c73c72f48bc237afc39`: PR #89의 내부 관리자 권한 조회.
- Expo의 권한 계약은 `GLOBAL_ADMIN_APPLICATION_READ_V1` / `GLOBAL_ADMIN`이다. 행사 소유자별 권한이라고 해석하지 않는다.
- User의 `notificationPhoneNumber`는 본인 번호 우선이므로 그룹 발송의 대표자 번호 규칙에 그대로 쓰지 않는다. 연결된 일반 참가자의 `representativeId`를 확인해 대표자 원천을 조회한다.
- Client의 기존 SMS 치환 이름은 `{이름}`, `{프로그램}`, `{일시}`, `{장소}`, `{상태}`다. 현재 구현 호환 계약이며 사용자의 최종 정책 확정이 아니다.

## 공급자 계약

[Solapi 메시지 발송](https://solapi.com/developers/api/messages)과
[알림톡](https://solapi.com/developers/api/messages-ata) 문서를 확인했다.
알림톡은 승인된 `pfId`·`templateId` 및 `#{승인변수명}` 매핑이 필요하다.
자동 SMS 대체는 `disableSms: true`로 막는다.
[결과 조회](https://solapi.com/developers/api/msg-getList)의 공급자 접수와 최종 전달을 구분한다.
실제 승인 정보와 연결은 이 검증의 대상이 아니다.

## 검증 기록

- 변경 전 Notification 기준선: `pnpm exec jest --runInBand`, 32 suites / 229 tests 통과.
- Notification 실제 HTTP 서버에 실제 Redis와 테스트 sender를 연결해 검증했다. 결과는
  [notification-10-http-evidence.json](notification-10-http-evidence.json)에 저장했다.
- 동일 대표자 번호의 일반/연수 개인 안내 2건과 번호 누락 1건을 함께 미리보기했다.
  신청 건수 3, 고유 수신번호 1, 메시지 2, 누락 1을 서로 구분했다.
- 내부 토큰 누락은 403, 미리보기 요청 내용 변경과 요청자·fingerprint 불일치는 409였다.
  동일 preview의 서로 다른 실행 멱등 키도 같은 작업 ID를 반환했다.
- 실제 스케줄러가 `ACCEPTED` 뒤 `DELIVERED` 2건으로 변경하는 것을 관찰했다.
  전달 완료 건에 재시도를 요청해도 `pending=0`, `delivered=2`를 유지했다.
- Application의 독립 Kotlin HTTP 검사도 같은 실제 Notification 서버에서 설정·미리보기·실행·중복·
  최종 전달·성공 건 재시도 금지를 확인했다. Application 공개 HTTP 테스트에서는 실제 gateway의
  직렬화/역직렬화를 HTTP 가짜 원천과 검증한다. 독립 Kotlin 검사는 실제 공개 Application 서버를
  함께 구동한 전체 서비스 e2e와 구분한다.

## 범위별 검증 상태

| 범위 | 결과 | 근거 |
| --- | --- | --- |
| Notification 실제 HTTP + Redis + 가짜 공급자 | 통과 | `notification-10-http-evidence.json` |
| Notification 단위 테스트 | 239/239 통과 | `pnpm exec jest --runInBand` |
| Swagger 병합 후 전체 HTTP e2e | 34/34 통과 | `pnpm test:e2e --runInBand` |
| 새 그룹 발송 실제 Redis HTTP 통합 | 4/4 통과 | `pnpm exec jest --config test/integration/jest.json --runInBand admin-group-message` |
| lint / 전체 타입 / build | 통과 | `pnpm lint:ci`, `pnpm exec tsc -p tsconfig.json --noEmit`, `pnpm build` |

전체 Kafka/Redis 재검증에서 기존 CUSTOM suite의 첫 테스트 timeout과 이후 Redis 연결 종료가 발생했다.
새 그룹 발송 suite와 다른 통합 suite는 통과했다. CUSTOM 테스트 소스는 수정하지 않았으며
실패 suite만 분리해 재검증했으며 8/8 통과했다(135.266초). 테스트를 삭제하거나 약화하지 않았다.
따라서 전체 실행 한 번이 모두 통과했다고 주장하지 않고, 나머지 통합 suite 통과와 CUSTOM 단독 재검증
통과를 구분해 기록한다. PR 링크는 Orca 작업공간 코멘트에 기록한다.

PR #31의 첫 CI에서는 Swagger 테스트의 내부 경로 2개 고정 검증이 새 경로 7개와 충돌했다.
경로 목록을 실제 계약으로 확장하고 새 그룹 발송 컨트롤러의 인증·403 문서를 보완한 뒤
전체 HTTP e2e 34/34와 lint·타입·build를 다시 통과했다.
