# Notification #20 검증 결과

2026-10-12. 브랜치/Orca 표시명 `feat/promotion-notification`.
최신 develop `6b02f7b48447462ffc39676700ab42b9b12ceef5`의 #8 운영 합의 문서를
fast-forward로 반영했다. #20 소스/테스트/문서만 변경했으며 다른 저장소는 읽기만 했다.

## 실행 결과

Node 22 (`/opt/homebrew/opt/node@22/bin/node`), pnpm 11.10.0, 설치 Solapi 6.0.1.
단위/HTTP 결과 JSON은 Git에서 제외된 `.tmp/promotion-unit.json`,
`.tmp/promotion-e2e.json`에 저장했다. 통합 테스트는 자체 생성한 Docker Kafka 3.9.1 /
Redis 7.4와 합성 HTTP 서버만 사용했으며 실제 Solapi 요청은 하지 않았다.

| 검증 | 결과 | 실행 |
|---|---|---|
| 전체 단위 | 229/229, 32 suites, 27.816초 | `pnpm test --runInBand --silent --json --outputFile=.tmp/promotion-unit.json` |
| HTTP e2e 회귀 | 30/30, 2 suites, 23.595초 | `pnpm test:e2e --runInBand --silent --json --outputFile=.tmp/promotion-e2e.json` |
| 전체 실제 Kafka/Redis 통합 | 25/25, 4 suites, 230.722초 | `node node_modules/jest/bin/jest.js --config test/integration/jest.json --runInBand --testPathPattern=promotion` |
| 승급 transport/schema 추가 검사 | 8/8 | `pnpm test --runInBand --silent src/promotion` |
| 전체 ESLint | PASS, 경고 0 | `pnpm lint:ci` |
| 전체/빌드 타입 | PASS | `pnpm exec tsc --noEmit`, `pnpm exec tsc -p tsconfig.build.json --noEmit` |
| Nest build | PASS | `pnpm build` |
| whitespace | PASS | `git diff --check` |

위 pnpm 명령에는 `PATH=/opt/homebrew/opt/node@22/bin:$PATH`를 적용했다.
통합 CLI의 promotion 패턴은 checkout 절대경로에도 매칭되므로 기존 CUSTOM와 하네스 회귀까지
모두 실행했다. 승급 테스트만 지정하려면 `--runTestsByPath
test/integration/promotion.integration-spec.ts test/integration/promotion-recovery.integration-spec.ts`를 사용한다.

## 실제 표면에서 관측한 시나리오

모든 행은 실제 Nest HTTP / KafkaJS consumer / Redis Lua 상태 기록을 사용한다.
Application HTTP와 Solapi HTTP 응답은 **공급자 구현을 대신한 합성 계약 fixture**다.

| 시나리오 | 관측 결과 | 증거 파일 |
|---|---|---|
| 단건, backlog, 중복, 재신청 새 ID | 3 Kafka 메시지 중 같은 ID 2개는 한 발송, 새 신청/ID는 새 발송. ACCEPTED 영구 기록 TTL=-1 | `test/integration/promotion.integration-spec.ts` |
| 다건·일반/연수·동행자 연락처 없음 | 매 승급 한 통, 대표 번호로 3통, 연수 발신번호 선택. 한국시간·이름·프로그램 포함 | 같은 파일 |
| 장소/조회 링크 nullable | 없으면 줄 생략, 있으면 포함, 추가 확정 버튼 없음 | 같은 파일 |
| 대표 번호 실제 없음 | OPERATIONS, 발송 0·추가 조회 0, 재전달/스케줄러로 재개되지 않음 | 같은 파일 |
| 취소/교체/옛 승급 | 각각 SKIPPED, 발송 0 | 같은 파일 |
| 조회 503 후 취소 | 실패 횟수 0으로 PENDING, 재조회에서 취소 확인 후 SKIPPED | 같은 파일 |
| 확실한 접수 거절 | eventId 유지, attemptId 5개, 최대 5회 후 OPERATIONS | 같은 파일 |
| 10초 timeout, HTTP 503, 잘못된 접수 응답 | UNKNOWN, 동일 ID 재전달에서 추가 발송 없음. 다른 eventId 결과/목록 없음으로 재개되지 않음 | 같은 파일 |
| timeout 후 공급자 최종 실패 확인 | 동일 eventId+attemptId 공급자 응답을 확인한 뒤에만 PENDING, 다음 발송 재조회 후 1회 | 같은 파일 |
| 공급자 접수/최종전달 분리 | ACCEPTED에서 결과 조회 503은 상태 유지, COMPLETE+4000 이후 DELIVERED, 발송은 한 번 | 같은 파일 |
| 내부 운영 HTTP 권한·입력 | 토큰 없음403, 올바른 토큰200, 잘못된 messageId400 | 같은 파일 |
| 결과 저장 실패와 선점 해제 | 실제 Redis SENDING 유지, lease가 없어도 재전달로 재발송하지 않음 | `test/integration/promotion-recovery.integration-spec.ts` |
| 오래된 작업자·동시 처리 | 교체된 선점 토큰으로 저장/해제 불가, 동시 처리 두 번에도 한 발송 | 같은 파일 |
| 실제 Redis ACL 쓰기 거부 | pre-send Lua NOPERM으로 발송0, 원장 PENDING 유지, 복구 후 한 번 발송 | 같은 파일 |
| malformed·위험 링크·식별자 불일치 | Zod 거절, 신청/승급 다른 응답 거절, JSON 오류가 필수 데이터로 통과하지 않음 | `src/promotion/promotion.schema.spec.ts` |
| transport 자동 재시도 없음·원문 비노출 | timeout/503 각각 fetch 한 번, malformed 조회/timeout은 null로 정규화 | `src/promotion/promotion-solapi.provider.spec.ts` |
| 기존 QR/CUSTOM/인증 회귀 | 전체 unit/e2e 및 CUSTOM 실통합10개 통과 | 위 실행 결과 |

