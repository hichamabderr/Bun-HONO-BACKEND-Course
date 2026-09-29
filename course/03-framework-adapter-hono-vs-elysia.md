# Module 3 — The Framework Adapter Architecture: Hono (`v4.13.x`) & Elysia (`v1.4.30`)

> **Course Phase**: Phases 4 & 5 (Sections 13–16, 122–124)
> **Verified Versions**: Hono `v4.13.10` | Elysia `v1.4.30` (Stable) / `v2.0-beta` (Experimental/Beta)

---

## 1. Concept: The Framework Adapter Architecture

Look at the architecture diagram that governs this entire course:

```text
                    CORE BACKEND ENGINEERING
                                │
        ├── Bun                 ├── Security
        ├── HTTP                ├── Queues
        ├── PostgreSQL          ├── Testing
        ├── Redis               └── Deployment
        └── Auth
                 │
                 ▼
       ┌───────────────────┐
       │ Framework Adapter │
       └─────────┬─────────┘
                 │
          ┌──────┴───────┐
          ▼              ▼
        Hono           Elysia
```

### Why We Separate Core Backend Engineering from the Framework Adapter

In poorly architected codebases, route handlers contain 200 lines of SQL queries, password verification, Redis calls, and Stripe webhook parsing directly coupled to `c: Context` (Hono) or `{ body, set, cookie }` (Elysia).
When you do that:
1. You cannot unit-test business logic without spinning up HTTP requests.
2. You cannot reuse the same domain service inside a **BullMQ background worker**, a **CLI script**, or a **WebSocket handler** (none of which have an HTTP `Context`).
3. Migrating frameworks—or running Hono on an edge proxy and Elysia on a core service—becomes a total rewrite.

With the **Framework Adapter Pattern**:
- **Core Service Layer**: Pure TypeScript functions/classes receiving validated DTOs and an explicit `ActorContext` (`{ userId, organizationId, role, requestId }`), returning domain objects or throwing `AppError`.
- **Framework Adapter Layer (Hono or Elysia)**: Responsible **only** for:
  1. Extracting HTTP inputs (`params`, `query`, `headers`, `body`, `cookies`).
  2. Running runtime schema validation (Zod v4 / Standard Schema / TypeBox).
  3. Calling the Core Service.
  4. Translating the result (or `AppError`) into an HTTP `Response` with status codes and headers.

---

## 2. Framework Evaluation: Hono vs Elysia (September 2026)

We do **not** declare a superficial "winner." Instead, we evaluate both frameworks objectively against current official documentation:

### Deep Comparison Matrix (Sections 13 & 124)

| Concern | Hono (`v4.13.10`) | Elysia (`v1.4.30` Stable / `v2.0` Beta) |
| :--- | :--- | :--- |
| **Runtime Target** | Built strictly on WinterTC / WHATWG Web Standards (`Request`/`Response`). Runs identically on Bun, Cloudflare Workers, Deno, Node.js, AWS Lambda. | Built **Bun-first** to exploit `Bun.serve()` static route compilation and native APIs; supports other WinterTC runtimes via adapters. |
| **Routing Architecture** | `RegExpRouter` (pre-compiled big regex) + `TrieRouter` (1.5–2x faster in v4.12+) + `SmartRouter`. | `Memoirist` radix tree + `Sucrose` static analysis + Ahead-of-Time (AOT) dynamic function compilation. |
| **Middleware & Lifecycle** | Classic Koa-style **onion model**: `async (c, next) => { /* before */; await next(); /* after */ }`. | Event-driven **9-stage lifecycle hook pipeline**: `request` → `parse` → `transform` → `beforeHandle` → `handle` → `afterHandle` → `mapResponse` → `onError` → `afterResponse`. |
| **Plugin Scoping** | Sub-apps (`new Hono()`) mounted via `app.route("/orders", orderRoutes)`. Middleware follows registration order & path prefix. | Every `.use(plugin)` is **isolated (`local`) by default** unless marked `.as("scoped")` or `.as("global")`. Powerful for modular encapsulation, but surprises beginners. |
| **Validation Ecosystem** | `@hono/standard-validator` or `@hono/zod-validator` middleware passed per route. | Native declarative `{ body, query, params, headers, response }` config supporting both built-in `t` (TypeBox) and **Standard Schema** (Zod, Valibot, ArkType). |
| **TypeScript Inference** | Explicit `new Hono<AppEnv>()` for context variables; method chaining required only when exporting `AppType` for `hc` RPC client. | Deep automatic type inference across `.state()`, `.decorate()`, `.derive()`, `.resolve()`, and `.macro()`. Requires unbroken method chaining. |
| **OpenAPI Generation** | `@hono/zod-openapi` (`v1.5.x` for Zod v4) or `hono-openapi` + `@scalar/hono-api-reference`. Explicit and battle-tested. | `@elysiajs/openapi` supports 1-line **OpenAPI Type Gen** (`references: fromTypes()`) that inspects TypeScript return types directly, plus Scalar UI out of the box. |
| **End-to-End Client Typing** | `hono/client` (`hc<AppType>`) with `$path()`, `parseResponse()`, and `ApplyGlobalResponse`. | `@elysiajs/eden` (**Eden Treaty 2** `treaty<App>()`) with proxy-based path syntax and discriminated `{ data, error }` status narrowing. |
| **WebSockets on Bun** | Uses `createBunWebSocket` from `hono/bun` (`upgradeWebSocket` middleware + `websocket` export). | Built-in `.ws('/ws', { body: ..., message(ws, msg) {} })` with schema validation on incoming WS messages. |
| **Production Concerns** | Rock-solid stability; security patches (e.g. `v4.13.10` query-after-fragment fix) ship rapidly; near-zero framework magic. | `v1.4.30` is the stable production line; `v2.0` ("DayDream") is currently in beta (complete rewrite). Teams must watch AOT/dynamic compilation edge cases and pin versions carefully. |

