# Module 14 — Production Debugging Training: 19 Real-World Backend Incidents

> **Course Section**: Section 119
> **Methodology**: Every scenario includes **(1) Broken Code**, **(2) Symptoms**, **(3) Reproduction**, **(4) Root Cause**, **(5) Production Fix**, and **(6) Mental Model**.

---

## Bug 1: Wrong Middleware Order (Auth Registered Before CORS)

1. **Broken Code**:
   ```typescript
   app.use("/api/*", authMiddleware);
   app.use("/api/*", cors({ origin: "https://app.acme.com", credentials: true }));
   ```
2. **Symptoms**: Postman and `curl` work fine, but every browser `fetch("https://api.acme.com/api/v1/orders", { headers: { Authorization: "Bearer ..." } })` fails in Chrome/Firefox console with `CORS error: Response to preflight request doesn't pass access control check`.
3. **Reproduction**: Send `curl -i -X OPTIONS https://api.acme.com/api/v1/orders -H "Origin: https://app.acme.com" -H "Access-Control-Request-Method: POST"`. It returns `401 Unauthorized` with no `Access-Control-Allow-Origin` header.
4. **Root Cause**: Browser `OPTIONS` preflight requests **never** include the `Authorization` header per the Fetch specification. Because `authMiddleware` ran before `cors()`, the preflight was rejected with `401`.
5. **Fix**: Register `requestId` → `logger` → `secureHeaders` → **`cors`** → `rateLimiter` → `authMiddleware`.
6. **Mental Model**: CORS preflight is an unauthenticated capability negotiation between the browser and the HTTP perimeter; it must execute before authentication.

---

## Bug 2: Missing Runtime Validation (Trusting TypeScript `as` Casts)

1. **Broken Code**:
   ```typescript
   interface TransferDto { amountCents: number; toAccountId: string }
   app.post("/transfer", async (c) => {
     const body = (await c.req.json()) as TransferDto;
     await walletService.transfer(c.get("actor").userId, body.toAccountId, body.amountCents);
   });
   ```
2. **Symptoms**: An attacker drains funds from another account into their own by sending `{"amountCents": -500000, "toAccountId": "victim_id"}` or crashes the query with `{"amountCents": "NaN"}`.
3. **Reproduction**: `curl -X POST /transfer -d '{"amountCents": -10000, "toAccountId": "..."}'`.
4. **Root Cause**: `as TransferDto` is erased at compile time; negative numbers and non-numbers pass right through to the SQL `UPDATE balance = balance - $amount`.
5. **Fix**: Validate with `zValidator("json", z.object({ amountCents: z.number().int().positive(), toAccountId: z.uuid() }))` AND add a PostgreSQL `CHECK (balance_cents >= 0)` constraint.
6. **Mental Model**: TypeScript protects developers from typos; Runtime Schemas + DB Constraints protect servers from attackers.

---

## Bug 3: Invalid Schema Coercion (`z.coerce.boolean()` on Query Strings)

1. **Broken Code**:
   ```typescript
   const QuerySchema = z.object({ archived: z.coerce.boolean().default(false) });
   ```
2. **Symptoms**: Client requests `GET /api/v1/products?archived=false`, but the API returns **archived** products (`archived === true`)!
3. **Reproduction**: Run `z.coerce.boolean().parse("false")` in `bun repl` -> returns `true`!
4. **Root Cause**: `z.coerce.boolean()` calls JavaScript's `Boolean(val)`. In JS, any non-empty string (`Boolean("false")`) evaluates to `true`.
5. **Fix**: Use Zod v4's `z.stringbool()` or `z.enum(["true", "false"]).transform((v) => v === "true")`.
6. **Mental Model**: HTTP query strings are always strings; never pass raw strings to `Boolean()`.

---

## Bug 4: Incorrect JWT Verification (Algorithm / Issuer / Secret Confusion)

1. **Broken Code**:
   ```typescript
   const payload = jwt.decode(token); // ❌ Uses decode() instead of verify()!
   ```
