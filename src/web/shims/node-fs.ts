/** Browser shim — these are only referenced (never called) by code paths the web build doesn't use. */
export function existsSync(): boolean { return false; }
export function readFileSync(): never { throw new Error('fs unavailable in the browser'); }
export function writeFileSync(): never { throw new Error('fs unavailable in the browser'); }
export function copyFileSync(): never { throw new Error('fs unavailable in the browser'); }
export function mkdirSync(): void {}
export default { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync };
