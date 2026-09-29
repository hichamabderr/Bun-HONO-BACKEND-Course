# 00 — Course Foundation, Verified Stack (September 2026) & Core Mental Models

```text
                    CORE BACKEND ENGINEERING
                                │
        ┌───────────────────────┼───────────────────────┐
        ├── Bun Runtime (v1.4.2)├── Auth & RBAC         ├── Queues & Workers
        ├── HTTP & Web APIs     ├── Security (OWASP)    ├── Testing Strategy
        ├── PostgreSQL & SQL    ├── Caching & Redis     └── Docker & Deployment
        └───────────────────────┼───────────────────────┘
                                │
                                ▼
                      ┌───────────────────┐
                      │ Framework Adapter │
                      └─────────┬─────────┘
                                │
                         ┌──────┴───────┐
                         ▼              ▼
                  Hono (v4.13.x)  Elysia (v1.4.x)
```

---

## 1. Course Philosophy

Most backend tutorials teach you how to glue framework syntax to an ORM and call it an API. When production traffic arrives—bringing race conditions, duplicate webhooks, connection pool exhaustion, cross-tenant data leaks, and slow queries—framework syntax alone cannot save you.

This course is built on a single foundational premise:

> **Frameworks are thin HTTP adapters over core backend engineering.**

We teach **Core Backend Engineering first**—HTTP semantics, Web Standards (`Request`, `Response`, `Headers`, `ReadableStream`), SQL and transactional isolation, cryptographic authentication, server-boundary multi-tenant authorization, distributed caching, idempotent background jobs, and observability—and then map those exact principles onto **both Hono and Elysia** through clean **Framework Adapters**.

---

## 2. Backend Engineering Mindset

A senior backend engineer approaches every feature through five lenses:

1. **Boundary Discipline**: Never trust the network, the browser, or upstream callers. Validate schemas at the edge; enforce authorization and tenant isolation at the service/data boundary.
2. **Failure by Default**: Assume Redis will go down, PostgreSQL queries will lock, payment providers will time out, and webhooks will be delivered five times concurrently.
3. **Explicit State & Lifecycles**: Know where every connection pool, stream buffer, background job, and session token lives, how it scales horizontally across 3+ instances, and how it drains on `SIGTERM`.
4. **Web Standards Over Proprietary Lock-In**: Prefer WinterTC / WHATWG primitives (`Request`, `Response`, `URL`, `Headers`, `WebCrypto`, `ReadableStream`, `Standard Schema`) so business logic outlives any single framework.
5. **Evidence Over Hype**: Never accept "X is 10x faster" without inspecting the workload, payload, connection concurrency, and database bottleneck.

---

## 3. Current Bun Status (Verified September 2026)

As of **September 2026**, Bun is a mature, production-grade JavaScript and TypeScript runtime, package manager, test runner, and bundler developed by Oven (which joined **Anthropic** in December 2025 to power modern developer infrastructure and AI execution toolchains).

Key milestones leading up to September 2026:
- **Bun 1.2 (Jan–Sep 2025)**: Introduced text-based lockfile (`bun.lock`), built-in PostgreSQL client (`Bun.sql`), built-in S3 client (`Bun.s3`), built-in Redis client (`Bun.redis` in v1.2.9), and isolated linker mode (`--linker=isolated`).
- **Bun 1.3 (Oct 2025–May 2026)**: Unified `Bun.sql` across Postgres, MySQL, and SQLite; parameterized/catch-all routes in `Bun.serve()`; workspace dependency `catalogs`; `URLPattern` API; fake timers in `bun:test`.
- **Bun 1.4 (Aug–Sep 2026)**: Internal core transition to Rust alongside Zig/C++ and JavaScriptCore; native **HTTP/2** support in `Bun.serve()` (v1.4.1); `node:crypto` `argon2` support; Node.js 26.x compatibility layer; `Bun.write(path, response)` streaming directly to disk; WebSocket `pause()`/`resume()` backpressure controls; and opt-in global virtual store.

