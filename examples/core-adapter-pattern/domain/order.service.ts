// examples/core-adapter-pattern/domain/order.service.ts
// Pure Core Backend Domain Service — ZERO imports from Hono or Elysia!

export interface TenantActor {
  userId: string;
  organizationId: string;
  role: "owner" | "admin" | "manager" | "member";
  requestId: string;
}

export interface CreateOrderInput {
  productId: string;
  quantity: number;
}

export interface OrderEntity {
  id: string;
  organizationId: string;
  customerUserId: string;
  productId: string;
  quantity: number;
  totalCents: number;
  status: "pending" | "paid" | "cancelled";
  idempotencyKey: string | null;
  createdAt: string;
}

export class DomainError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "VALIDATION_ERROR",
    public readonly statusCode: 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class OrderService {
  private readonly orders = new Map<string, OrderEntity>();
  private readonly stockByProduct = new Map<string, { organizationId: string; priceCents: number; stock: number }>([
    ["01923c8a-7b10-7000-8000-1a2b3c4d5e6f", { organizationId: "org_acme", priceCents: 24900, stock: 10 }],
  ]);

  async createOrder(params: {
    actor: TenantActor;
    input: CreateOrderInput;
    idempotencyKey: string | null;
  }): Promise<{ order: OrderEntity; deduplicated: boolean }> {
    const { actor, input, idempotencyKey } = params;

    // 1. Idempotency Check Scoped to Organization
    if (idempotencyKey) {
      for (const existing of this.orders.values()) {
        if (
          existing.organizationId === actor.organizationId &&
          existing.idempotencyKey === idempotencyKey
        ) {
          return { order: existing, deduplicated: true };
        }
      }
    }

    // 2. Tenant-Scoped Product & Inventory Verification
    const product = this.stockByProduct.get(input.productId);
    if (!product || product.organizationId !== actor.organizationId) {
      throw new DomainError("NOT_FOUND", 404, `Product '${input.productId}' not found in organization`);
    }

    if (product.stock < input.quantity) {
      throw new DomainError("CONFLICT", 409, `Insufficient inventory for product '${input.productId}'`);
    }

    // 3. Atomic Reservation & Order Creation
    product.stock -= input.quantity;
    const order: OrderEntity = {
      id: crypto.randomUUID(),
      organizationId: actor.organizationId,
      customerUserId: actor.userId,
      productId: input.productId,
      quantity: input.quantity,
      totalCents: product.priceCents * input.quantity,
      status: "pending",
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };

    this.orders.set(order.id, order);
    return { order, deduplicated: false };
  }

  async getOrderById(params: { orderId: string; actor: TenantActor }): Promise<OrderEntity> {
    const order = this.orders.get(params.orderId);

    // Server-Boundary Tenant Isolation: Never return an order belonging to another organization!
    if (!order || order.organizationId !== params.actor.organizationId) {
      throw new DomainError("NOT_FOUND", 404, `Order '${params.orderId}' not found`);
    }

    // Ownership check for regular members
    if (params.actor.role === "member" && order.customerUserId !== params.actor.userId) {
      throw new DomainError("FORBIDDEN", 403, "Members can only view their own orders");
    }

    return order;
  }
}
