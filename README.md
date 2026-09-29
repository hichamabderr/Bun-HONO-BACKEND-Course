# Modern Production Backend Engineering Course: Bun + TypeScript + Hono / Elysia (September 2026 Edition)

> **Objective**: *"I can design, build, secure, test, debug, optimize, deploy, and scale a production backend using Bun."*

```text
CORE BACKEND ENGINEERING
        │
        ├── Bun (v1.4.2 Runtime, JSC, Bun.serve, Bun.sql, Bun.redis, Bun.s3, Bun.password, bun:test)
        ├── HTTP & Web Standards (Request, Response, Headers, Streams, AbortController, ETag, CORS)
        ├── PostgreSQL 17/18 & Drizzle ORM (v0.45.2, ACID Transactions, Row Locking, Cursor Pagination)
        ├── Redis (Cache-Aside, Stampede Protection, Lua Rate Limiting, Pub/Sub)
        ├── Auth & Multi-Tenant RBAC (Argon2id, __Host- Cookies, JWT Rotation, Server-Boundary AuthZ)
        ├── Security (OWASP Top 10, CSRF, SSRF Guard, Magic-Byte File Verification, HMAC Webhooks)
        ├── Queues & Workers (BullMQ v5.77+ with createBunRedisClient, Retries, Circuit Breakers)
        ├── Testing & Observability (bun:test Pyramid, Pino Redacted JSON Logs, OpenTelemetry)
        └── Deployment (Multi-Stage Non-Root Docker, Graceful SIGTERM Drain, CI/CD, DR)
                 │
                 ▼
       ┌───────────────────┐
       │ Framework Adapter │
       └─────────┬─────────┘
                 │
          ┌──────┴───────┐
          ▼              ▼
    Hono (v4.13.10)  Elysia (v1.4.30)
```

---

## Verified Technology Stack (September 2026)

| Component | Verified Stable Version | Notes & Official Status |
| :--- | :--- | :--- |
| **Bun** | **`v1.4.2`** (Sep 5, 2026) | Native TypeScript execution, `Bun.serve` HTTP/1.1 + HTTP/2 + WS, `Bun.sql`, `Bun.redis`, `Bun.s3`, `Bun.password` (`argon2id`), text `bun.lock`, `bun:test`. |
| **TypeScript** | **`v6.0.x` / `v7.0`** | Strict static type checking (`tsc --noEmit`). |
| **Hono (Track A — Primary)** | **`v4.13.10`** (Sep 2026) | Web-Standards router & onion middleware kernel, `@hono/zod-openapi` (`v1.5.x`), `hc` RPC client. |
| **Elysia (Track B — Adapter)** | **`v1.4.30`** (Aug 26, 2026) | Stable `1.4` line with Standard Schema support, `@elysiajs/openapi` (`fromTypes()`), Eden Treaty 2 (`v2.0` "DayDream" is currently in Beta). |
| **Validation** | **Zod `v4.x`** (`zod@^4.0.0`) | Implements **Standard Schema v1**; works natively in both Hono and Elysia `1.4.30`. |
| **Database & ORM** | **PostgreSQL `17/18`** + **Drizzle ORM `v0.45.2`** | SQL-first query builder & migrations (`drizzle-orm@1.0` is in beta; Prisma `v7.10` is stable with `v8` in RC). |
| **Cache & Queues** | **Redis `7.4 / 8`** + **BullMQ `v5.77.0+`** | BullMQ `v5.77.0+` (May 2026) natively supports Bun's built-in `RedisClient` via `createBunRedisClient`. |

---

## Complete Course Curriculum & Repository Map

### Part I — Foundation, Runtime & Web Standards
- [**`course/00-course-foundation-and-mindset.md`**](./course/00-course-foundation-and-mindset.md)
  - Sections 1–25: Course Philosophy, Backend Engineering Mindset, Current Bun/Hono/Elysia Status, Decision Matrix, Core Mental Models, 31-Phase Roadmap, Capstone & Deployment Architecture.
- [**`course/01-bun-runtime-and-architecture.md`**](./course/01-bun-runtime-and-architecture.md)
  - Module 1 (Phase 1): Bun Runtime from First Principles, JavaScriptCore vs V8, Zig/Rust Bindings, Web Standard vs Bun-Specific vs `node:*` APIs, Node Compatibility Matrix, `bun install` (`bun.lock`, isolated linker, catalogs), `bun:test`, and `Bun.build`.
- [**`course/02-bun-serve-web-standards-and-http.md`**](./course/02-bun-serve-web-standards-and-http.md)
  - Module 2 (Phases 2–3): Raw `Bun.serve()` (declarative `routes`, HTTP/2, cookies, streaming, WebSockets), Web Standards (`Request`, `Response`, `Headers`, `ReadableStream`, `AbortController`), Deep HTTP (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`OPTIONS`/`HEAD`, status codes, `ETag` conditional requests, CORS preflight), and the 14-Step Request Lifecycle.

### Part II — The Framework Adapter Layer (Hono & Elysia Dual Tracks)
- [**`course/03-framework-adapter-hono-vs-elysia.md`**](./course/03-framework-adapter-hono-vs-elysia.md)
  - Module 3 (Phases 4–5): Decoupling Core Backend Engineering from Framework Adapters; Hono vs Elysia Architecture Comparison; Complete **Hono Track (`v4.13.10`)**; Complete **Elysia Track (`v1.4.30`)**; Mapping both frameworks to Web Standards.
- [**`course/04-routing-middleware-context-validation.md`**](./course/04-routing-middleware-context-validation.md)
  - Module 4 (Phases 6–8): Static/Dynamic/Wildcard Routing; Deep Middleware Pipeline (**Bad Order vs Good Order**); Typed Request Context; Input Validation (Zod v4, Valibot, TypeBox, Standard Schema v1); Compile-Time vs Runtime Security.
- [**`course/05-api-design-errors-openapi-e2e-types.md`**](./course/05-api-design-errors-openapi-e2e-types.md)
  - Module 5 (Phases 9 & 24): Production REST API Design & Versioning; Centralized `AppError` Hierarchy; Response Envelopes; First-Class OpenAPI 3.1 (`@hono/zod-openapi` vs `@elysiajs/openapi` `fromTypes()` + Scalar UI); End-to-End Type Safety (`hc` RPC vs Eden Treaty 2 vs Codegen).

### Part III — Data, Persistence, Authentication & Multi-Tenant Authorization
- [**`course/06-postgresql-sql-drizzle-architecture.md`**](./course/06-postgresql-sql-drizzle-architecture.md)
  - Module 6 (Phases 10–11, 14–16): PostgreSQL SQL First (UUIDv7 keys, `CHECK` constraints, partial/composite indexes); Drizzle ORM (`v0.45.2`) vs Prisma (`v7.10`); Feature-Based Modular Monolith; Offset vs UUIDv7 Cursor Pagination; Dynamic Product Search; ACID Transactions; Concurrency & Race Conditions (*"Two Users Buying the Last Product"*).
- [**`course/07-authentication-jwt-sessions-diagrams.md`**](./course/07-authentication-jwt-sessions-diagrams.md)
  - Module 7 (Phase 12): Production Authentication with `Bun.password` (`argon2id`); Constant-Time Login; Stateful `__Host-` Cookie Sessions vs Short-Lived JWT Access Tokens + Refresh Token Family Rotation & Reuse Detection; **All 7 Mermaid Sequence Diagrams**; Deep Dive on CSRF vs CORS vs Cookies.
- [**`course/08-authorization-rbac-multitenancy.md`**](./course/08-authorization-rbac-multitenancy.md)
  - Module 8 (Phase 13): Multi-Tenant Data Model (`organizations`, `memberships`, `roles`, `permissions`); Enforcing Authorization at the Server/Repository Boundary (`findByIdScoped({ id, organizationId })`); Preventing Cross-Tenant IDOR; Immutable Security Audit Logs.

### Part IV — Distributed Systems: Redis, Queues, Payments, Files & Real-Time
- [**`course/09-redis-caching-ratelimiting-queues.md`**](./course/09-redis-caching-ratelimiting-queues.md)
  - Module 9 (Phases 17–20): Selective Redis Data Structures & Native `Bun.redis`; Cache-Aside with TTL Jitter, Negative Caching & Stampede Protection; Post-Commit Cache Invalidation (`DEL` vs `SET`); Distributed Lua Rate Limiting; Background Jobs with **BullMQ (`v5.77+` `createBunRedisClient`)**; Retries, Timeouts & Circuit Breakers.
