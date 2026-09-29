# Module 8 — Authorization, RBAC, Multi-Tenancy & Audit Logging

> **Course Phase**: Phase 13 (Sections 36–38, 102, 106, 114)
> **Core Principle**: The Client UI and Route Middleware Are Not Enough — Enforce Authorization at the Server/Data Boundary

---

## 1. Concept: Authorization Architecture (Sections 36–38, 114)

Every authenticated request in a multi-tenant SaaS application must pass through a strict **8-stage authorization funnel**:

```text
Request
  ↓
1. Session / Verified JWT  ──► Proves `userId` (Authentication)
  ↓
2. User Account Status     ──► Checks user is active & not suspended
  ↓
3. Organization Resolution ──► Resolves target `organizationId` (from header/path/token)
  ↓
4. Membership Verification ──► Proves `userId` is an active member of `organizationId`
  ↓
5. Role & Permission Check ──► Evaluates RBAC (`owner`, `admin`, `manager`, `member`) + granular permissions
  ↓
6. Resource Ownership      ──► Checks if policy requires `resource.createdByUserId === actor.userId`
  ↓
7. Business Rule Policy    ──► e.g., "Cannot cancel an order whose status is already 'fulfilled'"
  ↓
8. Tenant-Constrained SQL  ──► `WHERE id = $1 AND organization_id = $2`
```

---

## 2. Multi-Tenant Data Model: Organizations, Memberships, Roles & Permissions (Section 38)

