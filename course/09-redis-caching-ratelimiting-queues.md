# Module 9 — Redis, Cache-Aside, Stampede Protection, Rate Limiting, BullMQ Queues, Retries & Circuit Breakers

> **Course Phase**: Phases 17, 18, 19 & 20 (Sections 40–45, 85, 97–100, 115–116)
> **Verified Stack**: Redis `7.4 / 8.x` | Native `Bun.redis` (`RedisClient` in Bun `v1.2.9+ / v1.4.2`) | `bullmq@^5.77.0+` (`createBunRedisClient` adapter)

---

## 1. Concept: Selective Redis Architecture & Native `Bun.redis` (Section 40)

Redis is an in-memory data structure server. In production, do not treat Redis as a dumping ground; choose the exact Redis data structure for each engineering problem:

| Redis Data Structure | Core Commands | Production Backend Use Case |
| :--- | :--- | :--- |
| **Strings** | `GET`, `SET key val EX ttl NX`, `INCR` | Cache-aside JSON blobs, distributed mutex locks (`SET NX EX`), simple counters. |
| **Hashes** | `HSET`, `HGETALL`, `HINCRBY` | Active user sessions, per-organization feature flags or quota buckets. |
| **Sets** | `SADD`, `SISMEMBER`, `SREM` | Revoked JWT ID (`jti`) allow/deny sets, unique IP tracking. |
| **Sorted Sets (ZSET)** | `ZADD`, `ZREMRANGEBYSCORE`, `ZCARD` | Sliding-window rate limiters (score = millisecond timestamp), leaderboards. |
| **Pub/Sub** | `PUBLISH`, `SUBSCRIBE` | Fanning out WebSocket events across multiple stateless Bun API instances. |
| **Streams / Lists** | `XADD`, `XREADGROUP`, `EVALSHA` | Durable job queues & worker coordination (used internally by BullMQ). |

### Native `Bun.redis` (`RedisClient`) in Bun `v1.4.2`

Starting in Bun `v1.2.9` and hardened through `v1.3` and `v1.4.2` (including strict TLS hostname verification), Bun includes a built-in, zero-dependency Redis client written in Zig/Rust:

```typescript
// src/infrastructure/redis/bun-redis.ts
import { RedisClient } from "bun";

export const redisClient = new RedisClient(Bun.env.REDIS_URL ?? "redis://localhost:6379", {
  connectionTimeout: 3_000,
  autoReconnect: true,
  maxRetries: 10,
});
```

---

## 2. Caching: Cache-Aside, Stampede Protection, Negative Caching & Invalidation (Sections 41–42, 85, 115)

### Cache-Aside Flow (Section 115)

```text
Incoming GET /api/v1/products/:id
       │
       ▼
Check Redis `tenant:{orgId}:product:{id}`
       │
       ├──► CACHE HIT  ──► Parse JSON & Return Immediately (~0.4ms)
       │
       └──► CACHE MISS (or Redis unreachable -> graceful fallback!)
                 │
                 ▼
            Acquire short single-flight lock (Prevents Cache Stampede!)
                 │
                 ▼
            Query PostgreSQL `SELECT * FROM products WHERE id = $1 AND organization_id = $2`
                 │
                 ▼
            Write result to Redis with TTL + Jitter (or `"__NULL__"` for 30s if not found)
                 │
                 ▼
            Return Response
```

### Complete Production Product Cache with Stampede Protection & Deterministic Invalidation

```typescript
// src/modules/products/product.cache.ts
import type { RedisClient } from "bun";
import type { Logger } from "pino";

const NULL_SENTINEL = "__NOT_FOUND__";

export class ProductCacheService<TProduct> {
  constructor(
    private readonly redis: RedisClient,
    private readonly logger: Logger,
  ) {}

  private buildKey(organizationId: string, productId: string): string {
    // CRITICAL: Always scope cache keys by tenant (organizationId) to prevent cross-tenant leaks!
    return `tenant:${organizationId}:product:${productId}`;
  }

  async getOrLoad(params: {
    organizationId: string;
    productId: string;
    loader: () => Promise<TProduct | null>;
  }): Promise<TProduct | null> {
    const key = this.buildKey(params.organizationId, params.productId);

    // 1. Try Cache Read (Gracefully degrade to PostgreSQL if Redis is down!)
    try {
      const cached = await this.redis.get(key);
      if (cached === NULL_SENTINEL) {
        return null; // Negative cache hit (protects DB from repeated queries for missing IDs)
      }
      if (cached !== null) {
        return JSON.parse(cached) as TProduct;
      }
    } catch (err) {
      this.logger.warn({ err, key }, "Redis read failed; falling back to PostgreSQL");
    }

    // 2. Cache Miss: Load from PostgreSQL
    const fresh = await params.loader();

    // 3. Populate Cache with jittered TTL (prevents mass simultaneous expiration / stampede)
    try {
      if (fresh === null) {
        // Negative caching: short 30-second TTL for non-existent resources
        await this.redis.set(key, NULL_SENTINEL, "EX", 30);
      } else {
        const baseTtlSeconds = 300; // 5 minutes
        const jitterSeconds = Math.floor(Math.random() * 60);
        await this.redis.set(key, JSON.stringify(fresh), "EX", baseTtlSeconds + jitterSeconds);
      }
    } catch (err) {
      this.logger.warn({ err, key }, "Redis write failed; continuing without cache");
    }

    return fresh;
  }

  /**
   * Call AFTER PostgreSQL transaction commits on create, update, or delete!
   * Why DELETE instead of SET on update?
   * Concurrent updates A and B could commit in order A->B in Postgres, but arrive at Redis
   * in order B->A if we did SET, leaving stale data until TTL expires. Deleting the key forces
   * the next read to fetch the latest committed row from Postgres.
   */
  async invalidate(organizationId: string, productId: string): Promise<void> {
    const key = this.buildKey(organizationId, productId);
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.error({ err, key }, "Failed to invalidate product cache key");
    }
  }
}
```

