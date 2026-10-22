# 행사별 그룹 문자 처리이력 (#42)

Notification이 문자 처리이력의 원천이다. Application은 권한 확인과 대리 조회를 담당하며 이력을 별도 저장하지 않는다. 이 문서는 Notification 개발 계약과 Application/Client 후속 접합을 구분한다.

## 확인한 실제 서비스 계약

2026-10-12 develop 기준:

- [Application #93](https://github.com/School-of-Company/Expo-Application-Server/issues/93): 신청 이력은 Application, 모집 변경은 Expo, 문자 발송은 Notification 원천으로 합의되어 있다.
- [Client #347](https://github.com/School-of-Company/Expo-Client/issues/347): 실제 공급자 API를 연결해야 하며 mock 값을 운영 이력으로 표시하면 안 된다.
- Application SHA `68c3c636b3f19e96e68996fcf8992581fbcbe227`의 [AdminGroupMessageGateway](https://github.com/School-of-Company/Expo-Application-Server/blob/68c3c636b3f19e96e68996fcf8992581fbcbe227/src/main/kotlin/team/startup/application/domain/application/service/impl/AdminGroupMessageGateway.kt)는 원본 `Authorization: Bearer`와 Expo 내부 토큰을 `GET /internal/expo/{expoId}/admin-access`에 전달한다. 응답의 행사 ID, 양수 safe integer 관리자 ID, `APPLICATION_READ`, `GLOBAL_ADMIN`, `GLOBAL_ADMIN_APPLICATION_READ_V1`을 검사한다.
- 같은 SHA의 [AdminGroupMessageController](https://github.com/School-of-Company/Expo-Application-Server/blob/68c3c636b3f19e96e68996fcf8992581fbcbe227/src/main/kotlin/team/startup/application/domain/application/presentation/AdminGroupMessageController.kt)는 `/application/expos/{expoId}/admin-group-messages` 아래 config/preview/execute/job/retry를 제공한다. 행사별 이력 경로는 없다.
- Expo SHA `24ae37832862bc61b494c88d21e350d67034a686`의 [GetAdminExpoAccessServiceImpl](https://github.com/School-of-Company/Expo-Expo-Server/blob/24ae37832862bc61b494c88d21e350d67034a686/src/main/kotlin/team/startup/expo/domain/expo/service/impl/GetAdminExpoAccessServiceImpl.kt)은 JWT decoder, 양수 subject, `ROLE_ADMIN`, User 현재 관리자 자격, 행사 존재 및 삭제 중 여부를 검사한다.
- Client SHA `27203a195184bf49dab6a4997a5128e169bc4d53`의 [history page](https://github.com/School-of-Company/Expo-Client/blob/27203a195184bf49dab6a4997a5128e169bc4d53/src/app/%28pages%29/admin/future-edu-expo/history/page.tsx)는 `RegistrationHistoryPage`를 사용하며 [useRegistrationQueries](https://github.com/School-of-Company/Expo-Client/blob/27203a195184bf49dab6a4997a5128e169bc4d53/src/features/registration/common/model/useRegistrationQueries.ts)는 `mockGetRegistrationHistories`를 호출한다. Notification 신규 이력 API에 이미 연결된 것으로 간주하지 않는다.

현재 Expo 계약은 **전역 관리자 조회 정책**이며 행사별 관리자 멤버십 또는 새 문자 전용 권한을 뜻하지 않는다. 이 API는 항상 요청 행사 인덱스만 읽지만 전역 관리자가 다른 행사에도 접근할 수 있는 기존 정책을 임의로 변경하지 않는다.

## 권한 경계와 Application 접합 요구사항

Client -> Application -> Expo(원본 JWT/현재 권한) -> Notification(내부 토큰) 순서다. Notification의 내부 토큰은 Application 서비스 신뢰 경계이며 사용자 ID 자체는 권한 증거가 아니다. Gateway에서 `/internal/**`를 외부 공개하지 않고 내부 토큰을 Client로 전달하지 않는다. Notification은 관리자 JWT를 저장하거나 로그에 남기지 않는다.

Application 후속 변경은 기존 공개 그룹 문자 prefix 아래 `GET /history`를 추가하는 것이다. 이 경로는 **아직 구현된 API가 아닌 제안**이다. 매 페이지 요청마다 원본 JWT를 Expo에 전달하고 현재 행사 권한 응답을 검증한 뒤 Notification의 요청 행사 이력을 조회해야 한다. Client가 보낸 `adminId`/`requesterUserId`, 과거 preview 성공, JWT decode 결과, 다른 행사에 대한 성공 응답만으로 승인하면 안 된다. 조회자의 ID로 이력을 제한하지 않는다. 행사 관리자는 다른 관리자의 행사 내 작업도 볼 수 있다.

Application은 응답 `expoId` 일치, 허용된 처리유형, 시각/커서/건수 스키마를 확인하고 `Cache-Control: no-store`로 전달한다. 기존 그룹 문자 gateway의 공급자 오류 매핑을 재사용한다. 이력은 Application DB에 중복 적재하지 않고 공급자별 독립 페이지/커서로 연결한다. 한 화면의 전역 정렬·페이지를 구현하려면 공급자별 커서를 유지하는 별도 Client/Application 계약이 필요하다.

| 경계 | HTTP 결과 |
| --- | --- |
| Application/Expo: 원본 JWT 누락·위조·만료 | 401, Notification 호출 금지 |
| Application/Expo: 현재 관리자 자격/조회 권한 거부 | 403, Notification 호출 금지 |
| Application/Expo: 행사 없음 | 404 |
| Expo/User 권한 공급자 장애·삭제 중 행사 | 실패를 그대로 처리, 권한 승인/빈 이력으로 대체 금지 |
| Notification 신규 이력: 내부 토큰 누락·불일치 | 401 |
| Notification 기존 발송 경로: 내부 토큰 누락·불일치 | 기존 403 유지 |
| Notification: 잘못된 행사 UUID·필터·커서 | 400 |
| Notification: Redis 장애·잘못된 저장 레코드 | 503, 일반화된 오류; raw 응답/토큰/번호 노출 금지 |
| Application: Notification 내부 토큰 거부 | 사용자 401/403으로 오인하지 않고 기존 공급자 오류 매핑으로 502 |

Notification에서 다른 행사 커서를 재사용하거나 행사 ID를 변경해도 응답에 요청 행사 외 레코드는 포함하지 않는다. 내부 토큰 소지자의 서비스 권한과 관리자별 권한은 별개다. 내부 토큰 탈취를 사용자 행사 권한 검증으로 대체할 수 없다.

## Notification 조회 API

`GET /internal/admin-group-messages/expos/{expoId}/history`

기존 `adminGroupMessaging.internalToken`을 `X-Internal-Token`으로 전달한다. 새 env/config 값은 없다. 발송 비활성화 시에도 기존 이력 조회는 허용하며 내부 토큰 설정 자체가 없으면 503이다. Swagger의 `includeInternal` 옵션이 켜진 경우에만 내부 경로를 공개한다.

| query | 규칙 |
| --- | --- |
| `from` | 선택 UTC ISO 8601 시각, 시작 포함 |
| `to` | 선택 UTC ISO 8601 시각, 끝 제외; `from < to` |
| `type` | 선택 `REQUESTED`, `SENT`, `FAILED`, `RETRIED` 중 하나 |
| `limit` | 기본 20, 1~100 |
| `cursor` | 앞 페이지 `nextCursor`를 그대로 전달; 숫자 13자리 epoch ms와 UUID tie-breaker |

지원 기간은 epoch ms `0..9999999999999`다. 알 수 없는 query와 사용자/관리자 ID query는 400으로 거부한다. 기간과 처리유형을 유지해서 다음 페이지를 조회한다. 필터를 바꾸면 커서를 초기화한다. 정렬은 `(occurredAt DESC, eventId DESC)`로, 동일 시각의 행도 서로 다른 UUID 커서로 페이지를 이어간다. 임의 날짜 숫자로 cursor를 재구성하지 않는다. `to`와 cursor가 함께 있으면 더 작은 상한을 적용한다.

응답은 `{ items: [...], nextCursor?: string }`이며 추가 행이 없으면 커서를 생략한다. offset/page/전체 건수 조회는 제공하지 않는다. 비어 있는 행사 또는 보관 기간 밖 기간은 200과 빈 `items`다. 이 API는 작업 전체의 진행/완료 시점 스냅샷 이력이며 각 수신자별 무제한 로그가 아니다.

각 item은 `eventId`, `type`, `adminId`, `occurredAt`, `targetScope`, `counts`, `status`, `jobId`만 포함한다. `targetScope.kind=EXPLICIT_TARGETS`, `applicationCount`, 정렬된 `programTypes`는 Notification이 전달받은 고정 발송 대상 범위다. Application의 `SELECTED`/`FILTERED` 원본 선택 방식과 필터는 기존 Notification 요청에 전달되지 않으므로 추측하지 않는다. 본문·번호·대상 ID 목록·fingerprint·template 변수·공급자 raw 오류·토큰은 포함하지 않는다.

사전등록 그룹 발송은 `targetScope.source=PREREGISTRATION`, `programTypes=[]`로 구분한다.
기존 프로그램 이력은 source 없이 기존 enum 배열을 유지하고, source 없는 과거 저장 이력도 읽는다.
Application/Client는 optional source와 빈 programTypes를 수용해야 한다.
상세 계약과 배포 순서는 [#106 계약](notification-106-preregistration-group-message.md)을 따른다.

`counts`는 `total`, `pending`(PENDING+SENDING), `accepted`, `delivered`, `failed`, `unknown`, `missing`을 분리한다. 공급자 접수는 최종 도착 성공으로 세지 않는다. `adminId`는 조회자가 아니라 최초 요청/재시도 작업을 승인한 관리자 ID다. 현재 기존 재시도 계약은 원래 요청자와 같은 관리자만 허용한다. 자동 공급자 결과 이벤트의 ID는 해당 작업의 요청 관리자에 귀속되며 사람이 그 시각에 직접 조작했다는 뜻은 아니다.

| type | 기록 시점 |
| --- | --- |
| `REQUESTED` | preview 실행으로 job이 최초 생성됨; 단순 preview/중복 execute는 추가하지 않음 |
| `RETRIED` | 확정 실패 대상이 새 멱등 작업으로 재대기 상태가 됨; 중복 멱등 키/실패 대상 없는 재시도는 추가하지 않음 |
| `SENT` | job이 COMPLETED로 정리됨; 누락 대상이 있으면 counts로 분리하며 delivered=0일 수도 있음 |
| `FAILED` | COMPLETED_WITH_FAILURES 또는 ATTENTION으로 정리됨; UNKNOWN은 확정 실패가 아니며 수동 재발송 대상에서 제외 |

동일 terminal type을 반복 저장하면 이력을 추가하지 않는다. 새 retry 이후 다시 종료되면 새 terminal 이벤트가 생성된다. PAUSED/RUNNING의 모든 poll을 로그로 쌓지 않는다. `status`와 `counts`는 **이벤트 당시** 값이며 현재 진행 상태는 기존 개별 job API로 조회한다. 전환 전에 만들어진 job은 계속 파싱하지만 과거 시각/관리자/이력을 재구성하지 않는다. 기존 job에 없는 `applicationCount`는 null로 표시한다.

## Redis 저장과 보관

기존 `{jobs}` hash tag에 행사별 `history:{expoId}:ALL`과 `history:{expoId}:{type}` ZSET을 둔다. 모든 score는 0이고 member는 `13자리 epoch ms:eventId|최소 이벤트 JSON의 base64url`이다. base64는 암호화가 아니며 이력 payload 자체에 본문/번호/토큰을 저장하지 않는다. 정렬과 기간·유형 필터를 Redis에서 적용하고 `ZREVRANGEBYLEX LIMIT 0 limit+1`로 최대 101행만 읽는다. 전체 SCAN, 전체 job fetch, 전체 결과 메모리 페이지는 사용하지 않는다. 만료 정리 `ZREMRANGEBYLEX`의 삭제 비용은 만료 행 수에 비례하므로 장기간 유휴 후 첫 요청은 정리 비용이 추가될 수 있다.

job 최초 생성·terminal 상태 저장·멱등 retry 변경 Lua에 이력 append를 함께 넣는다. job lock, retry operation key와 이력 marker가 중복 상태 기록을 막는다. Lua 실행 전 새 이력 key 타입을 검사하여 잘못된 인덱스로 job만 생성되는 경우를 막는다. 신규 키는 기존 queue/job key와 같은 Redis Cluster slot을 사용한다.

이력은 기존 `adminGroupMessaging.retentionSeconds`(기본 2,592,000초/30일)를 **각 이벤트 발생 시점**부터 적용한다. job/PII/재시도 멱등 키는 기존대로 **job 생성 시점**부터 보관하며 재시도가 job TTL을 연장하지 않는다. 따라서 job이 만료된 뒤에도 최근 최소 이력은 남을 수 있고, job ID 상세 조회는 404일 수 있다. 이는 과거 작업을 재발송 가능한 상태로 복원한다는 뜻이 아니다. 이력을 원래 job 생성 시각 기준으로 조기 삭제하지 않는다.

append/조회에서 retention cutoff보다 오래된 member를 제거한다. 각 전체/유형 인덱스의 키 TTL은 최신 이벤트 보관 기한까지 유지하고, 늦게 도착한 append가 기존 기한을 단축하지 않는다. 새 요청이 없는 인덱스도 TTL로 제거된다. marker TTL은 job의 남은 보관 기간과 맞춘다. 새로운 타입 인덱스가 별도로 있으므로 유형 필터를 위해 모든 이벤트를 가져오지 않는다.

배포 전 저장된 job의 과거 이력은 자동 backfill하지 않는다. 재시도나 완료 상태가 새로 저장되면 그 이후 이벤트만 기록한다. 기존 job에 없는 `applicationCount`는 null이다. Redis 장애나 잘못된 이력 레코드는 성공한 빈 페이지로 삼키지 않고 신규 조회 API에서 일반화된 503으로 반환한다. 기존 발송 경로의 HTTP 오류 정책은 그대로 유지한다.

## 공식 기술 근거

[Redis Lua 원자 실행과 KEYS 규칙](https://redis.io/docs/latest/develop/programmability/eval-intro/), [lex 역순 범위/LIMIT](https://redis.io/docs/latest/commands/zrevrangebylex/), [EXPIRE의 키 단위 만료](https://redis.io/docs/latest/commands/expire/)를 기준으로 구현한다. 동일 점수 lex 멤버에 시각과 tie-breaker를 포함하여 전체 SCAN과 메모리 페이지를 피한다. Lua는 직렬 원자 실행을 제공하지만 런타임 오류 시 이미 수행한 write를 자동 rollback하지 않으므로 키 타입/입력 계약을 유지해야 한다.

## 완료 범위

Notification API 개발 및 로컬 실제 Redis/HTTP 검증, Application #93 접합 요구 기록, Client #347 후속 표시 계약이 이번 범위다. 운영 JWT/서비스/실제 데이터에 대한 연결 검증, 배포, 운영 UI 검증과 유료 문자 발송은 수행하지 않는다. 타 저장소 코드는 변경하지 않는다.
