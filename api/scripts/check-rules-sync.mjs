/* Verifies the gate rules in index.html are byte-identical to api/src/rules.js, so the browser and server enforce the same gates. */
import { readFile } from 'node:fs/promises';
const block = s => { const a = s.indexOf('/* RULES:BEGIN'), b = s.indexOf('/* RULES:END */'); if (a < 0 || b < 0) throw new Error('RULES markers missing'); return s.slice(a, b); };
const api = block(await readFile(new URL('../src/rules.js', import.meta.url), 'utf8'));
const web = block(await readFile(new URL('../../index.html', import.meta.url), 'utf8'));
if (api !== web) { console.error('✕ Gate rules differ between api/src/rules.js and index.html. Copy the RULES block across.'); process.exit(1); }
console.log('✓ Gate rules in index.html match api/src/rules.js');
