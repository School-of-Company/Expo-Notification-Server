<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## CI

PRs targeting `develop` or `main` run `pr-title`, `lint`, and `verify` on
opened, edited, synchronize, and reopened events. Titles may use the existing
plain-language convention without a `[scope]` prefix, with at most 50 characters
and no emojis. Blank titles and control characters are also rejected.

CI uses Node.js 22.23.3 and pnpm 11.10.0 (pinned in `package.json`), with a pnpm
cache and frozen lockfile installation. Only `@swc/core` dependency builds are
approved in `pnpm-workspace.yaml`; the approval policy is not disabled.

```bash
pnpm install --frozen-lockfile
pnpm run lint:ci
pnpm exec tsc --noEmit --incremental false
pnpm test --runInBand
pnpm test:e2e --runInBand
pnpm run build
```

`lint:ci` checks without modifying files; `lint` retains its local auto-fix behavior.
Unit tests and HTTP e2e use mocked Kafka, Redis, Solapi, and external HTTP providers.
No production credentials or running services are needed. The local Kafka/Redis
Compose stack is not started by CI; real-service integration checks remain separate.
CI does not deploy or send Discord notifications, so no webhook secret is required.

The reference is Expo-Form-Server's `.github/workflows/ci.yml`, retrieved via
`gh api repos/School-of-Company/Expo-Form-Server/contents/.github/workflows/ci.yml`:
blob SHA `4468cd04b5aba0cb7146165287e5240e22dbb63f`.

## Swagger API 문서

문서는 기본 비활성화입니다. 선택 환경 변수는 없어도 부팅됩니다.

| 환경 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `SWAGGER_ENABLED` | `false` | `true`일 때 문서 경로를 등록합니다. |
| `SWAGGER_INCLUDE_INTERNAL` | `false` | `true`일 때 `/internal/**` API도 문서에 포함합니다. |

설정 서버에서는 `swagger.enabled`, `swagger.includeInternal`로 지정하며,
기존 로더와 동일하게 설정 서버 값이 환경 변수보다 우선합니다.

- OpenAPI JSON: `GET /sms/v3/api-docs`
- Swagger UI: `GET /sms/docs`
- 비활성화 시 JSON과 UI 모두 `404`입니다. 내부 포함 옵션만 켜도 문서는 열리지 않습니다.
- 내부 API 포함 시 `X-Internal-Token` 헤더를 `internalToken` API key 인증 스키마로 표시합니다.
  문서 옵션은 실제 내부 API 인증이나 활성화 설정을 변경하지 않습니다.
- 설명은 한국어이며 전화번호, 인증번호, 메시지 ID는 합성 예시입니다. 토큰 값은 문서에 넣지 않습니다.
- 게이트웨이 개발 프로필의 `docs.services`와 `GET /sms/v3/api-docs` 공개 경로 등록은
  설정 서버 담당자가 별도 PR로 진행합니다. 운영 공개는 기본 설정에 포함되지 않습니다.

구현 참고: [NestJS Swagger 설정](https://docs.nestjs.com/openapi/introduction),
[DTO 문서](https://docs.nestjs.com/openapi/types-and-parameters),
[인증 스키마](https://docs.nestjs.com/openapi/security).

## Run tests locally

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
