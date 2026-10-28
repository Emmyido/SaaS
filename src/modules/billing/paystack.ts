import crypto from "node:crypto";
import { config } from "../../config.js";
import { pool, one } from "../../db/pool.js";
import { AppError, badRequest } from "../../lib/errors.js";
import { getPlan } from "./plans.js";

/** Start a Paystack checkout for a plan; Paystack then charges on the plan's interval. */
export async function initializeCheckout(orgId: string, email: string, planId: "starter" | "pro", interval: "monthly" | "yearly") {
  if (!config.paystack.secretKey) throw new AppError(503, "billing_not_configured", "Online billing is not configured (PAYSTACK_SECRET_KEY)");
  const plan = getPlan(planId);
  const planCode = config.paystack.planCodes[planId];
  const amount = interval === "yearly" ? plan.priceYearlyKobo : plan.priceMonthlyKobo;
  const res = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { authorization: `Bearer ${config.paystack.secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      email,
      amount,
      ...(planCode && interval === "monthly" ? { plan: planCode } : {}),
      metadata: { orgId, plan: planId, interval },
      callback_url: `${config.publicBaseUrl}/billing/return`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const json: any = await res.json();
  if (!res.ok || !json.status) throw new AppError(502, "billing_error", json.message ?? "Paystack error");
  return { authorizationUrl: json.data.authorization_url as string, reference: json.data.reference as string };
}

export function verifyPaystackSignature(rawBody: string, signature: string | undefined): boolean {
  if (!config.paystack.secretKey || !signature) return false;
  const expected = crypto.createHmac("sha512", config.paystack.secretKey).update(rawBody).digest("hex");
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Apply a Paystack webhook event to the organisation's subscription. */
export async function handlePaystackEvent(event: { event: string; data: any }) {
  const data = event.data ?? {};
  const meta = typeof data.metadata === "string" ? safeJson(data.metadata) : data.metadata ?? {};
  switch (event.event) {
    case "charge.success": {
      if (!meta.orgId || !meta.plan) return { ignored: true };
      if (!["starter", "pro"].includes(meta.plan)) throw badRequest("Unknown plan in metadata");
      // Metadata can be set client-side with Paystack inline checkout, so check the amount actually paid.
      const plan = getPlan(meta.plan);
      const expected = meta.interval === "yearly" ? plan.priceYearlyKobo : plan.priceMonthlyKobo;
      if (Number(data.amount) < expected) return { ignored: true, reason: "amount below plan price" };
      const months = meta.interval === "yearly" ? 12 : 1;
      await pool.query(
        `UPDATE organizations SET plan = $2, plan_status = 'active', paystack_customer_code = COALESCE($3, paystack_customer_code),
                plan_renews_at = GREATEST(COALESCE(plan_renews_at, now()), now()) + make_interval(months => $4)
          WHERE id = $1`,
        [meta.orgId, meta.plan, data.customer?.customer_code ?? null, months],
      );
      return { updated: meta.orgId };
    }
    case "subscription.create": {
      const org = await one(pool, `SELECT id FROM organizations WHERE paystack_customer_code = $1`, [data.customer?.customer_code]);
      if (org) await pool.query(`UPDATE organizations SET paystack_subscription_code = $2 WHERE id = $1`, [org.id, data.subscription_code]);
      return { updated: org?.id ?? null };
    }
    case "invoice.payment_failed": {
      await pool.query(`UPDATE organizations SET plan_status = 'past_due' WHERE paystack_subscription_code = $1`, [data.subscription?.subscription_code]);
      return { updated: true };
    }
    case "subscription.disable":
    case "subscription.not_renew": {
      await pool.query(`UPDATE organizations SET plan_status = 'cancelled' WHERE paystack_subscription_code = $1`, [data.subscription_code]);
      return { updated: true };
    }
    default:
      return { ignored: true };
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
