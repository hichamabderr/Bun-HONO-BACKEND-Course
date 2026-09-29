// examples/capstone-saas-reference/src/entrypoints/worker.ts
// Dedicated Background Worker Process Entrypoint (BullMQ v5.77+ with Bun.redis adapter)

import { RedisClient } from "bun";
import { Worker, createBunRedisClient, type Job } from "bullmq";
import { loadConfig } from "../config/env";

const config = loadConfig();

// Wrap Bun's built-in RedisClient using BullMQ's official createBunRedisClient adapter
const workerConnection = createBunRedisClient(new RedisClient(config.REDIS_URL));

export interface BackgroundJobPayload {
  type: "email.verification" | "email.password_reset" | "order.confirmation" | "webhook.dispatch";
  organizationId: string;
  resourceId: string;
  recipient?: string;
}

const worker = new Worker<BackgroundJobPayload>(
  "commerce-operations",
  async (job: Job<BackgroundJobPayload>) => {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "Processing job",
        jobId: job.id,
        type: job.data.type,
        organizationId: job.data.organizationId,
        attempt: job.attemptsMade + 1,
      }),
    );
  },
  {
    connection: workerConnection,
    concurrency: 10,
  },
);

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ level: "info", signal, msg: "Draining BullMQ worker" }));
  await worker.close();
  // Always close via the wrapper returned by createBunRedisClient, never raw.close()!
  await workerConnection.quit();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
