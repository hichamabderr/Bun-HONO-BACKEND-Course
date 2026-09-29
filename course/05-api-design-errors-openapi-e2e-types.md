# Module 5 — REST API Design, Error Architecture, OpenAPI 3.1 & End-to-End Type Safety

> **Course Phase**: Phases 9 & 24 (Sections 21–25, 90, 129)
> **Verified Packages**: `@hono/zod-openapi@1.5.x`, `@scalar/hono-api-reference`, `@elysiajs/openapi`, `@elysiajs/eden`, `zod@^4.0.0`

---

## 1. Concept: The API Contract Pipeline (Section 129)

In a modern TypeScript backend, your API contract is not a stale Confluence page written six months ago. It is an executable pipeline derived from a single source of truth:

```text
  Zod v4 / TypeBox Schema (Single Source of Truth)
         │
         ├──► 1. Runtime Request Validation (Rejects malformed client input with 422)
         ├──► 2. Handler & Service Static Types (`z.infer<typeof Schema>`)
         ├──► 3. Runtime Response Serialization (Prevents accidental secret/field leaks)
         ├──► 4. OpenAPI 3.1 Specification & Scalar UI (`/openapi.json` & `/docs`)
         └──► 5. End-to-End Typed Client SDK (Hono RPC `hc<AppType>` / Elysia `treaty<App>`)
```

---

## 2. Production REST API Design & Versioning (Sections 21, 23, 90)

### URL & Resource Modeling Rules
1. **Use plural nouns representing domain resources**, nested only when ownership is strict (max 2 levels deep):
   - `GET /api/v1/organizations/:orgId/members`
   - `POST /api/v1/orders`
   - For state transitions that don't map cleanly to field patches, use explicit sub-resource verbs: `POST /api/v1/orders/:id/cancel`.
2. **Explicit URI Versioning (`/api/v1/...`)**:
   - Prefix all public routes with `/api/v1`.
   - **Non-breaking changes** (safe in `v1`): Adding optional request fields, adding new response fields, adding new endpoints.
   - **Breaking changes** (require `/api/v2` or a sunset window with `Deprecation` and `Sunset` HTTP headers): Removing/renaming response fields, making optional request fields required, changing field types (e.g., `number` to `string`).

### Consistent Response Envelopes (Section 23)

We standardize on two predictable JSON envelopes across all endpoints:

#### 1. Success Envelope (`200`, `201`, `202`)
```json
{
  "data": {
    "id": "01923c8a-7b10-7000-8000-1a2b3c4d5e6f",
    "sku": "PRO-SSD-2TB",
    "name": "Enterprise NVMe 2TB",
    "priceCents": 24900
  },
  "meta": {
    "requestId": "01923c8a-7b00-7000-8000-000000000001",
    "nextCursor": "01923c8a-7b10-7000-8000-1a2b3c4d5e6f",
    "hasMore": true
  }
}
```
*When are envelopes useful vs unnecessary?*
- **Useful**: List endpoints (where `meta.nextCursor` / `meta.hasMore` lives alongside `data: [...]`) and uniform client error parsing (`if ("error" in res)`).
- **When to skip**: Webhook receivers returning `204 No Content`, raw binary/CSV streams, or OpenTelemetry/Prometheus `/metrics` endpoints.

#### 2. Error Envelope (`4xx`, `5xx`)
```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Order '01923c8a-7b10-7000-8000-999999999999' was not found in this organization.",
    "requestId": "01923c8a-7b00-7000-8000-000000000001",
    "details": []
  }
}
```

---

## 3. Centralized Error Architecture (`AppError`) (Section 22)

Never throw raw `new Error("Database error: duplicate key value violates unique constraint users_email_key")` directly to the client! Raw errors leak table names, SQL queries, internal file paths, and upstream third-party tokens.

### Complete Production `AppError` Hierarchy

