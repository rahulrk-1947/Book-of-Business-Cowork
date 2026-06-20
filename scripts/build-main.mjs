// Bundles the Electron main & preload processes (and the whole backend) with esbuild.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';

mkdirSync('dist-electron', { recursive: true });

await build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/main.cjs',
  external: ['electron', 'better-sqlite3', 'node:sqlite'],
  sourcemap: true,
  logLevel: 'info',
});

await build({
  entryPoints: ['electron/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/preload.cjs',
  external: ['electron'],
  logLevel: 'info',
});

copyFileSync('src/backend/schema.sql', 'dist-electron/schema.sql');
console.log('main process built');