Bun is four separate but tightly integrated tools in one binary (`bun`):
1. **Bun Runtime**: Executes `.ts`, `.tsx`, `.js`, and `.mjs` directly using WebKit's **JavaScriptCore (JSC)** engine and native system bindings.
2. **Bun Package Manager**: `bun install`, `bun add`, `bun remove`, `bun pm`, workspace catalogs, and deterministic `bun.lock`.
3. **Bun Test Runner**: `bun test` (`bun:test` module) with Jest-compatible `expect`, lifecycle hooks, mocks, fake timers, snapshots, and coverage.
4. **Bun Bundler**: `bun build` / `Bun.build()` for server bundles, client assets, and `--compile` standalone executables.

---

## 4. Current Bun Version

- **Latest Verified Stable Version**: **Bun `v1.4.2`** (Released September 5, 2026; follows `v1.4.1` on September 4, 2026 and `v1.4.0` on August 20, 2026).
- **Previous Stable 1.3 Line**: **Bun `v1.3.14`** (May 2026).

---

## 5. Bun Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│Your TypeScript / JavaScript Application (Hono / Elysia)     │
├───────────────────┬─────────────────────┬───────────────────┤
│ Web Standard APIs │  Bun Native APIs    │ Node.js Compat    │
│ fetch, Request,   │  Bun.serve, Bun.sql,│ node:fs, node:net,│
│ Response, Streams,│  Bun.redis, Bun.s3, │ node:crypto,      │
│ WebCrypto, URL    │  Bun.password, file │ AsyncLocalStorage │
├───────────────────┴─────────────────────┴───────────────────┤
│        JavaScriptCore (JSC) Engine (JIT: LLInt/Baseline/    │
│        DFG/FTL) + Zig / Rust / C++ Native Runtime Bindings  │
├─────────────────────────────────────────────────────────────┤
│        Operating System Kernel (Linux io_uring / epoll,     │
│        macOS kqueue, TCP_DEFER_ACCEPT, BoringSSL)           │
├─────────────────────────────────────────────────────────────┤
│        Hardware: Network NIC / NVMe Disk / Multi-Core CPU   │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Bun vs Node

| Dimension | Bun (`v1.4.2`) | Node.js (`v22 LTS` / `v24 LTS` / `v26 Current`) |
| :--- | :--- | :--- |
| **JS Engine** | WebKit **JavaScriptCore (JSC)** (faster cold start, multi-tier JIT) | Google **V8** (heavier startup, aggressive peak optimization) |
| **Native TypeScript** | Executes `.ts` directly via native transpiler (note: does not typecheck at runtime; run `tsc --noEmit` in CI) | Node 22.6+ / 24+ supports `--experimental-strip-types` / native type stripping, with limitations on non-erasable TS syntax |
| **HTTP Server** | `Bun.serve()` (native uSockets/BoringSSL, HTTP/1.1 + HTTP/2, native WebSockets, `Request`/`Response`) | `node:http` / `node:http2` (`IncomingMessage`/`ServerResponse` Node streams; Web `Request` requires adapter) |
| **Built-in Clients** | `Bun.sql` (Postgres/MySQL/SQLite), `Bun.redis`, `Bun.s3`, `Bun.password` (Argon2/bcrypt) | Built-in `node:sqlite` (experimental/stabilizing); Postgres, Redis, S3, Argon2 require external npm packages |
| **Tooling** | Integrated PM (`bun install`), test runner (`bun:test`), bundler (`bun build`) | Separate tools (`npm`/`pnpm`, `node --test` or `vitest`, `esbuild`/`rolldown`) |
| **Ecosystem Maturity** | High Node compatibility, though niche C++ V8 addons or deep `node:vm`/`node:inspector` consumers can still hit edge cases | The canonical baseline for the npm ecosystem; 100% compatibility by definition |

---