```typescript
// src/errors/app-error.ts
export type ErrorCode =
  | "VALIDATION_ERROR"          // 422
  | "BAD_REQUEST"               // 400
  | "UNAUTHENTICATED"           // 401
  | "FORBIDDEN"                 // 403
  | "RESOURCE_NOT_FOUND"        // 404
  | "CONFLICT"                  // 409
  | "IDEMPOTENCY_CONFLICT"      // 409
  | "PAYLOAD_TOO_LARGE"         // 413
  | "RATE_LIMIT_EXCEEDED"       // 429
  | "EXTERNAL_PROVIDER_ERROR"   // 502
  | "UPSTREAM_TIMEOUT"          // 504
  | "INTERNAL_SERVER_ERROR";    // 500

export interface ErrorDetail {
  field?: string;
  issue: string;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details: ErrorDetail[];
  public readonly isOperational: boolean;

  constructor(params: {
    code: ErrorCode;
    statusCode: number;
    message: string;
    details?: ErrorDetail[];
    cause?: unknown;
    isOperational?: boolean;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "AppError";
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.details = params.details ?? [];
    this.isOperational = params.isOperational ?? true;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static validation(message: string, details: ErrorDetail[] = []) {
    return new AppError({ code: "VALIDATION_ERROR", statusCode: 422, message, details });
  }

  static unauthorized(message = "Authentication required") {
    return new AppError({ code: "UNAUTHENTICATED", statusCode: 401, message });
  }

  static forbidden(message = "You do not have permission to perform this action") {
    return new AppError({ code: "FORBIDDEN", statusCode: 403, message });
  }

  static notFound(resource: string, identifier?: string) {
    const msg = identifier ? `${resource} '${identifier}' was not found` : `${resource} was not found`;
    return new AppError({ code: "RESOURCE_NOT_FOUND", statusCode: 404, message: msg });
  }

  static conflict(message: string, code: ErrorCode = "CONFLICT") {
    return new AppError({ code, statusCode: 409, message });
  }

  static rateLimit(retryAfterSeconds: number) {
    return new AppError({
      code: "RATE_LIMIT_EXCEEDED",
      statusCode: 429,
      message: `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
      details: [{ issue: `retry_after_seconds:${retryAfterSeconds}` }],
    });
  }

  static externalProvider(providerName: string, cause?: unknown) {
    // Notice: `cause` is preserved for internal Pino logs, NEVER serialized to the client!
    return new AppError({
      code: "EXTERNAL_PROVIDER_ERROR",
      statusCode: 502,
      message: `Upstream provider '${providerName}' is temporarily unavailable`,
      cause,
    });
  }
}
```

---

## 4. OpenAPI 3.1 as a First-Class Citizen (Section 24)

### Track A: OpenAPI 3.1 in Hono with `@hono/zod-openapi` (`v1.5.x` + Zod v4) & Scalar

```typescript
// src/adapters/hono/openapi-app.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { AppEnv } from "../../middleware/hono-pipeline";

const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "RESOURCE_NOT_FOUND" }),
      message: z.string().openapi({ example: "Product was not found" }),
      requestId: z.string().openapi({ example: "01923c8a-7b00-7000-8000-000000000001" }),
      details: z.array(z.object({ field: z.string().optional(), issue: z.string() })),
    }),
  })
  .openapi("ErrorResponse");

const ProductResponseSchema = z
  .object({
    id: z.uuid().openapi({ example: "01923c8a-7b10-7000-8000-1a2b3c4d5e6f" }),
    sku: z.string().openapi({ example: "NVME-2TB" }),
    name: z.string().openapi({ example: "Enterprise NVMe 2TB" }),
    priceCents: z.number().int().openapi({ example: 24900 }),
  })
  .openapi("Product");

const getProductRoute = createRoute({
  method: "get",
  path: "/api/v1/products/{id}",
  tags: ["Products"],
  summary: "Get a product by ID within the authenticated organization",
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
    }),
  },
  responses: {
    200: {
      description: "Product found",
      content: {
        "application/json": {
          schema: z.object({ data: ProductResponseSchema }),
        },
      },
    },
    404: {
      description: "Product not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export function buildDocumentedHonoApp() {
  const app = new OpenAPIHono<AppEnv>();

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });

  app.openapi(getProductRoute, async (c) => {
    const { id } = c.req.valid("param");
    return c.json(
      {
        data: {
          id,
          sku: "NVME-2TB",
          name: "Enterprise NVMe 2TB",
          priceCents: 24900,
        },
      },
      200,
    );
  });

  // Expose OpenAPI 3.1 JSON Spec
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Multi-Tenant SaaS Commerce API",
      version: "1.0.0",
    },
  });

  // Expose Interactive Scalar Documentation UI
  app.get("/docs", Scalar({ url: "/openapi.json", theme: "kepler" }));

  return app;
}
```

### Track B: OpenAPI 3.1 in Elysia with `@elysiajs/openapi` & Type Gen (`fromTypes()`)

In Elysia `1.4+`, `@elysiajs/openapi` can generate OpenAPI 3.1 specs both from explicit schemas (`t` / Zod v4) **and** directly from your TypeScript return types using `fromTypes()`:

```typescript
// src/adapters/elysia/openapi-app.ts
import { Elysia, t } from "elysia";
import { openapi, fromTypes } from "@elysiajs/openapi";

