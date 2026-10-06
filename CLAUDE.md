# Expo Notification Server — Claude Code Operating Guide

## Project Overview

`expo-notification-server` is the notification server for the Expo (startup expo project) MSA.
**Status:** NestJS scaffold only — no domain code yet. Update this section as features land.

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
│   └── <feature>/              # one folder per feature
│       ├── *.controller.ts
│       ├── *.service.ts
│       ├── *.provider.ts       # external I/O only (push gateway, DB, HTTP)
│       └── *.module.ts
└── test/
    └── *.e2e-spec.ts
```

---

## Agent Routing

| Task | Agent |
|------|-------|
| Add new feature | `feature-agent` |
| Fix a bug | `fix-agent` |
| Write tests | `test-agent` |
| Code review | `review-agent` |
| Write PR description | `pr-agent` |
| Apply review feedback | `feedback-agent` |

---

## Feature Development Flow

1. `git status` — check current state
2. Create branch off `main`: `git checkout -b feat/<scope> origin/main` (or use `new-branch`)
3. Implement with `feature-agent`
4. Verify with `pnpm test` and `pnpm test:e2e`
5. Verify with `pnpm exec tsc -p tsconfig.build.json --noEmit`
6. Review diff with `review-agent`
7. Draft PR into `main` with `pr-agent`

## Bug Fix Flow

1. Reproduce the bug
2. `git checkout -b fix/<scope> origin/main`
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

- `main` is the only long-lived branch. All `feat/`/`fix/`/`chore/`/`refactor/`/`test/`/`docs/`
  branches fork from `origin/main` and PR back into `main`.
- If a `develop` integration branch is introduced later, update `.claude/` (skills, agents) and this section together.

## Git Rules

- No direct commits to `main`
- Do not commit or push without explicit request
- Always run `git status` before starting work
- Branch naming: `feat/<scope>`, `fix/<scope>`, `chore/<scope>`
- Do not add a `Co-Authored-By: Claude` (or similar AI attribution) trailer to commits or PRs in this repo — commits are authored by the person running Claude Code, full stop

## Coding Standards

- Keep I/O-free logic as pure functions
- External I/O (HTTP calls to a push gateway, DB, file reads) belongs only in provider classes, never directly in a service or controller
- Read env vars only inside their provider (or through a validated `ConfigService`) — never `process.env` directly in a controller or service
- Validate every external input (request body, route/query params) at the controller boundary
- Strict TypeScript typing — no `any`; narrow parsed results explicitly
- Comments only when the WHY is non-obvious

## Security Rules Summary

> Full rules: `.claude/rules/security.md`

- Do not read or print `.env`, `.env.*` files
- Never hardcode push tokens, API keys, or credentials in code
- Never log device push tokens, API keys, or full notification payloads
- Never include tokens, keys, or upstream response bodies in error messages sent to clients

## Architecture Rules Summary

> Full rules: `.claude/rules/architecture.md`

- Dependency direction: `controller → service → provider`. Reverse dependencies forbidden.
- `*.controller.ts`: route definitions, input validation only. No business logic.
- `*.service.ts`: orchestration/business logic. No direct I/O.
- `*.provider.ts`: external I/O only. No business logic.
- Do not introduce a shared abstraction before a second real use case needs it.