2. **Symptoms**: Any user can forge an admin token using jwt.io with a fake signature and gain full access.
3. **Reproduction**: Modify the base64 payload of any JWT to `{"sub":"admin","role":"owner"}` while keeping a garbage signature; endpoint accepts it.
4. **Root Cause**: `decode()` only base64-decodes the payload without verifying the cryptographic signature.
5. **Fix**: Use `await jwtVerify(token, secretKey, { algorithms: ["HS256"], issuer, audience })` from `jose`.
6. **Mental Model**: A JWT without signature verification is just a postcard written in Base64.

---

## Bug 5: Authorization Bypass (Checking Role Globally Instead of Per-Organization)

1. **Broken Code**:
   ```typescript
   // Checks if user is an "owner" of ANY organization, not the target `:orgId`!
   const isOwnerSomewhere = await db.query.memberships.findFirst({
     where: and(eq(memberships.userId, userId), eq(memberships.role, "owner")),
   });
   if (!isOwnerSomewhere) throw AppError.forbidden();
   ```
2. **Symptoms**: Any user who signs up and creates their own free organization (becoming its `owner`) can delete or modify **any other organization** on the platform!
3. **Reproduction**: User B creates `Org B` (role=`owner`), then calls `DELETE /api/v1/organizations/<Org_A_ID>`.
4. **Root Cause**: Role check omitted `eq(memberships.organizationId, targetOrgId)`.
5. **Fix**: Always resolve membership using composite key `(user_id, organization_id)`.
6. **Mental Model**: In multi-tenant RBAC, a role only exists in the context of a specific `(userId, organizationId)` tuple.

---

## Bug 6: Cross-Tenant Data Leak (IDOR in Repository & Redis Cache)

1. **Broken Code**:
   ```typescript
   const cached = await redis.get(`product:${productId}`);
   if (cached) return JSON.parse(cached);
   const [row] = await db.select().from(products).where(eq(products.id, productId));
   ```
2. **Symptoms**: Users in Organization B can view private pricing and products belonging to Organization A if they guess or obtain a product UUID.
3. **Reproduction**: Query `GET /api/v1/products/<orgA_product_uuid>` using an Organization B token.
4. **Root Cause**: Neither the Redis cache key nor the SQL `WHERE` clause constrained by `organizationId`.
5. **Fix**: Key Redis as `tenant:${organizationId}:product:${productId}` and SQL as `WHERE id = $1 AND organization_id = $2`.
6. **Mental Model**: Tenant isolation must be enforced at both the cache key namespace and the SQL `WHERE` clause.

---

## Bug 7: Duplicate Webhook Execution (Race Condition on Concurrent Delivery)

1. **Broken Code**:
   ```typescript
   const existing = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, event.id));
   if (existing.length > 0) return c.json({ ok: true });
   await creditCustomerWallet(event.data.userId, event.data.amountCents);
   await db.insert(webhookEvents).values({ eventId: event.id });
   ```
2. **Symptoms**: Customer wallet is credited twice when the payment provider retries or delivers duplicate webhook packets within 5ms of each other.
3. **Reproduction**: Fire `Promise.all([sendWebhook(event1), sendWebhook(event1)])`. Both `SELECT` queries return `[]` before either reaches `INSERT`.
4. **Root Cause**: Classic Check-Then-Act (TOCTOU) race condition outside a database lock/constraint.
5. **Fix**: Inside a single ACID transaction, run `INSERT INTO webhook_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING RETURNING id`. If `returned.length === 0`, abort/return early; otherwise credit the wallet in the same transaction.
6. **Mental Model**: Never use `SELECT` then `INSERT` for idempotency; let PostgreSQL's `UNIQUE` index arbitrate concurrency atomically.

---

## Bug 8: Refresh Token Reuse Without Family Revocation

1. **Broken Code**:
   ```typescript
   // Deletes old refresh token on rotation instead of keeping it marked `revoked_at` with a `family_id`
   await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, hash));
   ```