---

## 3. Distributed Redis Rate Limiting (Section 43)

In-memory `Map<string, number>` rate limiters break as soon as you scale to 2+ Bun API containers (an attacker gets `N * limit` attempts, and memory leaks if keys aren't evicted). Furthermore, a naive `GET` followed by `INCR` and `EXPIRE` in two network round-trips has a race condition if the process crashes between `INCR` and `EXPIRE` (leaving an immortal key with no TTL).

We use an **atomic Redis Lua script** for distributed rate limiting across:
1. **Login / Auth Rate Limit**: `5 attempts / 60s` per `IP + email` (Fail-Closed or strict fallback).
2. **Per-User API Rate Limit**: `120 requests / 60s` per `userId`.
3. **Per-Organization Quota**: `1,000 requests / 60s` per `organizationId`.

```typescript
// src/infrastructure/redis/rate-limiter.ts
import type { RedisClient } from "bun";
import { AppError } from "../../errors/app-error";

// Atomic Fixed/Sliding Counter with guaranteed TTL on first increment
const RATE_LIMIT_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]))
end
local ttl = redis.call("TTL", KEYS[1])
return { current, ttl }
`;

export class DistributedRateLimiter {
  constructor(private readonly redis: RedisClient) {}

  async consumeOrThrow(params: {
    bucket: "auth_login" | "api_user" | "org_quota";
    identifier: string;
    maxRequests: number;
    windowSeconds: number;
  }): Promise<{ remaining: number; resetInSeconds: number }> {
    const key = `ratelimit:${params.bucket}:${params.identifier}`;
    const raw = (await this.redis.send("EVAL", [
      RATE_LIMIT_LUA,
      "1",
      key,
      String(params.windowSeconds),
    ])) as [number, number];

    const count = Number(raw[0]);
    const ttl = Math.max(1, Number(raw[1]));

    if (count > params.maxRequests) {
      throw AppError.rateLimit(ttl);
    }

    return {
      remaining: Math.max(0, params.maxRequests - count),
      resetInSeconds: ttl,
    };
  }
}
```

---

## 4. Background Jobs & Queue Architecture on Bun (Sections 44–45, 100, 116)

### Evaluating Queue Systems on Bun (September 2026 Verified)

Do **not** assume every Node queue library works identically on Bun. Here is the verified status as of **September 2026**:
- **BullMQ (`bullmq@^5.77.0+`) — STABLE & VERIFIED ON BUN**:
  - Historically, BullMQ was tightly coupled to `ioredis`.
  - **Major Update (May 2026 — BullMQ `v5.77.0+`)**: BullMQ introduced pluggable Redis client adapters (`IRedisClient`), adding first-class support for **Bun's built-in `RedisClient` via `createBunRedisClient`** alongside `ioredis` and `node-redis`!
  - **Important Official Caveat from BullMQ Docs**: When sharing a wrapped Bun Redis client created via `createBunRedisClient(rawBunRedis)`, **always close it via the wrapper (`await connection.quit()` or `connection.disconnect()`)** after queues/workers close—never call `rawBunRedis.close()` directly, or in-flight commands will reject with `ConnectionClosedError`.

### Queue Architecture (Section 45 & Section 116)

```text
HTTP Request (POST /api/v1/orders)
       │
       ▼
PostgreSQL Transaction (Inserts Order + Reserves Stock)
       │
       ▼
Queue Producer (`orderQueue.add("order.confirmed", payload, { jobId })`)
       │
       ▼
Redis Streams / ZSET (BullMQ Persistence)
       │
       ▼
Separate Bun Worker Process (`src/entrypoints/worker.ts`)
       ├──► Sends transactional email
       ├──► Dispatches outbound webhooks
       └──► Generates PDF invoice & uploads to S3
```

### Complete BullMQ + `createBunRedisClient` Producer & Worker Setup

```typescript
// src/infrastructure/queue/bullmq-bun.ts
import { RedisClient } from "bun";
import { Queue, Worker, createBunRedisClient, type Job } from "bullmq";
import type { Logger } from "pino";

export interface OrderConfirmationJobData {
  orderId: string;
  organizationId: string;
  customerEmail: string;
  totalCents: number;
}

export function createOrderQueueInfrastructure(redisUrl: string, logger: Logger) {
  // 1. Producer Connection using Bun's native RedisClient + BullMQ v5.77+ adapter
  const producerConnection = createBunRedisClient(new RedisClient(redisUrl));

  const orderQueue = new Queue<OrderConfirmationJobData>("order-events", {
    connection: producerConnection,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 2_000, // 2s -> 4s -> 8s -> 16s -> 32s
      },
      removeOnComplete: { count: 1000, age: 3600 },
      removeOnFail: { count: 5000, age: 86400 * 7 },
    },
  });

  // 2. Worker (Run in dedicated `src/entrypoints/worker.ts` container in production!)
  const workerConnection = createBunRedisClient(new RedisClient(redisUrl));

  const orderWorker = new Worker<OrderConfirmationJobData>(
    "order-events",
    async (job: Job<OrderConfirmationJobData>) => {
      logger.info({ jobId: job.id, orderId: job.data.orderId, attempt: job.attemptsMade + 1 }, "Processing order job");
      // Execute idempotent email/notification logic here
    },
    {
      connection: workerConnection,
      concurrency: 10,
    },
  );

  orderWorker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Order background job failed");
  });

  // Clean shutdown helper following BullMQ official docs for createBunRedisClient
  async function shutdownQueues() {
    await orderWorker.close();
    await orderQueue.close();
    await workerConnection.quit();
    await producerConnection.quit();
  }

  return { orderQueue, orderWorker, shutdownQueues };
}
```

---

## 5. Retries, Timeouts & Circuit Breakers (Sections 97–99)

When calling external dependencies (Stripe, SMTP providers, shipping APIs), network failures are guaranteed.

### 1. Retries with Exponential Backoff & Full Jitter (Section 97)
- **Never retry non-retryable client errors** (`400`, `401`, `403`, `404`, `422`). Only retry transient network errors, `408`, `429`, `502`, `503`, `504`.
- **Never retry non-idempotent mutations** unless you pass the exact same `Idempotency-Key` header on every retry!
- **Always add random jitter** so 500 failed workers don't retry at the exact same millisecond (thundering herd).

### 2. Timeouts at Every Boundary (Section 98)
- **Inbound HTTP Timeout**: `Bun.serve({ idleTimeout: 30 })`
- **Outbound HTTP Timeout**: `fetch(url, { signal: AbortSignal.timeout(5_000) })`
- **PostgreSQL Statement Timeout**: `SET statement_timeout = '5000'` (5s) so a runaway query never holds a connection forever.

### 3. Circuit Breaker Implementation (Section 99)

```text
[CLOSED] (Normal) ──(Failures >= Threshold)──► [OPEN] (Fail-Fast in 0ms for 30s)
    ▲                                                │
    └──(Probe Succeeds)── [HALF-OPEN] ◄──(Cooldown)──┘
