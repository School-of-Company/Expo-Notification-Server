# Notification Server Architecture Rules

## Layer Structure

```
<feature>/
├── <feature>.controller.ts   — HTTP entry point. Input validation and error→HTTP mapping only.
├── <feature>.consumer.ts     — Kafka entry point. Parse + zod-validate, then delegate to a service.
├── <feature>.scheduler.ts    — Cron entry point. Delegates to a service.
├── <feature>.service.ts      — Orchestration / business logic.
├── <feature>.provider.ts     — External I/O to third parties (Solapi, Discord).
├── <feature>.store.ts        — Redis persistence primitives. No business decisions.
└── <feature>.module.ts       — Wiring only.
```

## Dependency Direction

```
controller | consumer | scheduler → service → provider | store
```

Reverse dependencies are forbidden (e.g., a provider knowing about a service, or a service knowing about the controller).

## File Responsibilities

- `*.controller.ts`: route definitions, DTO/param validation, error-type→HTTP-status mapping only. No business logic or direct I/O.
- `*.service.ts`: provider call order and business logic. No direct fetch/DB/file access.
- `*.provider.ts`: external I/O only. No business logic.
- Pure helpers: no I/O, no NestJS decorators.

## Error Contract

- Domain/provider errors are typed error classes, mapped to HTTP status in the controller (or an exception filter).
- Any unmapped error propagates unchanged (never swallowed).

## Abstraction Principle

- Do not introduce abstractions before a second real use case exists.
- Move shared utilities out only when used in three or more places.

## Async

- All I/O is `async`/`await`. Use async/await consistently instead of promise chaining.
- External HTTP calls use Node's global `fetch` unless a dependency is explicitly approved.

## Environment Validation

- Config is loaded once by `src/config/load-config.ts` (config server over env, validated with zod) and injected via the `APP_CONFIG` token — services never read `process.env`. `process.env` is touched only in that loader.
- Use CJS-compatible majors under ts-jest/CommonJS: `@nestjs/schedule@6.x` (`12.x` is pure ESM) and `@nestjs/config@4.x` if ever added.
- Validate required env vars at boot so the app fails fast instead of failing on the first request.
- In tests, override the `APP_CONFIG` provider with `createAppConfig()` (`test/fixtures/app-config.fixture.ts`).

## Kafka Consumers

- A malformed or schema-invalid message is logged and skipped (never thrown) — throwing makes Kafka redeliver forever.
- A downstream failure (Solapi down) is thrown so Kafka redelivers; protect against duplicates with an `eventId` claim that is released on failure.
- Producers must send `eventId` + `version`; see `docs/events-and-config.md`.
