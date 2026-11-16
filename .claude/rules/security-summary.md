---
paths:
  - "src/**/*.ts"
---

# Security rules summary

> Full rules: `.claude/rules/security.md`

- Do not read or print `.env`, `.env.*` files
- Never hardcode Solapi keys, Discord webhook URLs, or credentials in code
- Never log API keys, webhook URLs, verification codes, or full phone numbers (use `maskPhone`)
- Never include tokens, keys, or upstream response bodies in error messages sent to clients
