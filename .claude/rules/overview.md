---
paths:
  - "src/**"
  - "test/**"
  - "docs/**"
---

# Overview

## Project Overview

`expo-notification-server` is the notification server for the Expo (startup expo project) MSA.
It owns two things, fed by Kafka events and internal APIs of the other services:

- **sms** — sends SMS through Solapi (CoolSMS) from Kafka events: User's registration event → individual Client /qr links in one SMS (optional User name lookup, then publishes `notification.qr-sms.sent` for the representative), plus generic `notification.sms.requested` (failures past `sms.eventMaxAttempts` go to a DLQ topic), plus the HTTP phone-verification code flow (`POST /sms`, `POST /sms/verify`) with per-number and hourly global send caps
- **alarm** — hourly (KST) reads active expos from Expo's internal API and each expo's confirmed preregistration counts (total, waiting, per session) from Application's internal API, reports only expos whose counts changed since the last report to Discord, and snapshots "yesterday" confirmed counts in Redis at 00:00:30

Registers with Eureka as `expo-notification-server` when `eureka.serviceUrl` is set. Settings come from the config server (`GET /configs/notification/:profile`), falling back to env. See
`docs/events-and-config.md` for the event contract and config keys.

**Status:** sms + alarm implemented. The producing services (User/Application/Attention/Expo/Form) still need to publish the events.

**Framework:** NestJS 11
**Language:** TypeScript
**Package manager:** pnpm

## Project Structure

```
expo-notification-server/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── config/        # config-server + env loader, zod schema (APP_CONFIG token)
│   ├── logging/       # JsonLogger (pino): the standard JSON log line, see Logging
│   ├── kafka/         # shared Kafka client (KAFKA_CLIENT token), kafkajs logs routed to the Nest logger
│   ├── redis/         # shared Redis client (REDIS_CLIENT token)
│   ├── common/        # zod pipe, kafka JSON parsing, phone masking
│   ├── sms/           # controller (verify code), consumer (events), services, stores, Solapi provider
│   ├── alarm/         # scheduler, report service, internal-API count provider, Discord provider
│   └── expo-projection/ # expo.expo.changed consumer → Redis projection of expo list/sessions (flag, sync fallback)
├── test/              # e2e specs + fixtures (fake Redis, app-config fixture)
└── docs/events-and-config.md
```
