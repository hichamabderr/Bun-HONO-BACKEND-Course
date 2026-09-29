// examples/capstone-saas-reference/src/infrastructure/db/schema.ts
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

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "manager", "member"]);
export const orderStatusEnum = pgEnum("order_status", ["pending", "paid", "fulfilled", "cancelled"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: orgRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_org_membership_user").on(table.organizationId, table.userId),
    index("idx_org_membership_user").on(table.userId),
  ],
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_refresh_tokens_family").on(table.familyId),
    index("idx_refresh_tokens_user").on(table.userId),
  ],
);

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
    imageObjectKey: text("image_object_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_products_org_sku").on(table.organizationId, table.sku),
    index("idx_products_org_id_desc").on(table.organizationId, table.id.desc()),
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
    customerUserId: uuid("customer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: orderStatusEnum("status").notNull().default("pending"),
    totalCents: integer("total_cents").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_orders_org_idempotency")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("idx_orders_org_id_desc").on(table.organizationId, table.id.desc()),
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

export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  providerEventId: varchar("provider_event_id", { length: 128 }).notNull().unique(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: varchar("actor_user_id", { length: 64 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: varchar("resource_id", { length: 64 }).notNull(),
    result: varchar("result", { length: 16 }).notNull(),
    requestId: varchar("request_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_audit_logs_org_id_desc").on(table.organizationId, table.id.desc())],
);
