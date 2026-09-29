# Module 12 — Backend Security (OWASP), Environment & Secrets, Observability (Pino & OpenTelemetry), Health Checks, Graceful Shutdown & Testing

> **Course Phase**: Phases 25, 26 & 27 (Sections 59–67, 72–79, 104, 131)
> **Verified Tools**: `pino@^9.x`, `@opentelemetry/api`, `@opentelemetry/sdk-node`, `bun:test`

---

## 1. Comprehensive Backend Security Module (OWASP & Beyond) (Sections 59–60, 104)

### Defending Against OWASP Top 10 & Runtime Threats

| Threat | How It Happens in Backend Code | Production Defense in Our Bun Stack |
| :--- | :--- | :--- |
| **1. Broken Access Control (IDOR / BOLA)** | Querying `WHERE id = $1` without `AND organization_id = $2`. | Mandatory `organizationId` parameter in every service & repository signature (Module 8). |
| **2. Injection (SQL & Command)** | String concatenation in SQL (`sql.raw(\`... \${input}\`)`) or shell execution (`sh -c`). | Parameterized Drizzle queries / `Bun.sql` tagged templates; array args in `Bun.spawn([bin, arg])`. |
| **3. SSRF (Server-Side Request Forgery)** | Server fetches a user-supplied URL (e.g., webhook target or avatar URL) pointing to `http://169.254.169.254/latest/meta-data/` (cloud metadata) or `http://127.0.0.1:6379`. | Parse URL, enforce `https:`, resolve DNS, and reject loopback (`127.0.0.0/8`, `::1`), RFC1918 private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and link-local (`169.254.0.0/16`) IPs! |
| **4. Prototype Pollution** | Deep-merging untrusted JSON containing `{"__proto__": {"isAdmin": true}}` or `{"constructor": {"prototype": ...}}`. | Never recursively merge raw `req.json()`. Parse through Zod v4 / TypeBox first, which constructs clean objects with only schema-defined keys. |
| **5. Path Traversal** | Joining user input `../../etc/passwd` into `Bun.file(path.join(baseDir, userInput))`. | Never use user filenames on disk; validate `path.resolve(baseDir, target).startsWith(path.resolve(baseDir) + path.sep)`. |
| **6. HTTP Request Smuggling** | Discrepancy in `Content-Length` vs `Transfer-Encoding: chunked` between proxy and backend. | Bun `v1.4` hardened `Bun.serve()` HTTP parser to reject any `Transfer-Encoding` other than a single trailing `chunked` with `400 Bad Request` and cap chunk extensions. |

### SSRF Guard Implementation

```typescript
// src/shared/security/ssrf-guard.ts
import { AppError } from "../../errors/app-error";

const BLOCKED_IPV4_PREFIXES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./, // AWS / GCP / Cloud Metadata service!
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^0\./,
];

export function assertSafeExternalUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw AppError.validation("Invalid URL format");
  }

  if (parsed.protocol !== "https:") {
    throw AppError.validation("Only HTTPS outbound URLs are permitted");
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    BLOCKED_IPV4_PREFIXES.some((regex) => regex.test(host))
  ) {
    throw AppError.validation("Outbound requests to private, loopback, or metadata addresses are forbidden");
  }

  return parsed;
}
```

---

## 2. Secret Management & Bun Environment Variables (Sections 61–62)

### Bun's `.env` Loading Precedence
Bun automatically loads `.env` files in the following order (highest precedence first):
1. Shell environment variables passed directly to the process (`DATABASE_URL=... bun run ...`)
2. `.env.${NODE_ENV}.local` (e.g., `.env.development.local`, `.env.test.local`)
3. `.env.local` *(Note: skipped when `NODE_ENV=test` for deterministic test runs!)*
4. `.env.${NODE_ENV}`
5. `.env`

> **Production Rule for Standalone Binaries (`bun build --compile`)**: In Bun `v1.3.3+ / v1.4.2`, you can disable automatic `.env` / `bunfig.toml` file loading in compiled binaries if you want configuration injected strictly from your container orchestrator's secret store (AWS Secrets Manager, Doppler, Vault, Kubernetes Secrets).

### Fail-Fast Startup Environment Validation with Zod v4