2. **Symptoms**: When an attacker steals a refresh token and rotates it first, the legitimate user's next refresh attempt simply returns `401 Token Not Found`, leaving the attacker's newly rotated token completely active!
3. **Reproduction**: Rotate token once (attacker), then present original token again (victim). Attacker's new token still works.
4. **Root Cause**: Because the rotated token row was deleted instead of marked `used/revoked` under a `family_id`, the server cannot distinguish "expired/unknown token" from "replay of an already-rotated token in an active family."
5. **Fix**: Keep rotated tokens in the table with `revoked_at` and `family_id`. If a request presents a token where `revoked_at IS NOT NULL`, execute `UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $familyId`.
6. **Mental Model**: Refresh token reuse is a high-signal intrusion indicator; when detected, burn the entire token family.

---

## Bug 9: Stale Cache Due to Write-Update Race (`SET` Instead of `DEL`)

1. **Broken Code**:
   ```typescript
   await db.update(products).set({ priceCents }).where(eq(products.id, id));
   await redis.set(`tenant:${orgId}:product:${id}`, JSON.stringify(updatedProduct), "EX", 300);
   ```
2. **Symptoms**: Concurrent updates `price=100` (Req A) and `price=200` (Req B) leave PostgreSQL with `price=200`, but Redis serves `price=100` for the next 5 minutes!
3. **Reproduction**: Req A commits DB at `t=1ms`, pauses on GC/network, Req B commits DB at `t=2ms` and writes `price=200` to Redis at `t=3ms`, then Req A writes `price=100` to Redis at `t=4ms`.
4. **Root Cause**: Out-of-order dual writes between PostgreSQL and Redis.
5. **Fix**: **Delete (`redis.del(key)`)** the cache key after the PostgreSQL transaction commits instead of overwriting it with `SET`.
6. **Mental Model**: Cache invalidation via `DEL` is idempotent and forces the next reader to load the true post-commit state from PostgreSQL.

---

## Bug 10: Cache Stampede (Thundering Herd on Hot Key Expiration)

1. **Broken Code**: A homepage catalog cache key (`TTL = 60s`) expires under 2,000 req/s load, and all 2,000 concurrent requests miss Redis simultaneously and execute a heavy 80ms SQL aggregation query.
2. **Symptoms**: Every 60 seconds, PostgreSQL CPU spikes to 100% and API p99 latency jumps from 2ms to 4,000ms.
3. **Reproduction**: Run `autocannon -c 200` against an endpoint whose Redis key is about to expire.
4. **Root Cause**: No single-flight coalescing or TTL jitter on hot cache keys.
5. **Fix**: Use in-process promise coalescing (`inFlightMap.get(key)`) + Redis distributed lock (`SET lock:key 1 NX PX 3000`) + TTL jitter (`300 + random(0..60)`).
6. **Mental Model**: Only one worker should recompute an expired hot cache key while concurrent callers wait or serve slightly stale data.

---

## Bug 11: N+1 Database Query in Order Listing

1. **Broken Code**:
   ```typescript
   const orderList = await db.select().from(orders).where(eq(orders.organizationId, orgId)).limit(50);
   for (const order of orderList) {
     // ❌ Executes 50 separate round-trip SQL queries inside a loop!
     order.items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
   }
   ```
2. **Symptoms**: `GET /api/v1/orders?limit=50` takes 350ms and logs 51 SQL queries per HTTP request.
3. **Reproduction**: Enable query logging and fetch 50 orders.
4. **Root Cause**: Querying child rows inside a `for` loop (`1 + N` round trips).
5. **Fix**: Fetch all items for the 50 orders in **1 second query** using `inArray(orderItems.orderId, orderList.map(o => o.id))` (or a SQL `JOIN` / Drizzle relational `with: { items: true }`), always making sure to guard `orderList.length > 0` first.
6. **Mental Model**: Latency scales with network round-trips to PostgreSQL; 2 queries for 50 orders beats 51 queries by an order of magnitude.

---

## Bug 12: Database Connection Pool Exhaustion (Instantiating DB Client Inside Handler)

