/**
 * File attachments on transactions. Files are stored inside the ledger
 * database itself (base64), so a backup of the books carries its paperwork
 * with it — receipts, contracts, statements — and the single-file web
 * edition needs no filesystem.
 */
import { getDb } from '../db';
import { audit } from '../engine';

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB per file keeps the database nimble
const ENTITY_TYPES = ['invoice', 'manual_journal', 'payment', 'bank_transaction'];

export function list(entity_type: string, entity_id: number) {
  return getDb()
    .prepare(
      `SELECT id, filename, mime_type, size, uploaded_at FROM attachments
       WHERE entity_type = ? AND entity_id = ? ORDER BY id`
    )
    .all(entity_type, entity_id);
}

const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'csv', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'ofx', 'qfx'];

export function add(input: { entity_type: string; entity_id: number; filename: string; mime_type?: string; data_base64: string }, user_id = 1) {
  if (!ENTITY_TYPES.includes(input.entity_type)) throw new Error(`Unknown attachment target: ${input.entity_type}`);
  if (!input.filename?.trim()) throw new Error('The file needs a name');
  const b64 = input.data_base64 ?? '';
  const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  if (size <= 0) throw new Error('The file is empty');
  if (size > MAX_BYTES) throw new Error(`Files up to 3 MB are supported — this one is ${(size / 1048576).toFixed(1)} MB`);
  const ext = (input.filename.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw new Error(`"${input.filename}" isn't a supported file type. Allowed: ${ALLOWED_EXT.join(', ')}.`);
  const db = getDb();
  const r = db
    .prepare(
      `INSERT INTO attachments (entity_type, entity_id, filename, mime_type, size, data)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.entity_type, input.entity_id, input.filename.trim(), input.mime_type ?? null, size, b64);
  const id = Number(r.lastInsertRowid);
  audit('attachment', id, 'CREATE', null, { entity: `${input.entity_type}#${input.entity_id}`, filename: input.filename, size }, user_id);
  return { id, filename: input.filename.trim(), size };
}

export function get(id: number) {
  const a = getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  if (!a) throw new Error('Attachment not found');
  return a;
}

export function remove(id: number, user_id = 1) {
  const a = getDb().prepare('SELECT entity_type, entity_id, filename FROM attachments WHERE id = ?').get(id);
  if (!a) return;
  getDb().prepare('DELETE FROM attachments WHERE id = ?').run(id);
  audit('attachment', id, 'DELETE', { entity: `${a.entity_type}#${a.entity_id}`, filename: a.filename }, null, user_id);
}
