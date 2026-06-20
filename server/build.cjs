/* Compile the server (and the reused backend) to dist-server/, then copy the
   two SQL files the runtime reads at boot. */
const { execSync } = require('node:child_process');
const { copyFileSync, mkdirSync } = require('node:fs');
execSync('npx tsc -p server/tsconfig.json', { stdio: 'inherit' });
mkdirSync('dist-server', { recursive: true });
copyFileSync('src/backend/schema.sql', 'dist-server/schema.sql');
copyFileSync('server/src/control-schema.sql', 'dist-server/control-schema.sql');
console.log('Server built to dist-server/ (entry: dist-server/server/src/server.js)');