## 7. Current Hono Status (Verified September 2026)

- **Latest Verified Stable Version**: **Hono `v4.13.10`** (September 2026; `v4.12.x` in Feb 2026, `v4.13.x` through Q3 2026).
- **Architecture**: Zero-dependency core built strictly on WHATWG Web Standards (`Request` → `Response`). Runs identically on Bun, Cloudflare Workers, Deno, Node.js (`@hono/node-server`), and AWS Lambda.
- **Key Ecosystem Packages**:
  - `@hono/zod-validator` & `@hono/standard-validator` (Standard Schema v1 validation)
  - `@hono/zod-openapi` (`v1.5.x`, supporting Zod v4) & `@scalar/hono-api-reference`
  - `hono/client` (`hc`) for inferred RPC client type safety (`$path()`, `parseResponse`, `ApplyGlobalResponse`).

---

## 8. Current Elysia Status (Verified September 2026)

- **Latest Verified Stable Version**: **Elysia `v1.4.30`** (Released August 26, 2026 on the `1.4` "Supersymmetry" line).
- **Beta / Next Major Track**: **Elysia `2.0 beta` ("DayDream")** (Announced July 30, 2026; complete ground-up rewrite with Ahead-of-Time request compilation and lower memory footprint). *Production rule: Pin `elysia@^1.4.30` for production today; treat `2.0-beta/exp` as experimental until GA.*
- **Key Features in `1.4.x`**:
  - First-class **Standard Schema** support (mix and match TypeBox `t`, Zod v4, Valibot, ArkType directly in route definitions).
  - `@elysiajs/openapi` with **OpenAPI Type Gen** (`fromTypes()`) and Scalar UI.
  - **Eden Treaty 2** (`@elysiajs/eden`) for zero-codegen end-to-end type safety.

---

## 9. Hono vs Elysia Decision Matrix

| Concern | Hono (`v4.13.x`) | Elysia (`v1.4.30` Stable) |
| :--- | :--- | :--- |
| **Primary Design Goal** | Universal Web-Standard HTTP router & middleware kernel | Bun-first, schema-driven, end-to-end type-sound framework |
| **Bun Integration** | Exports `{ fetch, websocket }` consumed by `Bun.serve` | Directly wraps `Bun.serve` (`app.listen(3000)`) and compiles static routes into `Bun.serve.routes` |
| **Runtime Portability** | Native first-class on Bun, Cloudflare Workers, Deno, Vercel Edge, Node | Optimized for Bun first; supports WinterTC / Node via adapters |
| **Routing Engine** | `RegExpRouter` + `TrieRouter` (1.5–2x faster in v4.12+) + `LinearRouter` | `Memoirist` radix tree + Sucrose static analysis / AOT code compilation |
| **Middleware vs Lifecycle** | Explicit onion-model middleware (`await next()`) | Granular event lifecycle (`request` → `parse` → `transform` → `beforeHandle` → `handle` → `afterHandle` → `mapResponse` → `onError` → `afterResponse`) + `macro` |
| **Validation** | Middleware-based (`zValidator`, `sValidator` for Standard Schema) | Built into route config object (`{ body, query, params, headers, response }`) using `t` (TypeBox) or any Standard Schema (Zod, Valibot) |
| **Context Typing** | Explicit generic parameter `new Hono<{ Variables: ..., Bindings: ... }>()` | Automatic chain inference via `.decorate()`, `.state()`, `.derive()`, `.resolve()` |
| **OpenAPI Generation** | Declarative via `@hono/zod-openapi` (`createRoute`) or `hono-openapi` | 1-liner via `@elysiajs/openapi` + `fromTypes()` or explicit TypeBox/Standard schemas |
| **Client Type Safety** | `hc<AppType>()` (requires chained route definitions for full RPC inference) | `treaty<App>()` via `@elysiajs/eden` (ergonomic proxy client with status-code narrowing) |
| **Production Tradeoffs** | Simpler mental model, explicit control, zero magic; slightly more boilerplate for OpenAPI | Maximum DX and type inference; requires strict method-chaining discipline and plugin isolation awareness (`.as('scoped' \| 'global')`) |

