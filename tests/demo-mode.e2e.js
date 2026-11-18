/* Browser tests for demo (local) mode. Run: node tests/demo-mode.e2e.js  (needs Playwright + Chromium) */
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const OUT = path.join(__dirname, 'shots'); fs.mkdirSync(OUT, { recursive: true });
const URL = 'file://' + path.resolve(__dirname, '../index.html');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const pg = await ctx.newPage(); const errs = [];
  pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  pg.on('dialog', d => d.accept());
  await pg.goto(URL); await pg.waitForSelector('.stat');
  for (const r of ['home','em','product','incoming','capa','trending','audit','compliance']) { await pg.goto(URL + '#' + r); await pg.waitForTimeout(120); await pg.screenshot({ path: `${OUT}/d-${r}.png`, fullPage: true }); }
  const nav = async r => { await pg.evaluate(r => { location.hash = r; }, '#' + r); await pg.waitForFunction(r => route() === r && !PENDING, r); await pg.waitForTimeout(80); };
  // EM stats
  await nav('em'); const pr = await pg.textContent('.stat .n'); ok(pr.trim() === '87.1%', 'EM 30-day pass rate ' + pr);
  ok(await pg.locator('.pill', { hasText: 'Repeat positive' }).count() >= 1, 'repeat-positive flag shown');
  // Gate 1: held lemonade lot cannot be released
  await nav('product');
  const lmId = await pg.evaluate(() => S.lots.find(l => l.status === 'On Hold').id);
  await pg.evaluate(id => openRecord('lot', id), lmId); await pg.waitForSelector('#dlg[open]');
  await pg.fill('[data-b="review.by"]', 'Tester'); await pg.fill('[data-b="review.date"]', await pg.evaluate(() => today()));
  await pg.fill('[data-b="releasedBy"]', 'Tester'); await pg.selectOption('[data-b="status"]', 'Released'); await pg.waitForTimeout(50);
  await pg.click('[data-act="modal-save"]'); await pg.waitForTimeout(80);
  ok(await pg.locator('.err', { hasText: 'Release blocked' }).count() === 1, 'release blocked for OOS pH lot');
  ok(await pg.evaluate(id => S.lots.find(l => l.id === id).status, lmId) === 'On Hold', 'held lot still On Hold');
  await pg.screenshot({ path: `${OUT}/gate-release-blocked.png` });
  await pg.click('[data-act="modal-close"] >> nth=1');
  // New lot with failing pH -> auto On Hold + hold record
  const holdsBefore = await pg.evaluate(() => S.holds.length);
  await pg.click('[data-act="new-lot"]'); await pg.selectOption('[data-b="productId"]', 'p2'); await pg.waitForTimeout(50);
  await pg.fill('[data-b="code"]', 'LM-TEST1'); await pg.fill('[data-b="results.ph"]', '3.40'); await pg.fill('[data-b="results.brix"]', '10.8');
  await pg.selectOption('[data-b="results.sensory"]', 'Pass'); await pg.waitForTimeout(50);
  await pg.click('[data-act="modal-save"]'); await pg.waitForTimeout(100);
  const nl = await pg.evaluate(() => S.lots.find(l => l.code === 'LM-TEST1'));
  ok(nl && nl.status === 'On Hold', 'failing new lot auto-set On Hold');
  ok(await pg.evaluate(() => S.holds.length) === holdsBefore + 1, 'hold record auto-created');
  // try releasing it directly via data layer (bypassing UI)
  const bypass = await pg.evaluate(id => { const d = clone(S.lots.find(l => l.id === id)); d.status = 'Released'; d.review = { by: 'x', date: today() }; d.releasedBy = 'x'; M = { draft: d }; const r = commitLot(d, false, false); M = null; return [r, S.lots.find(l => l.id === id).status]; }, nl.id);
  ok(bypass[0] === false && bypass[1] === 'On Hold', 'data-layer release gate rejects OOS lot');
  // cross-link from lot
  const casesBefore = await pg.evaluate(() => S.cases.length);
  await pg.evaluate(id => caseFrom('lot', id), nl.id); await pg.waitForTimeout(150);
  ok(await pg.evaluate(() => S.cases.length) === casesBefore + 1, 'lot -> CAPA case created');
  ok(await pg.evaluate(id => !!S.cases.find(c => c.source.id === id && /pH/.test(c.deviation)), nl.id), 'lot case pre-filled with pH detail');
  ok(await pg.evaluate(id => { const c = S.cases.find(c => c.source.id === id); return S.holds.some(h => h.caseId === c.id); }, nl.id), 'hold linked to new case');
  await pg.screenshot({ path: `${OUT}/case-from-lot.png` }); await pg.click('[data-act="modal-close"] >> nth=1');
  // Release OJ awaiting review
  const ojId = await pg.evaluate(() => S.lots.find(l => l.status === 'Awaiting Review').id);
  const relBefore = await pg.evaluate(() => S.releases.length);
  await pg.evaluate(id => openRecord('lot', id), ojId); await pg.waitForSelector('#dlg[open]'); await pg.waitForTimeout(50);
  await pg.fill('[data-b="review.by"]', 'M. Chen'); await pg.fill('[data-b="review.date"]', await pg.evaluate(() => today()));
  await pg.fill('[data-b="releasedBy"]', 'Tester'); await pg.selectOption('[data-b="status"]', 'Released'); await pg.waitForTimeout(50);
  ok(await pg.locator('.gate.ok').count() === 1, 'release gate shows passed');
  await pg.click('[data-act="modal-save"]'); await pg.waitForTimeout(80);
  ok(await pg.evaluate(id => S.lots.find(l => l.id === id).status, ojId) === 'Released' && await pg.evaluate(() => S.releases.length) === relBefore + 1, 'in-spec reviewed lot released + logged');
  // Swab cross-link (Zone 1 ATP fail)
  await nav('em'); await pg.waitForTimeout(100);
  const z1 = await pg.evaluate(() => S.swabs.find(s => s.type === 'ATP' && s.result === 'Fail' && !s.caseId && swabCaseEligible(s)).id);
  await pg.click(`[data-act="case-from"][data-kind="swab"][data-id="${z1}"]`); await pg.waitForTimeout(150);
  ok(await pg.evaluate(id => S.cases.some(c => c.source.kind === 'swab' && c.source.id === id), z1), 'swab -> CAPA case created');
  await pg.click('[data-act="modal-close"] >> nth=1');
  // Load cross-link
  await nav('incoming'); await pg.waitForTimeout(100);
  await pg.click('[data-act="case-from"][data-kind="load"][data-id="ld6"]'); await pg.waitForTimeout(150);
  ok(await pg.evaluate(() => S.cases.some(c => c.source.kind === 'load' && c.source.id === 'ld6' && /COA/.test(c.deviation))), 'load -> CAPA case created with COA detail');
  await pg.click('[data-act="modal-close"] >> nth=1');
  // Accept gate on pending load without COA
  await pg.evaluate(() => openRecord('load', 'ld9')); await pg.waitForSelector('#dlg[open]'); await pg.waitForTimeout(50);
  await pg.selectOption('[data-b="decision"]', 'Accept'); await pg.waitForTimeout(50); await pg.click('[data-act="modal-save"]'); await pg.waitForTimeout(50);
  ok(await pg.locator('.err', { hasText: 'Accept blocked' }).count() === 1 && await pg.evaluate(() => S.loads.find(l => l.id === 'ld9').decision) === 'Pending', 'accept blocked without COA');
  await pg.click('[data-act="modal-close"] >> nth=1');
  // Closure gate
  await nav('capa'); await pg.waitForTimeout(100); await pg.evaluate(() => openRecord('case', 'case1')); await pg.waitForSelector('#dlg[open]'); await pg.waitForTimeout(50);
  await pg.selectOption('[data-b="status"]', 'Closed'); await pg.waitForTimeout(50); await pg.click('[data-act="modal-save"]'); await pg.waitForTimeout(50);
  await pg.screenshot({ path: `${OUT}/gate-close-blocked.png` });
  await pg.selectOption('[data-b="effectiveness.result"]', 'Fail'); await pg.waitForTimeout(50); await pg.click('[data-act="modal-save"]'); await pg.waitForTimeout(50);
  ok(await pg.evaluate(() => caseById('case1').status) !== 'Closed', 'closure blocked with Fail effectiveness');
  await pg.selectOption('[data-b="effectiveness.result"]', 'Pass'); await pg.waitForTimeout(50); await pg.click('[data-act="modal-save"]'); await pg.waitForTimeout(80);
  ok(await pg.evaluate(() => caseById('case1').status) === 'Closed', 'case closes with Pass effectiveness');
  // Trending charts
  await nav('trending'); await pg.waitForTimeout(150);
  ok(await pg.locator('[data-chart="pareto"] svg path').count() >= 3, 'pareto renders');
  ok(await pg.locator('[data-chart="lab"] svg path').count() >= 2, 'lab comparison renders 2 series');
  await pg.screenshot({ path: `${OUT}/trending.png`, fullPage: true });
  await nav('home'); await pg.waitForTimeout(80);
  ok(await pg.locator('.sig', { hasText: 'outside lab' }).count() >= 1, 'dashboard drift strip shows lab divergence');
  // Search
  await pg.fill('#q', 'sunvale'); await pg.waitForTimeout(80); ok(await pg.locator('#qres button').count() >= 3, 'global search finds Sunvale records');
  await pg.fill('#q', '');
  // Audit packet print
  await nav('audit'); await pg.waitForTimeout(80);
  await pg.emulateMedia({ media: 'print' }); await pg.pdf({ path: `${OUT}/audit.pdf`, format: 'Letter' });
  await pg.screenshot({ path: `${OUT}/audit-print.png`, fullPage: true }); await pg.emulateMedia({ media: 'screen' });
  // CSV
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.evaluate(() => A['csv']({ mod: 'product' }))]);
  const csv = fs.readFileSync(await dl.path(), 'utf8'); ok(csv.split('\n').length > 15 && csv.includes('Lot,Product'), 'product CSV export');
  // Offline copy
  const [dl2] = await Promise.all([pg.waitForEvent('download'), pg.evaluate(() => A['download-offline']())]);
  const off = path.join(OUT, 'offline.html'); fs.copyFileSync(await dl2.path(), off);
  const ctx2 = await b.newContext(); const p2 = await ctx2.newPage(); const e2 = []; p2.on('pageerror', e => e2.push(e.message));
  await p2.goto('file://' + off); await p2.waitForSelector('.stat');
  ok(await p2.evaluate(() => S.lots.some(l => l.code === 'LM-TEST1') && caseById('case1').status === 'Closed'), 'offline copy carries baked data');
  ok(e2.length === 0, 'offline copy no errors ' + e2.join('|'));
  ok(errs.length === 0, 'no console errors ' + errs.join(' | '));
  // Mobile overflow
  const mctx = await b.newContext({ viewport: { width: 375, height: 800 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage(); const me = []; mp.on('pageerror', e => me.push(e.message));
  await mp.goto(URL); await mp.waitForSelector('.stat');
  for (const r of ['home','em','product','incoming','capa','trending','audit','compliance']) {
    await mp.goto(URL + '#' + r); await mp.waitForTimeout(120);
    const w = await mp.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    ok(w[0] <= w[1], `mobile no overflow #${r} (${w[0]}/${w[1]})`);
    await mp.screenshot({ path: `${OUT}/m-${r}.png`, fullPage: true });
  }
  await mp.evaluate(() => openRecord('case', 'case2')); await mp.waitForTimeout(100); await mp.screenshot({ path: `${OUT}/m-case-modal.png` });
  const mw = await mp.evaluate(() => [document.querySelector('.mbody').scrollWidth, document.querySelector('.mbody').clientWidth]); ok(mw[0] <= mw[1], 'mobile modal no overflow ' + mw);
  ok(me.length === 0, 'mobile no errors ' + me.join('|'));
  await b.close(); console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
