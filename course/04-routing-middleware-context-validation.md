# Module 4 — Routing, Middleware Ordering, Typed Context & Runtime Schema Validation

> **Course Phase**: Phases 6, 7 & 8 (Sections 17–20, 93, 127–128)
> **Verified Packages**: `hono@4.13.10`, `elysia@1.4.30`, `zod@^4.0.0`, `valibot@^1.x`, `@hono/standard-validator`, `@hono/zod-validator`

---

## 1. Concept: The Edge Perimeter of Your Backend

Before a request ever reaches your business logic, four mechanisms must execute in strict sequence:
1. **Routing**: Resolving the HTTP method + URI path to a handler (or returning `404`/`405`).
2. **Middleware Pipeline**: Applying cross-cutting operational and security policies in deterministic order.
3. **Typed Request Context**: Propagating request-scoped state (`requestId`, `actor`, `tenant`, child `logger`) safely without global mutable variables.
4. **Runtime Schema Validation**: Proving that untrusted `params`, `query`, `headers`, and `body` conform to strict data contracts before execution proceeds.

---

## 2. Routing Architecture (Section 17)

Both Hono and Elysia support:
- **Static routes**: `GET /api/v1/health`
- **Dynamic parameters**: `GET /api/v1/organizations/:orgId/products/:productId`
- **Regex/constrained parameters**: Hono `GET /posts/:id{[0-9]+}` | Elysia `params: t.Object({ id: t.Numeric() })`
- **Wildcard / catch-all routes**: `GET /files/*`
- **Nested Router Composition**: Grouping routes by domain module (`authRoutes`, `productRoutes`, `orderRoutes`) and mounting under `/api/v1`.

### Router Registration Order Rule
Always register **specific static routes before dynamic parameterized routes** at the same path depth:
- Register `GET /api/v1/users/me` **before** `GET /api/v1/users/:id`. If `:id` is registered first without a UUID regex/schema constraint, a request to `/api/v1/users/me` can match `:id = "me"`.

---

## 3. Middleware Deep Dive & Why Order Matters (Section 18)

Middleware forms a concentric security and observability envelope around your route handlers. **Getting the middleware order wrong causes silent security holes, missing error logs, or broken CORS responses in production.**

### ❌ BAD MIDDLEWARE ORDER (Broken in Production)

```typescript
// ❌ BAD ORDER — DO NOT DO THIS IN PRODUCTION!
const badApp = new Hono();

// Problem 1: Auth runs BEFORE CORS! Browser OPTIONS preflight requests carry no Authorization header,
// so Auth returns 401 without CORS headers, breaking every browser fetch call!
badApp.use("/api/*", authMiddleware);

// Problem 2: Rate limiter runs AFTER Auth & Body parsing! Attackers can flood invalid JWTs or
// 50MB JSON payloads before rate limiting ever triggers.
badApp.use("/api/*", rateLimitMiddleware);

// Problem 3: Request ID & Logger registered LAST! Any error or 401 thrown in authMiddleware
// or rateLimitMiddleware is never logged and has no X-Request-Id header!
badApp.use("*", requestIdMiddleware);
badApp.use("*", structuredLoggerMiddleware);
badApp.use("/api/*", corsMiddleware);
```

### ✅ GOOD MIDDLEWARE ORDER (Production Standard)

```text
Incoming Request
  │
  ├─► 1. Request ID & High-Resolution Timer (`Bun.nanoseconds()`)
  ├─► 2. Structured Access & Error Logger (Wraps entire pipeline in `try/finally`)
  ├─► 3. Security Headers (`secureHeaders`: HSTS, CSP, X-Content-Type-Options)
  ├─► 4. CORS (`cors`: Handles `OPTIONS` preflight immediately before auth!)
  ├─► 5. Body Size Limit (`bodyLimit`: Rejects oversized payloads early with `413`)
  ├─► 6. IP / Global Rate Limiter (Protects auth & DB from volumetric floods with `429`)
  ├─► 7. Authentication (Verifies Cookie Session / JWT; populates `c.set("actor", ...)`)
  ├─► 8. Tenant & RBAC Context Resolution (Verifies org membership & user/org rate quota)
  ├─► 9. Route-Specific Schema Validation (`params`, `query`, `headers`, `body`)
  └─► 10. Route Handler ──► Domain Service
```

### Production Middleware Pipeline in Hono (`v4.13.10`)

