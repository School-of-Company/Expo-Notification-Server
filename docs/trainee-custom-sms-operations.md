# TRAINEE CUSTOM 연동 검증과 운영 절차 (#8)

## 검증 범위와 기반

초기 검증의 테스트 브랜치는 `test/trainee-custom-sms-integration`이었다. develop
`1b2a5980b9ce50c39a7bebf56eaedca0a1fc79f0`에서 시작하고, 명시적 선행 기반으로
`origin/feat/qr-sms-sent-event` / PR #7의
`11bee4d72ccbbe663556052baa599c29a08a6c4c`를 fast-forward했다.
#6의 다른 checkout이나 후속 변경은 기다리거나 포함하지 않았다.
공통 consumer/guard/store 및 QR 계약은 새로 구현하지 않았다.
이 SHA를 로컬에서 검증했다는 사실은 merge 또는 운영 배포 완료의 증거가 아니다.

`SmsEventConsumer → SmsEventService → SmsEventGuard → SmsEventDedupeStore`와
실제 KafkaJS consumer, Kafka, Redis를 사용한다. Nest 테스트 모듈은
`SmsSenderProvider` 토큰을 가짜 발송기로 대체한다. AppModule/SmsModule,
Solapi 클라이언트, 실제 자격증명, Eureka, Attention, User를 생성하거나 연결하지 않는다.
수신 번호와 본문은 합성 fixture이며 원문을 로그나 assertion 실패 결과에 출력하지 않는다.

## 재현

Docker daemon과 프로젝트 의존성이 필요하다. Kafka `apache/kafka:3.9.1`,
Redis `redis:7.4-alpine` 이미지를 사용한다. 외부 Kafka/Redis 주소나 `.env`를 읽지 않는다.

```sh
pnpm test:integration
```

pnpm의 자동 의존성 검사가 기존 `@swc/core` 빌드 승인 설정 때문에 실패하는 환경에서는
설치된 동일 Jest를 직접 실행할 수 있다. 전역 승인 설정을 바꿀 필요는 없다.

```sh
node node_modules/jest/bin/jest.js --config test/integration/jest.json --runInBand
```

실행마다 UUID가 붙은 전용 컨테이너 2개와 topic/group을 생성하고
127.0.0.1의 가용 포트에만 바인딩한다. topic 자동 생성은 비활성화하고
테스트가 요청/DLQ/QR topic을 각각 1 partition, replication factor 1로 만든다.
Redis는 이 실행 전용이며 persistence를 끈다. 정상 종료 및 테스트 실패 시
이 실행이 생성하여 기록한 container ID만 제거한다. 공유 컨테이너, topic, group,
볼륨을 지우거나 `FLUSHALL`, Docker prune을 실행하지 않는다.
호스트 포트 선택 후 bind까지 경쟁이 생기면 실행을 실패시키며 새 실행으로 재시도한다.
Redis `PING`과 Kafka metadata 응답까지 확인한 후 테스트를 시작한다.
컨테이너 하나의 제거가 실패해도 나머지 제거를 시도하고 실패를 모아서 보고한다.

강제 종료(SIGKILL 등)로 teardown이 실행되지 않았다면, 해당 실행의
`notification.issue8.run=notification8-<UUID>` label과 이름을 확인한 후
그 두 container ID만 `docker rm --force <ID>`로 제거한다. 다른 실행의 UUID를
추측하거나 전체 label에 대해 일괄 삭제하지 않는다.

완료 표시 장애는 실제 Redis ACL로 별도 completion 연결에 연결 확인 명령만 허용해
실제 `NOPERM` 응답을 발생시킨다. 정상 연결은 선점/실패 카운터/TTL을 계속 처리한다.
`SETEX`나 Lua로 완료 구현이 바뀌어도 데이터 쓰기 명령은 허용하지 않는다.
전체 Redis 서버 정지나 네트워크 장애 검증과 동일하다고 주장하지 않는다.
lease 만료 테스트는 전용 event key의 TTL을 1ms로 줄여 5분 대기를 가속한다.
각 테스트의 setup과 모든 offset/Redis 대기는 하나의 45초 deadline을 공유한다.
Jest timeout 60초 전에 조건 대기를 끝내고 정리에 여유를 둔다.
첫 consumer `FETCH` 완료는 KafkaJS가 시작 offset을 결정한 뒤 발생한다.
테스트는 이를 기다린 후 이벤트를 발행하며 sentinel이나 발송 기록 초기화를 사용하지 않는다.
DLQ callback은 메시지만 수집하고 assertion/복구 발행은 테스트 본문에서 실행한다.

## 운영 설정과 이벤트 계약

