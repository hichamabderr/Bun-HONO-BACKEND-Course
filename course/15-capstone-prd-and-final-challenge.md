# Module 15 — Capstone PRD, Complete Flows, Final Stack Comparison, Documentation Map, Stability Matrix & Final Architecture Design Challenge

> **Course Sections**: Sections 107–118, 125–126, 135–143

---

## 1. Package Strategy & Old vs Modern Backend Patterns (Sections 125–126)

### Senior Package Selection Rubric (Section 125)
Before running `bun add <package>`, every engineer on the team must answer six questions:
1. **Why do we need this?** What exact problem does it solve?
2. **Does Bun (`v1.4.2`) already provide this natively?**
   - *Examples*: Do **not** install `dotenv` (Bun loads `.env` natively), `ws` (Bun has native WebSockets), `bcrypt`/`argon2` (use `Bun.password`), `uuid` (use `crypto.randomUUID()` or `Bun.randomUUIDv7()`), `fast-glob` (use `Bun.Glob`), `node-fetch`/`axios` (use Web standard `fetch`), or `@aws-sdk/client-s3` (use `Bun.s3`).
3. **Does Hono or Elysia already provide this?**
   - *Examples*: Built-in `cors`, `secureHeaders`, `bodyLimit`, `cookie`, `jwt`, and streaming helpers.
4. **Is it 100% compatible with Bun's JSC runtime?** (No V8-specific C++ `v8.h` headers).
5. **Is it actively maintained as of 2026?**
6. **What is its supply-chain security footprint?** (Does it require `postinstall` scripts?).

### Old Backend Tutorials vs Modern Bun Engineering (Section 126)

| Concern | ❌ Old Node Tutorial Approach | ✅ Modern Bun Backend Approach (Sep 2026) |
| :--- | :--- | :--- |
| **Package Manager & Lockfile** | `npm install` + slow `node_modules` | `bun install --frozen-lockfile` + text `bun.lock` + `trustedDependencies` |
| **TypeScript Execution** | `ts-node` / `nodemon` + complex build step | Native `bun --watch run` + `tsc --noEmit` in CI |
| **HTTP Server** | `node:http` + Express v4 (`req`, `res` streams) | `Bun.serve()` + Web Standard `Request`/`Response` (Hono / Elysia) |
| **Test Runner** | `jest` + `ts-jest` + `supertest` | Native `bun:test` + `app.request()` / `app.handle()` |
| **Outbound HTTP Client** | `axios` (no default timeout, extra dependency) | Web Standard `fetch(url, { signal: AbortSignal.timeout(5000) })` |
| **Password Hashing** | `bcrypt` (C++ addon compile headaches in Docker) | Native `Bun.password.hash(pw, { algorithm: "argon2id" })` |
| **Object Storage** | 40MB `@aws-sdk/client-s3` dependency tree | Native zero-dependency `Bun.s3` (`S3Client` + `.presign()`) |
| **Input Validation** | Manual `if (!req.body.email)` checks | Zod v4 / TypeBox via **Standard Schema v1** |
| **Code Organization** | Giant 1,000-line controller files with SQL inside | Feature-based Modular Monolith + Framework Adapter + Repository boundary |

---

## 2. Final Capstone PRD: "Multi-Tenant SaaS Commerce & Operations Backend" (Sections 107–118, 139)

### 2.1 Product Overview & Business Requirements
Build a multi-tenant B2B/B2C commerce and operations backend where each customer company operates inside an isolated **Organization (Tenant)**:
- **Users & Identity**: Users register, verify email, log in with Argon2id passwords, rotate refresh tokens, and can belong to multiple Organizations.
- **Organizations & RBAC**: Every user membership in an Organization has a role (`owner`, `admin`, `manager`, `member`) mapping to granular permissions (`products:write`, `orders:cancel_any`, `members:manage`, `audit_logs:read`).
- **Products & Catalog**: Organizations manage products (`sku`, `name`, `category`, `priceCents`, `stockQuantity`, S3 images). Public/tenant product reads use **Redis Cache-Aside** and **UUIDv7 Cursor Pagination**.
- **Orders & Inventory**: Creating an order runs inside a **PostgreSQL ACID Transaction** that verifies `Idempotency-Key`, atomically decrements `stockQuantity` (`WHERE stock_quantity >= $qty`), creates `orders` and `order_items`, and enqueues background jobs.
- **Payments & Webhooks**: Integrates with a payment provider via payment intents and a signed webhook endpoint (`POST /api/v1/webhooks/payment`) protected by HMAC-SHA256 verification, a 5-minute replay window, and database event-ID deduplication.
- **Files**: Product images and invoice PDFs are validated via magic bytes and stored in **S3-compatible object storage** via `Bun.s3`.
- **Real-Time & Notifications**: Live order status updates and job progress stream over **WebSockets** (scaled across instances via Redis Pub/Sub) and **SSE**, while transactional emails are processed by **BullMQ Workers**.
- **Audit Logs**: All security-sensitive mutations write immutable records to `audit_logs`.

