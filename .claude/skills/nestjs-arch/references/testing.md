# Unit Test Style

## Instantiate Directly, Don't Build a TestingModule

For a plain service, `new` it with object-literal mocks — faster to read and write than wiring a module:

```ts
describe("ReviewDispatcherService", () => {
  let idempotencyStore: { exists: jest.Mock; markProcessed: jest.Mock };
  let kafkaProducer: { send: jest.Mock };
  let service: ReviewDispatcherService;

  beforeEach(() => {
    idempotencyStore = { exists: jest.fn(), markProcessed: jest.fn() };
    kafkaProducer = { send: jest.fn() };

    service = new ReviewDispatcherService(
      idempotencyStore as unknown as IdempotencyStore,
      kafkaProducer as unknown as KafkaProducerService,
    );
  });
});
```

Use `Test.createTestingModule()` only when the wiring itself is what's under test — module resolution,
guards, interceptors, or an end-to-end request path.

## What to Cover

Test the **branches that carry a decision**, not every method:

- duplicate detection hit vs. miss
- completed / failed routing
- publish or write failure propagating instead of being swallowed

Skip trivial delegation (a method that only forwards to one collaborator) — the test would just restate
the implementation.

## Mocks

Mock every external client; a unit test must never open a real Redis, Kafka, or HTTP connection. Fixtures
(payloads, contexts) go at the top of the `describe` block as plain `const`s so each test reads as
"given this payload, expect this branch".
