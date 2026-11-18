/* QA Lab Suite API — runtime-agnostic request handler.
   Runs on Cloudflare Workers (src/worker.js) and on Node for local dev/tests (dev.mjs).
   `db` is a @libsql/client instance (Turso over HTTP in production, a local file in dev). */
import R from './rules.js';

const ROLE_RANK = { viewer: 0, tech: 1, manager: 2, admin: 3 };
const ROLES = Object.keys(ROLE_RANK);
const WRITABLE = ['sites', 'swabs', 'emInv', 'products', 'lots', 'materials', 'loads', 'holds', 'cases', 'compliance'];
const READABLE = [...WRITABLE, 'releases'];
const MANAGER_COLLS = ['sites', 'products', 'materials'];
const PBKDF2_ITER = 100000;          // Cloudflare Workers' maximum
const MAX_FAILED = 5, LOCK_MINUTES = 15, MIN_PW = 10;
const GENESIS = '0'.repeat(64);

export const MEANINGS = {
  'lot.review':  { coll: 'lots',  role: 'tech',    label: 'Reviewed',  statement: 'Reviewed — I have reviewed the production and test records for this lot and they meet specification.' },
  'lot.release': { coll: 'lots',  role: 'manager', label: 'Released',  statement: 'Released — I approve this lot for release.' },
  'case.close':  { coll: 'cases', role: 'manager', label: 'Approved closure', statement: 'Approved — the corrective and preventive actions are complete and the effectiveness check passed; this CAPA is closed.' },
};

/* ---------------- utilities ---------------- */
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const randomB64url = n => b64(crypto.getRandomValues(new Uint8Array(n))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const newId = p => p + '-' + randomB64url(9);
const nowIso = () => new Date().toISOString();
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function pbkdf2(password, saltB64, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: iter }, key, 256));
}
async function hashPassword(pw) { const salt = b64(crypto.getRandomValues(new Uint8Array(16))); return { salt, iter: PBKDF2_ITER, hash: await pbkdf2(pw, salt, PBKDF2_ITER) }; }
function checkPasswordPolicy(pw, email) {
  if (typeof pw !== 'string' || pw.length < MIN_PW) throw new HttpError(400, `Password must be at least ${MIN_PW} characters.`);
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 3 && pw.toLowerCase().includes(local)) throw new HttpError(400, 'Password must not contain your email name.');
}
const localDate = tz => new Date(Date.now() - (Number(tz) || 0) * 60000).toISOString().slice(0, 10);
const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, active: !!Number(u.active), mustChange: !!Number(u.must_change), lockedUntil: u.locked_until || null, createdAt: u.created_at });
const need = (user, role) => { if (ROLE_RANK[user.role] < ROLE_RANK[role]) throw new HttpError(403, `This action needs the ${role} role (you are ${user.role}).`); };

