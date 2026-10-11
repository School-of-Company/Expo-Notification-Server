# DTOs, Validation & Config

## Every Boundary Argument Is a DTO

```ts
// dto/create-pr.request.dto.ts
export class CreatePrRequestDto {
  @IsString() owner: string;
  @IsString() repo: string;
  @IsInt() installationId: number;
  @IsString() baseBranch: string;
  @IsString({ each: true }) itemIds: string[];
}
```

```ts
// controller — binds and delegates, nothing else
@Post()
create(@Body() dto: CreatePrRequestDto): Promise<CreatePrResponseDto> {
  return this.prService.createPr(dto);
}

// service — takes the same DTO, not (owner, repo, installationId, baseBranch, itemIds)
async createPr(dto: CreatePrRequestDto): Promise<CreatePrResponseDto> { ... }
```

Why: adding a field doesn't ripple through every signature, argument order can't be mixed up, and the
validation rules live next to the shape they describe.

**DTOs must be classes.** `class-validator` decorators and `ValidationPipe` both need a runtime type, so
an interface can't be a DTO — and a DTO must never be imported with `import type`, which erases exactly
that runtime type. Interfaces remain the right choice for internal domain types that never cross a
boundary.

## Two Validation Layers

Don't conflate them:

- **Shape** (field presence, types, formats) — the global `ValidationPipe`:
  ```ts
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  ```
  `whitelist` strips unknown properties; `transform` turns the plain body into the DTO class instance.
- **Business rules** (does this repo exist, is this id real, is this state allowed) — plain code in the
  service. Throw; no fallback, no partial success, no silent skip.

## Config

```ts
// app.module.ts
imports: [ConfigModule.forRoot({ isGlobal: true })],
```

```ts
constructor(private readonly config: ConfigService) {}

// getOrThrow fails fast at the first read when the value is missing
const appId = this.config.getOrThrow<string>('GITHUB_APP_ID');
const port = this.config.get<number>('PORT', 3000);
```

Never read `process.env` from a service — it hides what a module actually requires and can't be
substituted in tests. Keep tunable constants (TTLs, timeouts, retry counts) as module-level `const`s, not
env vars, unless they genuinely differ per environment.