Never read `Bun.env.JWT_SECRET!` lazily inside a route handler 3 hours after deployment. Validate **all** required environment variables at process startup:

```typescript
// src/config/env.ts
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ message: "DATABASE_URL must be a valid PostgreSQL connection string" }),
  REDIS_URL: z.url({ message: "REDIS_URL must be a valid Redis connection string" }),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  WEBHOOK_SECRET: z.string().min(24, "WEBHOOK_SECRET must be at least 24 characters"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((val) => val.split(",").map((s) => s.trim())),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(rawEnv: Record<string, string | undefined> = Bun.env): AppConfig {
  const parsed = EnvSchema.safeParse(rawEnv);
  if (!parsed.success) {
    console.error("❌ Invalid environment configuration at startup:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}
```

---

## 3. Observability: Structured Logging (`Pino`) & OpenTelemetry on Bun (Sections 63–65, 131)

### Structured JSON Logging with Secret Redaction (Section 64)

Never use `console.log("User logged in:", user)` in production—it prints unindexed multi-line text and risks dumping `passwordHash` or tokens to CloudWatch/Datadog. Use **Pino** with strict path redaction:

```typescript
// src/infrastructure/logger/pino.ts
import pino from "pino";

export const logger = pino({
  level: Bun.env.LOG_LEVEL ?? "info",
  // Redact sensitive fields at any nesting depth before JSON serialization!
  redact: {
    paths: [
      "password",
      "*.password",
      "passwordHash",
      "*.passwordHash",
      "token",
      "*.token",
      "accessToken",
      "refreshToken",
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
    censor: "[REDACTED]",
  },
  base: {
    service: "commerce-api",
    runtime: `bun-${Bun.version}`,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
```

### OpenTelemetry on Bun: Honest Engineering Assessment (Section 65)

**Do Node.js OpenTelemetry auto-instrumentations work automatically on Bun?**
**No — not 100%. Here is the exact engineering truth as of September 2026:**
1. **What Works Well on Bun**:
   - `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-node` (`BatchSpanProcessor`), `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, and `@opentelemetry/context-async-hooks` (`AsyncLocalStorageContextManager`, which became **2x faster in Bun `v1.4.1`**).
   - Framework-level OpenTelemetry middleware: **`@hono/otel`** for Hono and **`@elysiajs/opentelemetry`** for Elysia both work reliably because they hook directly into the framework's middleware/lifecycle pipeline rather than relying on CJS `require`-in-the-middle monkey-patching.
2. **What Does NOT Work Automatically**:
   - `@opentelemetry/auto-instrumentations-node` relies on monkey-patching Node's `node:http` and CommonJS module loads. It **does not** automatically instrument `Bun.serve()`, `Bun.sql`, or `Bun.redis` because those are native Bun primitives, not Node userland CJS modules!
3. **Production Solution on Bun**:
   - Use `@hono/otel` or `@elysiajs/opentelemetry` for inbound HTTP spans, W3C `traceparent` header propagation, and outbound `fetch` spans.
   - Wrap your `Repository` / `Bun.sql` / `Bun.redis` helper with a lightweight 10-line `tracer.startActiveSpan("db.query", ...)` helper so every database and cache operation produces accurate child spans in Jaeger / Grafana Tempo / Honeycomb / Datadog.

---

## 4. Health Checks (`/health`, `/liveness`, `/readiness`) & Graceful Shutdown (Sections 66–67)

### Why `/liveness` and `/readiness` Must Be Separate Endpoints (Section 66)

| Endpoint | Who Calls It | What It Checks | What Happens on Failure (`503`) |
| :--- | :--- | :--- | :--- |
| **`GET /liveness`** | Kubernetes `livenessProbe` / Docker / Fly.io | **Only** whether the Bun event loop is alive (`return Response.json({ status: "alive" })`). Never check Postgres/Redis here! | Container orchestrator **kills and restarts** the container. (If `/liveness` checked Postgres, a temporary 3s DB blip would cause Kubernetes to restart all your API pods simultaneously!). |
| **`GET /readiness`** | Load Balancer / Kubernetes `readinessProbe` | Checks `isShuttingDown === false` AND runs `SELECT 1` on PostgreSQL + `PING` on Redis with a 1.5s timeout. | Load balancer **stops sending new traffic** to this instance while keeping the process alive to recover or finish draining. |
| **`GET /health`** | Monitoring / Status Page | Detailed component health report (`db`, `redis`, `uptimeSeconds`). | Alerts on-call engineers. |

### Complete Graceful Shutdown Implementation (`SIGTERM` / `SIGINT`) (Section 67)

```typescript
// src/entrypoints/graceful-shutdown.ts
import type { Server } from "bun";
import type { Logger } from "pino";

