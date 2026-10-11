---
name: nestjs-arch
description: Architecture reference for NestJS (TypeScript) projects — module structure and file naming, interface-token dependency injection, @nestjs/config for settings, DTO classes for every controller and service argument, ValidationPipe for request shape, store pattern, logging, thin controllers, consumer error handling, and constructor-injected unit tests. Use when creating or modifying NestJS modules, services, controllers, DTOs, providers, or their tests.
---

# NestJS Architecture

## Applies To

NestJS (TypeScript). **Check before using any of it** — items are picked by hand on a dashboard, and
Spring-side architecture skills have landed in Node repos and vice versa:

```bash
ls package.json build.gradle.kts pom.xml 2>/dev/null
grep -l '@nestjs/core' package.json 2>/dev/null
```

If the project is Spring instead, use `kotlin-spring-arch` or `java-spring-arch`. When it's a Node
project without NestJS, say so rather than applying the module/provider patterns below — they are
NestJS's DI container, not general TypeScript advice.

## Rules

- **Structure** — one directory per feature; `<name>.service.ts` / `.module.ts` / `.controller.ts` /
  `.store.ts` / `.constants.ts` / `.interface.ts` / `.type.ts` / `.guard.ts` / `.spec.ts`, plus `dto/`.
- **Injection** — inject a token + interface, never the concrete class. `@Global()` is only for
  infrastructure modules (Redis, Kafka, auth); feature modules are imported explicitly.
- **Config** — `@nestjs/config` with `ConfigModule.forRoot({ isGlobal: true })`; read values through
  `ConfigService.getOrThrow()`. Never read `process.env` from a service.
- **DTOs** — every argument crossing a controller or service boundary is a DTO **class** (not an
  interface, not loose positional params); responses are DTOs too.
- **Validation** — request shape via the global `ValidationPipe`; business rules throw from the service.
- **Controllers** — bind and delegate, nothing else. Do **not** `import type` a DTO: it's a class and
  `ValidationPipe` needs its runtime metadata.
- **Guards** — decide only whether the request may reach the handler (authorization, signature checks).
  Guards run _before_ pipes, so they never see a validated DTO — work on the raw request.
- **Interceptors** — cross-cutting wrapping only: logging/timing, timeout, exception mapping. Never a
  response envelope — controllers return the response DTO as-is, same as the Spring side.
- **Global guards/interceptors** — register via `APP_GUARD` / `APP_INTERCEPTOR` providers, not
  `useGlobalGuards()` / `useGlobalInterceptors()`, so DI still works.
- **Stores** — wrap external storage per concern; key building in a `private key()`, TTL as a
  module-level `const`.
- **Logging** — `private readonly logger = new Logger(ClassName.name)`; Korean messages; pass the error
  as the second argument (`logger.error('...', err)`), never interpolated.
- **Consumers** — don't catch processing failures; let them throw so the offset isn't committed. Log
  crashes, never `process.exit()`.
- **Tests** — instantiate the service directly with object-literal mocks; cover decision branches, not
  every method.

## Reference

| Topic                                            | Reference                           | Load when                              |
| ------------------------------------------------ | ----------------------------------- | -------------------------------------- |
| Directory layout, naming, DI tokens, `@Global()` | `.agents/skills/nestjs-arch/references/module-structure.md`    | Creating a module or provider          |
| DTO classes, `ValidationPipe`, `@nestjs/config`  | `.agents/skills/nestjs-arch/references/dto-validation.md`      | Adding an endpoint or config value     |
| Guards, interceptors, lifecycle order            | `.agents/skills/nestjs-arch/references/guards-interceptors.md` | Adding authorization, logging, timeout |
| Test style, mocking                              | `.agents/skills/nestjs-arch/references/testing.md`             | Writing or fixing tests                |