---

## 10. Selected Primary Framework & Dual-Track Adapter Architecture

Why choose blindly when good architecture decouples your business logic from both?

- **Primary Course Track**: **Hono (`v4.13.10`)** is selected as the primary baseline because its explicit onion-middleware model, explicit `new Hono<AppEnv>()` context typing, and strict adherence to Web Standard `Request`/`Response` make every HTTP and security mechanism transparent to learn and debug, while providing unmatched deployment portability across Bun containers, Node fallbacks, and Edge workers.
- **Complete Parallel Track**: **Elysia (`v1.4.30`)** is taught side-by-side in our **Framework Adapter** modules so you master Elysia's lifecycle hooks, `t` / Standard Schema validation, macros, OpenAPI Type Gen, and Eden Treaty client.
- **Architectural Rule**: Services, Repositories, Domain Errors (`AppError`), Validators, and Queue Producers **never** import `hono` or `elysia`.

---

## 11. Verified Technology Stack (September 2026)

| Layer | Selected Technology | Verified Version (Sep 2026) | Status | Why Chosen |
| :--- | :--- | :--- | :--- | :--- |
| **Runtime** | **Bun** | `v1.4.2` | **STABLE** | Native TS execution, fast startup, `Bun.serve` HTTP/1.1+HTTP/2+WS, `Bun.password`, `Bun.sql`, `Bun.redis`, `Bun.s3`, `bun:test` |
| **Type Checker** | **TypeScript** | `v6.0.x` (Stable) / `v7.0` (Native Go port) | **STABLE** | Strict compile-time verification (`tsc --noEmit`) |
| **HTTP Framework (Track A)** | **Hono** | `v4.13.10` | **STABLE** | Web-standard kernel, predictable middleware, `@hono/zod-openapi`, `hc` RPC |
| **HTTP Framework (Track B)** | **Elysia** | `v1.4.30` (`v2.0` is Beta) | **STABLE** | Bun-first AOT routing, Standard Schema, `@elysiajs/openapi`, Eden Treaty |
| **Validation Contract** | **Zod v4** + **Standard Schema v1** | `zod@^4.0.0` | **STABLE** | Native JSON Schema / OpenAPI 3.1 output (`z.toJSONSchema`), universal Standard Schema compatibility across Hono & Elysia |
| **Database** | **PostgreSQL** | `17.x` / `18.x` | **STABLE** | Industry-standard relational ACID database, row-level locking, JSONB, partial indexes |
| **ORM & SQL** | **Drizzle ORM** (+ `postgres` / `Bun.sql`) | `drizzle-orm@0.45.2` (`1.0` in beta) | **STABLE** | SQL-transparent query builder, zero binary engine overhead, deterministic SQL migrations (`drizzle-kit@0.31.x`) |
| **Cache & Broker** | **Redis** (or Valkey) | `Redis 7.4+ / 8.x` | **STABLE** | Sub-millisecond cache, rate-limiting Lua scripts, BullMQ backing store, WebSocket pub/sub |
| **Queue & Workers** | **BullMQ** | `bullmq@^5.77.0+` | **STABLE** | Supports both `ioredis` and native `Bun.redis` via `createBunRedisClient` adapter introduced in v5.77.0 (May 2026) |
| **Object Storage** | **S3-Compatible** (`Bun.s3`) | Built into Bun `1.2+` / `1.4.2` | **STABLE** | Native zero-dependency presigned URLs (`s3.presign()`) and streaming uploads across AWS S3, Cloudflare R2, MinIO |
| **Logging** | **Pino** | `pino@^9.x` | **STABLE** | Structured JSON logging with redaction and child loggers |
| **OpenAPI UI** | **Scalar** | `@scalar/hono-api-reference` / `@elysiajs/openapi` | **STABLE** | Modern OpenAPI 3.1 interactive documentation |
| **Testing** | **Bun Test** (`bun:test`) | Built into Bun `v1.4.2` | **STABLE** | Fast native runner, lifecycle hooks, mocking, fake timers, coverage |