1. **Broken Code**:
   ```typescript
   app.get("/products", async (c) => {
     const sql = postgres(Bun.env.DATABASE_URL!); // ❌ New pool created on EVERY HTTP request!
     const rows = await sql`SELECT * FROM products LIMIT 10`;
     return c.json({ data: rows });
   });
   ```
2. **Symptoms**: After ~100 requests, PostgreSQL rejects all queries with `FATAL: sorry, too many clients already (53300)`.
3. **Reproduction**: Run 120 requests against `/products`.
4. **Root Cause**: Creating a new connection pool inside a request handler leaks open TCP connections until PostgreSQL hits `max_connections`.
5. **Fix**: Instantiate the connection pool **once** as a singleton in `src/infrastructure/db/client.ts` and close it only on `SIGTERM`.
6. **Mental Model**: Connection pools are process-lifetime infrastructure singletons, never request-scoped objects.

---

## Bug 13: Event-Loop Blocking via Synchronous Regex / JSON / Crypto on Large Payloads

1. **Broken Code**: Using a catastrophic backtracking regular expression `/(a+)+$/` to validate user descriptions or hashing 50 passwords synchronously in a bulk import endpoint.
2. **Symptoms**: `/liveness` health checks time out and Kubernetes restarts the pod whenever a user submits a specific input string.
3. **Reproduction**: Send `"aaaaaaaaaaaaaaaaaaaaaaaaaaaa!"` to the vulnerable regex validator.
4. **Root Cause**: Exponential backtracking (`ReDoS`) locks the single JavaScriptCore thread at 100% CPU.
5. **Fix**: Use linear-time string validators (`z.string().max(2000)`), bound input lengths **before** regex evaluation, and offload heavy batch CPU tasks to a `Worker` or BullMQ job.
6. **Mental Model**: Never run unbounded regexes or `O(2^N)` loops on the main event loop thread.

---

## Bug 14: Memory Leak via Unbounded In-Memory Map / Event Listeners

1. **Broken Code**:
   ```typescript
   const requestMetricsCache = new Map<string, object>();
   app.use("*", async (c, next) => {
     requestMetricsCache.set(c.get("requestId"), { url: c.req.url, ts: Date.now() });
     await next();
   });
   ```
2. **Symptoms**: Container RSS memory climbs steadily from 60 MB to 2 GB over 48 hours until `OOMKilled` (exit code 137).
3. **Reproduction**: Load-test 100,000 requests and inspect `process.memoryUsage().heapUsed`.
4. **Root Cause**: Every unique `requestId` is inserted into a module-level `Map` and never deleted, rooting the objects in GC forever.
5. **Fix**: Never accumulate unbounded request keys in module-level `Map`s; emit metrics to a bounded ring buffer / Prometheus counter or store ephemeral state in Redis with `EX` TTL.
6. **Mental Model**: Any module-level `Map`, `Set`, or `Array` without an eviction policy or `delete` path is a memory leak.

---

## Bug 15: Worker Failure Due to Enqueuing Job Before DB Transaction Commits

1. **Broken Code**:
   ```typescript
   await db.transaction(async (tx) => {
     const [order] = await tx.insert(orders).values(newOrder).returning();
     await orderQueue.add("send-receipt", { orderId: order.id }); // ❌ Enqueued BEFORE tx commits!
     await slowAuditLogWrite(tx); // Takes 50ms
   });
   ```
2. **Symptoms**: On initial attempt (`attempt 1`), the BullMQ worker intermittently fails with `Error: Order 01923c... not found in database`, then succeeds 2 seconds later on `attempt 2`.
3. **Reproduction**: Add a `50ms` delay before the end of `db.transaction` while the worker is running locally.
4. **Root Cause**: Redis publishes the job to the worker in `<1ms`, so the worker queries PostgreSQL at `t=2ms`, while the API transaction doesn't `COMMIT` until `t=52ms` (under `READ COMMITTED`, uncommitted rows are invisible to other connections!).
5. **Fix**: Enqueue the BullMQ job **after** `await db.transaction(...)` resolves (or use a transactional outbox table).
6. **Mental Model**: External side effects (Redis queues, webhooks, cache invalidation) must happen **after** the database transaction commits.