실제 공급자는 participant/trainee 개인 번호를 응답할 필요가 없다. fixture도 대표 번호만 제공한다.
따라서 위의 nullable 연수 검증은 **Notification이 연수 개인 번호를 요구하지 않는 계약**의 증거이며,
Application/User의 실제 대표자 조회가 구현됐다는 증거가 아니다.

## 발견 후 수정한 문제

- `AbortSignal.timeout`의 DOMException과 fetch JSON의 SyntaxError는 Jest 실행 realm에서
  일반 Error instanceof 검사로 잡히지 않았다. 최초 timeout 테스트는 UNKNOWN 대신 SENDING으로
  남아 실패했고, malformed 결과 조회 테스트도 실패했다. 외부 transport 경계에서 오류 종류를
  성공/실패로 추측하지 않고 접수 불명/결과 미확인으로 정규화한 뒤 회귀 테스트를 통과했다.
- supertest import를 이 저장소 CommonJS 방식으로 맞췄다.
- 초기 Node 26 통합 실행에서 KafkaJS TimeoutNegativeWarning을 관측했다. 최종 Node 22 실행은
  통과했다. 기존 HTTP e2e의 MaxListenersExceededWarning은 남아 있고 원인 수정은 범위 밖이다.
- LSP가 설치돼 있지 않아 사용하지 않았다. 의존성 설치 대신 tsc와 ESLint로 검사했다.

## 자체 검토와 남은 한계

각 소스 파일은 입력 계약, 신청 조회, 본문 생성, 공급자 호출, 원장, 처리, 진입점의 한 책임을 갖는다.
외부 Kafka/HTTP/Redis 데이터는 Zod로 파싱하고 소비자는 검증/위임만 한다.
새 any/타입 억제/비밀 상수/개인정보 로그/추가 dependency는 없다.
Nest 생성자의 4개 인자는 기존 프로젝트의 DI 패턴이다. 업무 인자를 묶기 위한 추상화는 추가하지 않았다.
provider transport의 catch는 재발송 여부를 오판하지 않고 외부 오류 원문을 버리는 경계다.
번호·이름·본문은 원장과 로그에 저장하지 않고 운영 HTTP는 전용 내부 토큰으로 보호한다.

공백/주석 제외 파일 크기는 모두 250줄 이하이다. fixture 212줄과 주 시나리오 233줄은
200~250줄 구간이므로 추가 시나리오는 별도 파일로 나누는 것이 적절하다.
생성한 통합 컨테이너는 teardown으로 정리했고 다른 작업자의 컨테이너는 건드리지 않았다.

Application 실제 발행기/check API·User 대표자 조회, 운영 Redis 영속성/복구·공급자 조회 준비는
[계약 문서](notification-20-contract.md)에 남은 연동으로 기록했다. 조회 직후 취소와 실제 발송의
분산 경쟁은 원자적이지 않으며, 공급자가 messageId 없는 확실한 미접수를 증명한 경우의 운영 재개
자동화는 제공하지 않는다. 기록 유실 후 공급자 대조 없이 재발송하면 중복 위험이 있다.
#8 운영 증거가 남아 있어 #8과 #20을 닫지 않으며 #10을 진행하지 않는다.
운영 배포·머지·유료 발송·비밀 열람은 하지 않았다.
