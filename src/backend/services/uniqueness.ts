/**
 * Reusable "no duplicate names" guard. Names that differ only in case or
 * surrounding spaces ("Anchor Coworking" vs "anchor coworking ") are treated
 * as the same, which is what stops the confusing duplicates that would
 * otherwise show up in pickers and in Find & Recode.
 */
import { getDb } from '../db';

type UniqueOpts = {
  table: string;
  column: string;
  value: string;
  /** Exclude this row when editing an existing record. */
  excludeId?: number;
  /** Extra equality scope, e.g. { category_id: 4 } for options within a category. */
  scope?: Record<string, number | string>;
  /** Only compare against rows in these statuses; omit to compare against all. */
  statuses?: string[];
  /** Human label used in the error message. */
  label: string;
};

export function assertUniqueName(opts: UniqueOpts): void {
  const v = (opts.value ?? '').trim();
  if (!v) return; // emptiness is validated separately by each caller
  const where: string[] = [`LOWER(TRIM(${opts.column})) = LOWER(?)`];
  const args: Array<string | number> = [v];
  if (opts.excludeId != null) { where.push('id != ?'); args.push(opts.excludeId); }
  for (const [k, val] of Object.entries(opts.scope ?? {})) { where.push(`${k} = ?`); args.push(val); }
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
    args.push(...opts.statuses);
  }
  const hit = getDb()
    .prepare(`SELECT id, ${opts.column} AS name FROM ${opts.table} WHERE ${where.join(' AND ')} LIMIT 1`)
    .get(...args) as { id: number; name: string } | undefined;
  if (hit) {
    throw new Error(`${opts.label} "${hit.name}" already exists — pick a different name (names must be unique so they're never confused in reports or Find & recode).`);
  }
}