---

## 12. Ecosystem Map

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                        CLIENT / API CONSUMERS                           │
│    Browser SPA / Mobile App / Webhook Providers / CLI / Partner SDKs    │
└───────────────────┬─────────────────────────────────┬───────────────────┘
                    │ HTTPS (JSON / Multipart / SSE)  │ WSS (WebSockets)
                    ▼                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        BUN RUNTIME (v1.4.2)                             │
│                        Bun.serve() (HTTP/1.1, HTTP/2, WS)               │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ FRAMEWORK ADAPTER LAYER: Hono (v4.13.10) OR Elysia (v1.4.30)      │  │
│  │ • Request ID & Pino Logger   • Security Headers & CORS            │  │
│  │ • Rate Limiter (Redis Lua)   • Auth Session/JWT Verification      │  │
│  │ • Zod v4 / Standard Schema   • OpenAPI 3.1 & Scalar Docs          │  │
│  └─────────────────────────────────┬─────────────────────────────────┘  │
│                                    ▼                                    │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ CORE APPLICATION & DOMAIN LAYER (Framework-Agnostic TypeScript)   │  │
│  │ • Modules: auth, users, organizations, products, orders, payments │  │
│  │ • Explicit Tenant Context ({ actorId, organizationId, role })     │  │
│  │ • Domain Policies & AppError Hierarchy                            │  │
│  └────────┬────────────────────────┬────────────────────────┬────────┘  │
└───────────┼────────────────────────┼────────────────────────┼───────────┘
            │                        │                        │
            ▼                        ▼                        ▼
┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐
│ PostgreSQL 17/18     │ │ Redis 7/8            │ │ Object Storage (S3)  │
│ • Drizzle ORM 0.45.2 │ │ • Cache-Aside + TTL  │ │ • Bun.s3Client       │
│ • ACID Transactions  │ │ • Session Blacklist  │ │ • Presigned URLs     │
│ • Row Locks & Indexes│ │ • BullMQ Queues      │ │ • Magic-Byte Checks  │
└──────────────────────┘ └───────────┬──────────┘ └──────────────────────┘
                                     │
                                     ▼
                         ┌──────────────────────┐
                         │ BUN WORKER PROCESS   │
                         │ • BullMQ Workers     │
                         │ • Email / Webhooks   │
                         │ • Reports / Cleanup  │
                         └──────────────────────┘
```

---

## 13. HTTP Mental Model

HTTP is a stateless text/binary framing protocol over TCP (HTTP/1.1, HTTP/2) or QUIC (HTTP/3). Every interaction consists of:
- **Request**: `Method` (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`) + `URI` (`path` + `query`) + `Headers` (metadata, `Host`, `Authorization`, `Cookie`, `Content-Type`, `Accept`, `If-None-Match`, `Idempotency-Key`) + optional `Body` stream.
- **Response**: `Status Code` (`2xx` success, `3xx` redirection/cache, `4xx` client error, `5xx` server fault) + `Headers` (`Content-Type`, `Cache-Control`, `Set-Cookie`, `ETag`, security headers) + optional `Body` stream.

---

## 14. Bun Runtime Mental Model

Your TypeScript source is transpiled in-memory on startup into JavaScript bytecode executed by **JavaScriptCore**. Single-threaded JS execution coordinates non-blocking I/O via the OS kernel event notification system (`epoll`/`io_uring` on Linux, `kqueue` on macOS). Blocking the main thread with synchronous CPU loops stalls **all** concurrent HTTP requests on that process; CPU-intensive tasks must be offloaded to `Worker` threads or background queue processes.

---

## 15. Framework Mental Model

