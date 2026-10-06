# Notification Server Architecture Rules

## Layer Structure

```
<feature>/
├── <feature>.controller.ts   — Entry point. Input validation and error→HTTP mapping only.
├── <feature>.service.ts      — Orchestration / business logic.
├── <feature>.provider.ts     — External I/O (push gateway, HTTP, DB).
└── <feature>.module.ts       — Wiring only.
```

## Dependency Direction

```
controller → service → provider
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

- If `@nestjs/config` is added, use `4.x`, not `12.x` — `12.x` ships as pure ESM and breaks ts-jest/CommonJS.
- Validate required env vars at boot so the app fails fast instead of failing on the first request.
- **Gotcha:** `ConfigService` snapshots validated env at `AppModule` import time — set required env in
  `test/jest-e2e.setup.ts` (Jest `setupFiles`), not in a spec file's `beforeAll`.
