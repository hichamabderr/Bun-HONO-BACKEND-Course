// examples/capstone-saas-reference/src/entrypoints/api.ts
// Production Bun v1.4.2 Entrypoint with Liveness/Readiness Separation & Graceful SIGTERM Drain

let isShuttingDown = false;

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(Bun.env.PORT ?? 3000),
  maxRequestBodySize: 5 * 1024 * 1024,
  idleTimeout: 30,

  routes: {
    "/liveness": () =>
      Response.json({ status: "alive", runtime: `bun-${Bun.version}` }, { status: 200 }),

    "/readiness": () => {
      if (isShuttingDown) {
        return Response.json({ status: "draining" }, { status: 503 });
      }
      return Response.json({ status: "ready" }, { status: 200 });
    },
  },

  fetch(req) {
    const url = new URL(req.url);
    return Response.json(
      {
        error: {
          code: "NOT_FOUND",
          message: `Route ${req.method} ${url.pathname} not found`,
        },
      },
      { status: 404 },
    );
  },
});

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(JSON.stringify({ level: "info", signal, msg: "Starting graceful shutdown" }));
  await server.stop(false);
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(
  JSON.stringify({
    level: "info",
    msg: "Server listening",
    hostname: server.hostname,
    port: server.port,
    bunVersion: Bun.version,
  }),
);
