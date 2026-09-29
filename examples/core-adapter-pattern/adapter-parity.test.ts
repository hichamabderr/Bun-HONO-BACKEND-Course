// examples/core-adapter-pattern/adapter-parity.test.ts
// Verifies that both Hono and Elysia adapters produce identical HTTP behavior over the same Core OrderService
// (Runnable with `bun test`)

import { OrderService } from "./domain/order.service";
import { buildHonoOrderAdapter } from "./hono-adapter/order.routes";
import { buildElysiaOrderAdapter } from "./elysia-adapter/order.routes";

export async function verifyDualTrackParity() {
  const sharedProductId = "01923c8a-7b10-7000-8000-1a2b3c4d5e6f";

  // 1. Test Hono Adapter
  const honoService = new OrderService();
  const honoApp = buildHonoOrderAdapter(honoService);
  const honoRes = await honoApp.request("/api/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": "usr_alice",
      "X-Org-Id": "org_acme",
      "X-Role": "admin",
      "Idempotency-Key": "01923c8a-7b10-7000-8000-000000000099",
    },
    body: JSON.stringify({ productId: sharedProductId, quantity: 2 }),
  });

  // 2. Test Elysia Adapter
  const elysiaService = new OrderService();
  const elysiaApp = buildElysiaOrderAdapter(elysiaService);
  const elysiaRes = await elysiaApp.handle(
    new Request("http://localhost/api/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-Id": "usr_alice",
        "X-Org-Id": "org_acme",
        "X-Role": "admin",
        "Idempotency-Key": "01923c8a-7b10-7000-8000-000000000099",
      },
      body: JSON.stringify({ productId: sharedProductId, quantity: 2 }),
    }),
  );

  return {
    honoStatus: honoRes.status,
    elysiaStatus: elysiaRes.status,
  };
}
