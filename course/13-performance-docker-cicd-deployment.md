# Module 13 — Performance Engineering, Benchmarking, Database Tuning, Docker, CI/CD, Deployment & Disaster Recovery

> **Course Phase**: Phases 28, 29, 30 & 31 (Sections 68–71, 80–84, 120–121, 130, 132–134)
> **Verified Environment**: Bun `v1.4.2`, PostgreSQL `17/18`, Docker Multi-Stage Builds, GitHub Actions

---

## 1. Performance From First Principles & Latency Breakdown (Sections 80–81, 130)

Never optimize blindly. Break every request's total latency into measurable components:

```text
Total Client Latency = Network RTT/TLS + Framework/Validation + Business Logic + Redis/DB I/O + Serialization
                       (10–40ms)         (0.05–0.2ms)           (0.1–1ms)        (1–15ms)       (0.05–0.3ms)
```

### Event Loop Blocking: The #1 Node/Bun Throughput Killer (Section 81)

```typescript
// ❌ BAD: Synchronous CPU-heavy work on the HTTP event loop
app.get("/api/v1/reports/hash-loop", (c) => {
  // Blocks the single JS thread for 250ms!
  // During these 250ms, `/liveness`, `/orders`, and WebSockets CANNOT process a single packet!
  let acc = "seed";
  for (let i = 0; i < 500_000; i++) {
    acc = new Bun.CryptoHasher("sha256").update(acc).digest("hex");
  }
  return c.json({ acc });
});
```

**Three Ways to Fix Event-Loop Blocking**:
1. **Algorithmic Optimization**: Replace `O(N^2)` array `.find()` loops inside `.map()` with a precomputed `Map<string, Item>` (`O(1)` lookup).
2. **Bun `Worker` Thread**: Offload sub-second CPU work (image resize, CSV parsing) to a worker pool so the main HTTP loop stays below `<2ms` event-loop lag.
3. **BullMQ Background Queue**: Offload multi-second work (report generation, bulk exports) to the separate `worker` deployment and stream progress via SSE.

---

## 2. Responsible Load Testing & Benchmarking (Sections 82–83, 120)

### Rules of Honest Backend Benchmarking
1. **Never present a synthetic `Hello World` benchmark as proof of production database API speed.**
2. **Always control and report**: Hardware (CPU model, cores, RAM), OS kernel, exact runtime versions (`Bun v1.4.2`, `Hono v4.13.10`, `Elysia v1.4.30`), warmup duration (`5s` JIT warmup before measuring), concurrency (`50` or `100` keep-alive connections), payload size, and latency percentiles (**p50, p95, p99**—never just average RPS!).

### Controlled Benchmark Exercise Script (`Bun.serve` vs `Hono` vs `Elysia`)

```typescript
// benchmarks/compare-adapters.ts
import { Hono } from "hono";
import { Elysia } from "elysia";

const payload = { status: "ok", items: [1, 2, 3, 4, 5] };

// 1. Raw Bun.serve
const rawServer = Bun.serve({
  port: 4001,
  routes: {
    "/json": () => Response.json(payload),
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

// 2. Hono v4.13.x on Bun
const honoApp = new Hono().get("/json", (c) => c.json(payload));
const honoServer = Bun.serve({ port: 4002, fetch: honoApp.fetch });

// 3. Elysia v1.4.30 on Bun
const elysiaApp = new Elysia().get("/json", () => payload).listen(4003);

console.log("Benchmark servers ready on ports 4001 (Bun.serve), 4002 (Hono), 4003 (Elysia)");
console.log("Run: bunx autocannon -c 100 -d 10 -w 4 http://localhost:4001/json");
```

---

## 3. Database Performance (`EXPLAIN ANALYZE`) & Connection Management (Sections 68, 84)

