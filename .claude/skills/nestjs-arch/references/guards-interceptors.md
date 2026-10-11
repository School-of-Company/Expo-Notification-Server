# Guards, Interceptors & Request Lifecycle

## Execution Order

```
Middleware → Guards → Interceptors (pre) → Pipes → Controller
           → Interceptors (post, reverse order) → Exception filters
```

**Guards and interceptors run before pipes.** That means neither can see a validated, transformed DTO —
at that point the body is still the raw payload. A guard that needs the request body must work on the raw
value (e.g. HMAC signature verification reads `req.rawBody`), and must not assume any field exists.

Within each stage the order is global → controller → route (response interceptors unwind in reverse).

## Guards — What They Own

A guard answers one question: **should this request reach the handler at all?**

- **Own it**: authorization (roles, permissions, ownership), signature/secret verification, feature gates.
- **Don't own it**: parsing or issuing tokens (middleware or an auth service), attaching the user to the
  request (authentication middleware), and business rules that need loaded data (that's the service).

Returning `false` produces a 403; throw an explicit exception (`UnauthorizedException`,
`ForbiddenException`) when the reason matters to the caller.

## Guard Scope

```ts
@UseGuards(RolesGuard)          // route or controller scope
```

```ts
// global scope — use the provider form so DI works
providers: [{ provide: APP_GUARD, useClass: RolesGuard }],
```

`app.useGlobalGuards(new RolesGuard())` skips the DI container, so the guard can't inject anything. Prefer
`APP_GUARD` whenever the guard has dependencies.

## Role-Based Authorization

```ts
export const Roles = Reflector.createDecorator<string[]>();
```

```ts
@Post()
@Roles(['admin'])
create(@Body() dto: CreateStudentRequestDto) { ... }
```

```ts
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.get(Roles, context.getHandler());
    if (!roles) return true; // no metadata → not a protected route
    const { user } = context.switchToHttp().getRequest();
    return roles.some((role) => user?.roles?.includes(role));
  }
}
```

A global guard must treat "no metadata" as allow, otherwise it locks down every unannotated route.

## Interceptors — What They're For

Cross-cutting concerns that wrap the handler, not per-request decisions:

- **Logging / timing** — `tap()` around the handler.
- **Timeout** — `timeout(ms)` plus mapping to `RequestTimeoutException`.
- **Exception mapping** — `catchError()` to convert a low-level error into a domain exception.

**Not** for wrapping successful responses in an envelope. Controllers return the response DTO directly and
the HTTP status carries the outcome — the same rule as the Spring side (see the `api-design` skill), so a
client talking to both stacks has nothing to unwrap.

```ts
@Injectable()
export class TimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TimingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const { method, url } = context.switchToHttp().getRequest();
    return next
      .handle()
      .pipe(
        tap(() =>
          this.logger.log(`${method} ${url} — ${Date.now() - startedAt}ms`),
        ),
      );
  }
}
```

```ts
providers: [{ provide: APP_INTERCEPTOR, useClass: TimingInterceptor }],
```

Same DI caveat as guards: `app.useGlobalInterceptors()` can't inject, `APP_INTERCEPTOR` can.

## File Placement

- Shared across features → `src/middleware/` (or `src/common/`) as `<name>.guard.ts`,
  `<name>.interceptor.ts`, `<name>.filter.ts` — this is what large production NestJS codebases do.
- Used by exactly one feature → `<feature>/guards/<name>.guard.ts`.