A single user can belong to **multiple organizations** with **different roles** in each organization (e.g., `owner` of their personal workspace, `member` of an enterprise client's workspace). Therefore, `role` belongs on the **`organization_memberships`** join table—**not** purely on the `users` table (except for a platform-wide `isPlatformSuperAdmin` flag for internal staff).

```typescript
// src/modules/organizations/rbac.ts
export type OrgRole = "owner" | "admin" | "manager" | "member";

export type Permission =
  | "org:update"
  | "org:delete"
  | "members:read"
  | "members:manage"
  | "products:read"
  | "products:write"
  | "orders:read"
  | "orders:create"
  | "orders:cancel_any"
  | "audit_logs:read";

export const ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  owner: new Set([
    "org:update",
    "org:delete",
    "members:read",
    "members:manage",
    "products:read",
    "products:write",
    "orders:read",
    "orders:create",
    "orders:cancel_any",
    "audit_logs:read",
  ]),
  admin: new Set([
    "org:update",
    "members:read",
    "members:manage",
    "products:read",
    "products:write",
    "orders:read",
    "orders:create",
    "orders:cancel_any",
    "audit_logs:read",
  ]),
  manager: new Set([
    "members:read",
    "products:read",
    "products:write",
    "orders:read",
    "orders:create",
    "orders:cancel_any",
  ]),
  member: new Set([
    "members:read",
    "products:read",
    "orders:read",
    "orders:create",
  ]),
};

export function hasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}
```

---

## 3. Authorization at the Server Boundary: Preventing IDOR / Broken Object Level Authorization (Sections 37 & 106)

**Broken Access Control (specifically BOLA / IDOR — Insecure Direct Object Reference) is #1 on the OWASP Top 10.**

### ❌ BAD EXAMPLE: Route Middleware Only + Unscoped Repository Query (`getOrder(id)`)

```typescript
// ❌ CRITICAL VULNERABILITY (Cross-Tenant Data Leak / IDOR):
// 1. Developer checks `requireAuth` in route middleware.
// 2. Developer calls `orderRepo.findById(c.req.param("id"))` without passing `organizationId`!
// 3. Attacker from Organization B passes an Order UUID belonging to Organization A and steals/cancels it!
app.get("/api/v1/orders/:id", requireAuth, async (c) => {
  const order = await orderRepository.findById(c.req.param("id")); // <-- NO TENANT CONSTRAINT!
  if (!order) throw AppError.notFound("Order");
  return c.json({ data: order });
});
```

### ✅ PRODUCTION PATTERN: Service & Repository Enforce Tenant Scope + ABAC Ownership

Make it **impossible** at the TypeScript signature level to query a tenant resource without passing `organizationId`:

```typescript
// src/modules/orders/order.service.ts
import { AppError } from "../../errors/app-error";
import { hasPermission, type OrgRole } from "../organizations/rbac";
import type { AuditLogger } from "../audit/audit.service";

export interface TenantActor {
  userId: string;
  organizationId: string;
  role: OrgRole;
  requestId: string;
}

export interface OrderRecord {
  id: string;
  organizationId: string;
  customerUserId: string;
  status: "pending" | "paid" | "fulfilled" | "cancelled";
  totalCents: number;
}

export interface OrderRepositoryPort {
  // Notice: `organizationId` is REQUIRED in the repository signature!
  findByIdScoped(params: { id: string; organizationId: string }): Promise<OrderRecord | null>;
  updateStatusScoped(params: {
    id: string;
    organizationId: string;
    status: OrderRecord["status"];
  }): Promise<OrderRecord | null>;
}

export class OrderDomainService {
  constructor(
    private readonly orderRepo: OrderRepositoryPort,
    private readonly auditLogger: AuditLogger,
  ) {}

  async getOrder(params: { id: string; actor: TenantActor }): Promise<OrderRecord> {
    if (!hasPermission(params.actor.role, "orders:read")) {
      throw AppError.forbidden("Missing permission: orders:read");
    }

    // 1. Query is constrained by BOTH `id` AND `organizationId` in SQL!
    const order = await this.orderRepo.findByIdScoped({
      id: params.id,
      organizationId: params.actor.organizationId,
    });

    if (!order) {
      // Return 404 (not 403) when another tenant's ID is probed so we don't leak existence
      throw AppError.notFound("Order", params.id);
    }

    // 2. Resource Ownership Policy: A regular `member` can only view their own orders;
    // `manager`, `admin`, and `owner` can view all orders in their organization.
    if (params.actor.role === "member" && order.customerUserId !== params.actor.userId) {
      throw AppError.forbidden("Members may only view their own orders");
    }

    return order;
  }

  async cancelOrder(params: { id: string; actor: TenantActor }): Promise<OrderRecord> {
    const order = await this.getOrder(params);

    const canCancelAny = hasPermission(params.actor.role, "orders:cancel_any");
    const isOwnOrder = order.customerUserId === params.actor.userId;

    if (!canCancelAny && !isOwnOrder) {
      throw AppError.forbidden("You do not have permission to cancel this order");
    }

    if (order.status === "fulfilled" || order.status === "cancelled") {
      throw AppError.conflict(`Order in status '${order.status}' cannot be cancelled`);
    }

    const updated = await this.orderRepo.updateStatusScoped({
      id: order.id,
      organizationId: params.actor.organizationId,
      status: "cancelled",
    });

    if (!updated) {
      throw AppError.notFound("Order", params.id);
    }

    // Record immutable audit log
    await this.auditLogger.record({
      organizationId: params.actor.organizationId,
      actorUserId: params.actor.userId,
      action: "order.cancelled",
      resourceType: "order",
      resourceId: order.id,
      result: "success",
      requestId: params.actor.requestId,
      metadata: { previousStatus: order.status },
    });

    return updated;
  }
}
```

---

## 4. Security & Compliance Audit Logs (Section 102)

In B2B SaaS backends, customers and compliance frameworks (SOC 2, ISO 27001, GDPR) require an immutable **Audit Log** of every sensitive state change.

### What Every Audit Log Entry Must Record
- `id`: Time-ordered UUIDv7 (`Bun.randomUUIDv7()`)
- `organizationId`: Tenant scope
- `actorUserId`: Who performed the action (or `"system:webhook"` for automated actions)
- `action`: Dot-namespaced verb (`auth.login`, `member.role_updated`, `order.cancelled`, `organization.deleted`)
- `resourceType` & `resourceId`: Target entity (`"order"`, `"01923c8a-..."`)
- `result`: `"success"` | `"denied"` | `"failure"`
- `requestId`: Correlation ID linking to Pino logs and OpenTelemetry traces
- `timestamp`: UTC `TIMESTAMPTZ`
- **NEVER RECORD**: Passwords, raw JWTs, session cookies, credit card numbers, or API secrets!

```typescript
// src/modules/audit/audit.service.ts
export interface AuditEvent {
  organizationId: string;
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: "success" | "denied" | "failure";
  requestId: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AuditLogger {
  record(event: AuditEvent): Promise<void>;
}
```

---

## 5. Multi-Tenant Security Review Checklist (Section 106)

Before merging any PR that touches a database query or cache key, run this 4-point review:
1. **SQL Constraint**: Does every `SELECT`, `UPDATE`, and `DELETE` on a tenant table include `WHERE organization_id = $actorOrgId`?
2. **Input Spoofing Guard**: Is `organizationId` resolved from verified server membership (never blindly trusted from a JSON request body)?
3. **Cache Key Namespace**: Are Redis cache keys prefixed by tenant (`tenant:${organizationId}:product:${productId}`)? Without tenant prefixing in Redis, Tenant B can read Tenant A's cached product!
4. **Real-Time Room Isolation**: Are WebSocket pub/sub topics scoped per tenant (`org:${organizationId}:notifications`) and authorized before `ws.subscribe()`?

---

## 6. Exercises & Architecture Challenge

- **Beginner**: Implement a policy function `canUpdateMemberRole(actorRole, targetCurrentRole, newRole)` that prevents an `admin` from demoting an `owner` or promoting themselves to `owner`.
- **Intermediate**: Write an integration test in `bun:test` with two organizations (`OrgA` and `OrgB`). Create a product in `OrgA`, then attempt `GET`, `PATCH`, and `DELETE` on that product's UUID authenticated as the `owner` of `OrgB`. Assert all three return `404 Not Found` and `OrgA`'s product remains untouched.
- **Architecture Challenge**: *Why is PostgreSQL Row-Level Security (`ENABLE ROW LEVEL SECURITY`) a useful defense-in-depth layer alongside explicit `WHERE organization_id = $1` repository filters, and what connection-pooling pitfall (`SET LOCAL app.current_org_id = ...` inside transactions) must you handle when using PgBouncer in transaction pooling mode?*
