# Notification #8 로컬 검증 결과

검증일: 2026-10-11 (Asia/Seoul). 브랜치: `test/trainee-custom-sms-integration`.
develop 출발 SHA: `1b2a5980b9ce50c39a7bebf56eaedca0a1fc79f0`.
명시적으로 재사용한 PR #7 공통 기반 및 검증 HEAD:
`11bee4d72ccbbe663556052baa599c29a08a6c4c`.
결과는 해당 HEAD 위의 이 workspace 테스트/문서 변경에 대한 것이며 #6의 후속 수정은 포함하지 않는다.
생산 `src/` 코드는 변경하지 않았다.

## 실행 환경 및 증거

- Node `v26.8.1`, Docker Desktop `4.77.0`, Docker Engine `29.5.3`, macOS arm64.
- Kafka 이미지: `apache/kafka:3.9.1`, 검증 digest
  `sha256:4ceccc577f03f51f6af8dbfda55194d0d892f4fa7913ffbded567ce3895622ed`.
- Redis 이미지: `redis:7.4-alpine`, 검증 digest
  `sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99`.
- 실제 Kafka/Redis, 가짜 SMS sender, eventMaxAttempts=3, 1 partition,
  fromBeginning=false. 설정과 합성 이벤트는 `test/integration/custom-runtime.ts`에 있다.
- 최종 통합 실행 namespace: `notification8-`와 실행 UUID 조합.
  생성한 컨테이너는 teardown으로 제거됐고 label 조회에서 남은 컨테이너가 없었다.

| 검증 | 결과 | 증거 |
| --- | --- | --- |
| 실제 Kafka/Redis 통합 및 하네스 회귀 | 10/10 PASS, 2 suites, 94.902초 | [경로/시각 제외 요약](notification-8-integration-results.json) |
| 초기 offset/재시작 추가 실행 | 2/2 PASS, 새 전용 컨테이너, 28.976초 | `--testNamePattern='starts a new group\|resumes committed offsets'` |
| 기존 unit (PR 준비 시 재실행) | 163/163 PASS, 29 suites | [건수 요약](notification-8-unit-results.json) |
| 기존 e2e (PR 준비 시 재실행) | 22/22 PASS, 1 suite | 아래 실행 명령의 출력 및 `.tmp/notification-8-pr-e2e.json` 확인 |
| TypeScript | PASS, exit 0 | `node node_modules/typescript/bin/tsc --noEmit` |
| 변경 TS 파일 ESLint | PASS, exit 0 | `node node_modules/eslint/bin/eslint.js test/integration/*.ts` |
| 변경 코드/설정 format | PASS | `node node_modules/prettier/bin/prettier.cjs --check test/integration/*.ts test/integration/jest.json package.json` |
| Nest build (리뷰 수정 전 검증) | PASS, exit 0 | `node node_modules/@nestjs/cli/bin/nest.js build` |
| 빌드용 타입 검사 (PR 준비 시 재실행) | PASS, exit 0 | `node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit` |
| whitespace | PASS | `git diff --check` |

```sh
mkdir -p .tmp
node node_modules/jest/bin/jest.js --config test/integration/jest.json --runInBand --json --outputFile=.tmp/notification-8-review-results.json
node node_modules/jest/bin/jest.js --runInBand --silent --json --outputFile=.tmp/notification-8-unit-results.json
node node_modules/jest/bin/jest.js --config test/jest-e2e.json --runInBand
```

`pnpm exec`에서 자동 설치 검사 중 `ERR_PNPM_IGNORED_BUILDS: @swc/core@1.16.13`이
발생하여 설치된 도구를 Node로 직접 실행했다. 의존성/lockfile/전역 승인 설정은 바꾸지 않았다.
LSP 서버가 설치돼 있지 않아 LSP 검증은 수행하지 않았고 tsc 및 ESLint를 실행했다.
Node 26에서 Kafka 실행 중 `TimeoutNegativeWarning`이 1회 출력됐으나 suite는
성공했고 열린 handle 없이 종료했다. 이 런타임 경고의 원인은 이 작업에서 조사하지 않았다.
PR 준비 시 e2e 재실행에서는 기존 Server의 `MaxListenersExceededWarning`이 출력됐고
22개 테스트는 모두 통과했다. 해당 listener 경고의 원인 수정은 이 작업에 포함하지 않았다.
Jest raw JSON에는 로컬 절대경로와 실행 시각이 있으므로 Git에서 제외된 `.tmp/`에만
출력한다. 문서에 저장한 JSON은 실제 결과의 성공 여부/건수/테스트 상태만 추출한 요약이다.