/* ---------------- audit trail (hash-chained) ---------------- */
async function audit(tx, e) {
  const ts = e.ts || nowIso();
  const last = (await tx.execute('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')).rows[0];
  const prev = last ? last.hash : GENESIS;
  const before = e.before == null ? null : JSON.stringify(e.before), after = e.after == null ? null : JSON.stringify(e.after);
  const body = JSON.stringify([ts, e.user?.id || null, e.user?.name || null, e.action, e.coll || null, e.id || null, e.version ?? null, before, after, e.reason || null, e.summary || null]);
  const hash = await sha256(prev + body);
  await tx.execute({ sql: `INSERT INTO audit_log (ts,user_id,user_name,action,coll,record_id,version,before,after,reason,summary,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [ts, e.user?.id || null, e.user?.name || null, e.action, e.coll || null, e.id || null, e.version ?? null, before, after, e.reason || null, e.summary || null, prev, hash] });
}
async function verifyChain(db) {
  const rows = (await db.execute('SELECT * FROM audit_log ORDER BY seq')).rows; let prev = GENESIS;
  for (const r of rows) {
    const body = JSON.stringify([r.ts, r.user_id, r.user_name, r.action, r.coll, r.record_id, r.version, r.before, r.after, r.reason, r.summary]);
    if (r.prev_hash !== prev || r.hash !== await sha256(prev + body)) return { ok: false, count: rows.length, brokenAt: Number(r.seq) };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}

/* ---------------- sessions ---------------- */
async function authenticate(db, req, env) {
  const h = req.headers.get('authorization') || ''; const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) throw new HttpError(401, 'Sign in required.');
  const th = await sha256(tok); const now = nowIso();
  const s = (await db.execute({ sql: 'SELECT * FROM sessions WHERE token_hash = ?', args: [th] })).rows[0];
  const idle = (Number(env.SESSION_IDLE_MINUTES) || 60) * 60000;
  if (!s || s.expires_at < now || Date.parse(s.last_seen) + idle < Date.now()) {
    if (s) await db.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [th] });
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
  const u = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [s.user_id] })).rows[0];
  if (!u || !Number(u.active)) throw new HttpError(401, 'This account is not active.');
  await db.execute({ sql: 'UPDATE sessions SET last_seen = ? WHERE token_hash = ?', args: [now, th] });
  return { user: u, tokenHash: th };
}
/* Verifies a password, applying lockout. Returns true/false; writes audit on failure. */
async function verifyPassword(db, u, pw, what) {
  if (u.locked_until && u.locked_until > nowIso()) throw new HttpError(423, `Account locked after repeated failed attempts. Try again after ${new Date(u.locked_until).toLocaleTimeString('en-US')}.`);
  const ok = typeof pw === 'string' && safeEq(await pbkdf2(pw, u.pw_salt, Number(u.pw_iter)), u.pw_hash);
  const tx = await db.transaction('write');
  try {
    if (ok) await tx.execute({ sql: 'UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ?', args: [u.id] });
    else {
      const n = Number(u.failed_count) + 1; const lock = n >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
      await tx.execute({ sql: 'UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?', args: [lock ? 0 : n, lock, u.id] });
      await audit(tx, { user: u, action: what + '_failed', summary: lock ? `Account locked for ${LOCK_MINUTES} minutes after ${MAX_FAILED} failed attempts` : `Failed password (${what})` });
    }
    await tx.commit();
  } finally { tx.close(); }
  return ok;
}

/* ---------------- records ---------------- */
const parseRec = r => r && { coll: r.coll, id: r.id, data: JSON.parse(r.data), version: Number(r.version), deleted: !!Number(r.deleted) };
async function getRec(tx, coll, id) { return parseRec((await tx.execute({ sql: 'SELECT * FROM records WHERE coll = ? AND id = ?', args: [coll, id] })).rows[0]); }
async function listColl(tx, coll) { return (await tx.execute({ sql: 'SELECT data FROM records WHERE coll = ? AND deleted = 0', args: [coll] })).rows.map(r => JSON.parse(r.data)); }
async function putRec(tx, user, coll, id, data, oldVersion) {
  const now = nowIso();
  if (oldVersion == null) await tx.execute({ sql: 'INSERT INTO records (coll,id,data,version,deleted,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,1,0,?,?,?,?)', args: [coll, id, JSON.stringify(data), now, user.id, now, user.id] });
  else await tx.execute({ sql: 'UPDATE records SET data = ?, version = ?, deleted = 0, updated_at = ?, updated_by = ? WHERE coll = ? AND id = ?', args: [JSON.stringify(data), oldVersion + 1, now, user.id, coll, id] });
  return oldVersion == null ? 1 : oldVersion + 1;
}
const blankReview = () => ({ by: '', date: '' });
const lotChanged = (a, b) => R.lotSignedContent(a) !== R.lotSignedContent(b);
const isLocked = (coll, d) => (coll === 'lots' && d.status === 'Released') || (coll === 'cases' && d.status === 'Closed') || (coll === 'holds' && d.status !== 'On Hold') || (coll === 'loads' && ['Accept', 'Reject'].includes(d.decision));
async function openHoldFor(tx, kind, id, pending) {
  const holds = await listColl(tx, 'holds');
  const merged = new Map(holds.map(h => [h.id, h])); (pending || []).forEach(h => merged.set(h.id, h));
  return [...merged.values()].find(h => h.status === 'On Hold' && h.link && h.link.kind === kind && h.link.id === id) || null;
}
async function nextNum(tx, coll, prefix, width, year) {
  const all = await listColl(tx, coll); const re = new RegExp('^' + prefix.replace(/[-]/g, '\\-') + '(\\d+)$');
  const max = all.reduce((m, r) => { const k = re.exec(r.num || ''); return k ? Math.max(m, Number(k[1])) : m; }, 0);
  return prefix + String(max + 1).padStart(width, '0');
}

/* Server-side validation of a client write. Mutates `next` to protect server-owned fields. Returns notes for the audit summary. */
async function validateWrite(tx, user, coll, old, next, reason, lookup) {
  const notes = [];
  if (!WRITABLE.includes(coll)) throw new HttpError(403, `Records of type "${coll}" cannot be written directly.`);
  need(user, MANAGER_COLLS.includes(coll) ? 'manager' : 'tech');
  if (old && isLocked(coll, old) && !reason) throw new HttpError(428, 'A reason for change is required to modify a released, closed or dispositioned record.', { needReason: true });
  if (coll === 'lots') {
    if (!old) {
      if (next.status === 'Released') throw new HttpError(403, 'A lot can only be released with an electronic signature.');
      next.review = blankReview(); next.releasedBy = ''; next.releasedAt = ''; next.releasedById = '';
    } else {
      next.review = old.review || blankReview(); next.releasedBy = old.releasedBy || ''; next.releasedAt = old.releasedAt || ''; next.releasedById = old.releasedById || '';
      if (old.status === 'Released') {
        if (next.status === 'Released') { if (lotChanged(old, next)) throw new HttpError(409, 'Results of a released lot are locked. Place the lot on hold first, then correct it and re-release.'); }
        else { next.review = blankReview(); next.releasedBy = ''; next.releasedAt = ''; next.releasedById = ''; notes.push('release withdrawn — new review and release signatures required'); }
      } else if (next.status === 'Released') throw new HttpError(403, 'A lot can only be released with an electronic signature.');
      if (next.review.sigId && lotChanged(old, next)) { next.review = blankReview(); notes.push('review e-signature invalidated by change to signed results'); }
    }
    const product = await lookup('products', next.productId);
    if (!product) throw new HttpError(400, 'Unknown product.');
    const ev = R.evalTests(product.tests, next.results);
    if (ev.oos.length && !['On Hold', 'Rejected'].includes(next.status)) throw new HttpError(409, `Out-of-spec results (${ev.oos.map(r => r.t.name).join(', ')}) — the lot must be On Hold or Rejected.`);
  }
  if (coll === 'cases') {
    if (!old) { if (next.status === 'Closed') throw new HttpError(403, 'A CAPA case can only be closed with an electronic signature.'); next.closedDate = ''; next.closedBy = ''; next.closeSig = ''; }
    else {
      next.closedDate = old.closedDate || ''; next.closedBy = old.closedBy || ''; next.closeSig = old.closeSig || '';
      if (old.status === 'Closed') { need(user, 'manager'); if (next.status !== 'Closed') { next.closedDate = ''; next.closedBy = ''; next.closeSig = ''; notes.push('case reopened'); } }
      else if (next.status === 'Closed') throw new HttpError(403, 'A CAPA case can only be closed with an electronic signature.');
    }
    if (!old || !next.num) next.num = next.num && !(await listColl(tx, 'cases')).some(c => c.num === next.num && c.id !== next.id) ? next.num : await nextNum(tx, 'cases', `CAPA-${new Date().getUTCFullYear()}-`, 3);
  }
  if (coll === 'loads') {
    const changedDecision = !old || old.decision !== next.decision;
    if (old && ['Accept', 'Reject'].includes(old.decision) && changedDecision) need(user, 'manager');
    if (next.decision === 'Accept' && (changedDecision || JSON.stringify([old?.coa, old?.internal, old?.coaReceived, old?.materialId]) !== JSON.stringify([next.coa, next.internal, next.coaReceived, next.materialId]))) {
      const g = R.acceptChecks(next, await lookup('materials', next.materialId));
      if (!R.allOk(g)) throw new HttpError(409, 'Accept blocked: ' + g.filter(x => !x.ok).map(x => x.txt).join('; '));
    }
    if (['Hold', 'Reject'].includes(next.decision) && !next.reason) throw new HttpError(400, `A reason is required for ${next.decision}.`);
    if (changedDecision && next.decision !== 'Pending') { next.decidedBy = user.name; next.decidedById = user.id; } else if (old) { next.decidedBy = old.decidedBy; next.decidedById = old.decidedById; }
  }
  if (coll === 'holds') {
    if (!old) { next.placedBy = user.name; next.placedById = user.id; }
    else { next.placedBy = old.placedBy; next.placedById = old.placedById; }
    if (old && old.status === 'On Hold' && next.status !== 'On Hold') {
      need(user, 'manager');
      if (!next.disposition) throw new HttpError(400, 'Disposition notes are required.');
      next.dispositionedBy = user.name; next.dispositionedById = user.id; notes.push(`dispositioned: ${next.status}`);
    } else if (old) { next.dispositionedBy = old.dispositionedBy || ''; next.dispositionedById = old.dispositionedById || ''; }
    if (!old || !next.num) next.num = next.num && !(await listColl(tx, 'holds')).some(h => h.num === next.num && h.id !== next.id) ? next.num : await nextNum(tx, 'holds', 'H-', 3);
  }
  return notes;
}

/* ---------------- route handlers ---------------- */
async function handleBatch(db, user, body) {
  need(user, 'tech');
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (!changes.length) return { records: [] };
  if (changes.length > 200) throw new HttpError(400, 'Too many changes in one request.');
  const reason = (body.reason || '').trim(); const summaries = Array.isArray(body.summaries) ? body.summaries.slice(0, 20) : [];
  const tx = await db.transaction('write');
  try {
    const pending = new Map(changes.filter(c => c.op === 'put').map(c => [c.coll + '|' + c.id, c.data]));
    const lookup = async (coll, id) => { if (!id) return null; const p = pending.get(coll + '|' + id); if (p) return p; const r = await getRec(tx, coll, id); return r && !r.deleted ? r.data : null; };
    const out = [];
    for (const c of changes) {
      if (!c || !c.coll || !c.id || typeof c.id !== 'string' || c.id.length > 80) throw new HttpError(400, 'Malformed change.');
      const cur = await getRec(tx, c.coll, c.id);
      const curV = cur ? cur.version : null;
      if ((c.baseVersion ?? null) !== (cur && !cur.deleted ? curV : null) && !(cur && cur.deleted && c.baseVersion == null && c.op === 'put'))
        throw new HttpError(409, 'Someone else changed this record since you opened it. Your view has been refreshed — please re-apply your change.', { conflict: { coll: c.coll, id: c.id } });
      if (c.op === 'delete') {
        if (!cur || cur.deleted) continue;
        need(user, 'manager'); if (!reason) throw new HttpError(428, 'A reason is required to delete a record.', { needReason: true });
        if (c.coll === 'releases') throw new HttpError(403, 'Release records cannot be deleted.');
        await tx.execute({ sql: 'UPDATE records SET deleted = 1, version = version + 1, updated_at = ?, updated_by = ? WHERE coll = ? AND id = ?', args: [nowIso(), user.id, c.coll, c.id] });
        await audit(tx, { user, action: 'delete', coll: c.coll, id: c.id, version: curV + 1, before: cur.data, after: null, reason, summary: summaries.join(' · ') || null });
        out.push({ coll: c.coll, id: c.id, deleted: true, version: curV + 1 });
        continue;
      }
      if (c.op !== 'put' || !c.data || typeof c.data !== 'object') throw new HttpError(400, 'Malformed change.');
      const next = Object.assign({}, c.data, { id: c.id });
      const old = cur && !cur.deleted ? cur.data : null;
      const notes = await validateWrite(tx, user, c.coll, old, next, reason, lookup);
      pending.set(c.coll + '|' + c.id, next);
      if (old && JSON.stringify(old) === JSON.stringify(next)) { out.push({ coll: c.coll, id: c.id, data: next, version: curV }); continue; }
      const v = await putRec(tx, user, c.coll, c.id, next, cur ? curV : null);
      await audit(tx, { user, action: old ? 'update' : 'create', coll: c.coll, id: c.id, version: v, before: old, after: next, reason: reason || null, summary: [...summaries, ...notes].join(' · ') || null });
      out.push({ coll: c.coll, id: c.id, data: next, version: v });
    }
    await tx.commit();
    return { records: out };
  } finally { tx.close(); }
}

async function handleSign(db, user, body, env) {
  const m = MEANINGS[body.meaning]; if (!m) throw new HttpError(400, 'Unknown signature meaning.');
  need(user, m.role);
  if (!(await verifyPassword(db, user, body.password, 'signature'))) throw new HttpError(401, 'Password incorrect — signature not applied.', { badPassword: true });
  const tx = await db.transaction('write');
  try {
    const cur = await getRec(tx, m.coll, body.id);
    if (!cur || cur.deleted) throw new HttpError(404, 'Record not found.');
    if (body.version !== cur.version) throw new HttpError(409, 'The record changed since you opened it. Review the current version before signing.', { conflict: { coll: m.coll, id: body.id } });
    const rec = cur.data; const before = JSON.parse(JSON.stringify(rec)); const ts = nowIso(); const date = localDate(body.tzOffset);
    const sigId = newId('sig'); let checks; const extra = [];
    if (body.meaning === 'lot.review' || body.meaning === 'lot.release') {
      const pr = await getRec(tx, 'products', rec.productId); const product = pr && !pr.deleted ? pr.data : null;
      const openHold = await openHoldFor(tx, 'lot', rec.id);
      checks = body.meaning === 'lot.review' ? R.reviewChecks(rec, product, { openHold })
        : R.releaseChecks(rec, product, { mode: 'server', openHold, userId: user.id, separate: env.ALLOW_SELF_RELEASE !== 'true' });
      if (!R.allOk(checks)) throw new HttpError(409, 'Signature blocked: ' + checks.filter(x => !x.ok).map(x => x.txt).join('; '));
      if (body.meaning === 'lot.review') {
        rec.review = { by: user.name, userId: user.id, date, at: ts, sigId };
        if (rec.status === 'In Testing') rec.status = 'Awaiting Review';
      } else {
        rec.status = 'Released'; rec.releasedBy = user.name; rec.releasedById = user.id; rec.releasedAt = ts; rec.releaseSig = sigId;
        const rel = { id: newId('rel'), lotId: rec.id, code: rec.code, product: product.name, date, at: ts, by: user.name, reviewer: rec.review.by, reviewSig: rec.review.sigId, releaseSig: sigId,
          data: product.tests.map(t => `${t.name} ${t.type === 'pf' ? (rec.results[t.key] || '—') : R.fmtNum(rec.results[t.key], t.dp)}`).join('; ') };
        await putRec(tx, user, 'releases', rel.id, rel, null);
        await audit(tx, { user, action: 'create', coll: 'releases', id: rel.id, version: 1, after: rel, summary: `Release record for lot ${rec.code}` });
        extra.push({ coll: 'releases', id: rel.id, data: rel, version: 1 });
      }
    } else if (body.meaning === 'case.close') {
      checks = R.closureChecks(rec);
      if (rec.status === 'Closed') throw new HttpError(409, 'Case is already closed.');
      if (!R.allOk(checks)) throw new HttpError(409, 'Signature blocked: ' + checks.filter(x => !x.ok).map(x => x.txt).join('; '));
      rec.status = 'Closed'; rec.closedDate = date; rec.closedBy = user.name; rec.closedById = user.id; rec.closeSig = sigId;
    }
    const contentHash = await sha256(m.coll === 'lots' ? R.lotSignedContent(before) : JSON.stringify(before));
    await tx.execute({ sql: 'INSERT INTO signatures (id,ts,user_id,user_name,user_email,meaning,statement,coll,record_id,record_version,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      args: [sigId, ts, user.id, user.name, user.email, body.meaning, m.statement, m.coll, rec.id, cur.version, contentHash] });
    const v = await putRec(tx, user, m.coll, rec.id, rec, cur.version);
    await audit(tx, { ts, user, action: 'sign', coll: m.coll, id: rec.id, version: v, before, after: rec, summary: `${m.label} e-signature by ${user.name} (${user.email}) — ${m.statement}` });
    await tx.commit();
    const sig = { id: sigId, ts, userId: user.id, userName: user.name, userEmail: user.email, meaning: body.meaning, statement: m.statement, coll: m.coll, recordId: rec.id, recordVersion: cur.version, contentHash };
    return { signature: sig, records: [{ coll: m.coll, id: rec.id, data: rec, version: v }, ...extra] };
  } finally { tx.close(); }
}

async function handleState(db) {
  const rows = (await db.execute('SELECT coll, id, data, version FROM records WHERE deleted = 0')).rows;
  const records = {}; READABLE.forEach(c => records[c] = []);
  const versions = {};
  for (const r of rows) { if (!records[r.coll]) continue; records[r.coll].push(JSON.parse(r.data)); versions[r.coll + '|' + r.id] = Number(r.version); }
  const signatures = (await db.execute('SELECT * FROM signatures ORDER BY ts')).rows.map(s => ({ id: s.id, ts: s.ts, userId: s.user_id, userName: s.user_name, userEmail: s.user_email, meaning: s.meaning, statement: s.statement, coll: s.coll, recordId: s.record_id, recordVersion: Number(s.record_version), contentHash: s.content_hash }));
  const users = (await db.execute('SELECT id, name, role, active FROM users')).rows.map(u => ({ id: u.id, name: u.name, role: u.role, active: !!Number(u.active) }));
  return { records, versions, signatures, users, serverTime: nowIso() };
}

async function handleAudit(db, url) {
  const coll = url.searchParams.get('coll'), id = url.searchParams.get('id');
  const limit = Math.min(500, Number(url.searchParams.get('limit')) || 50); const before = Number(url.searchParams.get('before')) || null;
  const where = [], args = [];
  if (coll) { where.push('coll = ?'); args.push(coll); }
  if (id) { where.push('record_id = ?'); args.push(id); }
  if (before) { where.push('seq < ?'); args.push(before); }
  const full = !!(coll && id);
  const rows = (await db.execute({ sql: `SELECT seq, ts, user_id, user_name, action, coll, record_id, version, reason, summary${full ? ', before, after' : ''} FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`, args: [...args, limit] })).rows;
  return { entries: rows.map(r => ({ seq: Number(r.seq), ts: r.ts, userId: r.user_id, userName: r.user_name, action: r.action, coll: r.coll, recordId: r.record_id, version: r.version == null ? null : Number(r.version), reason: r.reason, summary: r.summary, ...(full ? { before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null } : {}) })) };
}

async function createSession(db, u, req, env) {
  const token = randomB64url(32); const now = nowIso();
  const exp = new Date(Date.now() + (Number(env.SESSION_MAX_HOURS) || 12) * 3600000).toISOString();
  await db.execute({ sql: 'INSERT INTO sessions (token_hash,user_id,created_at,last_seen,expires_at,user_agent) VALUES (?,?,?,?,?,?)', args: [await sha256(token), u.id, now, now, exp, (req.headers.get('user-agent') || '').slice(0, 200)] });
  await db.execute({ sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [now] });
  return { token, expiresAt: exp };
}

/* ---------------- router ---------------- */
export async function handle(req, env, db) {
  const url = new URL(req.url);
  const origin = req.headers.get('origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const cors = { 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (origin && (allowed.includes('*') || allowed.includes(origin))) cors['Access-Control-Allow-Origin'] = origin;
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...cors } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (origin && !cors['Access-Control-Allow-Origin']) return reply({ error: 'Origin not allowed. Add it to ALLOWED_ORIGINS.' }, 403);
  try {
    const p = url.pathname.replace(/\/+$/, '') || '/';
    let body = {};
    if (['POST', 'PATCH'].includes(req.method)) { const txt = await req.text(); if (txt) { try { body = JSON.parse(txt); } catch { throw new HttpError(400, 'Invalid JSON body.'); } } }
    if (!body || typeof body !== 'object') body = {};
    const route = req.method + ' ' + p;

    if (route === 'GET /' || route === 'GET /health') return reply({ ok: true, service: 'qa-lab-suite-api', time: nowIso() });
    if (route === 'GET /auth/status') {
      const n = Number((await db.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n);
      return reply({ needsSetup: n === 0, setupEnabled: !!env.SETUP_TOKEN, minPassword: MIN_PW });
    }
    if (route === 'POST /auth/setup') {
      if (!env.SETUP_TOKEN || !safeEq(String(body.setupToken || ''), String(env.SETUP_TOKEN))) throw new HttpError(403, 'Setup token is incorrect.');
      const email = String(body.email || '').trim().toLowerCase(), name = String(body.name || '').trim();
      if (!/^[^@\s]+@[^@\s]+$/.test(email) || !name) throw new HttpError(400, 'Enter your name and a valid email.');
      checkPasswordPolicy(body.password, email);
      const tx = await db.transaction('write');
      let u;
      try {
        if (Number((await tx.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n) > 0) throw new HttpError(409, 'Setup has already been completed.');
        const pw = await hashPassword(body.password); const now = nowIso();
        u = { id: newId('usr'), email, name, role: 'admin', pw_hash: pw.hash, pw_salt: pw.salt, pw_iter: pw.iter, active: 1, failed_count: 0, locked_until: null, must_change: 0, created_at: now };
        await tx.execute({ sql: 'INSERT INTO users (id,email,name,role,pw_hash,pw_salt,pw_iter,active,must_change,pw_changed_at,created_at,created_by) VALUES (?,?,?,?,?,?,?,1,0,?,?,?)', args: [u.id, email, name, 'admin', pw.hash, pw.salt, pw.iter, now, now, 'setup'] });
        await audit(tx, { user: u, action: 'user_create', coll: 'users', id: u.id, after: publicUser(u), summary: `First administrator ${name} <${email}> created during setup` });
        await tx.commit();
      } finally { tx.close(); }
      return reply({ user: publicUser(u), ...(await createSession(db, u, req, env)) });
    }
    if (route === 'POST /auth/login') {
      const email = String(body.email || '').trim().toLowerCase();
      const u = (await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] })).rows[0];
      if (!u || !Number(u.active)) {
        const tx = await db.transaction('write'); try { await audit(tx, { action: 'login_failed', summary: `Failed sign-in for ${email.slice(0, 120)}` }); await tx.commit(); } finally { tx.close(); }
        throw new HttpError(401, 'Email or password is incorrect.');
      }
      if (!(await verifyPassword(db, u, body.password, 'login'))) throw new HttpError(401, 'Email or password is incorrect.');
      const tx = await db.transaction('write'); try { await audit(tx, { user: u, action: 'login', summary: 'Signed in' }); await tx.commit(); } finally { tx.close(); }
      return reply({ user: publicUser(u), ...(await createSession(db, u, req, env)) });
    }

    // ---- everything below requires a session ----
    const { user, tokenHash } = await authenticate(db, req, env);
    if (Number(user.must_change) && route !== 'POST /auth/password' && route !== 'GET /auth/me' && route !== 'POST /auth/logout')
      throw new HttpError(403, 'You must set a new password before continuing.', { mustChange: true });

    if (route === 'GET /auth/me') return reply({ user: publicUser(user), config: { separateRelease: env.ALLOW_SELF_RELEASE !== 'true', idleMinutes: Number(env.SESSION_IDLE_MINUTES) || 60, meanings: MEANINGS } });
    if (route === 'POST /auth/logout') {
      await db.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [tokenHash] });
      const tx = await db.transaction('write'); try { await audit(tx, { user, action: 'logout', summary: 'Signed out' }); await tx.commit(); } finally { tx.close(); }
      return reply({ ok: true });
    }
    if (route === 'POST /auth/password') {
      if (!(await verifyPassword(db, user, body.current, 'password_change'))) throw new HttpError(401, 'Current password is incorrect.');
      checkPasswordPolicy(body.password, user.email);
      if (body.password === body.current) throw new HttpError(400, 'Choose a password different from the current one.');
      const pw = await hashPassword(body.password);
      const tx = await db.transaction('write');
      try {
        await tx.execute({ sql: 'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change = 0, pw_changed_at = ? WHERE id = ?', args: [pw.hash, pw.salt, pw.iter, nowIso(), user.id] });
        await tx.execute({ sql: 'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', args: [user.id, tokenHash] });
        await audit(tx, { user, action: 'password_change', coll: 'users', id: user.id, summary: 'Password changed; other sessions signed out' });
        await tx.commit();
      } finally { tx.close(); }
      return reply({ ok: true });
    }
    if (route === 'GET /state') return reply(await handleState(db));
    if (route === 'POST /batch') return reply(await handleBatch(db, user, body));
    if (route === 'POST /sign') return reply(await handleSign(db, user, body, env));
    if (route === 'GET /audit') return reply(await handleAudit(db, url));
    if (route === 'GET /audit/verify') { need(user, 'admin'); return reply(await verifyChain(db)); }

    if (route === 'GET /users') { need(user, 'admin'); return reply({ users: (await db.execute('SELECT * FROM users ORDER BY name')).rows.map(publicUser) }); }
    if (route === 'POST /users') {
      need(user, 'admin');
      const email = String(body.email || '').trim().toLowerCase(), name = String(body.name || '').trim();
      if (!/^[^@\s]+@[^@\s]+$/.test(email) || !name) throw new HttpError(400, 'Enter a name and a valid email.');
      if (!ROLES.includes(body.role)) throw new HttpError(400, 'Choose a role.');
      checkPasswordPolicy(body.tempPassword, email);
      if ((await db.execute({ sql: 'SELECT 1 FROM users WHERE email = ?', args: [email] })).rows.length) throw new HttpError(409, 'A user with that email already exists.');
      const pw = await hashPassword(body.tempPassword); const now = nowIso(); const u = { id: newId('usr'), email, name, role: body.role, active: 1, must_change: 1, created_at: now };
      const tx = await db.transaction('write');
      try {
        await tx.execute({ sql: 'INSERT INTO users (id,email,name,role,pw_hash,pw_salt,pw_iter,active,must_change,created_at,created_by) VALUES (?,?,?,?,?,?,?,1,1,?,?)', args: [u.id, email, name, body.role, pw.hash, pw.salt, pw.iter, now, user.id] });
        await audit(tx, { user, action: 'user_create', coll: 'users', id: u.id, after: publicUser(u), summary: `User ${name} <${email}> created with role ${body.role}` });
        await tx.commit();
      } finally { tx.close(); }
      return reply({ user: publicUser(u) });
    }
    const um = /^\/users\/([\w-]+)$/.exec(p);
    if (req.method === 'PATCH' && um) {
      need(user, 'admin');
      const t = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [um[1]] })).rows[0]; if (!t) throw new HttpError(404, 'User not found.');
      const sets = [], args = [], what = [];
      if (body.role != null) { if (!ROLES.includes(body.role)) throw new HttpError(400, 'Invalid role.'); if (t.id === user.id && body.role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin role.'); sets.push('role = ?'); args.push(body.role); what.push(`role ${t.role} → ${body.role}`); }
      if (body.name != null) { if (!String(body.name).trim()) throw new HttpError(400, 'Name required.'); sets.push('name = ?'); args.push(String(body.name).trim()); what.push(`name "${t.name}" → "${String(body.name).trim()}"`); }
      if (body.active != null) { if (t.id === user.id && !body.active) throw new HttpError(400, 'You cannot deactivate yourself.'); sets.push('active = ?'); args.push(body.active ? 1 : 0); what.push(body.active ? 'reactivated' : 'deactivated'); }
      if (body.unlock) { sets.push('failed_count = 0', 'locked_until = NULL'); what.push('unlocked'); }
      if (body.tempPassword != null) { checkPasswordPolicy(body.tempPassword, t.email); const pw = await hashPassword(body.tempPassword); sets.push('pw_hash = ?', 'pw_salt = ?', 'pw_iter = ?', 'must_change = 1'); args.push(pw.hash, pw.salt, pw.iter); what.push('password reset (must change at next sign-in)'); }
      if (!sets.length) throw new HttpError(400, 'Nothing to change.');
      const tx = await db.transaction('write');
      try {
        await tx.execute({ sql: `UPDATE users SET ${sets.join(', ')} WHERE id = ?`, args: [...args, t.id] });
        if (body.active === false || body.tempPassword != null || body.role != null) await tx.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [t.id] });
        await audit(tx, { user, action: 'user_update', coll: 'users', id: t.id, before: publicUser(t), reason: body.reason || null, summary: `User ${t.name}: ${what.join(', ')}` });
        await tx.commit();
      } finally { tx.close(); }
      return reply({ user: publicUser((await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [t.id] })).rows[0]) });
    }

    if (route === 'POST /admin/seed') {
      need(user, 'admin');
      const st = body.state || {};
      const tx = await db.transaction('write');
      try {
        if (Number((await tx.execute('SELECT COUNT(*) AS n FROM records WHERE deleted = 0')).rows[0].n) > 0) throw new HttpError(409, 'Sample data can only be loaded into an empty database.');
        let n = 0;
        for (const coll of READABLE) for (const r of (st[coll] || [])) { if (!r || !r.id) continue; await putRec(tx, user, coll, r.id, Object.assign({}, r, { sample: true }), null); n++; }
        await audit(tx, { user, action: 'seed', summary: `${n} SAMPLE demonstration records loaded` });
        await tx.commit();
        return reply({ ok: true, count: n });
      } finally { tx.close(); }
    }
    if (route === 'POST /admin/remove-sample') {
      need(user, 'admin');
      const tx = await db.transaction('write');
      try {
        const rows = (await tx.execute('SELECT coll, id, data, version FROM records WHERE deleted = 0')).rows.filter(r => JSON.parse(r.data).sample);
        for (const r of rows) await tx.execute({ sql: 'UPDATE records SET deleted = 1, version = version + 1, updated_at = ?, updated_by = ? WHERE coll = ? AND id = ?', args: [nowIso(), user.id, r.coll, r.id] });
        await audit(tx, { user, action: 'remove_sample', reason: body.reason || 'Remove demonstration data', summary: `${rows.length} SAMPLE records soft-deleted` });
        await tx.commit();
        return reply({ ok: true, count: rows.length });
      } finally { tx.close(); }
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return reply({ error: e.message, ...(e.extra || {}) }, e.status);
    console.error(e);
    return reply({ error: 'Server error. ' + (e && e.message ? e.message : '') }, 500);
  }
}
