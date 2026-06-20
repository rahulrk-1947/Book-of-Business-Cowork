// Post-build fixes for the single-file web edition:
// 1. The bundle is an IIFE, but Vite tags it type="module" — strip that so it
//    runs everywhere, including contexts that skip module scripts.
// 2. Classic scripts in <head> run before <body> exists; relocate the bundle
//    to the end of <body> so #root is present when React mounts.
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'dist-web/web.html';
let h = readFileSync(p, 'utf8');

const openTag = h.match(/<script type="module"[^>]*>/);
if (!openTag) throw new Error('module script tag not found — build layout changed?');
const start = h.indexOf(openTag[0]);
const end = h.indexOf('</script>', start) + '</script>'.length;
const bundle = '<script>' + h.slice(start + openTag[0].length, end);

h = h.slice(0, start) + h.slice(end); // remove from head
const bodyEnd = h.lastIndexOf('</body>');
if (bodyEnd < 0) throw new Error('</body> not found');
h = h.slice(0, bodyEnd) + bundle + '\n' + h.slice(bodyEnd);

writeFileSync(p, h);
console.log('finalized dist-web/web.html (classic script at end of body)');