### When to Choose Hono vs When to Choose Elysia (Sections 122–123)

- **Choose Hono (`v4.13.x`) when**:
  - You want an explicit, minimal, zero-magic Web-standard HTTP layer where middleware flow (`await next()`) is immediately obvious to every engineer on the team.
  - You need multi-runtime portability (e.g., running the same API gateway logic on Cloudflare Workers and Bun containers).
  - You prefer explicit `AppEnv` interface definitions over long chained type-inference graphs.
- **Choose Elysia (`v1.4.30`) when**:
  - You are 100% committed to Bun as your runtime and want built-in WebSocket schema validation, declarative route macros (`{ isAuth: true }`), automatic OpenAPI generation from TypeScript types (`fromTypes()`), and Eden Treaty's ergonomic client SDK.

---

## 3. Track A — The Hono Track (`v4.13.10`) (Section 14)

### Hono Mental Model

```text
Incoming Web `Request`
         │
         ▼
┌───────────────────────────────────────────────────────────┐
│ Hono `Context` (c) wraps `Request` + `Env` (Variables)    │
│                                                           │
│  Middleware 1 (RequestId / Logger) ──► before `next()`    │
│    Middleware 2 (Auth / Tenant)    ──► `c.set("actor",..)`│
│      Middleware 3 (zValidator)     ──► validates input    │
│        Route Handler               ──► `return c.json()`  │
│      Middleware 3                  ◄── after `next()`     │
│    Middleware 2                    ◄── after `next()`     │
│  Middleware 1 (Logs status & ms)   ◄── after `next()`     │
└───────────────────────────────────────────────────────────┘
         │
         ▼
Outgoing Web `Response` (or `app.onError` if thrown)
```

### Complete Hono Adapter Implementation

