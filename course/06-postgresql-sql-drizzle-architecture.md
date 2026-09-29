# Module 6 — PostgreSQL, SQL First, Drizzle ORM, Modular Monolith, Pagination, Transactions & Concurrency

> **Course Phase**: Phases 10, 11, 14, 15 & 16 (Sections 26–30, 86–89, 91–92, 94–96)
> **Verified Stack**: PostgreSQL `17 / 18` | Drizzle ORM `v0.45.2` (Stable) | `drizzle-kit@0.31.x` | `Bun.sql` / `postgres` driver

---

## 1. Concept: Teach SQL First — The Database Is Your Ultimate Invariant Boundary (Section 26)

Application code restarts, scales across 10 containers, and crashes mid-request. **PostgreSQL state persists.**
Before writing a single line of ORM code, you must design your relational schema so PostgreSQL itself makes invalid domain states impossible to store:

- **Primary Keys**: Prefer **UUIDv7** (`Bun.randomUUIDv7()` or PostgreSQL 18 `uuidv7()`). Unlike random UUIDv4 (which causes B-Tree page fragmentation on inserts), UUIDv7 is **time-ordered** (48-bit millisecond timestamp prefix + random bits), yielding sequential B-Tree index inserts and natural chronological sorting!
- **Foreign Keys & Referential Actions**: Always enforce `REFERENCES organizations(id) ON DELETE CASCADE` (or `RESTRICT` for financial ledger tables like `orders` and `payments`).
- **`CHECK` Constraints**: Enforce `CHECK (price_cents >= 0)` and `CHECK (stock_quantity >= 0)` inside PostgreSQL. Even if a bug in application code tries to decrement stock below zero, PostgreSQL aborts the transaction immediately.
- **Composite & Partial Indexes**: Index for your actual `WHERE` and `ORDER BY` clauses:
  - Multi-tenant index: `CREATE INDEX idx_products_org_created ON products (organization_id, created_at DESC, id DESC);`
  - Partial unique index for active invitations: `CREATE UNIQUE INDEX uq_pending_invite ON organization_invitations (organization_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;`

---

## 2. ORM Evaluation: Drizzle ORM vs Prisma in September 2026 (Section 27)

Let's evaluate the current official state of both major TypeScript ORMs as of **September 2026**:

| Dimension | Drizzle ORM (`v0.45.2` Stable / `v1.0` Beta) | Prisma ORM (`v7.10` Stable / `v8.0` RC) |
| :--- | :--- | :--- |
| **Current Verified Version (Sep 2026)** | **`drizzle-orm@0.45.2`** is the battle-tested stable release (`1.0.0-beta.x` is in active beta). | **`prisma@7.10.x`** is the stable release (note: `Prisma 8` is in Release Candidate as of Sep 2026). |
| **Architecture** | Pure TypeScript schema (`pgTable(...)`) + thin zero-overhead SQL builder over `Bun.sql` or `postgres` (`postgres.js`). | Prisma 7 removed the legacy Rust binary engine in favor of a TypeScript/WASM query compiler, but still requires a code-generation step (`prisma generate`) from `.prisma` DSL files. |
| **SQL Transparency** | **1:1 SQL semantics**. If you know SQL (`JOIN`, `GROUP BY`, `FOR UPDATE`, CTEs, subqueries), you know Drizzle. Never hides N+1 queries behind implicit getters. | High-level object abstraction (`findMany({ include: ... })`). Convenient for CRUD, but complex window functions, locking (`FOR UPDATE`), or custom SQL require `$queryRaw`. |
| **Bun Native Driver Support** | Supports both `drizzle-orm/bun-sql` (using Bun's native C/Zig Postgres driver `Bun.sql`) and `drizzle-orm/postgres-js`. | Works on Bun via driver adapters, though historically required workarounds during binary-to-TS transitions. |
| **Bundle Size & Cold Start** | ~50 KB; instant startup with zero codegen required at build time. | ~400–500 KB+; requires `prisma generate` before `tsc` or `bun run` can succeed. |

**Course Selection**: We select **Drizzle ORM (`drizzle-orm@0.45.2` pinned explicitly)** paired with `drizzle-kit` for SQL migrations. It keeps SQL front-and-center, runs with zero codegen step, and integrates directly with `Bun.sql` or `postgres.js`.

---

## 3. Drizzle Schema: Multi-Tenant Products, Orders & Inventory

```typescript
// src/infrastructure/db/schema.ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "paid",
  "fulfilled",
  "cancelled",
]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sku: varchar("sku", { length: 32 }).notNull(),
    name: varchar("name", { length: 140 }).notNull(),
    description: text("description").notNull().default(""),
    category: varchar("category", { length: 32 }).notNull(),
    priceCents: integer("price_cents").notNull(),
    stockQuantity: integer("stock_quantity").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every SKU is unique WITHIN an organization (not globally across tenants!)
    uniqueIndex("uq_products_org_sku").on(table.organizationId, table.sku),
    // Composite index for cursor pagination & tenant filtering
    index("idx_products_org_id_desc").on(table.organizationId, table.id.desc()),
    index("idx_products_org_category_price").on(table.organizationId, table.category, table.priceCents),
    // Database-level invariants!
    check("chk_products_price_non_negative", sql`${table.priceCents} >= 0`),
    check("chk_products_stock_non_negative", sql`${table.stockQuantity} >= 0`),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    customerUserId: uuid("customer_user_id").notNull(),
    status: orderStatusEnum("status").notNull().default("pending"),
    totalCents: integer("total_cents").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_orders_org_idempotency")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("idx_orders_org_created").on(table.organizationId, table.id.desc()),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
  },
  (table) => [
    index("idx_order_items_order_id").on(table.orderId),
    check("chk_order_items_qty_positive", sql`${table.quantity} > 0`),
  ],
);
```

---

## 4. Database Access & Modular Monolith Architecture (Sections 28–30, 86–89)

```text
HTTP Adapter (Hono / Elysia)
    │  Extracts & validates HTTP input
    ▼
Application / Domain Service (`OrderService`)
    │  Enforces authorization, orchestrates transaction boundaries,
    │  enqueues post-commit jobs
    ▼
Repository (`OrderRepository`, `ProductRepository`)
    │  Encapsulates Drizzle ORM / parameterized SQL queries;
    │  ALWAYS requires `organizationId` in method signatures
    ▼
PostgreSQL 17/18 (via `Bun.sql` or `postgres` connection pool)
```

### Why Feature-Based Modular Monolith Beats Technical Layer Folders (Sections 29 & 86)
- **Old Technical Layering (`controllers/`, `services/`, `repositories/`)**: Changing one feature (`orders`) requires jumping across 6 top-level directories, and services quickly turn into a tangled spaghetti graph importing everything.
- **Modern Feature-Based Modular Monolith (`src/modules/orders/*`)**: Co-locates `order.schemas.ts`, `order.service.ts`, `order.repository.ts`, `order.routes.ts`, and `order.test.ts`. Each module exposes a clean public facade (`index.ts`), making boundaries explicit and future microservice extraction (if ever needed) trivial.

---

## 5. Offset vs Cursor Pagination & Product Search (Sections 91–92)

### Why `OFFSET` Fails at Scale
If a table has 2,000,000 rows and a client requests `LIMIT 20 OFFSET 1000000`, PostgreSQL must scan, sort, and **discard 1,000,000 rows** before returning 20 rows (`O(N)` latency degradation). Worse, if a new row is inserted while the user pages from page 1 to page 2, rows shift and the user sees duplicate items.

### Why Cursor Pagination with UUIDv7 Is `O(1)`
Because our `id` column uses **UUIDv7** (`Bun.randomUUIDv7()`), `id` is strictly monotonically increasing with creation time and indexed by `idx_products_org_id_desc (organization_id, id DESC)`.
Fetching the next page is a simple B-Tree index seek: `WHERE organization_id = $1 AND id < $cursor ORDER BY id DESC LIMIT $limit + 1`.

```typescript
// src/modules/products/product.repository.ts
import { and, desc, asc, eq, gte, lte, lt, ilike, or, type SQL } from "drizzle-orm";
import { products } from "../../infrastructure/db/schema";
import type { ListProductsQuery } from "./product.schemas";

export class ProductRepository {
  constructor(private readonly db: any) {}

  async searchProducts(organizationId: string, query: ListProductsQuery) {
    // 1. Mandatory tenant isolation condition FIRST!
    const conditions: SQL[] = [eq(products.organizationId, organizationId)];

    if (query.category) {
      conditions.push(eq(products.category, query.category));
    }
    if (query.minPriceCents !== undefined) {
      conditions.push(gte(products.priceCents, query.minPriceCents));
    }
    if (query.maxPriceCents !== undefined) {
      conditions.push(lte(products.priceCents, query.maxPriceCents));
    }
    if (query.search) {
      // Parameterized ILIKE prevents SQL injection automatically
      const pattern = `%${query.search.replace(/[%_]/g, "\\$&")}%`;
      conditions.push(or(ilike(products.name, pattern), ilike(products.sku, pattern))!);
    }
    if (query.cursor) {
      conditions.push(lt(products.id, query.cursor));
    }

    // Fetch `limit + 1` rows to determine `hasMore` without a second COUNT(*) query!
    const rows = await this.db
      .select()
      .from(products)
      .where(and(...conditions))
      .orderBy(query.sortOrder === "asc" ? asc(products.id) : desc(products.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const data = hasMore ? rows.slice(0, query.limit) : rows;
    const nextCursor = hasMore ? data[data.length - 1]?.id ?? null : null;

    return {
      data,
      meta: {
        nextCursor,
        hasMore,
        limit: query.limit,
      },
    };
  }
}
```

---

## 6. Transactions, Concurrency & Race Conditions: "Two Users Buying the Last Product" (Sections 94–96)

### ❌ BAD EXAMPLE: Read-Modify-Write Race Condition Outside a Lock

```typescript
// ❌ BROKEN UNDER CONCURRENCY!
// User A and User B both request quantity=1 when stockQuantity=1 at the exact same millisecond:
// 1. User A reads stockQuantity = 1
// 2. User B reads stockQuantity = 1
// 3. Both pass `if (product.stockQuantity < 1)`!
// 4. Both orders are created for 1 item when only 1 existed in the warehouse!
const [product] = await db.select().from(products).where(eq(products.id, productId));
if (product.stockQuantity < requestedQty) throw new Error("Out of stock");
await db.update(products).set({ stockQuantity: product.stockQuantity - requestedQty }).where(eq(products.id, productId));
```

### ✅ PRODUCTION PATTERN: Atomic Conditional Update Inside an ACID Transaction

To guarantee that two concurrent buyers can **never** oversell the last unit of inventory, we combine:
1. A single PostgreSQL database transaction (`db.transaction(async (tx) => ...)`).
2. Deterministic **sorted product ID ordering** (prevents deadlocks when Order A buys `[Prod1, Prod2]` and Order B buys `[Prod2, Prod1]`).
3. **Atomic conditional `UPDATE ... SET stock_quantity = stock_quantity - $qty WHERE id = $id AND organization_id = $orgId AND stock_quantity >= $qty RETURNING ...`**: PostgreSQL acquires a row-level exclusive lock on the updated row, evaluates `stock_quantity >= $qty` atomically against the latest committed value, and returns 0 rows if inventory was exhausted.

```typescript
// src/modules/orders/order.transaction.ts
import { and, eq, gte, sql } from "drizzle-orm";
import { orders, orderItems, products } from "../../infrastructure/db/schema";
import { AppError } from "../../errors/app-error";

export interface CreateOrderLineInput {
  productId: string;
  quantity: number;
}

export async function createOrderWithInventoryReservation(
  db: any,
  params: {
    organizationId: string;
    customerUserId: string;
    idempotencyKey: string | null;
    items: CreateOrderLineInput[];
  },
) {
  // Sort items by productId ascending so concurrent transactions always acquire row locks
  // in the exact same order — eliminating circular AB-BA deadlocks!
  const sortedItems = [...params.items].sort((a, b) => a.productId.localeCompare(b.productId));

  return await db.transaction(async (tx: any) => {
    // 1. Check idempotency inside transaction if key provided
    if (params.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.organizationId, params.organizationId),
            eq(orders.idempotencyKey, params.idempotencyKey),
          ),
        );
      if (existing) {
        return { order: existing, deduplicated: true };
      }
    }

    let totalCents = 0;
    const reservedLines: Array<{ productId: string; quantity: number; unitPriceCents: number }> = [];

    // 2. Atomically reserve inventory for each line item
    for (const item of sortedItems) {
      const [updatedProduct] = await tx
        .update(products)
        .set({
          stockQuantity: sql`${products.stockQuantity} - ${item.quantity}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(products.id, item.productId),
            eq(products.organizationId, params.organizationId),
            gte(products.stockQuantity, item.quantity), // <-- Atomic guard!
          ),
        )
        .returning({
          id: products.id,
          priceCents: products.priceCents,
          remainingStock: products.stockQuantity,
        });

      if (!updatedProduct) {
        // Rolling back the entire transaction automatically restores any previously reserved items!
        throw AppError.conflict(
          `Insufficient stock or product not found for product '${item.productId}'`,
        );
      }

      totalCents += updatedProduct.priceCents * item.quantity;
      reservedLines.push({
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents: updatedProduct.priceCents,
      });
    }

    // 3. Insert Order header
    const [createdOrder] = await tx
      .insert(orders)
      .values({
        organizationId: params.organizationId,
        customerUserId: params.customerUserId,
        status: "pending",
        totalCents,
        idempotencyKey: params.idempotencyKey,
      })
      .returning();

    // 4. Insert Order Items
    await tx.insert(orderItems).values(
      reservedLines.map((line) => ({
        orderId: createdOrder.id,
        productId: line.productId,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
      })),
    );

    return { order: createdOrder, deduplicated: false };
  });
}
```

---

## 7. Exercises & Architecture Challenge

- **Beginner**: Write a SQL migration adding an `audit_logs` table with `id` (UUIDv7), `organization_id`, `actor_user_id`, `action`, `resource_type`, `resource_id`, `request_id`, and `created_at` with an index on `(organization_id, created_at DESC)`.
- **Intermediate**: Write an integration test firing `Promise.all([buyLastItem(userA), buyLastItem(userB)])` when `stockQuantity = 1` and assert that **exactly one** resolves with `201 Created` and **one** rejects with `409 Conflict`, leaving `stockQuantity === 0`.
- **Architecture Challenge**: *Why did we sort `sortedItems` by `productId` before executing the `UPDATE` loop inside the transaction? Draw the exact timeline of how Transaction 1 ordering `[Product_A, Product_B]` and Transaction 2 ordering `[Product_B, Product_A]` would cause a PostgreSQL deadlock (`40P01`) without sorting.*

---

## 8. Official Documentation & Pre-Flight Checklist

- **Official Docs**: [PostgreSQL 17/18 Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html) | [Drizzle ORM Docs](https://orm.drizzle.team/docs/overview) | [Bun.sql Docs](https://bun.sh/docs/api/sql)
- **What You Should Know Before Continuing**:
  - [x] Why UUIDv7 outperforms UUIDv4 for B-Tree primary keys and cursor pagination.
  - [x] How atomic conditional updates (`WHERE stock_quantity >= $qty`) prevent overselling under concurrency.
  - [x] Why every repository query in a multi-tenant system must include `organization_id`.
