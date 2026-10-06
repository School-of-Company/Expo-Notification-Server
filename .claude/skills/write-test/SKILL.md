# Write Test

## Steps

1. **Understand** — Read the code under test. Identify inputs, outputs, and side effects (HTTP calls, DB, push gateway).
2. **Check existing patterns** — See how sibling `*.spec.ts` files set up mocks.
3. **Write cases** — Happy path → error cases (400/upstream failure where applicable) → edge cases.
4. **Isolate external deps** — Mock `global.fetch`, or mock the collaborator class directly with `jest.fn()`.
5. **Run** — `pnpm test -- src/<feature>/<file>.spec.ts`

## Unit Test Pattern (direct instantiation)

```ts
const provider = {
  send: jest.fn().mockResolvedValue({ ok: true }),
} as unknown as PushProvider;

const service = new NotificationService(provider);
```

## e2e Pattern (real AppModule + supertest)

```ts
const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
app = moduleFixture.createNestApplication();
await app.init();

const response = await request(app.getHttpServer()).get('/');
expect(response.status).toBe(200);
```

Clean up with `app?.close()` (not `app.close()`), restore env vars by deleting keys that were
`undefined` before the test (assigning `undefined` to `process.env.X` coerces to the string
`"undefined"`, not deletion), and restore any `fetch` spy.

## Notes

- Each test must be runnable independently.
- Always test the validation/error paths, not just the happy path.