- [**`course/10-payments-webhooks-idempotency-files-email.md`**](./course/10-payments-webhooks-idempotency-files-email.md)
  - Module 10 (Phases 21–22): `Idempotency-Key` Engineering; End-to-End Payment Architecture; Secure Webhooks (Raw-Body HMAC-SHA256 with `timingSafeEqual`, 5-Minute Replay Window, Atomic Deduplication); File Uploads (Magic-Byte Signature Inspection + Native `Bun.s3` Presigned URLs); Async Email Workers.
- [**`course/11-realtime-websockets-sse-streams-workers.md`**](./course/11-realtime-websockets-sse-streams-workers.md)
  - Module 11 (Phase 23): Polling vs SSE vs WebSockets; Scaling WebSockets Horizontally Across Server 1/2/3 via Redis Pub/Sub; Web Streams (`ReadableStream`) & Backpressure (Streaming Large CSV Exports in Constant RAM); Bun `Worker` Threads; Safe Subprocesses (`Bun.spawn` Array Args vs Command Injection).

### Part V — Security, Observability, Testing, Performance, Deployment & Capstone
- [**`course/12-security-observability-testing.md`**](./course/12-security-observability-testing.md)
  - Module 12 (Phases 25–27): OWASP Top 10 & SSRF Guard; Secret Management & Zod v4 Startup `.env` Validation; Pino Structured JSON Logging with Redaction; Honest Assessment of OpenTelemetry on Bun; `/liveness` vs `/readiness` Probes; Graceful `SIGTERM` Shutdown; Complete `bun:test` Testing Pyramid.
- [**`course/13-performance-docker-cicd-deployment.md`**](./course/13-performance-docker-cicd-deployment.md)
  - Module 13 (Phases 28–31): Event-Loop Lag & CPU Profiling; Responsible Benchmarking (`Bun.serve` vs `Hono` vs `Elysia`); PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` & Connection Pool Sizing; Deployment Platform Compatibility Matrix; Multi-Stage Docker & Compose; GitHub Actions CI/CD; 10 Failure Scenarios & Disaster Recovery (`RPO`/`RTO`).
- [**`course/14-debugging-training-19-scenarios.md`**](./course/14-debugging-training-19-scenarios.md)
  - Module 14 (Section 119): **19 Real-World Production Bugs** with Broken Code, Symptoms, Reproduction, Root Cause, Fix, and Mental Model.
- [**`course/15-capstone-prd-and-final-challenge.md`**](./course/15-capstone-prd-and-final-challenge.md)
  - Module 15 (Sections 107–118, 139–143): Package Strategy, Old vs Modern Patterns, Full Capstone PRD & API Spec, Final Stack Comparison, Official Documentation Map, Stability Matrix (`STABLE` / `EXPERIMENTAL` / `DEPRECATED`), and the **Final 13-Point Architecture Design Challenge**.

---

## Runnable Reference Code Examples

- [**`examples/core-adapter-pattern/domain/order.service.ts`**](./examples/core-adapter-pattern/domain/order.service.ts) — Framework-agnostic Core Domain Service with tenant isolation, inventory reservation, and idempotency.
- [**`examples/core-adapter-pattern/hono-adapter/order.routes.ts`**](./examples/core-adapter-pattern/hono-adapter/order.routes.ts) — Track A: Hono (`v4.13.x`) HTTP Adapter wrapping `OrderService`.
- [**`examples/core-adapter-pattern/elysia-adapter/order.routes.ts`**](./examples/core-adapter-pattern/elysia-adapter/order.routes.ts) — Track B: Elysia (`v1.4.30`) HTTP Adapter wrapping the exact same `OrderService`.
- [**`examples/capstone-saas-reference/Dockerfile`**](./examples/capstone-saas-reference/Dockerfile) — Production multi-stage non-root `oven/bun:1.4.2-alpine` Dockerfile.
- [**`examples/capstone-saas-reference/docker-compose.yml`**](./examples/capstone-saas-reference/docker-compose.yml) — Production multi-container setup (`api`, `worker`, `postgres`, `redis`).
