/**
 * SQLite driver adapter.
 *
 * Book of Business prefers `better-sqlite3` (fast, battle-tested, prebuilt
 * binaries). If it isn't available — e.g. the native module wasn't built for
 * the current runtime — we fall back to Node's built-in `node:sqlite`
 * (available in Node 22+ / Electron 35+), which needs no native compilation.
 *
 * Both drivers are synchronous, which is exactly what an accounting engine
 * wants: a posting is a single transaction that either fully commits or
 * fully rolls back.
 */
import { createRequire } from 'node:module';

export interface Stmt {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export interface DB {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  transaction<T>(fn: () => T): T;
  close(): void;
  /** Online backup of the open database to a file path. */
  backup(destPath: string): Promise<void> | void;
  readonly driver: 'better-sqlite3' | 'node:sqlite';
}

/**
 * Resolve a CJS `require` lazily, only when a Node driver is actually opened.
 * Computing this at module-load time would crash non-Node environments (the
 * browser edition imports this module for its types but never calls
 * openDatabase — it brings its own WASM driver).
 */
function getRequire(): NodeRequire {
  // In a CJS bundle `require` exists; in ESM we create one.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (typeof require === 'function') return require;
  try {
    // Indirect lookup keeps this expression legal under CommonJS compilation
    // (the server build); under ESM (browser/Vite) import.meta.url resolves.
    const metaUrl = (0, eval)('typeof import.meta !== "undefined" ? import.meta.url : undefined');
    return createRequire(metaUrl || (process.cwd() + '/'));
  } catch {
    return createRequire(process.cwd() + '/');
  }
}

export function openDatabase(path: string): DB {
  const requireCjs = getRequire();
  // 1) better-sqlite3 if present and loadable
  try {
    const Better = requireCjs('better-sqlite3');
    const db = new Better(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return {
      driver: 'better-sqlite3',
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.prepare(sql),
      transaction: <T,>(fn: () => T): T => db.transaction(fn)(),
      close: () => db.close(),
      backup: (dest: string) => db.backup(dest),
    };
  } catch {
    /* fall through */
  }

  // 2) node:sqlite fallback
  const { DatabaseSync } = requireCjs('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  let txDepth = 0;
  const wrap = (stmt: any): Stmt => ({
    run: (...p) => {
      const r = stmt.run(...p);
      return { lastInsertRowid: r.lastInsertRowid, changes: Number(r.changes) };
    },
    get: (...p) => stmt.get(...p),
    all: (...p) => stmt.all(...p),
  });
  return {
    driver: 'node:sqlite',
    exec: (sql) => db.exec(sql),
    prepare: (sql) => wrap(db.prepare(sql)),
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
    backup: async (dest: string) => {
      const sqlite = requireCjs('node:sqlite');
      if (typeof sqlite.backup === 'function') await sqlite.backup(db, dest);
      else db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    },
  };
}