### 2.2 Complete Capstone API Specification (Section 109)

```text
AUTH
  POST   /api/v1/auth/register
  POST   /api/v1/auth/login
  POST   /api/v1/auth/refresh
  POST   /api/v1/auth/logout
  GET    /api/v1/auth/me
  POST   /api/v1/auth/forgot-password
  POST   /api/v1/auth/reset-password

USERS
  GET    /api/v1/users/me
  PATCH  /api/v1/users/me

ORGANIZATIONS & MEMBERS
  POST   /api/v1/organizations
  GET    /api/v1/organizations/:id
  PATCH  /api/v1/organizations/:id
  DELETE /api/v1/organizations/:id
  GET    /api/v1/organizations/:id/members
  POST   /api/v1/organizations/:id/members
  PATCH  /api/v1/organizations/:id/members/:memberId
  DELETE /api/v1/organizations/:id/members/:memberId

PRODUCTS
  GET    /api/v1/products
  GET    /api/v1/products/:id
  POST   /api/v1/products
  PATCH  /api/v1/products/:id
  DELETE /api/v1/products/:id
  POST   /api/v1/products/:id/images

ORDERS
  POST   /api/v1/orders                  (Requires Idempotency-Key header)
  GET    /api/v1/orders
  GET    /api/v1/orders/:id
  POST   /api/v1/orders/:id/cancel

ADMIN
  GET    /api/v1/admin/users
  PATCH  /api/v1/admin/users/:id/role
  DELETE /api/v1/admin/users/:id

WEBHOOKS & REAL-TIME
  POST   /api/v1/webhooks/payment        (Raw body HMAC-SHA256 + Timestamp check)
  GET    /api/v1/events/orders           (SSE stream)
  GET    /ws/notifications               (WebSocket upgrade)

OBSERVABILITY & DOCS
  GET    /health
  GET    /liveness
  GET    /readiness
  GET    /openapi.json
  GET    /docs                           (Scalar API Reference)
```

---

## 3. Final High-Level Comparison: Bun+Hono vs Bun+Elysia vs Node+Express vs Node+Fastify (Section 141)

| Dimension | Bun + Hono (`v4.13.x`) | Bun + Elysia (`v1.4.30`) | Node + Express (`v5.x`) | Node + Fastify (`v5.x`) |
| :--- | :--- | :--- | :--- | :--- |
| **Runtime & Engine** | Bun (`v1.4.2`, JSC) | Bun (`v1.4.2`, JSC) | Node.js (`v22/24`, V8) | Node.js (`v22/24`, V8) |
| **HTTP Primitives** | Web Standard `Request` / `Response` | Web Standard `Request` / `Response` + AOT context | Legacy Node `IncomingMessage` / `ServerResponse` | Node HTTP wrapped in Fastify `Request` / `Reply` |
| **Type Safety & Client RPC** | Strong (`AppEnv` + Zod v4 + `hc<AppType>`) | Best-in-class automatic inference (`treaty<App>`) | Minimal out of the box; requires manual typing | Good via Type Providers (`@fastify/type-provider-zod`) |
| **Validation & OpenAPI** | `@hono/zod-openapi` (Zod v4) | Native TypeBox `t` + Standard Schema + `fromTypes()` | Requires third-party middleware (`express-openapi-validator`) | Built-in AJV JSON Schema + `@fastify/swagger` |
| **Runtime Portability** | **Highest** (Runs unmodified on Bun, Cloudflare Workers, Deno, Node, Lambda) | Bun-first (WinterTC adapter available) | Node.js & Bun compat layer | Node.js & Bun compat layer |
| **Ecosystem & Legacy Compat** | Modern Web-standard ecosystem + npm | Elysia plugin ecosystem + npm | Largest legacy middleware ecosystem in history | Mature plugin architecture (`fastify-plugin`) |
| **Ideal Engineering Fit** | Teams wanting clean Web Standards, explicit middleware, and multi-runtime portability | Teams building 100% on Bun wanting maximum TS inference, macros, and Eden Treaty | Maintaining existing legacy Node codebases | High-throughput Node.js enterprise services requiring V8 |