export const elysiaOpenApiApp = new Elysia()
  .use(
    openapi({
      path: "/docs",
      references: fromTypes("src/adapters/elysia/openapi-app.ts"),
      documentation: {
        info: {
          title: "Multi-Tenant SaaS Commerce API (Elysia)",
          version: "1.0.0",
        },
      },
    }),
  )
  .get(
    "/api/v1/products/:id",
    ({ params }) => ({
      data: {
        id: params.id,
        sku: "NVME-2TB",
        name: "Enterprise NVMe 2TB",
        priceCents: 24900,
      },
    }),
    {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      detail: { tags: ["Products"], summary: "Get product by ID" },
    },
  );
```

---

## 5. End-to-End Type Safety: Hono RPC vs Eden Treaty vs Codegen (Section 25)

```typescript
// 1. Hono RPC Client (`hono/client`)
import { hc } from "hono/client";
import type { HonoApiRoutes } from "./app";

const honoClient = hc<HonoApiRoutes>("http://localhost:3000");
const res = await honoClient.api.v1.orders.$post({
  json: { productId: "01923c8a-7b10-7000-8000-1a2b3c4d5e6f", quantity: 2 },
});
if (res.ok) {
  const payload = await res.json(); // Strongly typed `{ data: Order, meta: { requestId: string } }`
}

// 2. Elysia Eden Treaty 2 (`@elysiajs/eden`)
import { treaty } from "@elysiajs/eden";
import type { ElysiaApp } from "../elysia/app";

const edenClient = treaty<ElysiaApp>("http://localhost:3000");
const { data, error } = await edenClient.api.v1.orders.post({
  productId: "01923c8a-7b10-7000-8000-1a2b3c4d5e6f",
  quantity: 2,
});
if (error) {
  // Discriminated union narrowed by status code (e.g. 422 vs 500)
  console.error(error.status, error.value);
} else {
  console.log(data.data.id);
}
```

### Architectural Comparison: Inferred Types vs OpenAPI Code Generation

| Approach | How It Works | Best For | Key Limitation |
| :--- | :--- | :--- | :--- |
| **Inferred RPC Types (`hc<AppType>` / `treaty<App>`)** | TypeScript compiler directly imports `type { App } from "@acme/api"` across a monorepo. Zero build step. | Full-stack TypeScript monorepos (Next.js / Vite / React Native + Bun API) & E2E tests. | Requires consumer to be written in TypeScript and share `typeof app` (can slow down IDE TS server if hundreds of routes aren't split into sub-routers). |
| **OpenAPI Codegen (`openapi-typescript` / `hey-api` / `orval`)** | Generates static `.d.ts` or client SDKs in TS, Swift, Kotlin, Go, or Python from `/openapi.json`. | Public external APIs, polyglot microservice teams, mobile iOS/Android teams, decoupled repositories. | Requires a build/sync step in CI to detect contract drift. |

---

## 6. Exercises & Architecture Challenge

- **Beginner**: Add a `409 Conflict` response schema to `createRoute` in `@hono/zod-openapi` and verify that `/openapi.json` includes the `409` status definition.
- **Intermediate**: Write a contract test in `bun:test` that fetches `/openapi.json` from your app instance and asserts that every `/api/v1/*` route has a `401`, `403`, or `422` error schema documented.
- **Architecture Challenge**: *Why can returning a raw Drizzle ORM database row directly from a route handler without an explicit response schema cause a severe security vulnerability even in a type-safe Elysia or Hono app?* (Answer: Inferred types happily infer and serialize **all** columns on the returned object—including `passwordHash`, `twoFactorSecret`, or `internalNotes`—and even document them in OpenAPI! Always map entities to explicit Response DTOs or validate against a Response Schema).
