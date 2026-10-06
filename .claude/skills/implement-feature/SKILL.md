# Implement Feature

## Steps

1. **Understand** — Read related existing files. Check the same layer's controller, service, and provider.
2. **Plan** — List which files to create or modify.
3. **Provider first (if new I/O is needed)** — external I/O goes in a `*.provider.ts`, nothing else.
4. **Implement service** — Business logic / orchestration. Delegate I/O to provider(s).
5. **Wire controller** — Add endpoint, validate input, map known error types to HTTP status.
6. **Write tests** — Add jest cases for new behavior, including failure paths.
7. **Validate** — `pnpm test && pnpm test:e2e && pnpm exec tsc -p tsconfig.build.json --noEmit`
8. **Report** — Changed files, validation result, remaining risks.

## Notes

- Follow existing patterns. Explain if introducing a new pattern.
- Access `process.env` only inside providers (or a validated `ConfigService`).
- Isolate external I/O with mocks in tests.
- Do not introduce a shared abstraction before a second real need exists.
