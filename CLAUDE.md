# Expo Notification Server — Claude Code Operating Guide

## Project Overview

`expo-notification-server` is the notification server for the Expo (startup expo project) MSA.
It owns two things, fed by Kafka events and internal APIs of the other services:

- **sms** — sends SMS through Solapi (CoolSMS) from Kafka events: User's registration event → individual Client /qr links in one SMS (optional User name lookup, then publishes `notification.qr-sms.sent` for the representative), plus generic `notification.sms.requested` (failures past `sms.eventMaxAttempts` go to a DLQ topic), plus the HTTP phone-verification code flow (`POST /sms`, `POST /sms/verify`) with per-number and hourly global send caps
- **alarm** — hourly (KST) reads active expos from Expo's internal API and each expo's confirmed preregistration counts (total, waiting, per session) from Application's internal API, reports only expos whose counts changed since the last report to Discord, and snapshots "yesterday" confirmed counts in Redis at 00:00:30

Registers with Eureka as `expo-notification-server` when `eureka.serviceUrl` is set. Settings come from the config server (`GET /configs/notification/:profile`), falling back to env. See
`docs/events-and-config.md` for the event contract and config keys.

**Status:** sms + alarm implemented. The producing services (User/Application/Attention/Expo/Form) still need to publish the events.

**Framework:** NestJS 11
**Language:** TypeScript
**Package manager:** pnpm

> **Response language:** Always respond in Korean.

---

## Validation Commands

```bash
# Required
pnpm test                # Unit tests (jest)
pnpm test:e2e            # e2e tests (real HTTP stack)

# Recommended
pnpm exec tsc -p tsconfig.build.json --noEmit   # Type check
pnpm lint                # eslint

# Run
pnpm start:dev
```

---

## Project Structure

```
expo-notification-server/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── config/        # config-server + env loader, zod schema (APP_CONFIG token)
│   ├── logging/       # JsonLogger (pino): the standard JSON log line, see Logging
│   ├── kafka/         # shared Kafka client (KAFKA_CLIENT token), kafkajs logs routed to the Nest logger
│   ├── redis/         # shared Redis client (REDIS_CLIENT token)
│   ├── common/        # zod pipe, kafka JSON parsing, phone masking
│   ├── sms/           # controller (verify code), consumer (events), services, stores, Solapi provider
│   ├── alarm/         # scheduler, report service, internal-API count provider, Discord provider
│   └── expo-projection/ # expo.expo.changed consumer → Redis projection of expo list/sessions (flag, sync fallback)
├── test/              # e2e specs + fixtures (fake Redis, app-config fixture)
└── docs/events-and-config.md
```

---

## Agent Routing

| Task                  | Agent            |
| --------------------- | ---------------- |
| Add new feature       | `feature-agent`  |
| Fix a bug             | `fix-agent`      |
| Write tests           | `test-agent`     |
| Code review           | `review-agent`   |
| Write PR description  | `pr-agent`       |
| Apply review feedback | `feedback-agent` |

---

## Feature Development Flow

1. `git status` — check current state
2. Create branch off `develop`: `git checkout -b feat/<scope> origin/develop` (or use `new-branch`)
3. Implement with `feature-agent`
4. Verify with `pnpm test` and `pnpm test:e2e`
5. Verify with `pnpm exec tsc -p tsconfig.build.json --noEmit`
6. Review diff with `review-agent`
7. Draft PR into `develop` with `pr-agent`

## Bug Fix Flow

1. Reproduce the bug
2. `git checkout -b fix/<scope> origin/develop`
3. Apply minimal fix with `fix-agent`
4. Add regression test
5. Verify with `pnpm test`

## Test Writing Flow

- Write jest-based tests with `test-agent`
- Unit test: mock the collaborator with `jest.fn()`, direct instantiation (no DI container needed for a single class)
- e2e test: boot the real `AppModule` via `@nestjs/testing` + `supertest`, mock external I/O (push gateway, `global.fetch`)
- Isolate side effects: always restore `process.env`, spies, and temp resources in `afterAll`/`afterEach`

---

## Branching Model

- `develop` is the integration branch. All `feat/`/`fix/`/`chore/`/`refactor/`/`test/`/`docs/`
  branches fork from `origin/develop` and PR back into `develop`.
- `main` is the stable/release branch. It only moves via a separate, manual `develop` → `main` release PR.

## Git Rules

- No direct commits to `main` or `develop`
- Do not commit or push without explicit request
- Always run `git status` before starting work
- Branch naming: `feat/<scope>`, `fix/<scope>`, `chore/<scope>`
- Do not add a `Co-Authored-By: Claude` (or similar AI attribution) trailer to commits or PRs in this repo — commits are authored by the person running Claude Code, full stop

## Coding Standards

- Keep I/O-free logic as pure functions
- External I/O (HTTP calls to a push gateway, DB, file reads) belongs only in provider classes, never directly in a service or controller
- Read env vars only inside their provider (or through a validated `ConfigService`) — never `process.env` directly in a controller or service
- Validate every external input (request body, route/query params, Kafka message payload) at the entry point with zod
- Strict TypeScript typing — no `any`; narrow parsed results explicitly
- Comments only when the WHY is non-obvious

## Logging

The Expo log standard, shared by every service (Spring and Nest) so the shared Loki in Expo-Monitoring labels them the same way:

- Every line on stdout is one JSON object with at least `@timestamp` (ISO-8601), `level` (uppercase
  `TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR`; Nest `fatal` is written as `ERROR`, `verbose` as `TRACE`),
  `service` (`expo-notification-server`, the Eureka app name), `module` and `message`. Errors add
  `stack_trace`. Nothing else goes to stdout — never `console.log` in the service (the `ops/` CLI is not
  the service).
- The log pipeline reads only these key names and has no per-service fallback. If this server's logs
  are missing or mis-labelled, fix the log output here, never add parsing fallbacks to the pipeline.
- `src/logging/json-logger.ts` (`JsonLogger`, pino) is installed with `Logger.overrideLogger()` at the
  top of `main.ts`, so config loading and fail-fast exits are JSON too. `module` is the Nest logger
  context (`new Logger(Foo.name)`), the same mapping as nestjs-pino's `renameContext: 'module'`; lines
  without a context get `app`. Never pass `module` at the call site. kafkajs logs go through
  `kafkaLogCreator` with `module` `kafkajs`.
- `LOG_LEVEL` (default `info`). Only when `CONFIG_PROFILE` (else `NODE_ENV`) is explicitly `local` is
  stdout also mirrored to `${EXPO_LOG_DIR:-~/.expo/logs}/expo-notification-server/app.log` for the local
  Loki file tail. Unlike the config fetch, an unset profile is not local. Elsewhere stdout only (pm2
  captures it); add no log file settings there.

## Security Rules Summary

> Full rules: `.claude/rules/security.md`

- Do not read or print `.env`, `.env.*` files
- Never hardcode Solapi keys, Discord webhook URLs, or credentials in code
- Never log API keys, webhook URLs, verification codes, or full phone numbers (use `maskPhone`)
- Never include tokens, keys, or upstream response bodies in error messages sent to clients

## Architecture Rules Summary

> Full rules: `.claude/rules/architecture.md`

- Dependency direction: `controller → service → provider`. Reverse dependencies forbidden.
- `*.controller.ts` / `*.consumer.ts` / `*.scheduler.ts`: entry points — validation and delegation only. No business logic.
- `*.service.ts`: orchestration/business logic. No direct I/O.
- `*.provider.ts` / `*.store.ts`: external I/O only (Solapi, Discord, Redis). No business logic.
- Do not introduce a shared abstraction before a second real use case needs it.
