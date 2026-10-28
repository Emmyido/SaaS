import type { Db } from "../../db/pool.js";
import { one, many } from "../../db/pool.js";
import { badRequest } from "../../lib/errors.js";
import { nextSeq } from "../../lib/sequences.js";

export interface LineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  description?: string;
  contactId?: string | null;
  itemId?: string | null;
  currency?: string | null;
  fxRate?: number | null;
  foreignAmount?: number | null;
}

export interface EntryInput {
  date: string;
  memo: string;
  sourceType?: string;
  sourceId?: string | null;
  createdBy?: string | null;
  lines: LineInput[];
}

/**
 * Post a balanced journal entry. Zero lines are dropped and same-side lines on one account are kept
 * separate (for audit detail). Throws if debits != credits; the DB trigger double-checks at commit.
 */
export async function postEntry(db: Db, orgId: string, input: EntryInput): Promise<string> {
  const lines = input.lines
    .map((l) => ({ ...l, debit: Math.round(l.debit ?? 0), credit: Math.round(l.credit ?? 0) }))
    .flatMap((l) => {
      // Normalise negatives: a negative debit is a credit and vice versa.
      const net = l.debit - l.credit;
      if (net === 0) return [];
      return [{ ...l, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }];
    });
  if (lines.length < 2) throw badRequest("A journal entry needs at least two non-zero lines");
  const dr = lines.reduce((s, l) => s + l.debit, 0);
  const cr = lines.reduce((s, l) => s + l.credit, 0);
  if (dr !== cr) throw badRequest(`Journal entry is unbalanced: debits ${dr} vs credits ${cr}`);

  const entryNo = await nextSeq(db, orgId, "journal");
  const entry = await one(
    db,
    `INSERT INTO journal_entries (org_id, entry_no, entry_date, memo, source_type, source_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [orgId, entryNo, input.date, input.memo, input.sourceType ?? "manual", input.sourceId ?? null, input.createdBy ?? null],
  );
  for (const l of lines) {
    await db.query(
      `INSERT INTO journal_lines (entry_id, org_id, account_id, debit, credit, description, contact_id, item_id, currency, fx_rate, foreign_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [entry!.id, orgId, l.accountId, l.debit, l.credit, l.description ?? null, l.contactId ?? null, l.itemId ?? null,
        l.currency ?? null, l.fxRate ?? null, l.foreignAmount ?? null],
    );
  }
  return entry!.id;
}

/** Post the mirror image of an entry (used for voids). Returns the reversing entry id. */
export async function reverseEntry(db: Db, orgId: string, entryId: string, date: string, memo: string, userId?: string): Promise<string> {
  const original = await one(db, `SELECT * FROM journal_entries WHERE id = $1 AND org_id = $2`, [entryId, orgId]);
  if (!original) throw badRequest("Journal entry not found");
  const lines = await many(db, `SELECT * FROM journal_lines WHERE entry_id = $1`, [entryId]);
  const id = await postEntry(db, orgId, {
    date,
    memo,
    sourceType: original.source_type,
    sourceId: original.source_id,
    createdBy: userId,
    lines: lines.map((l) => ({
      accountId: l.account_id,
      debit: l.credit,
      credit: l.debit,
      description: l.description,
      contactId: l.contact_id,
      itemId: l.item_id,
    })),
  });
  await db.query(`UPDATE journal_entries SET reverses_id = $1 WHERE id = $2`, [entryId, id]);
  return id;
}
