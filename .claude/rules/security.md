# Notification Server Security Rules

## Strictly Forbidden

- Reading or printing `.env`, `.env.*` files
- Hardcoding Solapi keys, Discord webhook URLs, Redis passwords, or any secret in code
- Logging API keys, webhook URLs, verification codes, or unmasked phone numbers (use `maskPhone`)
- Putting upstream error strings into thrown errors (they can echo URLs/keys) — wrap with a generic message
- Reading files under a `secrets/` directory if one is ever introduced

## Environment Variable Management

Env vars are read only inside their provider (or via a validated `ConfigService`).
Controller and service layers never read `process.env` directly.

## Input Validation

- Every request body/param/query is validated at the controller boundary (DTO + `ValidationPipe`, or a whitelist regex).
- Invalid input returns 400 and never reaches a service or provider.
- A value used to build a file path, URL path, or query must be validated against a whitelist first.

## Error Messages to Clients

- Do not expose internal details (upstream addresses, raw network error strings, tokens) in an `HttpException` message.
  Send detail to server logs; respond to clients with a generalized message.

## Logging

- Never log push tokens, credentials, or upstream response bodies containing them
- Do not log full request/response bodies in production
- Use structured logging (JSON) if logging is added