| 환경값 | 기본값 또는 확인 사항 |
| --- | --- |
| `KAFKA_BROKERS` | 운영 Kafka 주소, 인증/접근 권한 별도 확인 |
| `KAFKA_SMS_REQUESTED_TOPIC` | `notification.sms.requested` |
| `KAFKA_SMS_DEAD_LETTER_TOPIC` | `notification.sms.requested.dlq` |
| `KAFKA_SMS_GROUP_ID` | `expo-notification-server.sms`; 재시작 시 동일 값 유지 |
| `SMS_FROM_TRAINEE_NUMBER` | 승인된 연수 발신번호; 실제 번호를 이 문서에 복사하지 않음 |
| `SMS_FROM_STANDARD_NUMBER` | 일반 발신번호; TRAINEE CUSTOM은 이 값을 선택하지 않음 |
| `SMS_EVENT_MAX_ATTEMPTS` | 운영 기본 5, 로컬 검증에서는 3 |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | 운영 전용 Redis와 persistence/복구 정책 확인 |

Expo는 `version=1`, `type=CUSTOM`, `senderType=TRAINEE`, 수신자 한 명,
Expo가 완성한 `text`, 내구 저장한 `eventId`를 보내고 Kafka key도 `eventId`로 둔다.
동일 작업의 발행 복구는 같은 ID/JSON을 유지하고 실제 신청 변경은 새 ID를 사용한다.
Notification은 본문을 추가 가공하지 않으며 CUSTOM은 QR 발송 횟수 집계나
`notification.qr-sms.sent` 발행을 실행하지 않는다.
Expo의 Kafka ACK는 broker 수락이며 Notification 처리 완료나 SMS 전달 완료가 아니다.

## 보존 기간과 재처리

검증한 PR #7 SHA에서 완료 마커 `sms:event:<eventId>=done`은 완료 시점부터
604800초(7일), processing lease는 300초(5분)이다. 같은 ID의 재전달을 무시할 때
완료 TTL을 갱신하지 않는다. 실패 카운터 `sms:event-fail:<eventId>`의 TTL은 첫 실패부터
7일이며 실패마다 연장하지 않는다. develop 조사 SHA의 완료 TTL은 24시간이었다.
실제 배포 SHA 및 Redis 상태가 어느 정책인지 배포 전에 확인해야 한다.

위의 `done`과 24시간 TTL은 해당 SHA의 역사 기록이다. 현재 소스의 완료 마커는
`sms:event:<eventId>=done-v2`이며 완료 시점부터 604800초(7일) 보존한다.
기존 HTTP 방식의 `done`은 `legacy-done`으로 구분하여 문자와 QR 완료 발행을 모두
건너뛴다. `done-v2`는 이미 보낸 문자를 다시 보내지 않고 STANDARD의 미완료 QR
완료 발행을 이어갈 수 있다. CUSTOM은 QR 완료 발행을 하지 않는다.
현재 소스 확인과 운영 배포 확인은 별개다.

전부 실패한 발송은 선점을 해제하고 실패 횟수를 증가시킨다. 상한에 도달하면
key/value 원본과 `x-source-topic`을 DLQ로 옮긴 뒤 실패 카운터를 지운다.
같은 ID/JSON으로 요청 topic에 복구하면 새 실패 예산으로 처리된다.
검증한 코드에서는 상한 전 실패 후 성공한 경우 실패 카운터를 즉시 지우지 않고
TTL까지 유지한다. 완료 마커가 정상 기록되면 재전달은 발송을 다시 수행하지 않는다.
processing 대기는 실패 카운터에 포함되지 않으며 offset을 넘기지 않고 재시도한다.

문자 성공 뒤 완료 기록은 최대 3회 시도한다. 모두 실패해도 즉시 선점을 풀지 않고
현재 메시지는 성공 처리되어 offset이 커밋될 수 있다. 그 뒤 같은 ID 재전달은
lease 동안 기다리지만 lease 만료 후 다시 발송할 수 있다. 완료 마커의 7일 TTL
만료, Redis 데이터 유실/교체, 오래된 DLQ replay도 중복 가능성을 남긴다.
정확히 한 번의 SMS 발송을 보장하지 않는다.

**합의 상태: 2026-10-12 Expo 담당자 승인.** 완료 마커 보존 기간은 완료 시점부터 7일이다.
DLQ 수동 재처리는 최초 Notification 처리 시도부터 7일 미만에만 허용하며,
원본 `eventId`와 JSON을 유지한다. 최초 처리 시각을 확인할 수 없는 건은 자동 재처리하지 않는다.
DLQ 보관 기간 자체가 안전한 재처리 기간은 아니다.
7일 이상 지난 replay는 발송 이력과 중복 영향을 담당자가 확인한 뒤 수동 판단한다.
기간 변경 시 Expo의 replay 정책과 Notification 실제 배포 TTL을 함께 확인한다.
이 합의는 실제 배포 완료나 Redis 장애에서 중복 없는 발송을 보장하지 않는다.