```typescript
// src/adapters/hono/app.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createBunWebSocket } from "hono/bun";
import { z } from "zod";
import { OrderService, type CreateOrderInput } from "../../modules/orders/order.service";
import { AppError } from "../../errors/app-error";

// 1. Strongly type Hono's Context Environment
export type HonoAppEnv = {
  Variables: {
    requestId: string;
    actor: {
      userId: string;
      organizationId: string;
      role: "owner" | "admin" | "member";
    };
  };
};

const { upgradeWebSocket, websocket } = createBunWebSocket();

export function createHonoAdapter(orderService: OrderService) {
  const app = new Hono<HonoAppEnv>();

  // 2. Global Middleware: Request ID & Timing
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? Bun.randomUUIDv7();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    await next();
  });

  // 3. Modular Sub-Router (Chained for Hono RPC Type Inference)
  const CreateOrderSchema = z.object({
    productId: z.uuid(),
    quantity: z.number().int().min(1).max(100),
  });

  const orderRoutes = new Hono<HonoAppEnv>()
    .post(
      "/",
      zValidator("json", CreateOrderSchema, (result, c) => {
        if (!result.success) {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR",
                message: "Invalid request payload",
                details: result.error.issues,
              },
            },
            422,
          );
        }
      }),
      async (c) => {
        // Validated input is both runtime-checked and compile-time typed!
        const input: CreateOrderInput = c.req.valid("json");
        const actor = c.get("actor");
        const idempotencyKey = c.req.header("idempotency-key") ?? null;

        // Delegate to framework-agnostic Core Service
        const order = await orderService.createOrder({
          actor,
          input,
          idempotencyKey,
        });

        return c.json({ data: order, meta: { requestId: c.get("requestId") } }, 201);
      },
    )
    .get("/:id", async (c) => {
      const orderId = c.req.param("id");
      const actor = c.get("actor");
      const order = await orderService.getOrderById({
        orderId,
        organizationId: actor.organizationId,
      });
      return c.json({ data: order }, 200);
    });

  // 4. Mount Route Group under /api/v1/orders
  const apiRoutes = app.basePath("/api/v1").route("/orders", orderRoutes);

  // 5. Native Bun WebSocket Integration via hono/bun
  app.get(
    "/ws/notifications",
    upgradeWebSocket((c) => ({
      onMessage(event, ws) {
        ws.send(JSON.stringify({ type: "PONG", requestId: c.get("requestId"), echo: event.data }));
      },
    })),
  );

  // 6. Centralized Error Boundary
  app.onError((err, c) => {
    const requestId = c.get("requestId");
    if (err instanceof AppError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            details: err.details,
            requestId,
          },
        },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500,
      );
    }
    console.error({ requestId, err }, "Unhandled exception in Hono adapter");
    return c.json(
      {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected internal error occurred",
          requestId,
        },
      },
      500,
    );
  });

  return { app, apiRoutes, websocket };
}

export type HonoApiRoutes = ReturnType<typeof createHonoAdapter>["apiRoutes"];
```

---

## 4. Track B — The Elysia Track (`v1.4.30`) (Section 15)

### Elysia Mental Model

```text
Incoming Web `Request`
         │
         ▼
┌────────────────────────────────────────────────────────────────────┐
│ Elysia Lifecycle Pipeline (Compiled via AOT / Sucrose)             │
│                                                                    │
│  1. onRequest      ──► Request ID, IP rate limit, early abort      │
│  2. onParse        ──► Body parser (JSON, FormData, Text)          │
│  3. onTransform    ──► Mutate/coerce params before validation      │
│  4. Validation     ──► TypeBox (`t`) OR Standard Schema (Zod v4)   │
│  5. beforeHandle   ──► Macros / RBAC guard (`{ requireAuth: true}`)│
│  6. resolve/derive ──► Inject typed `{ actor, requestId }`         │
│  7. Route Handler  ──► Calls Core Service, returns plain object    │
│  8. afterHandle    ──► Transform output before serialization       │
│  9. onError        ──► Catch `AppError` / `VALIDATION` errors      │
│ 10. afterResponse  ──► Post-flush telemetry & metrics              │
└────────────────────────────────────────────────────────────────────┘
```

### Complete Elysia Adapter Implementation ( Calling the Exact Same `OrderService`!)

```typescript
// src/adapters/elysia/app.ts
import { Elysia, t } from "elysia";
import { z } from "zod";
import { OrderService } from "../../modules/orders/order.service";
import { AppError } from "../../errors/app-error";

// Reusable Auth & Request-ID Plugin using `.as("scoped")` so parent instances inherit types
export const requestContextPlugin = new Elysia({ name: "request-context" })
  .derive({ as: "scoped" }, ({ request, set }) => {
    const requestId = request.headers.get("x-request-id") ?? Bun.randomUUIDv7();
    set.headers["x-request-id"] = requestId;
    // In production, resolved from verified session/JWT (covered in Module 7)
    const actor = {
      userId: request.headers.get("x-test-user-id") ?? "usr_123",
      organizationId: request.headers.get("x-test-org-id") ?? "org_123",
      role: "admin" as const,
    };
    return { requestId, actor };
  });

// Standard Schema (Zod v4) works natively alongside TypeBox `t` in Elysia 1.4+!
const CreateOrderZodSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(100),
});

export function createElysiaAdapter(orderService: OrderService) {
  const orderModule = new Elysia({ prefix: "/api/v1/orders" })
    .use(requestContextPlugin)
    .post(
      "/",
      async ({ body, actor, requestId, request, set }) => {
        const idempotencyKey = request.headers.get("idempotency-key");
        const order = await orderService.createOrder({
          actor,
          input: body,
          idempotencyKey,
        });
        set.status = 201;
        return { data: order, meta: { requestId } };
      },
      {
        // Using Zod v4 directly via Elysia 1.4 Standard Schema support!
        body: CreateOrderZodSchema,
      },
    )
    .get(
      "/:id",
      async ({ params, actor }) => {
        const order = await orderService.getOrderById({
          orderId: params.id,
          organizationId: actor.organizationId,
        });
        return { data: order };
      },
      {
        // Or using Elysia's built-in TypeBox `t` validator:
        params: t.Object({
          id: t.String({ format: "uuid" }),
        }),
      },
    );

  const app = new Elysia()
    .use(requestContextPlugin)
    .onError(({ code, error, set, requestId }) => {
      if (error instanceof AppError) {
        set.status = error.statusCode;
        return {
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
            requestId,
          },
        };
      }
      if (code === "VALIDATION") {
        set.status = 422;
        return {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request payload",
            details: error.all,
            requestId,
          },
        };
      }
      set.status = 500;
      return {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected internal error occurred",
          requestId,
        },
      };
    })
    .use(orderModule)
    .ws("/ws/notifications", {
      body: t.Object({ ping: t.String() }),
      message(ws, message) {
        ws.send({ type: "PONG", echo: message.ping });
      },
    });

  return app;
}

export type ElysiaApp = ReturnType<typeof createElysiaAdapter>;
```

