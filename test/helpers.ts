import { afterAll, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { pool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { buildApp } from "../src/app.js";

let counter = 0;
let migrated = false;

export async function resetDatabase() {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate();
  migrated = true;
}

/** Fresh schema + app for a test file. */
export function useApp() {
  const ctx = {} as { app: FastifyInstance };
  beforeAll(async () => {
    if (!migrated) await resetDatabase();
    ctx.app = (await buildApp({ logger: false })) as unknown as FastifyInstance;
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  return ctx;
}

export interface Session {
  token: string;
  orgId: string;
  userId: string;
  call: <T = any>(method: string, url: string, payload?: unknown, expectStatus?: number) => Promise<T>;
  raw: (method: string, url: string, payload?: unknown) => Promise<{ status: number; body: any }>;
}

export async function signUp(app: FastifyInstance, opts: { verticals?: string[]; plan?: "starter" | "pro"; name?: string } = {}): Promise<Session> {
  counter++;
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email: `owner${counter}-${Date.now()}@example.com`,
      password: "password123",
      fullName: "Ada Okafor",
      phone: "+2348012345678",
      business: { name: opts.name ?? `Ada Motors ${counter}`, verticals: opts.verticals ?? ["dealer"], plan: opts.plan ?? "pro", city: "Lagos", state: "Lagos" },
    },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return session(app, body.token, body.organization.id, body.user.id);
}

export function session(app: FastifyInstance, token: string, orgId: string, userId: string): Session {
  const raw = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: res.body ? safeJson(res.body) : null };
  };
  return {
    token,
    orgId,
    userId,
    raw,
    call: async (method, url, payload, expectStatus) => {
      const res = await raw(method, url, payload);
      const ok = expectStatus ? res.status === expectStatus : res.status < 300;
      if (!ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(res.body)}`);
      return res.body;
    },
  };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Naira to kobo. */
export const N = (naira: number) => Math.round(naira * 100);

export async function accountBalance(orgId: string, key: string): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0)::bigint AS bal FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE a.org_id = $1 AND a.system_key = $2`,
    [orgId, key],
  );
  return Number(r.rows[0].bal);
}

export async function accountIdFor(orgId: string, key: string): Promise<string> {
  const r = await pool.query(`SELECT id FROM accounts WHERE org_id = $1 AND system_key = $2`, [orgId, key]);
  return r.rows[0].id;
}