---

## Bug 16: Queue Retry Storm Against a Struggling Downstream API

1. **Broken Code**: Configuring `attempts: 50` with a fixed `delay: 100` (100ms) and no concurrency limit on a webhook/email worker.
2. **Symptoms**: When the downstream provider has a brief 10-second outage, 1,000 queued jobs retry 10 times per second (`10,000 req/s`), DDoSing the provider and getting your IP banned.
3. **Reproduction**: Mock a `503` response on the downstream API and enqueue 200 jobs.
4. **Root Cause**: Fixed sub-second retry intervals without exponential backoff, jitter, or a Circuit Breaker.
5. **Fix**: Configure `attempts: 5`, `backoff: { type: "exponential", delay: 2000 }`, cap worker `concurrency`, and wrap the outbound call in a `CircuitBreaker`.
6. **Mental Model**: Retries without exponential backoff and jitter amplify outages into self-inflicted DDoS attacks.

---

## Bug 17: WebSocket Connection & Listener Leak on Disconnect

1. **Broken Code**:
   ```typescript
   websocket: {
     open(ws) {
       redisSub.on("message", (channel, msg) => ws.send(msg)); // ❌ Adds a new listener per client, never removed!
     }
   }
   ```
2. **Symptoms**: `MaxListenersExceededWarning`, soaring CPU usage on every Redis pub/sub message, and errors sending to closed sockets.
3. **Reproduction**: Connect and disconnect 100 WebSocket clients, then publish 1 Redis message.
4. **Root Cause**: Registering a per-socket listener on a shared Redis subscriber without removing it in `close(ws)`.
5. **Fix**: Register **one** singleton `redisSub` listener at server startup that calls `server.publish(topic, message)`, and use Bun's native `ws.subscribe(topic)` / `ws.unsubscribe(topic)` per socket!
6. **Mental Model**: Bridge Redis Pub/Sub once per **server process** into `server.publish(topic, msg)`, not once per connected WebSocket client.

---

## Bug 18: Environment Variable Exposure in Error Responses or Client Bundles

1. **Broken Code**:
   ```typescript
   app.get("/debug-config", (c) => c.json(Bun.env)); // or serializing `err` containing `connectionString`
   ```
2. **Symptoms**: `DATABASE_URL`, `JWT_SECRET`, and `S3_SECRET_ACCESS_KEY` are exposed over HTTP or leaked into logs.
3. **Reproduction**: Trigger a database connection error when `app.onError` returns `c.json({ error: err })`.
4. **Root Cause**: Raw error objects and `Bun.env` contain sensitive credentials.
5. **Fix**: Never expose `Bun.env` or raw `err` objects in HTTP responses; use `AppError` for client responses and Pino `redact` for logs.
6. **Mental Model**: Secrets enter the process via `env` and must never leave the process via HTTP responses or logs.

---

## Bug 19: Deployment Container Binding to `127.0.0.1` Instead of `0.0.0.0`

1. **Broken Code**:
   ```typescript
   Bun.serve({ hostname: "127.0.0.1", port: 3000, fetch: app.fetch });
   ```
2. **Symptoms**: The server starts cleanly inside Docker / Fly.io / Railway (`Listening on http://127.0.0.1:3000`), but the load balancer returns `502 Bad Gateway: connection refused` for every external request.
3. **Reproduction**: Run container with `-p 3000:3000` and `curl http://localhost:3000` from outside the container namespace.
4. **Root Cause**: Binding to `127.0.0.1` inside a container listens **only** on the container's internal loopback interface (`lo`), rejecting traffic arriving on the container's virtual Ethernet interface (`eth0`).
5. **Fix**: Always bind to `hostname: "0.0.0.0"` in containerized deployments.
6. **Mental Model**: Inside a container, `127.0.0.1` is isolated to that container alone; `0.0.0.0` binds all network interfaces including the container bridge.