## 준비 및 배포 순서

1. 실제 배포할 Notification SHA에 PR #7 공통 변경이 포함됐는지 확인한다.
   테스트 브랜치의 기반 SHA와 운영 SHA를 각각 기록한다.
2. 요청/DLQ topic, 접근 권한, Redis, 연수 발신번호를 준비한다.
   동일 배포에 PR #7 QR 변경이 들어가므로 User의 QR 완료 이벤트 consumer
   (Expo-User-Server #53)와 `notification.qr-sms.sent` topic을 Notification보다 먼저 준비한다.
   topic이 없으면 QR 완료 발행 재시도로 관련 partition이 막힐 수 있다.
3. Expo의 기능을 비활성화한 상태로 Notification consumer와 운영 group을 준비한다.
   `fromBeginning:false`이고 기존 offset이 없는 group은 첫 구독 이전의 메시지를 건너뛴다.
   group join/partition assignment만으로 초기 offset 결정까지 증명하지 말고,
   접근을 통제한 합성 이벤트와 가짜 발송기 환경에서 처리/committed offset까지 확인한다.
   이 작업은 실제 유료 발송을 실행하지 않았다. 운영 확인 방법은 담당자가 별도 결정한다.
4. 이전 backlog 처리가 필요하면 시작 offset 정책을 먼저 합의하고 consumer를 멈춘 상태에서
   대상 group/topic/partition만 조정한다. 무조건 earliest로 바꾸거나 새 group을 만들지 않는다.
   Kafka offset reset만으로 Redis 완료 상태를 복원할 수 없다.
5. group 준비 및 실제 배포 코드/재처리 기간 확인 후 Expo 기능을 활성화한다.
   재시작은 동일 group으로 진행한다. 검증에서는 committed offset 이후의 offline 메시지를
   처리하고 이전 완료 ID replay는 Redis로 억제했다.

배포 순서는 Notification consumer의 구독 및 offset 준비를 확인한 뒤 Expo 발행 기능을
활성화하는 것으로 합의했다. 기존 group과 committed offset을 유지하며, offset이 없는
group의 사전 발행 메시지는 별도 복구 대상으로 판단한다. 기존 메시지를 무조건 earliest로
재생하지 않는다. 실제 배포 SHA와 consumer 준비 상태는 아직 확인되지 않았다.
2026-10-12 저장소 확인에서 `deploy.yml`은 `develop`에만 있고 기본 브랜치 `main`에는
없었다. 기존 `gh run list --workflow deploy.yml`의 404는 배포 성공/실패의 증거가 아니다.
실제 배포 SHA, 배포된 7일 TTL 및 consumer 구독/offset 준비 증거를 담당자가 확인하기
전에는 운영 조건 완료를 선언하거나 #27을 닫지 않는다. #8은 개발 완료로 닫혔으며,
남은 운영 확인은 #27에서 관리한다. 읽기 전용 조사 결과와 DevOps 확인 명령은
[Notification #27 운영 확인 runbook](notification-27-deployment-check.md)에 기록한다.
Application 외부 성공 직후 Expo 프로세스 중단이나
HTTP 응답 유실의 성공 여부 확인은 Notification 책임이 아니며 outbox만으로 해결했다고 설명하지 않는다.

## 실패 조사와 개인정보

일반 운영 기록에는 eventId, topic, partition/offset, 처리 시각, attempts, group lag,
완료/processing 상태와 TTL만 기록한다. 발신번호 설정은 값 대신 설정 유무/승인 상태를 확인한다.
기존 전체 실패 로그는 수신자 수만, 일부 실패 로그는 마스킹된 번호를 남긴다.
DLQ key/value에는 전화번호와 본문이 있으므로 일반 로그, Orca comment, 이슈 또는 PR에
원문을 복사하지 않는다. DLQ 열람/재발행 도구는 권한 제한된 환경에서 원본을 메모리로 전달하고
stdout에는 식별자/건수만 출력해야 한다.

`이벤트를 DLQ로 이동`, `완료 표시 실패`, consumer restart/lag, Redis 가용성/TTL을
함께 확인한다. processing 상태를 완료 마커로 임의 변경하거나 key를 삭제하면
중복/유실 판단을 바꾸므로 발송 이력 확인 없이 운영 복구 명령을 실행하지 않는다.
검증에서 운영 resource 변경, 유료 문자, 운영 배포 및 이슈 수정은 실행하지 않았다.
2026-10-12 사용자(Expo 담당자) 합의는 위 운영 정책에 한정한다. 별도로 요청된
문서 PR과 이슈 댓글은 운영 배포 또는 consumer 준비 완료의 증거가 아니다.
