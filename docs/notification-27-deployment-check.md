# Notification #27 운영 확인 runbook

## 판정과 조사 범위

2026-10-12 KST 조사. **운영 준비 미확인, #27은 OPEN 유지한다.**
[#27](https://github.com/School-of-Company/Expo-Notification-Server/issues/27)의
완료 조건과 [#8](https://github.com/School-of-Company/Expo-Notification-Server/issues/8),
[기존 운영 절차](trainee-custom-sms-operations.md)를 기준으로 조사하였다.
#8의 개발/통합 검증 완료와 운영 준비 완료는 별개다.
이 문서 PR의 병합으로 #27을 닫거나 Expo 발행 기능을 활성화하지 않는다.
#28 카카오 설정은 승인 정보 대기 중으로 범위 밖이다. #10/#26 코드와 workflow는 수정하지 않았다.

## 확인된 GitHub 증거

| 항목 | 관측 | 의미와 한계 |
| --- | --- | --- |
| develop | `cab7852cfb2dc55da9d07249d0bb54ff6d15180d` | 조사한 소스 기준, 운영 SHA 아님 |
| main | `a06c04855395ecd2393b379b6a8d4f6852b11dd3` | 조사 당시 원격 release 브랜치, 운영 SHA 아님 |
| workflow 파일 | develop에 `ci.yml`, `deploy.yml`; main에는 `ci.yml`만 존재 | deploy workflow가 기본 브랜치에 없음 |
| Actions 등록 workflow | `CI` 하나, ID `381157634` | 배포 실행 증거 없음 |
| Actions 실행 | API 전체 실행 수 18, 조회한 18건 모두 `CI` | CI 성공은 배포 완료 증거가 아님 |
| Deploy 조회 | `actions/workflows/deploy.yml/runs` HTTP 404 | 조회 불가이며 배포 실패/성공을 뜻하지 않음 |
| GitHub deployments / releases | 각각 빈 배열 | 수동/외부 배포의 부재까지 증명하지 못함 |
| User #53 | CLOSED, #54 merge 댓글 존재 | User consumer 구현 merge만 확인, 선행 운영 배포/offset 미확인 |

소스 permalink:
[deploy.yml](https://github.com/School-of-Company/Expo-Notification-Server/blob/cab7852cfb2dc55da9d07249d0bb54ff6d15180d/.github/workflows/deploy.yml),
[완료 마커](https://github.com/School-of-Company/Expo-Notification-Server/blob/cab7852cfb2dc55da9d07249d0bb54ff6d15180d/src/sms/sms-event-dedupe.store.ts),
[consumer](https://github.com/School-of-Company/Expo-Notification-Server/blob/cab7852cfb2dc55da9d07249d0bb54ff6d15180d/src/sms/sms-kafka.consumer.ts),
[User #53 선행 배포 요청](https://github.com/School-of-Company/Expo-User-Server/issues/53#issuecomment-6030660395).
develop 소스의 완료 마커는 `done-v2`, TTL은 `60 * 60 * 24 * 7 = 604800`초다.
consumer는 `fromBeginning: false`이며 정상 이벤트 처리 직전에 현재 메시지 offset을
커밋한다. committed offset 존재만으로 문자 성공을 증명하지 않는다.

현재 develop의 deploy workflow는 main push/manual dispatch에서만 실행하며,
릴리스명은 `<GITHUB_SHA 앞 12자리>-<GITHUB_RUN_ATTEMPT>`다.
원격 root는 `/srv/users/projects/2026/team1/expo`이며 package는
`dist`, `node_modules`, `package.json`이다. 이 설계가 서버에서 실행됐다는 증거는 없다.

재조회 명령(모두 읽기 전용):

```sh
git ls-remote origin refs/heads/main refs/heads/develop
gh api repos/School-of-Company/Expo-Notification-Server/actions/workflows
gh api 'repos/School-of-Company/Expo-Notification-Server/actions/runs?per_page=100' \
  --jq '{total_count, runs: [.workflow_runs[] | {id,name,head_sha,head_branch,status,conclusion,html_url}]}'
gh api repos/School-of-Company/Expo-Notification-Server/deployments \
  --jq '[.[] | {id,sha,environment,created_at}]'
gh api repos/School-of-Company/Expo-Notification-Server/releases \
  --jq '[.[] | {tag_name,target_commitish,published_at,html_url}]'
```

`total_count`가 조회 건수를 초과하면 다음 페이지도 조회한다.

## SSH 결과와 접근 경계

저장소 공개 변수의 접속 대상에 기존 인증으로만 시도하였다:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -p 18000 gsm11@glink.kr 'date -u +%FT%TZ'
```

exit 255:

```text
No ED25519 host key is known for [glink.kr]:18000 and you have requested strict checking.
Host key verification failed.
```

인증 처리에 도달하지 않았으므로 사용자 권한/키의 사용 가능 여부도 미확인이다.
SSH agent는 `The agent has no identities.`라고 응답했지만 기존 파일 키의 사용 가능 여부는
추측하지 않는다. host key 추가, strict checking 해제, 키/secret 탐색, 새 인증 구축은 하지 않았다.
`.env` 원문, PM2 환경변수, SMS/DLQ payload, 전화번호, 본문은 읽지 않았다.

## 저장소 측 준비 점검 도구 (2026-10-19 추가)

2026-10-19 재조회: main에도 `deploy.yml`이 있고 Deploy workflow가 main push마다 성공했다
(최근 `8f9e5b27eb940994acedc8c6ac07bd1d449909ab`, v0.6.0). 해당 SHA의 완료 마커는 `done-v2`,
TTL 604800초다. workflow 성공은 서버에서 그 artifact가 PM2로 실행 중이라는 증거가 아니다.

이후 배포부터 package에 `release.json`(전체 SHA, release 이름, run ID/attempt/URL, 빌드 시각)이
포함된다. 서버 `deploy.sh`가 tarball 전체를 풀어 `dist`와 같은 위치에 두는지 담당자가 확인한다.

PM2가 실행 중인 artifact 디렉터리에서 서비스와 같은 설정으로 읽기 전용 점검을 실행한다.
설정이 ecosystem env로만 주어지면 같은 값을 환경에 넣고 실행한다. 출력에는 비밀값·전화번호가 없다.

```sh
cd <verified-artifact-directory>
node --env-file=<서비스 .env> dist/ops/sms-readiness.cli.js > readiness.json; echo "exit=$?"
```

| 항목 | 판정 |
| --- | --- |
| `release.sha` | `release.json`의 전체 SHA. 없으면 `manual` |
| `sms.doneMarkerTtl` | 실행 artifact에 컴파일된 `done-v2` / 604800초 |
| `sms.traineeSender` | 설정 유무만. 승인 번호인지는 `manual` |
| `sms.apiBaseUrl` | `SMS_API_BASE_URL` 미설정이면 `ok`. 설정돼 있으면 `fail`(호스트만 표시, 전체 URL은 출력하지 않음) — 공동 연결 검증 전용 값이라 운영에서는 제거한다 |
| `kafka.topic.*` | 요청/DLQ/QR 완료 topic 존재와 partition 수. 없는 topic은 메타데이터를 요청하지 않아 자동 생성되지 않는다 |
| `kafka.group` | `Stable`이고 member가 있어야 `ok` |
| `kafka.committedOffsets` | 요청 topic 모든 partition에 commit이 있어야 `ok` (partition별 committed/logEnd/lag 기록) |
| `redis.maxmemoryPolicy` | `noeviction`이어야 `ok` (eviction 시 완료 마커 유실로 중복 가능) |
| `redis.persistence`, `kafka.acl` | 관측값만 기록하고 `manual` — 복구 절차, 실효 principal의 READ/WRITE 권한은 담당자 확인 |

종료 코드: `fail`이 없으면 0, 있으면 1, 설정 로드 등 실행 실패는 2.
Kafka는 topic 목록·메타데이터·group describe·offset fetch, Redis는 `INFO`만 사용한다.
group join, offset 변경, 발행, key 조회를 하지 않는다. `ready: true`도 `manual` 항목 확인 전에는
#27 완료가 아니다.

## DevOps에 요청할 읽기 전용 확인

아래 명령은 이번 조사에서 서버 실행하지 않았다. 기존 승인된 접속 환경에서 담당자가 실행한다.
인증 정보를 명령 인자나 출력에 추가하지 않는다. 신뢰된 접속 대상이 아니면 중단한다.
프로세스 재시작, offset reset, 이벤트 발행, SMS 발송, 배포를 하지 않는다.

### 1. PM2 상태와 실제 실행 artifact

기존 PM2 소유 사용자로 daemon이 이미 실행 중인지 먼저 확인한다.
`pm2 jlist`는 daemon을 새로 시작할 수 있으므로 daemon이 없으면 실행하지 않는다.

```sh
date -u +%FT%TZ
pgrep -u "$(id -u)" -f 'PM2.*God Daemon'
# 위에서 기존 daemon을 확인한 경우만 실행한다. JSON 전체나 env를 출력하지 않는다.
pm2 jlist | node -e '
let data = "";
process.stdin.on("data", chunk => { data += chunk; });
process.stdin.on("end", () => {
  const rows = JSON.parse(data).filter(p => /notification/i.test(p.name || ""));
  console.log(JSON.stringify(rows.map(p => ({
    name: p.name, id: p.pm_id, pid: p.pid,
    status: p.pm2_env.status, startedAt: p.pm2_env.pm_uptime,
    restarts: p.pm2_env.restart_time,
    cwd: p.pm2_env.pm_cwd, script: p.pm2_env.pm_exec_path
  })), null, 2));
});'
```

프로세스가 다른 이름이면 승인된 이름으로 filter를 맞춘다.
조회한 `cwd` / `script`의 실제 path를 `readlink -f <path>`로 확인하고,
`readlink -f /srv/users/projects/2026/team1/expo/app/notification/current`와 대조한다.
`current`의 존재/배치는 미확인이므로 없으면 PM2 path를 기준으로 확인한다.
current link만으로는 시작 후 link가 바뀐 프로세스의 artifact를 증명할 수 없다.
PM2 시작 시각, PID, 실행 path, 기존 release manifest/배포 기록을 대조한다.

Git checkout인 것으로 확인된 artifact에 한해 실행한다:

```sh
git -C <verified-artifact-directory> rev-parse HEAD
```

package 압축 해제 방식에서는 Git metadata가 없을 수 있다. release 이름의 12자리 prefix를
GitHub commit/run의 전체 SHA와 대조하고 run URL/attempt/배포 기록도 남긴다.
다른 checkout의 HEAD나 추측한 prefix를 PM2 프로세스 SHA로 기록하지 않는다.
대응 관계를 확인할 수 없으면 SHA는 미확인으로 둔다.
승인된 artifact의 `dist/sms/sms-event-dedupe.store.js`는
`rg -n 'DONE_SECONDS|done-v2' <verified-artifact-directory>/dist/sms/sms-event-dedupe.store.js`
로 TTL 구현만 확인한다. `.env`나 ecosystem 전체는 출력하지 않는다.

### 2. Kafka group・committed offset・lag

기존 Kafka 관리 CLI와 승인된 접속 properties를 사용한다. 아래 placeholder는
담당자가 알고 있는 값/path로 바꾼다. properties 내용은 출력하지 않는다.
담당자가 실효 group/topic을 확인하고 아래 기본값과 다르면 바꾼다. 비밀값은 공개하지 않는다.

```sh
kafka-consumer-groups.sh --bootstrap-server <approved-brokers> \
  --command-config <existing-admin-properties> \
  --describe --group expo-notification-server.sms --state
kafka-consumer-groups.sh --bootstrap-server <approved-brokers> \
  --command-config <existing-admin-properties> \
  --describe --group expo-notification-server.sms --members --verbose
kafka-consumer-groups.sh --bootstrap-server <approved-brokers> \
  --command-config <existing-admin-properties> \
  --describe --group expo-notification-server.sms --offsets
kafka-topics.sh --bootstrap-server <approved-brokers> \
  --command-config <existing-admin-properties> \
  --describe --topic notification.sms.requested
kafka-topics.sh --bootstrap-server <approved-brokers> \
  --command-config <existing-admin-properties> \
  --describe --topic notification.sms.requested.dlq
```

UTC 시각, 실효 group, topic, partition, CURRENT-OFFSET, LOG-END-OFFSET, LAG,
group state와 assignment를 기록한다. member 출력의 client/host는 내부에서만 취급한다.
각 partition에 commit이 있는지 확인한다. `-`/미등록이면 준비 완료로 보지 않는다.
stable/member 존재/lag 0만으로 초기 offset 결정이나 발송 성공을 증명하지 않는다.
기존 commit과 assignment를 대조하고 조회할 수 없는 partition은 미확인으로 둔다.
consumer 재시작이나 합성 이벤트 발행으로 증거를 만들지 않는다.
관리 principal의 describe 성공은 Notification principal의 권한을 증명하지 않는다.
실효 principal의 request READ/group READ, DLQ WRITE 권한은 담당자의 기존 ACL 기록과 대조한다.
DLQ WRITE 테스트는 하지 않는다.

User #53도 담당자가 알고 있는 실효 group에서 `notification.qr-sms.sent`의
assignment/offset과 실행 artifact SHA를 확인한다. group 이름은 추측하지 않는다.
Notification보다 먼저 준비한 시각/기록이 필요하며 #54 merge만으로는 부족하다.

### 3. 추가 미확인 항목과 제출 형식

| #27 조건 | 필요한 증거 | 이번 상태 |
| --- | --- | --- |
| 실제 SHA·7일 TTL | PM2 실행 artifact와 전체 SHA 대응, 배포/run 기록, artifact TTL 구현 | 미확인 |
| request/DLQ 접근 | 실효 principal 권한, topic/partition 존재 | 미확인 |
| Redis persistence·복구 | 기존 운영 설정과 복구 절차/검증 기록, 담당자 확인 | 미확인 |
| 승인된 연수 발신번호 | 실효 설정 유무와 승인 기록 참조만, 값은 비공개 | 미확인 |
| consumer 준비 | 시각 포함 assignment·partition별 commit/lag, 기존 group 유지 | 미확인 |
| User consumer 선행 준비 | User 실행 SHA·QR topic/group/offset과 선행 시각 | merge만 확인 |
| DLQ 운영 | 최초 시도부터 7일 미만, 같은 eventId/JSON, 시각 불명/기간 초과 시 수동 판단 | #8/#24 정책 합의 완료, 운영 적용 미확인 |

Redis 복구 정책은 persistence 설정만으로 확인 완료로 보지 않는다. 담당자에게 기존
backup/restore 절차, 보존 기간, 최근 복구 검증 기록을 받는다.
TTL 관측이 필요하면 이미 알고 있는 승인된 event key에 한해 기존 인증된 redis-cli 환경에서
`TTL sms:event:<approved-event-id>`를 실행하며 key 값이나 목록은 조회하지 않는다.
남은 TTL이 0보다 크고 604800 이하여도 초기 TTL/구현을 단독으로 증명할 수 없다.
`-1`은 만료 없음, `-2`는 key 부재이며 7일 설정의 증거로 취급하지 않는다.

제출 기록은 UTC 시각 / 대상 서비스 / 실행 SHA와 대응 근거 / PM2 상태 /
topic·group·partition별 offset/lag / 미확인 항목 / 담당자를 기본으로 한다.
secret, 전화번호, 본문, DLQ 원문은 이슈/PR/Orca 댓글에 붙이지 않는다.
위 미확인 조건이 충족되기 전에는 #27 체크를 완료로 바꾸거나 close하지 않는다.
Expo 발행 기능 활성화는 이번 작업 범위에 포함되지 않는다.