---

## 4. Final Official Documentation Map (Section 142)

- **Bun (`v1.4.2`)**:
  - Runtime & APIs: [https://bun.sh/docs](https://bun.sh/docs)
  - `Bun.serve` HTTP & WebSockets: [https://bun.sh/docs/api/http](https://bun.sh/docs/api/http) | [https://bun.sh/docs/api/websockets](https://bun.sh/docs/api/websockets)
  - `Bun.sql` (Postgres/MySQL/SQLite): [https://bun.sh/docs/api/sql](https://bun.sh/docs/api/sql)
  - `Bun.redis`: [https://bun.sh/docs/api/redis](https://bun.sh/docs/api/redis)
  - `Bun.s3`: [https://bun.sh/docs/api/s3](https://bun.sh/docs/api/s3)
  - `bun:test`: [https://bun.sh/docs/cli/test](https://bun.sh/docs/cli/test)
  - Node.js Compatibility: [https://bun.sh/docs/runtime/nodejs-apis](https://bun.sh/docs/runtime/nodejs-apis)
- **Hono (`v4.13.10`)**:
  - Core Documentation: [https://hono.dev/docs/](https://hono.dev/docs/)
  - RPC Client (`hc`): [https://hono.dev/docs/guides/rpc](https://hono.dev/docs/guides/rpc)
  - Zod OpenAPI: [https://hono.dev/examples/zod-openapi](https://hono.dev/examples/zod-openapi)
- **Elysia (`v1.4.30` Stable)**:
  - Core Documentation: [https://elysiajs.com/at-glance](https://elysiajs.com/at-glance)
  - OpenAPI & Type Gen: [https://elysiajs.com/plugins/openapi](https://elysiajs.com/plugins/openapi)
  - Eden Treaty: [https://elysiajs.com/eden/overview](https://elysiajs.com/eden/overview)
- **TypeScript & Validation**:
  - TypeScript (`v6.0 / v7.0`): [https://www.typescriptlang.org/docs/](https://www.typescriptlang.org/docs/)
  - Zod v4: [https://zod.dev](https://zod.dev)
  - Standard Schema: [https://standardschema.dev](https://standardschema.dev)
- **PostgreSQL & Drizzle ORM**:
  - PostgreSQL Current Docs: [https://www.postgresql.org/docs/current/](https://www.postgresql.org/docs/current/)
  - Drizzle ORM (`v0.45.2`): [https://orm.drizzle.team/docs/overview](https://orm.drizzle.team/docs/overview)
- **Redis & BullMQ**:
  - Redis Docs: [https://redis.io/docs/latest/](https://redis.io/docs/latest/)
  - BullMQ (`v5.77+` Connections & `createBunRedisClient`): [https://docs.bullmq.io/guide/connections](https://docs.bullmq.io/guide/connections)
- **Security, Observability & Deployment**:
  - OWASP API Security Top 10: [https://owasp.org/API-Security/](https://owasp.org/API-Security/)
  - Pino Logger: [https://getpino.io/](https://getpino.io/)
  - OpenTelemetry JS: [https://opentelemetry.io/docs/languages/js/](https://opentelemetry.io/docs/languages/js/)
  - Docker Bun Official Images: [https://hub.docker.com/r/oven/bun](https://hub.docker.com/r/oven/bun)

---

## 5. Stability Classification Matrix: STABLE vs EXPERIMENTAL vs DEPRECATED (Section 143)

Never use experimental APIs silently in production. Verify stability status as of **September 2026**:

| Category | Technology / Feature | Current Status (Sep 2026) | Guidance |
| :--- | :--- | :--- | :--- |
| **STABLE** | `Bun.serve()` (HTTP/1.1, HTTP/2, Routes, WebSockets), `Bun.password`, `Bun.sql`, `Bun.redis`, `Bun.s3`, `bun.lock` (text), `bun:test`, Hono `v4.13.10`, Elysia `v1.4.30`, Zod `v4.x`, Standard Schema `v1`, Drizzle ORM `v0.45.2`, Prisma `v7.10`, BullMQ `v5.77+` (`createBunRedisClient`) | **STABLE — Production Ready** | Safe for mission-critical production workloads; pin minor/patch versions in `package.json` and commit `bun.lock`. |
| **BETA / RC / EXPERIMENTAL** | **Elysia `v2.0 beta` ("DayDream")**, **Drizzle ORM `v1.0.0-beta`**, **Prisma `v8.0 RC`**, Bun Android support, Node `@opentelemetry/auto-instrumentations-node` CJS hooks on Bun | **BETA / EXPERIMENTAL** | Do **not** adopt blindly in production without explicit pinning and testing. Stay on `elysia@1.4.30`, `drizzle-orm@0.45.2`, and `prisma@7.10` for production today, and use explicit `@hono/otel` or `@elysiajs/opentelemetry` spans. |
| **DEPRECATED / LEGACY** | Binary `bun.lockb` (replaced by text `bun.lock` in Bun 1.2+), `app.fire()` in Hono (deprecated in Hono v4.8.0 in favor of adapter `fire()`), `@elysiajs/swagger` (succeeded by `@elysiajs/openapi`), Eden Treaty 1 (`edenTreaty`, succeeded by `treaty` in Eden Treaty 2) | **DEPRECATED — Do Not Use in New Code** | Migrate to the modern equivalents documented in Modules 1–13. |

---

## 6. Final Architecture Design Challenge (Section 140)

> **Important**: Per Section 140 of the course specification, **do not skip this step**. Before reviewing a finalized blueprint, **you** are now the Lead Backend Architect.

Design and write out your architectural decisions for the **Multi-Tenant SaaS Commerce & Operations Backend** across these **13 dimensions**:

1. **Framework Choice**: Will you use **Hono (`v4.13.10`)** or **Elysia (`v1.4.30`)** as your primary HTTP adapter, and why does it fit your deployment target?
2. **Module Structure**: How will you organize `src/modules/*` and `src/infrastructure/*`, and what rules govern imports between modules?
3. **API Structure**: How will you version your routes, structure success/error envelopes, and generate OpenAPI 3.1 docs?
4. **Database Schema & Indexing**: Which tables need `organization_id`, what composite indexes and `CHECK` constraints will you create, and how will you prevent overselling the last item in stock?
5. **Authentication**: Will you use stateful `HttpOnly` cookie sessions, short-lived JWT access tokens + rotated refresh tokens, or both? How will you detect refresh token theft?
6. **Authorization**: How will `owner`, `admin`, `manager`, and `member` roles map to permissions, and where in the call stack will authorization be enforced?
7. **Tenant Isolation**: How will you guarantee at the code/type level that Tenant B can never read, update, or cached-read Tenant A's orders or products?
8. **Cache Strategy**: What will you cache in Redis, how will keys be formatted, what TTL + stampede protections will you use, and when will invalidation happen relative to DB commits?
9. **Queue Architecture**: Which operations will be synchronous in the HTTP cycle vs asynchronous in BullMQ, and how will you avoid the "job enqueued before DB commit" race condition?
10. **Worker Architecture**: How will your worker processes scale, handle retries/backoff, and shut down gracefully on `SIGTERM`?
11. **File Storage**: Will you use presigned URLs (`Bun.s3.presign`) or server-proxied uploads with magic-byte validation for product images vs private invoices?
12. **Webhook Handling**: Walk through the exact step-by-step execution when the payment provider delivers `payment.succeeded` 3 times concurrently.
13. **Deployment & Observability**: How will you package Docker containers, manage PostgreSQL connection pools across replicas, separate `/liveness` from `/readiness`, and trace requests?

**Reply with your 13-point architecture design, and I will conduct a rigorous Senior Principal Backend Architecture Review of your design!**
