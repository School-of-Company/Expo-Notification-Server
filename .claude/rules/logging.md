---
paths:
  - "src/logging/**"
  - "src/kafka/**"
  - "src/main.ts"
---

# Logging

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