## 관측한 동작

1. TRAINEE 발신번호 선택과 원본 CUSTOM 본문/수신자 보존. 같은 eventId 두 번은
   한 번만 발송하고 새 ID는 새 발송. 완료 TTL은 604800초 이하/604740초 초과.
   QR topic end offset은 0이고 published 마커도 없음.
2. 전체 실패는 3번 발송 시도 후 DLQ에 원본 key/value와 source topic을 보존하고
   실패 카운터/선점을 제거. DLQ 원본을 동일 ID로 복구하여 첫 실패 후 두 번째에 성공.
   총 5회 시도, DLQ 메시지는 한 개. 복구 성공 후 실패 카운터 1은 TTL까지 유지됨.
3. processing 상태에서 4회 이상 실제 claim/retry를 관측. 발송 0, 실패 카운터 없음,
   DLQ 0. lease 해제 후 처리되어 offset 커밋/발송 1회.
4. 문자 성공 뒤 실제 Redis ACL `SET` 거부 3회. processing lease는 즉시 해제되지 않음.
   동일 이벤트 즉시 재전달/4회 이상 claim에서 추가 발송과 실패 횟수 증가는 없음.
5. 완료 기록 실패 후 lease를 만료시키고 같은 ID를 재전달하면 두 번째 발송이 일어남.
   정확히 한 번 보장으로 설명할 수 없다는 한계를 실제로 확인.
6. Redis 완료 기록 거부가 2회 후 해소되면 세 번째 기록이 성공하고 같은 ID 재전달은 억제.
7. 기존 offset 없는 group에서 첫 구독 전 메시지는 건너뛰고 이후 메시지는 처리.
   consumer 첫 `FETCH` 완료 후 발행하여 초기 offset 결정까지 기다린다.
   sentinel과 발송 기록 초기화 없이 이전 이벤트 발송 0회/Redis 마커 없음도 확인.
8. consumer 종료 후 offline 메시지와 이전 완료 이벤트를 발행. 동일 group 재시작으로
   committed offset 이후를 처리하고 이전 완료 ID는 Redis로 억제.

## Claude 리뷰 반영

- group Stable 조회와 sentinel을 제거했다. 실제 KafkaJS consumer의 첫 FETCH 완료를
  관측하므로 latest offset 결정 전에 확인용 메시지가 건너뛰는 경쟁이 없다.
- Redis PING/Kafka metadata 응답까지 준비를 기다린다. 시작 직후 연결 재시도에만
  의존하지 않는다.
- 컨테이너 제거는 오류를 모으면서 모든 생성 ID를 시도한다. 실패한 ID는 남겨 재시도할
  수 있고, mock/Logger는 finally에서 복원한다. 테스트 client 종료도 각 연결을 모두 시도한다.
- DLQ callback은 메시지를 수집한다. assertion과 복구 발행을 테스트 본문으로 옮겨
  assertion 실패가 KafkaJS 재시도에 묻히지 않게 했다.
- setup/모든 조건 대기는 테스트당 하나의 45초 deadline을 공유한다.
- Redis fault 연결은 PING/INFO/CLIENT만 허용하여 SETEX/Lua 등 쓰기 방식이 바뀌어도
  실패 주입이 유지된다. ACL 사용자 정리는 전용 Redis 컨테이너 제거에 포함된다.
- 결과 JSON에서 로컬 경로/실행 시각을 제거했다. 계약 문서에는 이미 7일 TTL이
  명시되어 있어 그 지적에 따른 중복 설명은 추가하지 않았다.

정리 회귀 테스트는 기존 stop 구현에서 첫 kafka-id 삭제 실패 후 redis-id 삭제가
실행되지 않아 실패했다. 수정 후 두 ID 모두 시도하는 것을 확인했다.
공유 deadline이 이미 지났을 때 즉시 실패하는 별도 테스트도 통과했다.

## 변경 검토와 남은 외부 의존성

