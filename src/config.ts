import "dotenv/config";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(env("PORT", "4000")),
  nodeEnv: env("NODE_ENV", "development"),
  databaseUrl: env("DATABASE_URL", "postgres://greenrev:greenrev@localhost:5432/greenrev_suite"),
  jwtSecret: env("JWT_SECRET", "dev-only-secret-change-me"),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:4000"),
  corsOrigins: env("CORS_ORIGINS", "*").split(",").map((s) => s.trim()),
  uploadDir: env("UPLOAD_DIR", "./uploads"),
  greenrev: {
    ssoSecret: process.env.GREENREV_SSO_SECRET || "",
    marketplaceUrl: process.env.GREENREV_MARKETPLACE_URL || "",
    marketplaceApiKey: process.env.GREENREV_MARKETPLACE_API_KEY || "",
    webhookSecret: process.env.GREENREV_WEBHOOK_SECRET || "",
  },
  runWorkerInProcess: env("RUN_WORKER_IN_PROCESS", "true") === "true",
  ai: {
    model: env("AI_MODEL", "claude-opus-5-5"),
  },
  paystack: {
    secretKey: process.env.PAYSTACK_SECRET_KEY || "",
    planCodes: {
      starter: process.env.PAYSTACK_PLAN_STARTER || "",
      pro: process.env.PAYSTACK_PLAN_PRO || "",
    },
  },
};