export function registerGracefulShutdown(params: {
  server: Server;
  logger: Logger;
  onDrainStateChange: (isShuttingDown: boolean) => void;
  closeResources: () => Promise<void>;
}) {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    params.onDrainStateChange(true); // Immediately makes `GET /readiness` return 503!

    params.logger.info({ signal }, "Received shutdown signal; starting graceful drain");

    // Hard timeout guard: if draining hangs beyond 15s, exit with code 1
    const forceExitTimer = setTimeout(() => {
      params.logger.error("Graceful shutdown timed out after 15s; forcing exit");
      process.exit(1);
    }, 15_000);
    forceExitTimer.unref();

    try {
      // 1. Stop accepting new connections; wait for in-flight HTTP requests to complete
      // (`false` = do not abruptly terminate active requests; fixed/hardened in Bun 1.3+)
      await params.server.stop(false);

      // 2. Close BullMQ workers/queues, Redis clients, and PostgreSQL connection pools
      await params.closeResources();

      params.logger.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      params.logger.error({ err }, "Error during graceful shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
```

---

## 5. Comprehensive Testing Strategy (`bun:test`) (Sections 72–79)

We structure our test suite around the **Backend Testing Pyramid** using `bun:test` + `app.request()` (Hono) / `app.handle()` (Elysia):

1. **Unit Tests (Section 73)**: Fast (<1ms per test), zero network/DB I/O. Tests domain services, RBAC policies (`hasPermission`), Zod v4 schemas, `detectMimeFromMagicBytes`, `WebhookSignatureVerifier`, and `CircuitBreaker`.
2. **Integration Tests (Sections 74 & 76)**: Tests Repositories + Services against **real PostgreSQL and Redis** (spun up via `docker compose up -d postgres-test redis-test` or Testcontainers). Each test runs inside a database transaction that rolls back (or truncates tables) for isolation.
3. **E2E API Flow Tests (Section 75)**: Exercises the complete lifecycle through HTTP requests (`Register -> Login -> Create Organization -> Create Product -> Create Order -> Cancel Order -> Logout`).
4. **Auth & Security Tests (Sections 77–78)**: Explicitly tests negative security cases:
   - Expired JWT (`exp` in the past) → `401`
   - Replayed Refresh Token → `401` + family revoked
   - Cross-Tenant IDOR (`Org B` querying `Org A` order ID) → `404`
   - SQL Injection payload (`?search=' OR 1=1 --`) → safely parameterized, returns 0 matching rows
   - Oversized payload (`> 1MB`) → `413 Payload Too Large`
   - Disguised HTML file upload → `422 Validation Error`
5. **Contract Tests (Section 79)**: Validates actual HTTP responses against the generated OpenAPI 3.1 schema so implementation never drifts from documentation.

---

## 6. Exercises & Architecture Challenge

- **Beginner**: Write a `bun:test` security test verifying that `assertSafeExternalUrl` rejects `http://169.254.169.254/latest/meta-data/`, `https://127.0.0.1/admin`, and `https://10.0.0.1/internal`.
- **Intermediate**: Implement `/liveness` and `/readiness` routes and test that calling `onDrainStateChange(true)` during `SIGTERM` causes `/readiness` to immediately return `503 Service Unavailable` while `/liveness` still returns `200 OK`.
- **Architecture Challenge**: *During a rolling deployment on Kubernetes or Fly.io, when a pod receives `SIGTERM`, the load balancer might take 1–2 seconds to remove the pod from its active endpoint list. Why should you flip `isShuttingDown = true` (making `/readiness` return `503`) and wait ~2 seconds before calling `server.stop()` in high-traffic environments?*
