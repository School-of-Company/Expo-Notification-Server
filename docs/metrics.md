# Notification 공통 메트릭 (#38)

서비스 HTTP와 별개인 내부 listener에서 `GET /metrics`만 제공합니다. 서비스 포트의 `/metrics`,
`/sms/metrics`는 404이며 Gateway 공개 API를 통해 메트릭을 제공하지 않습니다.

| 설정 | 환경 변수 | 기본값 |
|---|---|---|
| `metrics.enabled` | `METRICS_ENABLED` | `true` |
| `metrics.port` | `METRICS_PORT` | `9464` |
| `metrics.host` | `METRICS_HOST` | `127.0.0.1` |

Config Server 설정이 환경 변수보다 우선합니다. 활성화는 정확한 `true`/`false`만 허용하고,
포트는 0~65535, host는 IPv4/IPv6 리터럴만 허용합니다. 포트 0은 로컬 테스트의 임시 포트입니다.
운영에서는 서비스 HTTP 포트와 분리된, 동일 호스트의 다른 프로세스와 겹치지 않는 포트를 할당해야 합니다.
disabled이면 listener를 열지 않습니다. bind 실패는 부팅을 실패시키며 Eureka에 등록하지 않습니다.

`http_server_requests_seconds` Histogram은 `method`, `status`, `uri`만 사용합니다. `uri`는
Express 라우트 템플릿(`/internal/promotion-notifications/:eventId`)이며 컨트롤러에 매칭되지 않은
요청은 `unmatched`입니다. 메서드는 Gateway와 동일한 GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS이고
나머지는 `OTHER`입니다. 응답 완료 시 계측하여 인증 거부, 입력 검증 실패, 404와 500을 포함합니다.
원문 URL, 쿼리, 사용자 ID, 전화번호, 토큰은 라벨에 사용하지 않습니다.

Gateway `LATENCY_BUCKETS`와 동일한 초 단위 경계를 사용합니다:
`0.0005, 0.001, 0.0025, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04,
0.05, 0.06, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10` 및 `+Inf`.
Spring과의 버킷 통일은 공통 규약에서 아직 확정하지 않았습니다.

`collectDefaultMetrics`로 CPU, 메모리, Node.js heap/event loop/GC를 제공합니다. 런타임 collector는
프로세스당 한 번 생성하고 앱별 registry에 공유하여 여러 앱을 만들어도 observer가 중복되지 않습니다.
HTTP Histogram과 listener는 앱별이며 종료 시 listener를 닫고 앱 registry를 비웁니다.

Eureka 라이브러리 `@school-of-company/nestjs-eureka` 0.1.0은 생성자가 아닌
`onApplicationBootstrap`에서 등록합니다. listener의 `onModuleInit`이 성공한 뒤 실제 `server.address()`를
읽어 등록 정보를 구성합니다. 광고 IP가 bind IP와 같거나 wildcard bind로 광고 IP를 포함할 때만
`prometheus.scrape="true"`, 실제 bind 포트의 `prometheus.port`, `prometheus.path="/metrics"`를 넣습니다.
loopback bind와 사설 광고 IP가 다르면 scrape metadata를 생략합니다. Eureka 등록 실패 시 listener를
닫고 오류를 전파하며, 정상 종료는 Eureka deregistration 후 listener를 닫습니다.

## 규약 및 실제 설정 근거

- [Config Server 공통 규약](https://github.com/School-of-Company/Expo-Config-Server/blob/ba3c050c7319afaa7a9065d252db44689747e069/docs/metrics-convention.md): 기본 활성/9464, 라벨, `unmatched`, 별도 listener.
- [Gateway 버킷](https://github.com/School-of-Company/Expo-Gateway/blob/ccadf872b61ff34291c5c2703a80e4c4a598f372/src/metrics/metrics.service.ts), [host 기본값](https://github.com/School-of-Company/Expo-Gateway/blob/ccadf872b61ff34291c5c2703a80e4c4a598f372/src/bootstrap/env.ts), [metadata 도달성 조건](https://github.com/School-of-Company/Expo-Gateway/blob/ccadf872b61ff34291c5c2703a80e4c4a598f372/src/eureka/eureka-options.factory.ts).
- [Monitoring 실제 relabel 설정](https://github.com/School-of-Company/Expo-Monitoring/blob/f07f36c1bfafa7015b1b740d52cdccb56f785636/prometheus/prometheus.yml): 광고 IP + metadata port로 scrape합니다.
- [Monitoring 운영 기록](https://github.com/School-of-Company/Expo-Monitoring/blob/f07f36c1bfafa7015b1b740d52cdccb56f785636/docs/deployment-environment.md): 같은 호스트의 loopback 수집이며 Notification은 기존 6개 대상에 없습니다.
- [prom-client 15.1.3 공식 문서](https://github.com/prometheus/client_js/blob/v15.1.3/README.md): `Registry`, `collectDefaultMetrics`, Histogram, `registry.metrics()` 사용.

## 개발 검증과 운영 후속

`pnpm test`, `pnpm test:e2e`, `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build`로 개발 완료를 검증합니다.
`test/metrics.e2e-spec.ts`는 실제 TCP listener와 로컬 Eureka HTTP stub으로 응답/버킷/라벨/metadata,
등록 전에 scrape 가능 여부, disabled/bind 실패/IP 불일치, 등록 실패 정리와 종료를 검증합니다.
Kafka/Redis/Solapi는 테스트 대역을 사용하여 유료 발송은 없습니다.

운영 포트 할당 근거는 현재 확인한 문서에 없어 임의로 지정하지 않았습니다. 운영 담당자는 배포 전에
Notification 전용 포트, 실제 Prometheus 출발지와 bind/광고 IP, 내부 접근 조건을 확정해야 합니다.
같은 호스트의 바이너리 배포는 loopback 수집을 기준으로 설정하고, 컨테이너 간 수집은 접근 가능한
내부 IP를 사용하며 메트릭 포트를 외부 publish하지 않습니다. Config Server의 `metrics.port=9464`가
환경 변수를 덮어쓸 수 있으므로 운영 할당은 최종 Config Server 응답에도 반영되어야 합니다.

배포 후 실제 Eureka metadata와 Prometheus `/api/v1/targets`에서 Notification target의 `health=up`,
마지막 scrape 오류, 배포 SHA/시각을 확인해야 합니다. 이는 외부 운영 후속이며 로컬 HTTP 테스트
성공을 운영 수집 완료로 간주하지 않습니다. 이 변경에서는 배포나 머지를 수행하지 않습니다.