```typescript
// src/middleware/hono-pipeline.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";

export interface ActorContext {
  userId: string;
  organizationId: string;
  role: "owner" | "admin" | "manager" | "member";
  permissions: ReadonlySet<string>;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    log: Logger;
    actor: ActorContext;
  };
};

export function configureProductionMiddleware(app: Hono<AppEnv>, baseLogger: Logger, allowedOrigins: string[]) {
  // 1 & 2: Request ID + Structured Child Logger + Timing
  app.use("*", async (c, next) => {
    const startNs = Bun.nanoseconds();
    const requestId = c.req.header("x-request-id") ?? Bun.randomUUIDv7();
    const childLogger = baseLogger.child({
      requestId,
      method: c.req.method,
      path: c.req.path,
    });

    c.set("requestId", requestId);
    c.set("log", childLogger);
    c.header("X-Request-Id", requestId);

    try {
      await next();
    } finally {
      const durationMs = Number((Bun.nanoseconds() - startNs) / 1_000_000n);
      c.header("Server-Timing", `app;dur=${durationMs}`);
      childLogger.info({ status: c.res.status, durationMs }, "http_request_completed");
    }
  });

  // 3: Security Headers
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );

  // 4: CORS (Must run BEFORE Auth so OPTIONS preflight succeeds)
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id", "X-Organization-Id"],
      exposeHeaders: ["X-Request-Id", "Retry-After"],
      credentials: true,
      maxAge: 86400,
    }),
  );

  // 5: Payload Size Guard (1MB max for standard JSON API routes)
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 1MB limit" } },
          413,
        ),
    }),
  );
}
```

---

## 4. Typed Request Context (Section 19)

Never store request state in module-level globals (`let currentUser = ...`)! Because Bun handles thousands of concurrent async requests on a single event loop, module-level globals will overwrite each other across concurrent users (**cross-tenant data bleed**).

Instead, always attach request-scoped data to the **Framework Request Context** (`c.set()` / `c.get()` in Hono, or `.derive()` / `.resolve()` in Elysia), or propagate an explicit `ActorContext` parameter into every service call.

```typescript
// Creating a type-safe Hono middleware with `createMiddleware`
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./hono-pipeline";
import { AppError } from "../errors/app-error";

export const requirePermission = (permission: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const actor = c.get("actor");
    if (!actor) {
      throw AppError.unauthorized("Authentication required");
    }
    if (!actor.permissions.has(permission) && actor.role !== "owner") {
      throw AppError.forbidden(`Missing required permission: ${permission}`);
    }
    await next();
  });
```

---

## 5. Input Validation & Runtime vs Compile-Time Safety (Sections 20, 93, 127–128)

### The Golden Rule of TypeScript Backend Security (Section 128)

> **TypeScript types vanish completely at runtime.**

Writing `const body = (await req.json()) as CreateUserInput` provides **zero** runtime protection. An attacker can send `{"email": {"$gt": ""}, "role": "admin", "priceCents": -99999}` and TypeScript will not stop it because `as CreateUserInput` is erased before execution.

Only a **runtime schema validator** inspects the actual JSON value in memory, strips unknown keys (preventing mass assignment / prototype pollution), coerces query strings safely, and produces both a validated value and a static TypeScript type (`z.infer<typeof Schema>`).

### Evaluating Validation Libraries (September 2026)

| Library | Verified Status (Sep 2026) | Strengths | Tradeoffs |
| :--- | :--- | :--- | :--- |
| **Zod v4 (`zod@^4.0.0`)** | **STABLE (Primary Choice)** | 3x–7x faster than Zod v3, smaller bundle, built-in `z.toJSONSchema()` for OpenAPI 3.1, implements **Standard Schema v1**, supported by `@hono/zod-openapi` (`v1.5.x`) and Elysia `1.4+`. | Slightly larger footprint than Valibot (irrelevant on server, matters only on client). |
| **Valibot (`valibot@^1.x`)** | **STABLE** | Modular functional pipe API (`v.pipe(v.string(), v.email())`), tiny bundle size, implements **Standard Schema v1**. | Less ubiquitous in third-party OpenAPI tooling than Zod v4. |
| **TypeBox (`@sinclair/typebox` / `Elysia.t`)** | **STABLE** | Native JSON Schema representation; powers Elysia's AOT validator compilation for maximum throughput. | Verbose syntax for complex custom refinements compared to Zod v4. |
| **ArkType (`arktype@^2.x`)** | **STABLE** | TypeScript-like string syntax (`type({ email: "string.email" })`), blazing fast, implements **Standard Schema v1**. | String-DSL syntax has a steeper learning curve for some teams. |

**Course Selection**: We use **Zod v4 (`zod@^4.0.0`)** via **Standard Schema v1** as our primary domain schema library because the exact same Zod v4 schema validates inputs in **Hono** (`@hono/zod-validator` / `@hono/standard-validator`), **Elysia 1.4.30** (native Standard Schema support), **BullMQ job payloads**, and **environment variables**.

