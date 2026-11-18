/* API tests — run with `npm test`. Uses a throwaway local libSQL database. */
import { createClient } from '@libsql/client';
import { rm } from 'node:fs/promises';
import { handle } from '../src/app.js';
import { migrate } from '../scripts/migrate.mjs';

const DBFILE = '/tmp/qa-api-test.db';
await rm(DBFILE, { force: true }); await rm(DBFILE + '-wal', { force: true }); await rm(DBFILE + '-shm', { force: true });
const db = createClient({ url: 'file:' + DBFILE }); await migrate(db);
const env = { ALLOWED_ORIGINS: 'https://example.github.io', SETUP_TOKEN: 'setup-secret', SESSION_IDLE_MINUTES: '60', ALLOW_SELF_RELEASE: 'false' };
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) passes++; else { fails++; console.log('FAIL ' + m); } };
async function call(method, path, body, token, headers = {}) {
  const r = await handle(new Request('http://api.test' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }), env, db);
  return { status: r.status, ...(await r.json()) };
}

// ---- setup & users ----
ok((await call('GET', '/auth/status')).needsSetup === true, 'needs setup');
ok((await call('POST', '/auth/setup', { setupToken: 'nope', email: 'a@x.co', name: 'Ada Admin', password: 'correct horse battery' })).status === 403, 'bad setup token rejected');
const setup = await call('POST', '/auth/setup', { setupToken: 'setup-secret', email: 'ada@plant.co', name: 'Ada Admin', password: 'correct horse battery' });
ok(setup.status === 200 && setup.token && setup.user.role === 'admin', 'setup creates admin');
ok((await call('POST', '/auth/setup', { setupToken: 'setup-secret', email: 'b@x.co', name: 'B', password: 'correct horse battery' })).status === 409, 'setup only once');
const ADMIN = setup.token;
ok((await call('GET', '/state')).status === 401, 'state needs sign-in');
for (const [email, name, role] of [['tina@plant.co', 'Tina Tech', 'tech'], ['mo@plant.co', 'Mo Manager', 'manager'], ['vic@plant.co', 'Vic Viewer', 'viewer'], ['tom@plant.co', 'Tom Tech', 'tech']])
  ok((await call('POST', '/users', { email, name, role, tempPassword: 'Temporary-pass-1' }, ADMIN)).status === 200, 'create ' + role);
ok((await call('POST', '/users', { email: 'x@plant.co', name: 'X', role: 'tech', tempPassword: 'short' }, ADMIN)).status === 400, 'password policy enforced');
async function login(email, pw, newPw) {
  let r = await call('POST', '/auth/login', { email, password: pw });
  if (newPw) {
    ok((await call('GET', '/state', null, r.token)).mustChange === true, 'must change password first: ' + email);
    ok((await call('POST', '/auth/password', { current: pw, password: newPw }, r.token)).status === 200, 'password changed: ' + email);
  }
  return r.token;
}
const TECH = await login('tina@plant.co', 'Temporary-pass-1', 'amber-river-stone-1');
const MGR = await login('mo@plant.co', 'Temporary-pass-1', 'copper-field-lamp-2');
const VIEW = await login('vic@plant.co', 'Temporary-pass-1', 'violet-harbor-moss-3');
const TOM = await login('tom@plant.co', 'Temporary-pass-1', 'granite-sail-pine-4');
ok((await call('POST', '/users', { email: 'y@plant.co', name: 'Y', role: 'tech', tempPassword: 'Temporary-pass-1' }, MGR)).status === 403, 'only admin manages users');
ok((await call('GET', '/state', null, TECH, { origin: 'https://evil.example' })).status === 403, 'unknown origin rejected');

// ---- specs (manager only) ----
const product = { id: 'p1', name: 'Orange Juice', prefix: 'OJ', tests: [{ key: 'ph', name: 'pH', unit: '', min: 3.3, max: 4.0, type: 'num', req: true, dp: 2 }, { key: 'sensory', name: 'Sensory', type: 'pf', req: true }] };
const material = { id: 'm1', name: 'OJ Concentrate', category: 'Ingredient', tests: [{ key: 'brix', name: 'Brix', unit: '°Bx', min: 64, max: 66, type: 'num', req: true, dp: 1 }] };
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'products', id: 'p1', data: product, baseVersion: null }] }, TECH)).status === 403, 'tech cannot edit specs');
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'products', id: 'p1', data: product, baseVersion: null }, { op: 'put', coll: 'materials', id: 'm1', data: material, baseVersion: null }] }, MGR)).status === 200, 'manager edits specs');
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'swabs', id: 's1', data: { id: 's1' }, baseVersion: null }] }, VIEW)).status === 403, 'viewer cannot write');

