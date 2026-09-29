// examples/capstone-saas-reference/src/config/env.ts
import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().default("postgres://commerce:secret@localhost:5432/commerce_dev"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(32).default("dev_only_jwt_secret_at_least_32_bytes_long!"),
  WEBHOOK_SECRET: z.string().min(24).default("whsec_dev_secret_at_least_24_chars!"),
  S3_BUCKET: z.string().default("commerce-assets"),
  S3_ENDPOINT: z.string().url().default("https://s3.us-east-1.amazonaws.com"),
  S3_ACCESS_KEY_ID: z.string().default("minioadmin"),
  S3_SECRET_ACCESS_KEY: z.string().default("minioadmin"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173,https://app.acme.com")
    .transform((v) => v.split(",").map((s) => s.trim())),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "fatal"]).default("info"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(rawEnv: Record<string, string | undefined> = Bun.env): AppConfig {
  const result = EnvSchema.safeParse(rawEnv);
  if (!result.success) {
    console.error("Invalid startup environment variables:", result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return Object.freeze(result.data);
}
