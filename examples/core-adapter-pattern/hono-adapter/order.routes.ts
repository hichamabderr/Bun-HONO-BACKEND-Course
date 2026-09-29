// examples/core-adapter-pattern/hono-adapter/order.routes.ts
// Track A: Hono (v4.13.x) HTTP Adapter wrapping the framework-agnostic OrderService

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { OrderService, DomainError, type TenantActor } from "../domain/order.service";

export type HonoEnv = {
  Variables: {
    actor: TenantActor;
  };
};

const CreateOrderSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(100),
});

export function buildHonoOrderAdapter(orderService: OrderService) {
  const app = new Hono<HonoEnv>();

  // Demo Auth Context Middleware
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("actor", {
      userId: c.req.header("x-user-id") ?? "usr_01",
      organizationId: c.req.header("x-org-id") ?? "org_acme",
      role: (c.req.header("x-role") as TenantActor["role"]) ?? "admin",
      requestId,
    });
    c.header("X-Request-Id", requestId);
    await next();
  });

  const routes = app
    .post("/api/v1/orders", zValidator("json", CreateOrderSchema), async (c) => {
      const actor = c.get("actor");
      const input = c.req.valid("json");
      const idempotencyKey = c.req.header("idempotency-key") ?? null;

      const { order, deduplicated } = await orderService.createOrder({
        actor,
        input,
        idempotencyKey,
      });

      return c.json(
        { data: order, meta: { requestId: actor.requestId, deduplicated } },
        deduplicated ? 200 : 201,
      );
    })
    .get("/api/v1/orders/:id", async (c) => {
      const actor = c.get("actor");
      const order = await orderService.getOrderById({
        orderId: c.req.param("id"),
        actor,
      });
      return c.json({ data: order, meta: { requestId: actor.requestId } }, 200);
    });

  app.onError((err, c) => {
    const requestId = c.get("actor")?.requestId;
    if (err instanceof DomainError) {
      return c.json(
        { error: { code: err.code, message: err.message, requestId } },
        err.statusCode,
      );
    }
    return c.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected error", requestId } },
      500,
    );
  });

  return routes;
}

export type HonoOrderAppType = ReturnType<typeof buildHonoOrderAdapter>;