### Validating `params`, `query`, `headers`, and `body` Strictly (Section 93)

```typescript
// src/modules/products/product.schemas.ts
import { z } from "zod";

// 1. Path Params Schema
export const ProductIdParamSchema = z.object({
  id: z.uuid({ message: "Product ID must be a valid UUID" }),
});

// 2. Query Params Schema (Note: HTTP query params arrive as strings and must be coerced safely!)
export const ListProductsQuerySchema = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  category: z.enum(["hardware", "software", "services"]).optional(),
  minPriceCents: z.coerce.number().int().min(0).optional(),
  maxPriceCents: z.coerce.number().int().min(0).optional(),
  sortBy: z.enum(["createdAt", "priceCents", "name"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).refine(
  (q) => q.minPriceCents === undefined || q.maxPriceCents === undefined || q.minPriceCents <= q.maxPriceCents,
  { message: "minPriceCents cannot be greater than maxPriceCents", path: ["minPriceCents"] },
);

// 3. Headers Schema (for Idempotency-Key required on POST)
export const IdempotencyHeaderSchema = z.object({
  "idempotency-key": z.uuid({ message: "Idempotency-Key header must be a valid UUID" }),
});

// 4. Request Body Schema (Strict by default: unknown keys are stripped!)
export const CreateProductBodySchema = z.object({
  sku: z.string().trim().regex(/^[A-Z0-9-]{3,32}$/, "SKU must be 3-32 uppercase alphanumeric characters"),
  name: z.string().trim().min(2).max(140),
  description: z.string().trim().max(2000).default(""),
  category: z.enum(["hardware", "software", "services"]),
  priceCents: z.number().int().min(0).max(100_000_000),
  stockQuantity: z.number().int().min(0).default(0),
});

export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;
export type CreateProductInput = z.infer<typeof CreateProductBodySchema>;
```

---

## 6. Bad Example vs Production Pattern

### ❌ BAD EXAMPLE: Trusting Type Assertions & Passing Unvalidated `req.json()` to DB

```typescript
// ❌ BAD: Mass Assignment Vulnerability!
// If an attacker sends `{ "name": "Mouse", "organizationId": "victim_org_id", "isVerified": true }`,
// spreading `body` directly into the ORM overwrites tenant ownership!
app.post("/products", async (c) => {
  const body = (await c.req.json()) as any;
  const created = await db.insert(products).values({
    ...body, // <-- MASS ASSIGNMENT VULNERABILITY!
  });
  return c.json(created);
});
```

### ✅ PRODUCTION PATTERN: Strict Schema Parsing + Server-Assigned Tenant Scope

```typescript
// ✅ GOOD: Only explicitly whitelisted fields exist on `input`, and `organizationId` comes from `actor`
app.post(
  "/products",
  zValidator("json", CreateProductBodySchema),
  async (c) => {
    const input = c.req.valid("json");
    const actor = c.get("actor");

    const product = await productService.createProduct({
      organizationId: actor.organizationId, // <-- Server-controlled boundary, never from client body!
      createdByUserId: actor.userId,
      input,
    });

    return c.json({ data: product }, 201);
  },
);
```

---

## 7. Exercises & Architecture Challenge

- **Beginner**: Write a Zod v4 schema for `PATCH /api/v1/users/me` that allows updating `displayName` and `timezone` (optional fields), explicitly forbids updating `role` or `emailVerifiedAt`, and rejects empty `{}` payloads where no field is provided.
- **Intermediate**: Write a `bun:test` test verifying that sending `GET /api/v1/products?limit=999999&sortBy=DROP_TABLE` returns `422 Unprocessable Content` with structured field-level error details.
- **Architecture Challenge**: *Why is `z.coerce.boolean()` dangerous on query parameters like `?active=false` in JavaScript (`Boolean("false") === true`), and how should you parse boolean query strings (`z.enum(["true", "false"]).transform(v => v === "true")` or Zod v4 `z.stringbool()`) safely?*

---

## 8. Official Documentation & Pre-Flight Checklist

- **Official Docs**: [Zod v4 Docs](https://zod.dev) | [Standard Schema Spec](https://standardschema.dev) | [Hono Validation Guide](https://hono.dev/docs/guides/validation) | [Elysia Validation Guide](https://elysiajs.com/essential/validation)
- **What You Should Know Before Continuing**:
  - [x] Why middleware registration order is a critical security concern.
  - [x] Why TypeScript compile-time types never validate untrusted network payloads.
  - [x] How to prevent Mass Assignment by stripping unknown properties and injecting `organizationId` from the authenticated context.