---

## 5. How Both Frameworks Map to Web Standards (Section 16)

Never let framework conveniences obscure the underlying Web Standard primitives:

| Underlying Web Standard | In Hono (`v4.13.x`) | In Elysia (`v1.4.30`) |
| :--- | :--- | :--- |
| **Raw `Request`** | `c.req.raw` (is a genuine `Request`) | `ctx.request` (is a genuine `Request`) |
| **Executing a Test Request without TCP** | `await app.request("/api/v1/orders", init)` or `await app.fetch(new Request(...))` | `await app.handle(new Request("http://localhost/api/v1/orders", init))` |
| **Returning a Raw `Response` / Stream** | `return new Response(readableStream, { headers })` | `return new Response(readableStream, { headers })` |
| **Passing to `Bun.serve()`** | `Bun.serve({ fetch: app.fetch, websocket })` | `app.listen(3000)` or `Bun.serve({ fetch: app.fetch })` |

---

## 6. Bad Example vs Production Pattern

### ❌ BAD EXAMPLE: Breaking Type Inference & Leaking Framework Into Domain

```typescript
// ❌ BAD (Hono & Elysia anti-pattern):
// 1. Passing Hono `Context` directly into OrderService couples domain to HTTP framework!
// 2. Breaking method chaining in Elysia/Hono RPC loses client route types!
const app = new Hono();
app.get("/orders", (c) => orderService.listOrders(c)); // <-- OrderService now depends on Hono!
export type AppType = typeof app; // <-- AppType has NO route types because `.get()` wasn't chained!
```

### ✅ PRODUCTION PATTERN: Chained Route Export + Framework-Free Service Signature

See [`examples/core-adapter-pattern/`](../../examples/core-adapter-pattern/) in this repository for the full runnable implementation of:
- `domain/order.service.ts` (zero framework imports)
- `hono-adapter/order.routes.ts`
- `elysia-adapter/order.routes.ts`

---

## 7. Exercises & Architecture Challenge

- **Beginner**: Write a `bun:test` suite that tests both `createHonoAdapter(orderService)` (using `app.request()`) and `createElysiaAdapter(orderService)` (using `app.handle()`) against the exact same in-memory `OrderService` instance.
- **Intermediate**: Add an Elysia `.macro()` named `requireRole(role)` and an equivalent Hono middleware `requireRole(role)` that returns `403 Forbidden` if `actor.role !== role`.
- **Architecture Challenge**: *Why does Elysia isolate plugins by default (`local` scope) whereas Hono middleware mounted with `app.use('*')` applies globally? When building a multi-tenant API, how could forgetting `{ as: 'scoped' }` on an Elysia auth plugin cause a security bug?*

---

## 8. Official Documentation & Pre-Flight Checklist

- **Official Docs**: [Hono Docs](https://hono.dev/docs/) | [Hono Bun Guide](https://hono.dev/docs/getting-started/bun) | [Elysia Docs](https://elysiajs.com/at-glance) | [Elysia Lifecycle](https://elysiajs.com/essential/life-cycle)
- **What You Should Know Before Continuing**:
  - [x] How to write a domain service that works unmodified with both Hono and Elysia.
  - [x] How Hono's onion middleware (`await next()`) compares to Elysia's lifecycle hooks.
  - [x] How to test both frameworks in-memory using standard `new Request()` without opening a network port.