Both Hono and Elysia are **functions of `(Request) => Promise<Response>`**:
- **Hono** wraps the `Request` in a `Context` (`c`), passes it down a linear/onion middleware pipeline (`await next()`), matches the route via `RegExpRouter`/`TrieRouter`, and returns a Web `Response`.
- **Elysia** compiles routes and lifecycle hooks (`onRequest`, `parse`, `beforeHandle`, `afterHandle`, `onError`) into an optimized execution pipeline ahead of time, passing a shared mutable/derived context object.

---

## 16. Database Mental Model

PostgreSQL is the **single source of truth**. Every query executes inside a transaction (implicit single-statement or explicit `BEGIN ... COMMIT`). Data integrity is enforced by the database engine first (primary keys, foreign keys, `UNIQUE` constraints, `CHECK` constraints, `NOT NULL`, and `FOR UPDATE` locks)—never solely by `if` statements in application memory, which fail under concurrent requests.

---

## 17. Authentication Mental Model

**Authentication answers: "Who is making this request?"**
- **Browser Web Apps**: Prefer `HttpOnly; Secure; SameSite=Lax` cookies backed by a database/Redis session (or short-lived Access Token + rotated Refresh Token) with strict CSRF protection.
- **API / Mobile / Service Clients**: Prefer short-lived signed JWT Access Tokens (5–15 min) paired with opaque or rotated Refresh Tokens stored as SHA-256 hashes in PostgreSQL with family-based reuse detection.

---

## 18. Authorization Mental Model

**Authorization answers: "Is this authenticated principal permitted to perform this action on this specific tenant's resource?"**
- Never enforce authorization solely in UI or route middleware.
- Every service and repository method in a multi-tenant backend must require the tenant scope explicitly: `orderRepository.findById({ id, organizationId })`.

---

## 19. Queue Mental Model

If an operation is slow (PDF generation), depends on an unreliable third party (sending email via SMTP/API), or can be retried asynchronously (webhook fan-out), **do not run it synchronously inside the HTTP request-response cycle**. Persist the state change in PostgreSQL, enqueue a small immutable job payload into Redis/BullMQ, return `202 Accepted` or `201 Created`, and let an isolated Worker process execute it with exponential backoff and idempotency guards.

---

## 20. Caching Mental Model

Redis is an **ephemeral performance accelerator**, not your primary source of truth.
- Always bound cache entries with a `TTL`.
- Protect hot keys against **cache stampedes** (single-flight lock or early recomputation).
- Invalidate deterministically after PostgreSQL `COMMIT` (never before commit).
- Design your API so that if Redis is temporarily unreachable, cached reads degrade gracefully to PostgreSQL (or fail closed only where security requires it, such as auth rate-limiting).

---

## 21. Production Architecture

We use a **Modular Monolith with Separated API and Worker Deployments**:
- One shared, strongly typed codebase organized by domain module (`auth`, `users`, `organizations`, `products`, `orders`, `payments`, `notifications`).
- Deployed as two distinct container process types from the same Docker image:
  1. `api` replicas (`bun run src/entrypoints/api.ts`) behind a TLS-terminating Load Balancer / Reverse Proxy.
  2. `worker` replicas (`bun run src/entrypoints/worker.ts`) processing BullMQ jobs and scheduled tasks without consuming HTTP event-loop capacity.

---

## 22. Complete Course Roadmap (31 Phases across 15 Deep-Dive Modules)

