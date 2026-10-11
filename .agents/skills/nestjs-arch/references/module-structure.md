# Module Structure & Dependency Injection

## Directory Layout

One directory per feature, named after the feature (not after the layer):

```
src/
├── common/                      # cross-cutting helpers (retry, fetch wrappers, type guards)
├── redis/                       # infrastructure module
│   ├── redis.module.ts
│   ├── redis.constants.ts       # injection tokens
│   ├── idempotency.store.ts
│   └── job-state.type.ts
└── webhook/                     # feature module
    ├── webhook.module.ts
    ├── webhook.controller.ts
    ├── webhook.service.ts
    ├── dto/
    │   └── github-webhook.request.dto.ts
    └── guards/
        └── webhook-signature.guard.ts
```

## Interface Tokens

Declare the token next to the interface (or in `*.constants.ts` for third-party clients):

```ts
// installation-token-manager.interface.ts
export const INSTALLATION_TOKEN_MANAGER = "INSTALLATION_TOKEN_MANAGER";

export interface InstallationTokenManager {
  getOctokit(installationId: number): Promise<Octokit>;
}
```

```ts
// consumer side
constructor(
  @Inject(INSTALLATION_TOKEN_MANAGER)
  private readonly tokenManager: InstallationTokenManager,
) {}
```

```ts
// module side
providers: [
  { provide: INSTALLATION_TOKEN_MANAGER, useClass: InstallationTokenManagerService },
],
exports: [INSTALLATION_TOKEN_MANAGER],
```

Call sites stay unchanged when the implementation is swapped (mock, different caching strategy).

## Placeholder Providers

When an implementation doesn't exist yet, register a provider that throws, so wiring fails loudly instead
of silently injecting `undefined`:

```ts
{
  provide: REVIEW_ORCHESTRATOR,
  useFactory: () => {
    throw new Error('ReviewOrchestrator is not implemented. Provide a concrete class.');
  },
}
```

## `@Global()`

Only for infrastructure every feature needs — Redis, Kafka, GitHub App auth. Registering it once in
`app.module.ts` lets other modules inject the token without repeating `imports:`. Feature modules are
always imported explicitly so the dependency graph stays readable.

## Store Pattern

Wrap external storage in a small `*.store.ts` class per concern:

```ts
const TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class IdempotencyStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async markProcessed(jobId: string): Promise<void> {
    await this.redis.set(this.key(jobId), "1", "EX", TTL_SECONDS);
  }

  private key(jobId: string): string {
    return `review:idempotency:${jobId}`;
  }
}
```
