---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---

# Coding standards

- Keep I/O-free logic as pure functions
- External I/O (HTTP calls to a push gateway, DB, file reads) belongs only in provider classes, never directly in a service or controller
- Read env vars only inside their provider (or through a validated `ConfigService`) — never `process.env` directly in a controller or service
- Validate every external input (request body, route/query params, Kafka message payload) at the entry point with zod
- Strict TypeScript typing — no `any`; narrow parsed results explicitly
- Comments only when the WHY is non-obvious