// ---- lots: auto-hold, release only by e-signature ----
const lot = { id: 'lot1', productId: 'p1', code: 'OJ-1', date: '2026-11-18', results: { ph: 3.6, sensory: 'Pass' }, outside: {}, status: 'Awaiting Review', review: { by: 'Forged Name', date: '2026-11-18' }, releasedBy: 'Forged' };
let r = await call('POST', '/batch', { changes: [{ op: 'put', coll: 'lots', id: 'lot1', data: { ...lot, results: { ph: 4.4, sensory: 'Pass' } }, baseVersion: null }] }, TECH);
ok(r.status === 409 && /On Hold/.test(r.error), 'OOS lot must be On Hold');
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'lots', id: 'lot1', data: { ...lot, status: 'Released' }, baseVersion: null }] }, TECH)).status === 403, 'cannot write Released status');
r = await call('POST', '/batch', { changes: [{ op: 'put', coll: 'lots', id: 'lot1', data: lot, baseVersion: null }], summaries: ['Lot OJ-1 entered'] }, TECH);
ok(r.status === 200 && r.records[0].data.review.by === '' && r.records[0].data.releasedBy === '', 'typed reviewer/releaser stripped by server');
let v = r.records[0].version;
ok((await call('POST', '/sign', { meaning: 'lot.release', id: 'lot1', version: v, password: 'amber-river-stone-1' }, TECH)).status === 403, 'tech cannot sign release');
ok((await call('POST', '/sign', { meaning: 'lot.review', id: 'lot1', version: v, password: 'wrong-password' }, TECH)).status === 401, 'wrong password: no signature');
r = await call('POST', '/sign', { meaning: 'lot.review', id: 'lot1', version: v, password: 'amber-river-stone-1', tzOffset: 300 }, TECH);
ok(r.status === 200 && r.records[0].data.review.by === 'Tina Tech' && r.records[0].data.review.sigId, 'tech e-signs review');
v = r.records[0].version;
// content change after review invalidates the review signature
r = await call('POST', '/batch', { changes: [{ op: 'put', coll: 'lots', id: 'lot1', data: { ...r.records[0].data, results: { ph: 3.7, sensory: 'Pass' } }, baseVersion: v }] }, TECH);
ok(r.status === 200 && !r.records[0].data.review.sigId, 'editing results voids review signature');
v = r.records[0].version;
r = await call('POST', '/sign', { meaning: 'lot.release', id: 'lot1', version: v, password: 'copper-field-lamp-2' }, MGR);
ok(r.status === 409 && /review/i.test(r.error), 'release blocked without valid review signature');
r = await call('POST', '/sign', { meaning: 'lot.review', id: 'lot1', version: v, password: 'copper-field-lamp-2' }, MGR);
v = r.records[0].version;
r = await call('POST', '/sign', { meaning: 'lot.release', id: 'lot1', version: v, password: 'copper-field-lamp-2' }, MGR);
ok(r.status === 409 && /different person/.test(r.error), 'reviewer cannot also release');
r = await call('POST', '/sign', { meaning: 'lot.review', id: 'lot1', version: v, password: 'granite-sail-pine-4' }, TOM);
ok(r.status === 200, 'second tech re-reviews'); v = r.records[0].version;
ok((await call('POST', '/sign', { meaning: 'lot.release', id: 'lot1', version: v - 1, password: 'copper-field-lamp-2' }, MGR)).status === 409, 'stale version cannot be signed');
r = await call('POST', '/sign', { meaning: 'lot.release', id: 'lot1', version: v, password: 'copper-field-lamp-2' }, MGR);
ok(r.status === 200 && r.records[0].data.status === 'Released' && r.records[0].data.releasedBy === 'Mo Manager' && r.records.some(x => x.coll === 'releases'), 'manager e-signs release; release record written');
v = r.records[0].version; const released = r.records[0].data;
// locked after release
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'lots', id: 'lot1', data: { ...released, notes: 'x' }, baseVersion: v }] }, TECH)).status === 428, 'edit of released lot needs reason');
ok((await call('POST', '/batch', { reason: 'typo', changes: [{ op: 'put', coll: 'lots', id: 'lot1', data: { ...released, results: { ph: 3.5, sensory: 'Pass' } }, baseVersion: v }] }, TECH)).status === 409, 'released results locked');
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'releases', id: 'rx', data: {}, baseVersion: null }] }, MGR)).status === 403, 'release records not client-writable');

