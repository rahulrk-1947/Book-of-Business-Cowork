import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase, getDb, runMigrations, databaseInfo, APP_SCHEMA_VERSION } from '../src/backend/db';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir = '';
afterEach(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } dir = ''; } });

describe('safe app upgrading', () => {
  it('a fresh database reports the current data format as up to date', () => {
    initDatabase(':memory:');
    const info = databaseInfo();
    expect(info.schema_version).toBe(APP_SCHEMA_VERSION);
    expect(info.app_schema_version).toBe(APP_SCHEMA_VERSION);
    expect(info.up_to_date).toBe(true);
    expect(info.newer_than_app).toBe(false);
  });

  it('refuses to open data created by a NEWER version of the app', () => {
    initDatabase(':memory:');
    getDb().prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))").run(APP_SCHEMA_VERSION + 1);
    expect(databaseInfo().newer_than_app).toBe(true);
    expect(() => runMigrations(getDb())).toThrow(/newer version/i);
  });

  it('takes a pre-upgrade backup before applying pending migrations to a file', () => {
    dir = mkdtempSync(join(tmpdir(), 'bob-upg-'));
    const path = join(dir, 'company.sqlite');
    initDatabase(path); // reaches the latest version
    // Pretend we're one version behind on a real file. Re-running the newest
    // migration is safe: it's either an idempotent CREATE ... IF NOT EXISTS or a
    // column-add, which the runner treats as already-applied if the column exists.
    getDb().prepare('DELETE FROM schema_version WHERE version = ?').run(APP_SCHEMA_VERSION);
    expect(databaseInfo().schema_version).toBe(APP_SCHEMA_VERSION - 1);
    runMigrations(getDb(), path); // should snapshot first, then upgrade
    const backups = readdirSync(dir).filter((f) => f.includes('pre-upgrade'));
    expect(backups.length).toBe(1);
    expect(backups[0]).toContain(`pre-upgrade-v${APP_SCHEMA_VERSION - 1}`);
    expect(databaseInfo().schema_version).toBe(APP_SCHEMA_VERSION); // upgraded back up
  });

  it('does not create a backup when the file is already current', () => {
    dir = mkdtempSync(join(tmpdir(), 'bob-upg-'));
    const path = join(dir, 'company.sqlite');
    initDatabase(path);
    runMigrations(getDb(), path); // nothing pending
    const backups = readdirSync(dir).filter((f) => f.includes('pre-upgrade'));
    expect(backups.length).toBe(0);
  });

  it('never backs up an in-memory database', () => {
    initDatabase(':memory:');
    expect(() => runMigrations(getDb())).not.toThrow();
    expect(databaseInfo().up_to_date).toBe(true);
  });
});
