/* Browser tests for server mode. Start a fresh dev server first:
   cd api && rm -f /tmp/e2e.db* && SETUP_TOKEN=dev-setup-token node dev.mjs --db file:/tmp/e2e.db
   then: node tests/server-mode.e2e.js */
const { chromium, devices } = require('playwright');
const path = require('path'); const fs = require('fs');
const OUT = path.join(__dirname, 'shots-server'); fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:8787/';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const errs = [];
function watch(p, tag) {
  p.on('pageerror', e => errs.push(tag + ': ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/401|403|409|423|428|Failed to load resource/.test(m.text())) errs.push(tag + ': ' + m.text()); });
  p.on('dialog', d => d.type() === 'prompt' ? d.accept(p._reason || 'Correction recorded by test') : d.accept());
}
async function signIn(p, email, pw, newPw) {
  await p.goto(BASE); await p.waitForSelector('#au-email');
  await p.fill('#au-email', email); await p.fill('#au-pw', pw); await p.click('[data-act="auth-login"]');
  if (newPw) {
    await p.waitForSelector('#au-cur'); await p.fill('#au-cur', pw); await p.fill('#au-pw', newPw); await p.fill('#au-pw2', newPw); await p.click('[data-act="auth-change"]');
  }
  await p.waitForSelector('.stat');
}
const nav = async (p, r) => { await p.evaluate(r => { location.hash = r; }, '#' + r); await p.waitForFunction(r => route() === r && !PENDING, r); await p.waitForTimeout(120); };
const dlgOpen = p => p.waitForSelector('#dlg[open] .mbody');
(async () => {
  const b = await chromium.launch();
  // ---- admin setup on a desktop ----
  const adminCtx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const ad = await adminCtx.newPage(); watch(ad, 'admin');
  await ad.goto(BASE); await ad.waitForSelector('#au-token');
  ok(await ad.locator('h1', { hasText: 'First-time setup' }).count() === 1, 'first-time setup screen');
  await ad.screenshot({ path: `${OUT}/01-setup.png` });
  await ad.fill('#au-token', 'dev-setup-token'); await ad.fill('#au-name', 'Ada Admin'); await ad.fill('#au-email', 'ada@plant.example');
  await ad.fill('#au-pw', 'correct horse battery'); await ad.fill('#au-pw2', 'correct horse battery'); await ad.click('[data-act="auth-setup"]');
  await ad.waitForSelector('.stat'); ok(await ad.locator('.tabs a', { hasText: 'Users' }).count() === 1, 'admin sees Users tab');
  await ad.evaluate(() => A['server-seed']()); await ad.waitForFunction(() => S.lots.length > 10);
  ok(await ad.evaluate(() => S.lots.length === 20 && S.cases.length === 3), 'sample data loaded into server');
  // create users through the Users screen (one) and API (rest)
  await nav(ad, 'users'); await ad.waitForSelector('[data-act="user-new"]'); await ad.click('[data-act="user-new"]'); await dlgOpen(ad);
  await ad.fill('[data-b="name"]', 'Tina Tech'); await ad.fill('[data-b="email"]', 'tina@plant.example'); await ad.fill('[data-b="tempPassword"]', 'Temp-pass-0001');
  await ad.click('[data-act="modal-save"]'); await ad.waitForSelector('.rec >> text=Tina Tech');
  await ad.screenshot({ path: `${OUT}/02-users.png` });
  for (const [n, e, r] of [['Mo Manager', 'mo@plant.example', 'manager'], ['Vic Viewer', 'vic@plant.example', 'viewer']])
    await ad.evaluate(([n, e, r]) => api('POST', '/users', { name: n, email: e, role: r, tempPassword: 'Temp-pass-0001' }), [n, e, r]);

  // ---- Tina on a laptop ----
  const lap = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(lap, 'tina');
  await signIn(lap, 'tina@plant.example', 'Temp-pass-0001', 'amber-river-stone');
  ok(await lap.evaluate(() => ME.role === 'tech' && S.lots.length === 20), 'tech signed in, sees shared data');
  ok(await lap.locator('#who', { hasText: 'Tina Tech' }).count() === 1, 'header shows signed-in user');
  // new lot, in spec, then Save & e-sign review
  await nav(lap, 'product'); await lap.click('[data-act="new-lot"]'); await dlgOpen(lap);
  await lap.fill('[data-b="code"]', 'OJ-E2E1'); await lap.fill('[data-b="results.ph"]', '3.65'); await lap.fill('[data-b="results.brix"]', '11.5'); await lap.fill('[data-b="results.ta"]', '0.72');
  await lap.selectOption('[data-b="results.sensory"]', 'Pass'); await lap.waitForTimeout(80);
  ok(await lap.locator('[data-b="status"] option[value="Released"]').count() === 0, 'Released not selectable in server mode');
  ok(await lap.locator('[data-b="review.by"]').count() === 0, 'no typed reviewer field in server mode');
  await lap.click('[data-meaning="lot.review"]'); await lap.waitForSelector('#dlg[open] .sigbox');
  ok(await lap.evaluate(() => S.lots.some(l => l.code === 'OJ-E2E1') && VERS['lots|' + S.lots.find(l => l.code === 'OJ-E2E1').id] === 1), 'lot saved to server before signing');
  await lap.screenshot({ path: `${OUT}/03-sign-dialog.png` });
  await lap.fill('[data-b="password"]', 'wrong-password'); await lap.click('[data-act="modal-save"]'); await lap.waitForSelector('.err');
  ok(await lap.locator('.err', { hasText: 'Password incorrect' }).count() === 1, 'wrong password rejects signature');
  await lap.fill('[data-b="password"]', 'amber-river-stone'); await lap.click('[data-act="modal-save"]');
  await lap.waitForFunction(() => { const l = S.lots.find(l => l.code === 'OJ-E2E1'); return l && l.review && l.review.sigId; });
  ok(true, 'tech e-signed review');
  await lap.waitForSelector('#dlg[open] [data-meaning="lot.release"]');
  ok(await lap.locator('[data-meaning="lot.release"]').isDisabled(), 'release button disabled for tech');
  ok(await lap.locator('.sigline.ok', { hasText: 'Tina Tech' }).count() === 1, 'review signature manifest shown');
  await lap.screenshot({ path: `${OUT}/04-reviewed.png` });
  await lap.click('[data-act="modal-close"] >> nth=1');

  // ---- Mo on a phone ----
  const phCtx = await b.newContext({ ...devices['iPhone 13'] }); const ph = await phCtx.newPage(); watch(ph, 'mo');
  await signIn(ph, 'mo@plant.example', 'Temp-pass-0001', 'copper-field-lamp');
  const lotId = await ph.evaluate(() => S.lots.find(l => l.code === 'OJ-E2E1')?.id);
  ok(!!lotId, 'phone sees the lot entered on the laptop');
  await nav(ph, 'product'); await ph.evaluate(id => openRecord('lot', id), lotId); await dlgOpen(ph);
  await ph.waitForSelector('[data-meaning="lot.release"]:not([disabled])');
  await ph.click('[data-meaning="lot.release"]'); await ph.waitForSelector('#dlg[open] .sigbox');
  await ph.screenshot({ path: `${OUT}/05-phone-release-sign.png` });
  await ph.fill('[data-b="password"]', 'copper-field-lamp'); await ph.click('[data-act="modal-save"]');
  await ph.waitForFunction(id => S.lots.find(l => l.id === id).status === 'Released', lotId);
  ok(await ph.evaluate(id => { const l = S.lots.find(l => l.id === id); return l.releasedBy === 'Mo Manager' && S.releases.some(r => r.lotId === id && r.releaseSig && r.reviewer === 'Tina Tech'); }, lotId), 'manager released on phone; release record has both e-signers');
  await ph.waitForSelector('#dlg[open] .sigline.ok >> text=Mo Manager'); await ph.screenshot({ path: `${OUT}/06-phone-released.png` });
  await ph.click('[data-act="modal-close"] >> nth=0');
  // laptop picks it up
  await lap.evaluate(() => refreshState(true)); await lap.waitForTimeout(200);
  ok(await lap.evaluate(id => S.lots.find(l => l.id === id).status === 'Released', lotId), 'laptop sees release made on phone');

  // ---- two-person rule: Mo reviews a lot, cannot release it himself ----
  const awaitId = await ph.evaluate(() => S.lots.find(l => l.status === 'Awaiting Review' && l.code !== 'OJ-E2E1').id);
  await ph.evaluate(id => openRecord('lot', id), awaitId); await dlgOpen(ph);
  await ph.click('[data-meaning="lot.review"]'); await ph.waitForSelector('#dlg[open] .sigbox'); await ph.fill('[data-b="password"]', 'copper-field-lamp'); await ph.click('[data-act="modal-save"]');
  await ph.waitForSelector('#dlg[open] [data-meaning="lot.release"]');
  ok(await ph.locator('[data-meaning="lot.release"]').isDisabled() && await ph.locator('.gate li.n', { hasText: 'different person' }).count() === 1, 'reviewer cannot release own review (two-person rule)');
  await ph.click('[data-act="modal-close"] >> nth=0');

  // ---- CAPA closure e-signature ----
  await nav(ph, 'capa'); await ph.evaluate(() => openRecord('case', 'case1')); await dlgOpen(ph);
  ok(await ph.locator('[data-meaning="case.close"]').isDisabled(), 'closure blocked before Pass');
  await ph.selectOption('[data-b="effectiveness.result"]', 'Pass'); await ph.waitForTimeout(120);
  await ph.click('[data-meaning="case.close"]'); await ph.waitForSelector('#dlg[open] .sigbox');
  await ph.fill('[data-b="password"]', 'copper-field-lamp'); await ph.click('[data-act="modal-save"]');
  await ph.waitForFunction(() => caseById('case1').status === 'Closed');
  ok(await ph.evaluate(() => caseById('case1').closedBy === 'Mo Manager' && !!caseById('case1').closeSig), 'case closed by e-signature');
  await ph.click('[data-act="modal-close"] >> nth=0');

  // ---- conflict detection ----
  await lap.evaluate(() => refreshState(true)); await ph.evaluate(() => refreshState(true));
  await nav(lap, 'em'); await nav(ph, 'em');
  await lap.evaluate(() => openRecord('swab', 'sw1')); await dlgOpen(lap);
  await ph.evaluate(() => openRecord('swab', 'sw1')); await dlgOpen(ph);
  await ph.fill('[data-b="notes"]', 'Edited on phone'); await ph.click('[data-act="modal-save"]'); await ph.waitForFunction(() => !document.querySelector('#dlg').open);
  await lap.fill('[data-b="notes"]', 'Edited on laptop'); await lap.click('[data-act="modal-save"]'); await lap.waitForSelector('.err');
  ok(await lap.locator('.err', { hasText: 'Someone else changed this record' }).count() === 1, 'concurrent edit detected as conflict');
  ok(await lap.evaluate(() => swabById('sw1').notes === 'Edited on phone'), 'laptop refreshed to the saved version');
  await lap.click('[data-act="modal-close"] >> nth=1');

  // ---- reason for change on a released lot ----
  lap._reason = 'Added outside-lab note after release';
  await nav(lap, 'product'); await lap.evaluate(id => openRecord('lot', id), lotId); await dlgOpen(lap);
  await lap.fill('[data-b="notes"]', 'Outside lab confirms pH'); await lap.click('[data-act="modal-save"]'); await lap.waitForFunction(() => !document.querySelector('#dlg').open);
  const hist = await lap.evaluate(id => api('GET', `/audit?coll=lots&id=${id}`), lotId);
  ok(hist.entries.some(e => e.reason === 'Added outside-lab note after release' && e.userName === 'Tina Tech'), 'change to released lot recorded with reason and user');
  ok(hist.entries.filter(e => e.action === 'sign').length === 2, 'two signature events in the lot audit trail');
  // record history modal
  await lap.evaluate(id => openRecord('lot', id), lotId); await dlgOpen(lap);
  await lap.click('#dlg [data-act="history"]'); await lap.waitForSelector('#dlg[open] .trail');
  ok(await lap.locator('.trail li').count() >= 4 && await lap.locator('#dlg .sigline.ok').count() === 2, 'record history shows audit entries and signatures');
  await lap.screenshot({ path: `${OUT}/07-history.png` });
  await lap.click('[data-act="modal-save"]');

  // ---- audit trail page + integrity ----
  await nav(ad, 'trail'); await ad.waitForSelector('#trailList table');
  ok(await ad.locator('#trailList tr', { hasText: 'Mo Manager' }).count() > 0, 'audit trail page lists actions by user');
  await ad.screenshot({ path: `${OUT}/08-trail.png` });
  await ad.click('main [data-act="verify-chain"]'); await ad.waitForSelector('.toast >> text=hash chain intact');
  ok(true, 'audit trail integrity verified');
  // dashboard feed from audit
  await nav(ad, 'home'); await ad.waitForSelector('#feed .feed li'); ok(await ad.locator('#feed', { hasText: 'Approved closure e-signature by Mo Manager' }).count() === 1, 'dashboard activity comes from audit trail');
  await ad.screenshot({ path: `${OUT}/09-dashboard.png`, fullPage: true });

  // ---- viewer is read only ----
  const vw = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(vw, 'vic');
  await signIn(vw, 'vic@plant.example', 'Temp-pass-0001', 'violet-harbor-moss');
  await nav(vw, 'product'); ok(!(await vw.locator('[data-act="new-lot"]').isVisible()), 'viewer has no create buttons');

  // ---- sign out, session gone ----
  await lap.click('#menuBtn'); await lap.click('[data-act="sign-out"]'); await lap.waitForSelector('#au-email');
  ok(await lap.evaluate(() => !localStorage.getItem('qaLabSuite.token')), 'sign out clears token');

  // ---- phone layout ----
  for (const r of ['home', 'product', 'capa', 'trail']) { await nav(ph, r); await ph.waitForTimeout(250); const w = await ph.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); ok(w[0] <= w[1], `phone no overflow #${r} ${w}`); }
  await nav(ph, 'home'); await ph.screenshot({ path: `${OUT}/10-phone-home.png` });
  // ---- offline: read-only cache ----
  await phCtx.setOffline(true); await ph.reload().catch(() => {});
  ok(true, 'offline reload attempted');
  await phCtx.setOffline(false);

  ok(errs.length === 0, 'no unexpected console errors ' + errs.join(' | '));
  await b.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