| Course File | Phases Covered | Core Engineering Topics |
| :--- | :--- | :--- |
| [`00-course-foundation-and-mindset.md`](./00-course-foundation-and-mindset.md) | Intro (1–25) | Philosophy, Verified Sept 2026 Stack, Mental Models, Decision Matrix |
| [`01-bun-runtime-and-architecture.md`](./01-bun-runtime-and-architecture.md) | Phase 1 | Bun Runtime, JSC vs V8, Node Compat, `bun install` (`bun.lock`), `bun:test`, `Bun.build` |
| [`02-bun-serve-web-standards-and-http.md`](./02-bun-serve-web-standards-and-http.md) | Phases 2–3 | `Bun.serve` (HTTP/1.1, HTTP/2, Routes, WS), Web Standards, Deep HTTP, Request Lifecycle |
| [`03-framework-adapter-hono-vs-elysia.md`](./03-framework-adapter-hono-vs-elysia.md) | Phases 4–5 | Core + Framework Adapter Pattern, Complete Hono Track, Complete Elysia Track |
| [`04-routing-middleware-context-validation.md`](./04-routing-middleware-context-validation.md) | Phases 6–8 | Routing, Middleware Ordering (Bad vs Good), Typed Context, Zod v4 & Standard Schema |
| [`05-api-design-errors-openapi-e2e-types.md`](./05-api-design-errors-openapi-e2e-types.md) | Phases 9, 24 | REST Design, `AppError` System, Envelopes, OpenAPI 3.1, Hono RPC vs Eden Treaty |
| [`06-postgresql-sql-drizzle-architecture.md`](./06-postgresql-sql-drizzle-architecture.md) | Phases 10–11, 14–16 | PostgreSQL SQL First, Drizzle ORM (`0.45.2`), Modular Monolith, Cursor Pagination, Search, Transactions, Locking & Race Conditions |
| [`07-authentication-jwt-sessions-diagrams.md`](./07-authentication-jwt-sessions-diagrams.md) | Phase 12 | `Bun.password` (Argon2id), Cookie Sessions, JWT Access/Refresh Rotation, 7 Mermaid Diagrams, CSRF/CORS |
| [`08-authorization-rbac-multitenancy.md`](./08-authorization-rbac-multitenancy.md) | Phase 13 | RBAC, Fine-Grained Permissions, Server-Boundary Enforcement, Multi-Tenancy & Audit Logs |
| [`09-redis-caching-ratelimiting-queues.md`](./09-redis-caching-ratelimiting-queues.md) | Phases 17–20 | `Bun.redis` & `ioredis`, Cache-Aside, Invalidation, Rate Limiting, BullMQ (`createBunRedisClient`), Workers, Retries, Timeouts, Circuit Breakers |
| [`10-payments-webhooks-idempotency-files-email.md`](./10-payments-webhooks-idempotency-files-email.md) | Phases 21–22 | `Idempotency-Key`, Payment Architecture, HMAC Webhooks, File Uploads (Magic Bytes, `Bun.s3`), Async Email |
| [`11-realtime-websockets-sse-streams-workers.md`](./11-realtime-websockets-sse-streams-workers.md) | Phase 23 | Polling vs SSE vs WebSockets, Redis Pub/Sub Scaling, Web Streams & Backpressure (CSV), Bun `Worker` & `Bun.spawn` |
| [`12-security-observability-testing.md`](./12-security-observability-testing.md) | Phases 25–27 | OWASP Top 10, Security Headers, Secrets/Env, Pino Logging, OpenTelemetry on Bun, Health Checks, Graceful Shutdown, Full Testing Pyramid |
| [`13-performance-docker-cicd-deployment.md`](./13-performance-docker-cicd-deployment.md) | Phases 28–31 | Event Loop & CPU, Honest Benchmarking, `EXPLAIN ANALYZE`, Connection Pools, Platform Matrix, Docker Compose, CI/CD, Failure Scenarios & DR |
| [`14-debugging-training-19-scenarios.md`](./14-debugging-training-19-scenarios.md) | Section 119 | 19 Real-World Production Bugs: Broken Code, Symptoms, Reproduction, Root Cause, Fix, Mental Model |
| [`15-capstone-prd-and-final-challenge.md`](./15-capstone-prd-and-final-challenge.md) | Sections 107–118, 139–143 | Full Capstone PRD, End-to-End Flows, Final Stack Comparison, Official Docs Map, Stable/Experimental Matrix, Final Architecture Challenge |

