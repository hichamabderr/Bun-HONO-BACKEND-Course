# Module 2 — `Bun.serve`, Web Standards & Deep HTTP Engineering

> **Course Phase**: Phases 2 & 3 (Sections 9–12)
> **Verified Environment**: Bun `v1.4.2` (Native HTTP/1.1 + HTTP/2 + WebSockets + Declarative Routes)

---

## 1. Concept: Master the Wire Before the Framework

Before touching Hono or Elysia, you must understand that **neither framework owns an HTTP server on Bun**. Under the hood, both Hono and Elysia hand a `fetch(request, server)` function (and optional `routes` / `websocket` handlers) to `Bun.serve()`.

If you do not understand `Bun.serve()`, `Request`, `Response`, `Headers`, `ReadableStream`, `AbortSignal`, and HTTP protocol semantics (methods, idempotency, status codes, caching, CORS preflight, and conditional requests), you will treat your framework like a black box.

---

## 2. Mental Model & Complete Request Lifecycle (Section 12)

Every production HTTP request traverses 14 distinct stages from client to database and back:

```text
 1. Browser / Client      ──► Initiates fetch("https://api.acme.com/api/v1/orders")
         │
 2. DNS Resolution        ──► Resolves api.acme.com to Anycast / Edge IP (A / AAAA record)
         │
 3. TLS 1.3 Handshake     ──► ALPN negotiates h2 (HTTP/2) or http/1.1; cipher suite agreed
         │
 4. Reverse Proxy / WAF   ──► Cloudflare / Nginx / Envoy terminates TLS, drops malformed frames,
         │                    sets X-Forwarded-For, X-Forwarded-Proto, CF-Connecting-IP
         ▼
 5. Load Balancer         ──► Routes TCP/HTTP2 stream to healthy Bun container (passes /readiness)
         │
 6. Bun Runtime           ──► Kernel epoll/io_uring wakes Bun.serve(); parses HTTP headers into
         │                    a Web Standard `Request` object + `AbortSignal`
         ▼
 7. Framework Adapter     ──► Hono (app.fetch) or Elysia (app.fetch) creates request Context
         │
 8. Middleware Pipeline   ──► Request ID -> Structured Logger -> Security Headers -> CORS ->
         │                    Rate Limit -> Authentication
         ▼
 9. Route Matcher         ──► Matches `POST /api/v1/orders` and extracts path/query parameters
         │
10. Schema Validation     ──► Validates JSON body & headers against Zod v4 / Standard Schema
         │
11. Authorization         ──► Verifies actor's membership & `orders:create` permission in tenant
         │
12. Domain Service        ──► Executes business rules inside transaction boundary
         │
13. Database / Redis      ──► Drizzle ORM runs parameterized SQL on PostgreSQL; updates Redis
         │
14. Response Serialization──► Constructs Web Standard `Response` (status, headers, JSON stream),
                              flushes bytes over socket, emits final structured log & trace span
```

---

## 3. `Bun.serve()` — Native HTTP, Declarative Routes & WebSockets (Section 9)

In Bun `v1.3+` and `v1.4.2`, `Bun.serve()` supports:
- **Built-in declarative `routes`** (static responses, parameterized routes `/users/:id`, per-method handlers, wildcard routes `/api/*`) alongside the fallback `fetch(req, server)` handler.
- **Native HTTP/2 and HTTP/1.1** on the same port (added in Bun `v1.4.1`).
- **Native `Bun.CookieMap` (`req.cookies`)** on `BunRequest` inside `routes` handlers for zero-dependency cookie reading and setting.
- **Per-request timeout control** via `server.timeout(req, seconds)` and client disconnect detection via `req.signal`.

### Complete Production-Grade Raw `Bun.serve()` Server

```typescript
// src/raw-server/bun-serve-demo.ts
const server = Bun.serve({
  // Bind to 0.0.0.0 in containers so reverse proxies / load balancers can reach it
  hostname: "0.0.0.0",
  port: Number(Bun.env.PORT ?? 3000),
  // Maximum request body size (default 128MB; tighten to 5MB for JSON APIs)
  maxRequestBodySize: 5 * 1024 * 1024,
  // Idle connection timeout in seconds
  idleTimeout: 30,

  // 1. Declarative Routes (Bun 1.2.3+ / 1.3+ / 1.4.2)
  routes: {
    // Zero-allocation static health check
    "/liveness": new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),

    // Method-specific handlers with typed params and native req.cookies
    "/api/v1/echo/:id": {
      GET(req) {
        const id = req.params.id;
        const theme = req.cookies.get("theme") ?? "system";

        // Setting a secure cookie natively via BunRequest.cookies:
        req.cookies.set("last_visited_id", id, {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: 3600,
        });

        return Response.json(
          { data: { id, theme, protocol: req.headers.get("x-forwarded-proto") ?? "http" } },
          { status: 200 },
        );
      },
    },
  },

  // 2. Fallback Web-Standard fetch handler
  async fetch(req, srv) {
    const url = new URL(req.url);

    // Upgrade to WebSocket if requested at /ws
    if (url.pathname === "/ws") {
      const upgraded = srv.upgrade(req, {
        data: { connectedAt: Date.now(), clientIp: srv.requestIP(req)?.address ?? "unknown" },
      });
      if (upgraded) return undefined;
      return Response.json({ error: "WebSocket upgrade failed" }, { status: 400 });
    }

    // Streaming NDJSON response with client disconnect handling
    if (url.pathname === "/stream" && req.method === "GET") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          for (let i = 1; i <= 5; i++) {
            if (req.signal.aborted) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(JSON.stringify({ tick: i, ts: Date.now() }) + "\n"));
            await Bun.sleep(200);
          }
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    return Response.json(
      { error: { code: "NOT_FOUND", message: `Route ${req.method} ${url.pathname} not found` } },
      { status: 404 },
    );
  },

  // 3. Native WebSocket handler
  websocket: {
    open(ws) {
      ws.subscribe("system-announcements");
    },
    message(ws, message) {
      ws.send(JSON.stringify({ ack: true, receivedBytes: Buffer.byteLength(message) }));
    },
    close(ws) {
      ws.unsubscribe("system-announcements");
    },
  },

  // 4. Global uncaught error boundary for Bun.serve
  error(err) {
    console.error("[Bun.serve Unhandled Error]", err);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "An unexpected server error occurred" } },
      { status: 500 },
    );
  },
});

console.log(`Listening on http://${server.hostname}:${server.port}`);
```

---

## 4. Web Standards First (Section 10)

Modern backend runtimes (Bun, Deno, Cloudflare Workers) converge on **WHATWG / WinterTC Web Standards**:

| Web Standard Primitive | Backend Engineering Purpose |
| :--- | :--- |
| **`Request`** | Immutable representation of an incoming HTTP message (`req.method`, `req.url`, `req.headers`, `req.signal`, and body readers `req.json()`, `req.text()`, `req.formData()`, `req.arrayBuffer()`, `req.bytes()`, `req.body`). *Crucial rule: A `Request` body stream can only be consumed once unless `req.clone()` is called first!* |
| **`Response`** | Outgoing HTTP message (`new Response(body, { status, headers })`, `Response.json(data, init)`, `Response.redirect(url, 302)`). |
| **`Headers`** | Case-insensitive header map (`headers.get("content-type")`, `headers.set()`, `headers.append("Set-Cookie", ...)`). |
| **`URL` & `URLSearchParams`** | RFC-compliant URL parser. Prevents naive string splitting bugs on query strings (`url.searchParams.getAll("tag")`). |
| **`FormData` & `Blob` / `File`** | Standard `multipart/form-data` parsing (`const form = await req.formData(); const file = form.get("avatar") as File;`). |
| **`ReadableStream` / `TransformStream` / `WritableStream`** | Chunked data processing with built-in **backpressure** so 2GB exports never buffer into RAM. |
| **`AbortController` & `AbortSignal`** | Cooperative cancellation across HTTP requests, database queries, and `AbortSignal.timeout(3000)` outbound calls. |

---

## 5. HTTP — Deep Protocol Semantics (Section 11)

### HTTP Methods: Semantics, Idempotency & Safety

| Method | Safe? (No State Mutation) | Idempotent? (N Identical Calls = 1 Call) | Request Body? | Production Semantics |
| :--- | :--- | :--- | :--- | :--- |
| **`GET`** | Yes | Yes | No | Retrieve representation of a resource. Must never mutate state! |
| **`HEAD`** | Yes | Yes | No | Identical to `GET`, but server returns **headers only** and empty body. |
| **`OPTIONS`** | Yes | Yes | No | Capability discovery & **CORS Preflight** check before cross-origin requests. |
| **`POST`** | No | **No** (Unless `Idempotency-Key` enforced!) | Yes | Create subordinate resource or trigger non-idempotent action (orders, payments). |
| **`PUT`** | No | **Yes** | Yes | **Full replacement** of resource at known URI (`/products/:id`). |
| **`PATCH`** | No | Usually No (Yes if setting deterministic fields) | Yes | **Partial modification** of resource fields (`/products/:id`). |
| **`DELETE`** | No | **Yes** (Second call may return `204` or `404`, state remains deleted) | No | Remove resource at target URI. |

### Status Codes Every Backend Engineer Must Use Precisely

- **2xx Success**:
  - `200 OK`: Standard synchronous success (`GET`, `PATCH`, `PUT`).
  - `201 Created`: Resource created (`POST`); include `Location` header when appropriate.
  - `202 Accepted`: Request accepted for asynchronous background processing (queued in BullMQ).
  - `204 No Content`: Success with intentionally empty body (`DELETE`, `POST /logout`).
- **3xx Redirection & Caching**:
  - `301 Moved Permanently` / `308 Permanent Redirect` (preserves HTTP method!).
  - `302 Found` / `303 See Other` (forces `GET` after OAuth callback) / `307 Temporary Redirect` (preserves method).
  - `304 Not Modified`: Client's cached version matching `If-None-Match` (`ETag`) is still fresh; empty body saves bandwidth.
- **4xx Client Errors**:
  - `400 Bad Request`: Malformed JSON syntax or missing required header.
  - `401 Unauthorized`: **Unauthenticated**—missing, expired, or invalid credentials.
  - `403 Forbidden`: **Unauthorized**—identity is known, but lacks permission/role for this resource.
  - `404 Not Found`: Resource does not exist (or hidden to prevent cross-tenant ID enumeration).
  - `409 Conflict`: Unique constraint violation, optimistic lock conflict, or in-flight duplicate `Idempotency-Key`.
  - `413 Content Too Large`: Request body or file upload exceeds maximum size limit.
  - `415 Unsupported Media Type`: Missing or wrong `Content-Type` header.
  - `422 Unprocessable Content`: Valid JSON syntax, but failed domain/schema validation rules.
  - `429 Too Many Requests`: Rate limit exceeded; always include `Retry-After` header.
- **5xx Server Errors**:
  - `500 Internal Server Error`: Unexpected unhandled fault (never leak SQL/stack trace).
  - `502 Bad Gateway` / `503 Service Unavailable` / `504 Gateway Timeout`: Upstream dependency down or readiness probe failing during drain.

### Conditional Requests (`ETag` & `If-None-Match`) & CORS Preflight

```typescript
// Implementing RFC 9110 Conditional GET with ETag in Web Standard Request/Response
export function withETagResponse(req: Request, payload: unknown, cacheControl = "private, max-age=60"): Response {
  const bodyString = JSON.stringify(payload);
  // Fast non-cryptographic or SHA-256 hash for strong ETag
  const hash = new Bun.CryptoHasher("sha256").update(bodyString).digest("hex").slice(0, 32);
  const etag = `"${hash}"`;

  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": cacheControl,
      },
    });
  }

  return new Response(bodyString, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ETag: etag,
      "Cache-Control": cacheControl,
    },
  });
}
```

---

## 6. Bad Example vs Production Pattern

### ❌ BAD EXAMPLE: Reading Request Body Twice & Ignoring `AbortSignal`

```typescript
// ❌ BAD:
async function badHandler(req: Request) {
  // 1. Logging helper reads req.text()
  console.log("Incoming body:", await req.text());
  // 2. Route handler tries to read req.json() -> Throws TypeError: Body already used!
  const data = await req.json();
  // 3. Calls external API without a timeout -> hangs forever if upstream stalls!
  const upstream = await fetch("https://slow-partner.example.com/verify");
  return Response.json(data);
}
```

### ✅ PRODUCTION PATTERN: Bounded Stream Consumption & `AbortSignal.any()`

```typescript
// ✅ GOOD: Combine inbound client disconnect signal with a strict 3000ms outbound timeout
export async function fetchPartnerWithTimeout(inboundReq: Request, partnerUrl: string): Promise<unknown> {
  const signal = AbortSignal.any([
    inboundReq.signal,              // Aborts if client disconnects early
    AbortSignal.timeout(3_000),     // Aborts if partner takes > 3 seconds (40x faster in Bun 1.3+)
  ]);

  const res = await fetch(partnerUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Partner API failed with status ${res.status}`);
  }
  return await res.json();
}
```

---

## 7. Exercises & Architecture Challenge

- **Beginner**: Build a raw `Bun.serve()` endpoint `GET /api/v1/headers` that inspects `Accept-Language` and `User-Agent` using `req.headers.get()` and returns a `200` JSON response with `Cache-Control: no-store`.
- **Intermediate**: Implement `withETagResponse` on a `GET /api/v1/catalog` route and write a `bun:test` test proving that sending `If-None-Match` with the returned `ETag` yields `304 Not Modified` and an empty body.
- **Production**: Implement an `OPTIONS` preflight handler in raw `Bun.serve()` that validates `Origin` against an allowlist (`https://app.acme.com`), sets `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, `Access-Control-Max-Age: 86400`, and `Vary: Origin`.
- **Architecture Challenge**: *Why must `Vary: Origin` always be returned when `Access-Control-Allow-Origin` is dynamically echoed from an allowlist?* (Answer: Without `Vary: Origin`, a shared CDN or browser cache could cache the response with `Access-Control-Allow-Origin: https://app1.acme.com` and serve it to `https://app2.acme.com`, causing intermittent CORS failures in production).

---

## 8. Official Documentation & Pre-Flight Checklist

- **Official Docs**: [Bun.serve](https://bun.sh/docs/api/http) | [MDN HTTP Reference](https://developer.mozilla.org/en-US/docs/Web/HTTP) | [WHATWG Fetch Standard](https://fetch.spec.whatwg.org/)
- **What You Should Know Before Continuing**:
  - [x] Every stage of the 14-step HTTP request lifecycle.
  - [x] How `Bun.serve` handles `routes`, `fetch`, `websocket`, and `error`.
  - [x] The exact difference between `401` and `403`, `400` and `422`, and `PUT` and `PATCH`.