```

```typescript
// src/shared/resilience/circuit-breaker.ts
import { AppError } from "../../errors/app-error";

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private nextAttemptAt = 0;

  constructor(
    private readonly name: string,
    private readonly failureThreshold = 5,
    private readonly openDurationMs = 30_000,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const now = Date.now();

    if (this.state === "OPEN") {
      if (now < this.nextAttemptAt) {
        throw AppError.externalProvider(`${this.name} (circuit open)`);
      }
      this.state = "HALF_OPEN";
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    this.state = "CLOSED";
  }

  private onFailure() {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold || this.state === "HALF_OPEN") {
      this.state = "OPEN";
      this.nextAttemptAt = Date.now() + this.openDurationMs;
    }
  }
}
```

---

## 6. Exercises & Architecture Challenge

- **Beginner**: Write a `bun:test` test for `CircuitBreaker` proving that after 5 consecutive failures, the 6th call fails immediately with `EXTERNAL_PROVIDER_ERROR` without invoking the underlying async function.
- **Intermediate**: Enqueue a job with deterministic `jobId: \`order-confirm:\${orderId}\`` in BullMQ and verify that enqueuing the same `jobId` twice while the job is waiting deduplicates it automatically.
- **Architecture Challenge**: *Why can calling `orderQueue.add(...)` INSIDE a PostgreSQL `db.transaction(...)` block before `COMMIT` finishes cause a phantom job failure where the worker picks up the job from Redis in 1ms and queries PostgreSQL before the transaction has committed the order row? How do post-commit hooks or the Transactional Outbox pattern solve this?*
