# Review Local Diff

## Steps

1. `git diff` — see current changes.
2. `git diff --name-only` — list changed files.
3. Read each file — understand the context before and after.
4. Review against criteria below.
5. Report findings.

## Review Criteria

**Bugs (must check)**
- Missing `await` on async calls
- Unhandled `fetch`/`response.json()` failure
- Missing exception handling
- Incorrect HTTP status codes

**Security**
- Request input reaching a provider, URL, or path without validation
- Hardcoded secrets
- Push tokens, credentials, or full notification payloads in logs or client-facing error messages

**Layering**
- Controller → service → provider only; no `process.env` or direct I/O in controllers/services

**Missing tests**
- New endpoint without tests
- Failure cases not tested

**Performance**
- Blocking I/O inside async context
- Repeated upstream calls inside a loop

## Output Format

```
[HIGH] file.ts:line — description
[MED]  file.ts:line — description
[LOW]  file.ts:line — description
Missing tests: yes/no
```

Style issues are handled by eslint. Do not duplicate.