### Reading `EXPLAIN (ANALYZE, BUFFERS)` in PostgreSQL
Before shipping any complex query, run:
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, sku, name, price_cents
FROM products
WHERE organization_id = '01923c8a-7b00-7000-8000-000000000001'
ORDER BY id DESC
LIMIT 21;
```
- **What you want to see**: `Index Scan using idx_products_org_id_desc on products (actual time=0.042..0.058 rows=21 loops=1)` with `Buffers: shared hit=4`.
- **Red flags**: `Seq Scan on products` on large tables, `Rows Removed by Filter: 450000`, or external disk `Sort Method: external merge Disk: ...`.

### Database Connection Management Across Deployment Topologies (Section 68)

PostgreSQL spawns a separate OS process per backend connection (~5–10 MB RAM each). Opening 500 direct connections degrades PostgreSQL due to lock contention and context switching.

```text
Formula for Optimal Active DB Connections on PostgreSQL Primary:
max_active_queries ≈ (CPU_Cores * 2) + Effective_Spindle_Count
(e.g., 4 vCPU Postgres instance performs best around 10–20 active concurrent queries, max ~100 connections)
```

| Deployment Topology | Connection Pool Strategy | Pool Size per Process (`max`) |
| :--- | :--- | :--- |
| **Single Bun Container** | Direct pool to PostgreSQL (`Bun.sql` / `postgres({ max: 20 })`) | `max: 20` |
| **4 Bun API Containers + 2 Worker Containers** | Direct pool OR PgBouncer (`4 * 15 + 2 * 10 = 80` total connections) | `max: 15` (API), `max: 10` (Worker) |
| **Autoscaling Containers / Serverless (Vercel Bun)** | **Mandatory Connection Pooler** (PgBouncer, Supabase Pooler, Neon Proxy, or AWS RDS Proxy) | `max: 1` to `5` per ephemeral instance, with `idle_timeout: 20` |

---

## 4. Deployment Runtime Compatibility Matrix (Section 69)

> **"Just because a framework runs on Bun locally does not mean every deployment target behaves identically."**

| Platform | Runtime Engine | `Bun.serve` & Native APIs? | WebSockets? | Persistent Filesystem? | DB Connection Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Docker on VPS / AWS ECS / Kubernetes** | **Full Bun `v1.4.2`** | Yes (100% native `Bun.*`) | Yes (Long-lived stateful WS) | Ephemeral unless Volume mounted (use S3!) | Persistent connection pool (`max: 15`) |
| **Fly.io / Railway / Render** | **Full Bun `v1.4.2` Container** | Yes (100% native `Bun.*`) | Yes | Ephemeral container rootfs (use S3/R2) | Persistent connection pool |
| **Vercel (Bun Runtime, Oct 2025+)** | **Bun Serverless Functions** | `Bun.*` APIs supported; HTTP lifecycle managed by Vercel invoke | **No** long-lived stateful WS (use external pusher/Ably or container host) | Read-only except `/tmp` | Ephemeral cold/warm instances -> **Must use pooled DB URL** |
| **Cloudflare Workers** | **Cloudflare `workerd` (V8 isolates)** | **No `Bun.*` APIs!** Hono runs natively because Hono uses Web Standards | Yes (via Cloudflare Durable Objects / WebSocketPair) | No local FS (use Cloudflare R2 / KV / D1) | Hyperdrive or HTTP/WebSocket serverless driver |

### When to Use Bun vs When Node.js Is a Safer Choice (Section 121)
- **Choose Bun (`v1.4.2`) when**: You want sub-15ms startup, unified TypeScript/test/package tooling, native `Bun.serve` + `Bun.sql` + `Bun.redis` + `Bun.s3` + `Bun.password`, and your stack uses modern Web-standard frameworks (Hono / Elysia).
- **Choose Node.js (`v22 / v24 LTS`) when**: You depend on legacy V8 C++ native addons (`nan` / `v8.h`), mandate strict enterprise FIPS-certified OpenSSL builds required by government compliance regimes, or rely on proprietary legacy enterprise APM agents that only support Node's V8 inspector hooks.

---

## 5. Production Docker & Docker Compose Setup (Section 70)

See [`examples/capstone-saas-reference/Dockerfile`](../../examples/capstone-saas-reference/Dockerfile) and [`examples/capstone-saas-reference/docker-compose.yml`](../../examples/capstone-saas-reference/docker-compose.yml). Key production hardening rules:
1. Pin exact image tags (`oven/bun:1.4.2-alpine` or `oven/bun:1.4.2-slim`).
2. Use multi-stage builds (`deps` → `test/typecheck` → minimal `runtime`).
3. **Never run as `root` inside the container**: Run as `USER bun` (UID 1000).
4. Include a container `HEALTHCHECK` probing `http://127.0.0.1:3000/liveness`.
5. Run `api` and `worker` as separate services from the same image (`command: ["bun", "run", "src/entrypoints/api.ts"]` vs `command: ["bun", "run", "src/entrypoints/worker.ts"]`).

---

## 6. Production CI/CD Pipeline (GitHub Actions) (Section 71)

```yaml
# .github/workflows/ci-cd.yml
name: Production Backend CI/CD
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: testpassword
          POSTGRES_DB: app_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 3s
          --health-retries 5
      redis:
        image: redis:7.4-alpine
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.4.2"
      - name: Install Dependencies (Deterministic Lockfile)
        run: bun install --frozen-lockfile
      - name: Audit Dependencies for High/Critical CVEs
        run: bun audit --audit-level=high
      - name: TypeScript Compile-Time Verification
        run: bun run typecheck
      - name: Run Unit, Integration & Security Tests
        env:
          NODE_ENV: test
          DATABASE_URL: postgres://app:testpassword@localhost:5432/app_test
          REDIS_URL: redis://localhost:6379
          JWT_SECRET: test_jwt_secret_at_least_32_characters_long_123
          WEBHOOK_SECRET: whsec_test_secret_at_least_24_chars
        run: bun test --coverage
      - name: Build & Verify Docker Image
        run: docker build -t acme-commerce-backend:${{ github.sha }} .
```

