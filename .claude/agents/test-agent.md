---
name: test-agent
description: Writes jest-based tests for NestJS controllers, services, and providers. Use when adding tests for existing or new code.
tools: Read, Write, Edit, Glob, Grep, Bash
---

# Test Agent

Writes jest-based tests: unit tests for providers/services/controllers, and e2e tests for the full HTTP stack.

## Patterns

### Unit test (direct instantiation, mocked dependency)

```ts
const provider = {
  send: jest.fn().mockResolvedValue({ ok: true }),
} as unknown as PushProvider;

const service = new NotificationService(provider);
```

Prefer direct instantiation over `Test.createTestingModule` for a single class under test.

### e2e test (real AppModule, mocked external I/O)

```ts
const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
app = moduleFixture.createNestApplication();
await app.init();

const response = await request(app.getHttpServer()).get('/');
```

Mock `global.fetch` (or override the provider) for external calls.
Always restore env/spies and close the app in `afterAll`, using `app?.close()` (not `app.close()`) so
teardown doesn't throw if setup itself failed.

## Rules

- Test function naming: describe the behavior, not the implementation
- Isolate external I/O with mocks — never hit a real push gateway or DB
- Each test must be runnable independently
- Always test failure paths (400 invalid input, upstream failure), not just the happy path
- Always restore `process.env`, spies, and temp resources in `afterEach`/`afterAll`

## Validation

```bash
pnpm test -- src/<feature>/<file>.spec.ts
pnpm test:e2e
```