각 파일은 컨테이너 lifecycle, CUSTOM 테스트 runtime, 통합 시나리오라는 책임을 갖는다.
fixture는 기존 Zod schema로 파싱하며 새로운 any/type assertion/억제 주석은 없다.
외부 SMS 경계만 fake로 대체하고 consumer/store는 실제 객체를 사용했다.
공백/주석 제외 측정에서 runtime 226줄, spec 228줄로 200~250줄 경고 구간이다.
추가 시나리오를 늘릴 때 runtime 또는 시나리오 파일을 나누는 것이 적절하다.
새 dependency나 공통 구현 중복은 없다.

PR 준비 시 PR #7은 아직 OPEN이며 원격 head는
`907a27b4a101cdbefe4f3cf762fb3c5f88637a24`로 확인됐다.
이 테스트 브랜치는 지시받은 `11bee4d72ccbbe663556052baa599c29a08a6c4c`를 계속 사용한다.
develop 대상 draft PR에는 그 선행 커밋도 보인다. 신규 커밋은 테스트/문서만 포함한다.
PR #7을 먼저 병합한 뒤 선행 커밋을 정리하고 후속 공통 코드에 맞춰 재검증해야 한다.
현재 결과를 PR #7 최신 head의 검증 결과로 해석하면 안 된다.

외부 확인 필요: Expo 담당자와의 재처리 허용 기간/시작 offset 정책 합의,
실제 운영 Notification 배포 SHA와 PR #7 포함 여부, User #53/QR topic 준비,
운영 Kafka/Redis 권한·보존·복구 정책, 연수 발신번호 승인, Expo 기능 활성화 시점.
이 문서는 담당자 합의나 운영 배포 완료를 선언하지 않는다.
실제 SMS 전달, 전체 Redis 네트워크 장애, 상대 서비스 end-to-end는 검증하지 않았다.
운영 절차와 중복 위험은 [운영 문서](trainee-custom-sms-operations.md)에 기록했다.
검증에서 실제 Solapi/유료 문자, 운영 배포 및 이슈 수정은 실행하지 않았다.
PR 생성은 검증 완료 뒤 별도 사용자 요청으로 진행하며 운영 배포를 의미하지 않는다.

## 병합 후 릴리즈 재검증 (2026-10-11)

develop `7718f05e83a330dbc581fb57436be52805d5a7b4`를 기준으로 PR #17의
`chore/release-0.1.0`에서 최신 공통 코드를 재검증했다. 위의 이전 SHA 기록은
당시 검증 이력이며 현재 결과를 대체하지 않는다.

PR #12의 claim 대역이 boolean을 반환하여 단위 테스트 1개가 실패했고,
PR #13의 완료 마커 기대값이 구버전 `done`이어서 통합 테스트 6개가 실패했다.
대역은 현재 `claimed`/`done` 반환 계약으로, 실제 Redis 완료 마커 검증은
`done-v2`로 수정했다. 런타임 발송 로직이나 assertion의 검증 범위는 변경하지 않았다.

Node 22에서 단위 172개, HTTP e2e 22개, 실제 격리 Kafka/Redis 통합 10개를
통과했다. 통합 실행은 `pnpm test:integration`, 2 suites, 97.492초였다.
ESLint, 전체 타입 검사, 빌드와 diff 검사를 통과했다. 생성한 통합 컨테이너는
테스트 teardown으로 정리되었다. 운영 합의, 배포 SHA 및 실제 유료 발송은
여전히 확인하지 않았으므로 #8의 운영 완료 조건은 남아 있다.

## 운영 정책 합의 갱신 (2026-10-12)

위의 합의 미확인 문구와 초기 `done` 마커 기록은 각 검증 시점의 역사 기록이다.
현재 계약은 `done-v2`, 완료 시점부터 7일 TTL이며 기존 `done`은 `legacy-done`으로
구분한다. 사용자(Expo 담당자)는 최초 Notification 처리 시도부터 7일 미만의 DLQ
수동 재처리에서 동일 `eventId`/JSON 유지, 오래된 건의 수동 판단, Notification
구독/offset 준비 후 Expo 활성화 순서에 합의했다.
상세 정책은 [운영 문서](trainee-custom-sms-operations.md)에 기록했다.
실제 배포 SHA와 배포된 TTL, 운영 consumer 구독/offset 준비는 아직 증거가 없다.
이 정책 합의와 과거 로컬 테스트 통과만으로 #8을 완료 처리하지 않는다.
