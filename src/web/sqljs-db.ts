/**
 * Browser SQLite driver: sql.js (SQLite compiled to WebAssembly), wrapped to
 * present exactly the same DB/Stmt interface the desktop drivers expose, so
 * the entire backend runs unchanged.
 */
import initSqlJs, { type Database } from 'sql.js';
import type { DB, Stmt } from '../backend/sqlite';
import { SQLJS_WASM_BASE64 } from './generated/sqljs-wasm';

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface WebDB extends DB {
  /** Serialise the whole database to bytes (for persistence / backup). */
  exportBytes(): Uint8Array;
}

export async function openWebDatabase(initial?: Uint8Array): Promise<WebDB> {
  const SQL = await initSqlJs({ wasmBinary: b64ToBytes(SQLJS_WASM_BASE64).buffer as ArrayBuffer });
  const db: Database = initial ? new SQL.Database(initial) : new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON;');

  let txDepth = 0;

  const makeStmt = (sql: string): Stmt => ({
    run: (...params: unknown[]) => {
      const st = db.prepare(sql);
      try {
        st.bind(params as any);
        st.step();
      } finally {
        st.free();
      }
      const changes = db.getRowsModified();
      let lastInsertRowid = 0;
      const idStmt = db.prepare('SELECT last_insert_rowid() AS id');
      try {
        idStmt.step();
        lastInsertRowid = Number((idStmt.getAsObject() as any).id ?? 0);
      } finally {
        idStmt.free();
      }
      return { lastInsertRowid, changes };
    },
    get: (...params: unknown[]) => {
      const st = db.prepare(sql);
      try {
        st.bind(params as any);
        if (!st.step()) return undefined;
        return st.getAsObject();
      } finally {
        st.free();
      }
    },
    all: (...params: unknown[]) => {
      const st = db.prepare(sql);
      const rows: any[] = [];
      try {
        st.bind(params as any);
        while (st.step()) rows.push(st.getAsObject());
      } finally {
        st.free();
      }
      return rows;
    },
  });

  return {
    driver: 'node:sqlite', // closest label; nothing branches on it
    exec: (sql: string) => {
      db.exec(sql);
    },
    prepare: makeStmt,
    transaction: <T,>(fn: () => T): T => {
      if (txDepth > 0) return fn(); // nested: join the outer transaction
      db.exec('BEGIN');
      txDepth++;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        txDepth--;
      }
    },
    close: () => db.close(),
    backup: () => {
      throw new Error('Use exportBytes() in the browser');
    },
    exportBytes: () => db.export(),
  };
}