---

## 7. Production Readiness Checklist, Failure Scenarios & Disaster Recovery (Sections 132–134)

### Production Readiness Checklist (Section 132)
- [ ] **Security & Auth**: Argon2id hashing (`Bun.password`); constant-time login; 10m Access JWT + SHA-256 hashed Refresh Token family rotation; `__Host-` `HttpOnly; Secure; SameSite=Lax` cookies; CSRF Origin check; SSRF guard; magic-byte file verification; HSTS/CSP headers.
- [ ] **Multi-Tenancy**: Every tenant table has `organization_id`; every repository query filters by `organization_id`; Redis keys prefixed with `tenant:${orgId}:`.
- [ ] **Validation & Errors**: Zod v4 / Standard Schema on all `params`, `query`, `headers`, `body`; `bodyLimit` configured; `AppError` global handler strips SQL/stack traces.
- [ ] **Database & Transactions**: UUIDv7 primary keys; `CHECK` constraints on non-negative money/stock; sorted lock order + atomic conditional `UPDATE` for inventory; statement timeouts configured.
- [ ] **Resilience & Observability**: Pino JSON logs with secret redaction; `X-Request-Id` propagation; `/liveness` vs `/readiness` split; `SIGTERM` graceful drain; `AbortSignal.timeout()` on all outbound `fetch` calls.

### Expected Behavior Under 10 Production Failure Scenarios (Section 133)

| Failure Scenario | Expected Production System Behavior |
| :--- | :--- |
| **1. Redis is unavailable** | Product cache-aside logs a warning and falls back to PostgreSQL (`getOrLoad`). Read endpoints remain up! |
| **2. PostgreSQL is slow** | `statement_timeout (5s)` cancels runaway queries; connection pool queues up to `connectionTimeout (3s)` then fails fast with `503` instead of hanging forever; `/readiness` returns `503`. |
| **3. Email provider is down** | Registration and Order HTTP requests still succeed in `<30ms` because email is queued in BullMQ. Workers retry with exponential backoff (`2s, 4s, 8s, 16s, 32s`). |
| **4. Payment provider times out** | Outbound `fetch` aborts at `5s` via `AbortSignal.timeout(5000)`; `CircuitBreaker` opens after 5 consecutive failures; retries reuse the exact same `Idempotency-Key`. |
| **5. Queue (Redis) is unavailable during checkout** | Either fail the request before committing if synchronous queue guarantee is required, or write to a PostgreSQL `outbox_events` table inside the same ACID transaction and have a poller flush to BullMQ when Redis recovers. |
| **6. One API instance dies (`SIGKILL` / hardware loss)** | Load balancer fails health check within seconds and routes traffic to remaining instances; because sessions/cache live in Redis/Postgres (not local RAM), zero users are logged out. |
| **7. Multiple workers pick up or retry the same job** | Job handlers use deterministic `jobId` and database `ON CONFLICT DO NOTHING` / status checks so executing a job twice is a safe no-op. |
| **8. Webhook delivered 5 times concurrently** | `INSERT INTO webhook_events (provider_event_id) ... ON CONFLICT DO NOTHING` ensures only 1 transaction mutates order state; the other 4 return `200 OK` immediately. |
| **9. Client sends the same order POST twice** | `uq_orders_org_idempotency` constraint + `Idempotency-Key` check returns the original order (`200`/`201`) or `409 IDEMPOTENCY_CONFLICT` if still in-flight. |
| **10. DB connection pool exhausted** | Pool rejects new acquisitions after `3s` timeout with a monitored `503` error rather than queuing infinitely in memory until `OOMKilled`. |

### Disaster Recovery Thinking: RPO, RTO & Backups (Section 134)
- **RPO (Recovery Point Objective)**: *How much data can we afford to lose in a catastrophe?* With PostgreSQL continuous WAL archiving (Point-in-Time Recovery / PITR to S3), RPO is **< 1 minute** (or **0** with synchronous standby replication).
- **RTO (Recovery Time Objective)**: *How long does it take to restore service?* With automated standby promotion and stateless Bun containers, RTO is **< 5 minutes**.
- **Golden Rule of Backups**: *An untested backup is not a backup.* Automate monthly restore drills that spin up a temporary PostgreSQL instance from the latest WAL snapshot and run verification queries.
