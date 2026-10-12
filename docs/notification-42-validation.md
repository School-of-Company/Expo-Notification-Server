# Notification #42 검증 기록

## 검증 환경과 범위

2026-10-12 로컬 checkout `feat/admin-message-history`에서 검증하였다. 원격 서비스 코드와 이슈는 읽기만 수행했고, 기록 댓글만 사용자 허용 범위에서 작성하였다. 실제 Redis 7.4와 Nest HTTP를 사용하며 SMS 공급자는 기존 fake sender로 교체하였다. 실제 Solapi 요청, 유료 발송, 배포, 머지, 운영 비밀 조회는 수행하지 않았다.

## 실제 HTTP 수동 검사

독립 Redis 컨테이너와 `test/harness/admin-group-message-harness.ts`를 포트 0으로 기동하고 Node HTTP fetch로 검사하였다. 테스트 토큰·번호·문구는 합성 데이터이며 출력은 상태와 검사명으로 제한하였다. 테스트가 소유한 컨테이너와 하네스만 종료하였다.

| 시나리오 | 관찰 결과 |
| --- | --- |
| 미리보기 / 실행 / 행사별 이력 | 201 / 202 / 200 |
| 내부 인증 누락 | 401 |
| requesterUserId 권한 흉내 query / 잘못된 행사 UUID | 400 / 400 |
| 공급자 확정 실패 | FAILED 이력 1행 |
| 같은 멱등 키로 재시도 2회 | 202, RETRIED 1행 |
| limit=1과 nextCursor 후속 페이지 | 서로 다른 eventId |
| 다른 행사 UUID | 빈 items, 원래 행사 job 없음 |
| from이 이벤트 시각과 같음 | 포함 |
| to가 이벤트 시각과 같음 | 제외 |
| 이력 민감정보 / 캐시 | 본문·번호·fingerprint·공급자 오류·토큰 필드 없음 / no-store |

위 수동 검사 15개 assertion이 통과하였다. 재현 가능한 전체 HTTP/Redis 회귀 검사는 아래 integration spec에 포함한다.

## 오류를 통해 확인한 보안 경계

잘못된 Redis 이력 인덱스 타입으로 job 생성이 실패하는 경우 원래 ioredis `ReplyError`는 Redis 명령 인자에 본문과 번호를 포함할 수 있었다. `AdminGroupMessageStore`에서 이 오류를 일반화하여 HTTP/Nest logger에 원본 명령 인자가 전달되지 않도록 수정하고 logger spy로 번호·본문·fingerprint 비노출을 검증한다. 잘못된 타입의 인덱스에서 job만 생성되지 않는 것도 검사한다. 신규 이력 조회는 Redis 오류를 일반화된 503으로 반환한다.

기존 발송 내부 경로의 누락 토큰 403과 새 이력 경로의 401은 실제 HTTP에서 검사한다. **운영 관리자 JWT의 401/403 검사는 이번 로컬 Notification 실행에 포함하지 않았다.** 해당 상태의 발급자는 Application/Expo이고, 실제 pinned 코드의 원본 JWT·현재 자격 검사 계약을 [#42 계약 문서](notification-42-admin-message-history.md)에 기록하였다. Application 공개 이력 접합 전에는 Client 관리자 권한 흐름이 연결 완료된 것으로 표시하지 않는다.

## 재현 명령

```bash
pnpm test --runInBand
pnpm test:e2e --runInBand
pnpm test:integration --runTestsByPath \
  test/integration/admin-group-message.integration-spec.ts \
  test/integration/harness.integration-spec.ts
pnpm lint:ci
pnpm exec tsc -p tsconfig.build.json --noEmit
pnpm build
git diff --check
```

integration은 실제 Redis·Kafka 테스트 컨테이너를 사용한다. 행사 분리, 유형 필터, 동일 시각 UUID 커서, 기간 양쪽 경계, 커서+기간 상한, 만료 레코드 정리, 실제 짧은 TTL 키 만료, 중복 실행/재시도, 결과 불명 재시도 금지, 미종료 ATTENTION의 조기 완료 기록 금지, 민감정보 없는 저장소 오류를 검사한다. 공급자만 fake이며 HTTP/Redis는 실제 구현이다.

단위 검사는 기존 `applicationCount` 없는 job 호환을 포함하고, Swagger e2e는 내부 경로 옵션, 토큰 보안 선언과 새 response schema를 검사한다. 새 env/config 설정은 추가하지 않았다.

## 최종 결과

Redis 오류 일반화 수정 후 최종 Node 26.8.1 실행 결과:

| 검사 | 결과 |
| --- | --- |
| 전체 단위 테스트 | 39 suites, 265/265 PASS |
| 전체 e2e | 4 suites, 41/41 PASS |
| 관리자 그룹 문자 + HTTP harness 실제 integration | 2 suites, 11/11 PASS (문자 9, harness 2) |
| 독립 TCP HTTP + Redis 수동 검사 | 15 assertions PASS |
| lint:ci / tsc --noEmit / nest build / diff --check | 모두 exit 0 |
| 독립 읽기 전용 코드 리뷰 | CLEAR / APPROVE, 차단 결함 없음 |

최종 integration에서 테스트 시간 조작에 따른 Node TimeoutNegativeWarning을 관찰했으나 모든 검사가 통과하였다. 이 경고와 기존 MaxListeners 경고를 숨기기 위해 테스트를 변경하지 않았다.

추가 LSP 도구는 설치되어 있지 않아 사용하지 않았다. 외부 skill의 no-excuse 스크립트는 TypeScript 7 전용 `typescript/unstable/async`·`ast`를 요구하여 이 저장소의 기존 TypeScript에서 실행되지 않았다. 이 추가 도구를 위해 의존성을 바꾸지 않았고, 실제 프로젝트 TypeScript·ESLint 및 읽기 전용 리뷰로 검증하였다.

초기 기본 Node 26.8.1 실행에서 기존 metrics e2e의 비노출 정규식 검사 1건이 실패하였다. Node 22.22.3 전체 재실행과 Node 26.8.1 전체 재실행 모두 41/41 통과하여 실패가 재현되지 않았다. 기존 e2e의 MaxListenersExceededWarning도 관찰하였다. 이 작업에서 metrics 구현과 기존 테스트를 약화하거나 변경하지 않았다.