// ---- open hold blocks release ----
const lot2 = { id: 'lot2', productId: 'p1', code: 'OJ-2', date: '2026-11-18', results: { ph: 4.5, sensory: 'Pass' }, status: 'On Hold' };
const hold = { id: 'h1', num: '', itemType: 'Finished lot', ref: 'OJ-2', link: { kind: 'lot', id: 'lot2' }, reason: 'pH high', placed: '2026-11-18', placedBy: 'Forged', status: 'On Hold', disposition: '', dispDate: '' };
r = await call('POST', '/batch', { changes: [{ op: 'put', coll: 'lots', id: 'lot2', data: lot2, baseVersion: null }, { op: 'put', coll: 'holds', id: 'h1', data: hold, baseVersion: null }] }, TECH);
ok(r.status === 200 && r.records[1].data.num === 'H-001' && r.records[1].data.placedBy === 'Tina Tech', 'hold numbered and attributed by server');
r = await call('POST', '/batch', { changes: [{ op: 'put', coll: 'lots', id: 'lot2', data: { ...lot2, results: { ph: 3.8, sensory: 'Pass' }, status: 'Awaiting Review' }, baseVersion: 1 }] }, TECH);
ok((await call('POST', '/sign', { meaning: 'lot.review', id: 'lot2', version: r.records[0].version, password: 'amber-river-stone-1' }, TECH)).status === 409, 'review blocked by open hold');
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'holds', id: 'h1', data: { ...hold, num: 'H-001', status: 'Released', disposition: 'retest ok' }, baseVersion: 1 }] }, TECH)).status === 403, 'tech cannot disposition hold');

// ---- conflicts ----
await call('POST', '/batch', { changes: [{ op: 'put', coll: 'swabs', id: 'sw1', data: { id: 'sw1', result: 'Pass' }, baseVersion: null }] }, TECH);
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'swabs', id: 'sw1', data: { id: 'sw1', result: 'Fail' }, baseVersion: 1 }] }, TOM)).status === 200, 'first edit wins');
r = await call('POST', '/batch', { changes: [{ op: 'put', coll: 'swabs', id: 'sw1', data: { id: 'sw1', result: 'Pass' }, baseVersion: 1 }] }, TECH);
ok(r.status === 409 && r.conflict, 'second concurrent edit gets conflict');

// ---- incoming accept gate ----
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'loads', id: 'ld1', data: { id: 'ld1', materialId: 'm1', supplier: 'S', supplierLot: '1', coaReceived: true, coa: { brix: 61 }, decision: 'Accept' }, baseVersion: null }] }, TECH)).status === 409, 'accept blocked when COA OOS');
ok((await call('POST', '/batch', { changes: [{ op: 'put', coll: 'loads', id: 'ld1', data: { id: 'ld1', materialId: 'm1', supplier: 'S', supplierLot: '1', coaReceived: true, coa: { brix: 65 }, decision: 'Accept' }, baseVersion: null }] }, TECH)).status === 200, 'accept allowed when COA in spec');

