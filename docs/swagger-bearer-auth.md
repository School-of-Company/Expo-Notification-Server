# Gateway Swagger 인증 정책 (#35)

2026-10-12에 GitHub의 최신 `develop`을 조회하여 확인하였습니다.

- [Config `gateway-dev.yml`](https://github.com/School-of-Company/Expo-Config-Server/blob/70913618a6ee526d97578a6b91f6c35d0007593c/configs/gateway-dev.yml)
- [Gateway 공개 경로 매칭](https://github.com/School-of-Company/Expo-Gateway/blob/b3aec9a37ca77ae4fb260517b70a10e78ab6a6fd/src/auth/public-path.matcher.ts)
- [Gateway JWT guard](https://github.com/School-of-Company/Expo-Gateway/blob/b3aec9a37ca77ae4fb260517b70a10e78ab6a6fd/src/auth/jwt-auth.guard.ts)
- [Gateway internal 차단](https://github.com/School-of-Company/Expo-Gateway/blob/b3aec9a37ca77ae4fb260517b70a10e78ab6a6fd/src/proxy/blocked-paths.ts)

메서드를 지정한 공개 규칙은 해당 메서드와 정확한 경로만 매칭합니다(끝의 `/`는 무시). 아래는 Notification의 현재 controller와 대조한 결과이며, 런타임에 별도의 공개 경로 목록을 추가하지 않았습니다.

| Operation | 실제 공개 규칙 | OpenAPI security |
|---|---|---|
| `POST /sms` | `POST /sms` | 없음 |
| `POST /sms/verify` | `POST /sms/verify` | 없음 |
| `GET /sms` | `GET /sms` | 없음 |
| `GET /` | 없음 | `bearerAuth` |
| `/internal/**` | Gateway에서 차단 | 기본 문서 제외, 포함 시 `internalToken` |

`GET /`는 공개 규칙 밖에 있으므로 bearer requirement를 선언하였습니다. 현재 Gateway routing에는 `/sms`만 Notification으로 연결되며 `/`는 Notification으로 연결되지 않습니다. 이 선언이 Gateway의 루트 경로 routing을 추가하지는 않습니다.

`components.securitySchemes.bearerAuth`는 HTTP bearer / JWT입니다. 전역 security를 지정하지 않고 보호 operation에만 선언하였습니다. 서비스 JWT 검증은 추가하지 않았으며, `SWAGGER_ENABLED` 기본값은 `false`입니다. 내부 문서를 포함할 때 기존 `X-Internal-Token` 스키마와 requirement를 유지합니다.

구현은 [NestJS 공식 문서](https://docs.nestjs.com/openapi/security)와 [Swagger bearer 인증 문서](https://swagger.io/docs/specification/v3_0/authentication/bearer-authentication/)의 스키마/operation 선언 방식을 따릅니다.

## 검증 범위와 남은 dev 확인

- `src/swagger.spec.ts`: 보호 상태 확인과 공개 SMS operation의 security를 단위 검증합니다.
- `test/swagger.e2e-spec.ts`: 실제 Nest HTTP 스택의 JSON/UI, bearer 스키마, 보호/공개 operation, internal 제외/포함, 비활성 옵션을 검증합니다. 외부 Kafka·Redis·Solapi는 합성 대역이며 유료 발송을 하지 않습니다.
- `src/config/swagger-config.spec.ts`: Swagger 기본 비활성 설정을 검증합니다.

실행 결과: `pnpm test --runInBand` 37 suites / 245 tests 통과, `pnpm test:e2e --runInBand` 3 suites / 34 tests 통과. `pnpm lint:ci`, `pnpm exec tsc -p tsconfig.build.json --noEmit`, `pnpm build`, `git diff --check`도 통과하였습니다. 전체 e2e 실행 중 `MaxListenersExceededWarning`이 출력되었으나 테스트 실패는 없었습니다.

로컬 실행 환경 조회에서 Gateway·Config의 Node listener와 Docker 컨테이너가 없었습니다(Docker에는 Report PostgreSQL만 실행 중). Config Server의 `env.validation.ts`는 `VAULT_ADDR`와 `VAULT_TOKEN`을 필수로 요구하고, `ConfigMergeService`는 설정 조회 시 Vault도 조회합니다. 로컬 Vault도 실행 중이지 않았습니다. 실제 인증값을 읽지 않고 실행할 준비된 Gateway+Config 환경을 확인하지 못하여 실제 Gateway `/docs`의 Notification 선택·Authorize·Try it out은 미확인입니다. 합성 e2e 결과는 실제 dev 배포 검증을 뜻하지 않습니다.

위 Config revision의 `docs.services`에는 참여·폼·유저만 있고 Notification과 `GET /sms/v3/api-docs` 공개 항목은 없습니다. 실제 dev 확인에는 Gateway/Config 담당자가 Notification 문서 연결을 준비하고, Notification의 dev Swagger를 활성화한 뒤 통합 화면을 확인해야 합니다. 타 저장소와 운영 환경은 수정하지 않았습니다. dev 종료 조건이 남으므로 PR은 `Related #35`로 연결합니다.
