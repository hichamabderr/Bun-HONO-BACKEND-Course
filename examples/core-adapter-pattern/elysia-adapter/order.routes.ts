// examples/core-adapter-pattern/elysia-adapter/order.routes.ts
// Track B: Elysia (v1.4.30) HTTP Adapter wrapping the EXACT same OrderService

import { Elysia, t } from "elysia";
import { z } from "zod";
import { OrderService, DomainError, type TenantActor } from "../domain/order.service";

// Standard Schema (Zod v4) works directly in Elysia 1.4+!
const CreateOrderZodSchema = z.object({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(100),
});

export function buildElysiaOrderAdapter(orderService: OrderService) {
  return new Elysia()
    .derive({ as: "scoped" }, ({ request, set }) => {
      const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
      set.headers["x-request-id"] = requestId;
      const actor: TenantActor = {
        userId: request.headers.get("x-user-id") ?? "usr_01",
        organizationId: request.headers.get("x-org-id") ?? "org_acme",
        role: (request.headers.get("x-role") as TenantActor["role"]) ?? "admin",
        requestId,
      };
      return { actor };
    })
    .onError(({ error, set, actor }) => {
      if (error instanceof DomainError) {
        set.status = error.statusCode;
        return {
          error: {
            code: error.code,
            message: error.message,
            requestId: actor?.requestId,
          },
        };
      }
    })
    .post(
      "/api/v1/orders",
      async ({ body, actor, request, set }) => {
        const idempotencyKey = request.headers.get("idempotency-key");
        const { order, deduplicated } = await orderService.createOrder({
          actor,
          input: body,
          idempotencyKey,
        });
        set.status = deduplicated ? 200 : 201;
        return { data: order, meta: { requestId: actor.requestId, deduplicated } };
      },
      {
        body: CreateOrderZodSchema,
      },
    )
    .get(
      "/api/v1/orders/:id",
      async ({ params, actor }) => {
        const order = await orderService.getOrderById({
          orderId: params.id,
          actor,
        });
        return { data: order, meta: { requestId: actor.requestId } };
      },
      {
        params: t.Object({ id: t.String({ format: "uuid" }) }),
      },
    );
}

export type ElysiaOrderAppType = ReturnType<typeof buildElysiaOrderAdapter>;
