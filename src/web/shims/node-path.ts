export function join(...parts: string[]): string { return parts.filter(Boolean).join('/'); }
export function dirname(p: string): string { return p.split('/').slice(0, -1).join('/') || '/'; }
export default { join, dirname };
