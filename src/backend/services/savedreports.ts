/**
 * Saved report views. A view stores a report's full configuration — type, date
 * range, filters, chosen columns, comparison periods and basis — under a name,
 * so a customised report can be re-run in one click. The config is opaque JSON
 * owned by the Reports screen; this service just persists and lists it.
 */
import { getDb } from '../db';

export function list() {
  return getDb().prepare(
    'SELECT id, name, report_type, updated_at FROM saved_reports ORDER BY name COLLATE NOCASE'
  ).all();
}

export function get(id: number) {
  const row: any = getDb().prepare('SELECT * FROM saved_reports WHERE id = ?').get(id);
  if (!row) throw new Error('Saved report not found');
  return { ...row, config: safeParse(row.config_json) };
}

export function save(input: { id?: number; name: string; report_type: string; config: unknown }): number {
  const db = getDb();
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('Give the saved report a name');
  if (!input.report_type) throw new Error('A saved report needs a report type');
  const config_json = JSON.stringify(input.config ?? {});

  if (input.id) {
    const ex = db.prepare('SELECT id FROM saved_reports WHERE id = ?').get(input.id);
    if (!ex) throw new Error('Saved report not found');
    db.prepare("UPDATE saved_reports SET name = ?, report_type = ?, config_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, input.report_type, config_json, input.id);
    return input.id;
  }
  // Names are unique so "save" of an existing name updates it rather than duplicating.
  const dup: any = db.prepare('SELECT id FROM saved_reports WHERE name = ? COLLATE NOCASE').get(name);
  if (dup) {
    db.prepare("UPDATE saved_reports SET report_type = ?, config_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(input.report_type, config_json, dup.id);
    return dup.id;
  }
  return Number(db.prepare('INSERT INTO saved_reports (name, report_type, config_json) VALUES (?, ?, ?)')
    .run(name, input.report_type, config_json).lastInsertRowid);
}

export function remove(id: number) {
  getDb().prepare('DELETE FROM saved_reports WHERE id = ?').run(id);
  return { ok: true };
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