// ---- CAPA closure only by e-signature with passing effectiveness ----
const cs = { id: 'c1', num: '', title: 'T', status: 'Effectiveness Check', rca: { whys: [], cats: [], rootCause: 'RC' }, corrective: [{ id: 'a', desc: 'fix', done: true }], preventive: [], effectiveness: { metric: 'm', date: '2026-11-18', result: '' } };
r = await call('POST', '/batch', { changes: [{ op: 'put', coll: 'cases', id: 'c1', data: { ...cs, status: 'Closed' }, baseVersion: null }] }, MGR);
ok(r.status === 403, 'cannot write Closed status');
r = await call('POST', '/batch', { changes: [{ op: 'put', coll: 'cases', id: 'c1', data: cs, baseVersion: null }] }, TECH);
ok(r.status === 200 && /^CAPA-\d{4}-001$/.test(r.records[0].data.num), 'case numbered by server');
ok((await call('POST', '/sign', { meaning: 'case.close', id: 'c1', version: 1, password: 'copper-field-lamp-2' }, MGR)).status === 409, 'closure blocked without Pass');
r = await call('POST', '/batch', { changes: [{ op: 'put', coll: 'cases', id: 'c1', data: { ...r.records[0].data, effectiveness: { ...cs.effectiveness, result: 'Pass' } }, baseVersion: 1 }] }, TECH);
ok((await call('POST', '/sign', { meaning: 'case.close', id: 'c1', version: 2, password: 'amber-river-stone-1' }, TECH)).status === 403, 'tech cannot approve closure');
r = await call('POST', '/sign', { meaning: 'case.close', id: 'c1', version: 2, password: 'copper-field-lamp-2' }, MGR);
ok(r.status === 200 && r.records[0].data.status === 'Closed' && r.records[0].data.closedBy === 'Mo Manager', 'manager e-signs closure');

// ---- deletes are soft, need manager + reason ----
ok((await call('POST', '/batch', { changes: [{ op: 'delete', coll: 'swabs', id: 'sw1', baseVersion: 2 }] }, TECH)).status === 403, 'tech cannot delete');
ok((await call('POST', '/batch', { changes: [{ op: 'delete', coll: 'swabs', id: 'sw1', baseVersion: 2 }] }, MGR)).status === 428, 'delete needs reason');
ok((await call('POST', '/batch', { reason: 'entered in error', changes: [{ op: 'delete', coll: 'swabs', id: 'sw1', baseVersion: 2 }] }, MGR)).status === 200, 'manager deletes with reason');
ok(Number((await db.execute("SELECT COUNT(*) n FROM records WHERE coll='swabs' AND id='sw1'")).rows[0].n) === 1, 'deleted record retained');

// ---- audit trail ----
const a = await call('GET', '/audit?coll=lots&id=lot1', null, VIEW);
ok(a.entries.some(e => e.action === 'sign' && e.userName === 'Mo Manager') && a.entries.some(e => e.action === 'create' && e.userName === 'Tina Tech') && a.entries.every(e => e.ts), 'record audit trail with users and timestamps');
ok(a.entries.some(e => /invalidated/.test(e.summary || '')), 'audit notes invalidated signature');
let threw = false; try { await db.execute('UPDATE audit_log SET summary = 1'); } catch { threw = true; } ok(threw, 'audit_log cannot be updated');
threw = false; try { await db.execute('DELETE FROM signatures'); } catch { threw = true; } ok(threw, 'signatures cannot be deleted');
ok((await call('GET', '/audit/verify', null, ADMIN)).ok === true, 'audit hash chain verifies');
await db.execute('DROP TRIGGER audit_log_no_update'); await db.execute("UPDATE audit_log SET summary = 'tampered' WHERE seq = 5");
ok((await call('GET', '/audit/verify', null, ADMIN)).ok === false, 'tampering detected by hash chain');

// ---- lockout ----
for (let i = 0; i < 5; i++) await call('POST', '/auth/login', { email: 'vic@plant.co', password: 'nope-nope-nope' });
r = await call('POST', '/auth/login', { email: 'vic@plant.co', password: 'violet-harbor-moss-3' });
ok(r.status === 423, 'account locked after 5 failures');
ok((await call('PATCH', '/users/' + (await call('GET', '/users', null, ADMIN)).users.find(u => u.email === 'vic@plant.co').id, { unlock: true }, ADMIN)).status === 200, 'admin unlocks');
ok((await call('POST', '/auth/login', { email: 'vic@plant.co', password: 'violet-harbor-moss-3' })).status === 200, 'login after unlock');
// deactivate kills sessions
const tomId = (await call('GET', '/users', null, ADMIN)).users.find(u => u.email === 'tom@plant.co').id;
await call('PATCH', '/users/' + tomId, { active: false }, ADMIN);
ok((await call('GET', '/state', null, TOM)).status === 401, 'deactivated user signed out');
ok((await call('POST', '/auth/logout', null, TECH)).status === 200 && (await call('GET', '/state', null, TECH)).status === 401, 'logout ends session');

console.log(`\n${passes} passed, ${fails} failed`); process.exit(fails ? 1 : 0);
