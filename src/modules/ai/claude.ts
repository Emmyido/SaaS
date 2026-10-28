import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config } from "../../config.js";
import { pool, one } from "../../db/pool.js";
import { AppError, paymentRequired } from "../../lib/errors.js";
import { getPlan } from "../billing/plans.js";
import { assertFeature, type OrgContext } from "../../plugins/context.js";

export type ImageInput = { data: Buffer; mimeType: string } | { url: string };
export type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

/** Minimal surface the AI features need; tests swap in a fake. */
export interface StructuredModel {
  run<T>(args: { system: string; content: ContentBlock[]; schema: z.ZodType<T>; effort?: "low" | "medium" | "high" }): Promise<{
    output: T;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

class ClaudeModel implements StructuredModel {
  private client = new Anthropic();

  async run<T>(args: { system: string; content: ContentBlock[]; schema: z.ZodType<T>; effort?: "low" | "medium" | "high" }) {
    let res;
    try {
      res = await this.client.beta.messages.parse({
        model: config.ai.model,
        max_tokens: 16000,
        system: args.system,
        messages: [{ role: "user", content: args.content }],
        output_config: { effort: args.effort ?? "medium", format: betaZodOutputFormat(args.schema) },
        // Re-route automatically if a safety classifier declines (e.g. a false positive on a document).
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new AppError(503, "ai_busy", "The AI service is busy; try again in a moment");
      if (err instanceof Anthropic.BadRequestError) throw new AppError(422, "ai_rejected_input", `The AI could not process this input: ${err.message}`);
      if (err instanceof Anthropic.APIError) throw new AppError(502, "ai_unavailable", "The AI service is unavailable right now");
      throw err;
    }
    if (res.stop_reason === "refusal") throw new AppError(422, "ai_refused", "The AI declined to process this content");
    if (res.stop_reason === "max_tokens" || !res.parsed_output) throw new AppError(502, "ai_incomplete", "The AI returned an incomplete answer; try again");
    return { output: res.parsed_output as T, usage: res.usage };
  }
}

let model: StructuredModel | null = null;
export function getModel(): StructuredModel {
  if (!model) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new AppError(503, "ai_not_configured", "AI features are not configured on this server (set ANTHROPIC_API_KEY)");
    }
    model = new ClaudeModel();
  }
  return model;
}
export function setModel(m: StructuredModel | null): void {
  model = m;
}

/** Monthly AI credits: one credit per AI call. */
export async function assertCredits(ctx: OrgContext): Promise<{ used: number; limit: number }> {
  assertFeature(ctx, "ai");
  const limit = getPlan(ctx.plan).limits.aiCreditsMonthly;
  const r = await one(pool, `SELECT count(*)::int AS n FROM ai_usage WHERE org_id = $1 AND created_at >= date_trunc('month', now())`, [ctx.orgId]);
  if (r.n >= limit) throw paymentRequired(`You have used all ${limit} AI credits for this month.`, { limit, upgradeTo: ctx.plan === "starter" ? "pro" : undefined });
  return { used: r.n, limit };
}

export async function runAi<T>(ctx: OrgContext, feature: string, args: Parameters<StructuredModel["run"]>[0] & { schema: z.ZodType<T> }): Promise<T> {
  await assertCredits(ctx);
  const { output, usage } = await getModel().run(args);
  await pool.query(`INSERT INTO ai_usage (org_id, user_id, feature, input_tokens, output_tokens) VALUES ($1,$2,$3,$4,$5)`, [
    ctx.orgId, ctx.userId, feature, usage.input_tokens, usage.output_tokens,
  ]);
  return output;
}

export function imageBlock(img: ImageInput): ContentBlock {
  if ("url" in img) return { type: "image", source: { type: "url", url: img.url } };
  if (img.mimeType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: img.data.toString("base64") } };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: img.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: img.data.toString("base64") },
  };
}