---

## 23. Capstone Project

**"Multi-Tenant SaaS Commerce & Operations Backend"**
A complete, multi-tenant B2B/B2C commerce platform where organizations manage team members with granular roles (`owner`, `admin`, `manager`, `member`), maintain product catalogs with S3 image uploads and Redis caching, process inventory-safe transactional orders with `Idempotency-Key`, handle asynchronous payment provider webhooks, stream live order/job notifications over WebSockets and SSE, and record immutable security audit logs.

---

## 24. Capstone Architecture

```text
src/
├── entrypoints/
│   ├── api.ts                 # HTTP + WebSocket server entrypoint (Bun.serve)
│   └── worker.ts              # BullMQ background worker entrypoint
├── adapters/
│   ├── hono/                  # Hono v4.13.x router, middleware & OpenAPI adapter
│   └── elysia/                # Elysia v1.4.30 plugin, macro & OpenAPI adapter
├── modules/
│   ├── auth/                  # Register, login, refresh rotation, sessions, password reset
│   ├── users/                 # User profile & account settings
│   ├── organizations/         # Multi-tenant orgs, memberships, RBAC roles, invitations
│   ├── products/              # Catalog CRUD, cursor pagination, search, Redis cache-aside
│   ├── orders/                # Transactional order creation, inventory locking, cancellation
│   ├── payments/              # Payment intents, HMAC webhook verification, idempotency
│   ├── files/                 # Magic-byte validation, Bun.s3 presigned URLs
│   ├── notifications/         # Real-time WebSocket pub/sub, SSE feeds, email jobs
│   └── audit/                 # Immutable security & compliance audit logging
├── infrastructure/
│   ├── db/                    # Drizzle ORM 0.45.2 schema, migrations, Postgres pool
│   ├── redis/                 # Bun.redis / ioredis client, Lua rate-limiters, locks
│   ├── queue/                 # BullMQ v5.77+ queues & createBunRedisClient adapter
│   ├── storage/               # Bun.s3 S3Client wrapper
│   ├── email/                 # Transactional email provider client
│   ├── logger/                # Pino structured JSON logger with secret redaction
│   └── telemetry/             # OpenTelemetry trace/metric bootstrap & health probes
├── config/                    # Startup Zod v4 environment variable validation
├── errors/                    # AppError hierarchy & error code registry
└── shared/                    # Branded types, pagination helpers, crypto utilities
```

---

## 25. Deployment Architecture

```text
                        ┌────────────────────────────┐
                        │  Cloudflare / Edge DNS/WAF │
                        └─────────────┬──────────────┘
                                      │ HTTPS (TLS 1.3)
                        ┌─────────────▼──────────────┐
                        │Reverse Proxy / LoadBalancer│
                        └──────┬──────────────┬──────┘
                               │              │
              ┌────────────────▼───┐      ┌───▼────────────────┐
              │  Bun API Instance 1│      │  Bun API Instance 2│
              │  (Hono / Elysia)   │      │  (Hono / Elysia)   │
              └────────┬───────┬───┘      └───┬───────┬────────┘
                       │       │              │       │
          ┌────────────┘       └──────┬───────┘       └────────────┐
          ▼                           ▼                            ▼
┌───────────────────┐       ┌───────────────────┐        ┌───────────────────┐
│ PostgreSQL 17/18  │       │   Redis 7.4 / 8   │        │ S3 / Cloudflare R2│
│ (PgBouncer Pool + │       │ (Cache, RateLimit,│        │ (Object Storage)  │
│  Primary/Replica) │       │  WS PubSub, Queue)│        └───────────────────┘
└─────────▲─────────┘       └─────────┬─────────┘
          │                           │
          │                 ┌─────────▼─────────┐
          └─────────────────┤ Bun Worker Fleet  │
                            │ (BullMQ Consumers)│
                            └───────────────────┘
```
