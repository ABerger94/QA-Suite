/* RULES:BEGIN — this block is copied verbatim into index.html; `npm run check-rules` verifies they match. */
const R = (() => {
  const isNum = v => v !== '' && v != null && isFinite(Number(v));
  const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const fmtNum = (v, dp) => !isNum(v) ? '—' : dp == null ? String(Number(v)) : Number(v).toFixed(dp);
  /* tests: {key,name,unit,min,max,type:'num'|'pf',req,dp} */
  function checkVal(t, v) {
    if (t.type === 'pf') return v === 'Pass' ? 'ok' : v === 'Fail' ? 'oos' : 'missing';
    if (!isNum(v)) return 'missing';
    const n = Number(v);
    if (isNum(t.min) && n < Number(t.min)) return 'oos';
    if (isNum(t.max) && n > Number(t.max)) return 'oos';
    return 'ok';
  }
  function specText(t) {
    if (t.type === 'pf') return 'Pass required';
    const u = t.unit ? ' ' + t.unit : ''; const f = v => fmtNum(v, t.dp);
    if (isNum(t.min) && isNum(t.max)) return `${f(t.min)} – ${f(t.max)}${u}`;
    if (isNum(t.min)) return `≥ ${f(t.min)}${u}`;
    if (isNum(t.max)) return `≤ ${f(t.max)}${u}`;
    return 'record only';
  }
  function evalTests(tests, values) {
    const rows = (tests || []).map(t => ({ t, v: (values || {})[t.key], st: checkVal(t, (values || {})[t.key]) }));
    return { rows, missing: rows.filter(r => r.t.req && r.st === 'missing'), oos: rows.filter(r => r.st === 'oos') };
  }
  /* The fields an e-signature on a lot covers. Changing any of them invalidates the review signature. */
  function lotSignedContent(lot) { return JSON.stringify([lot.productId || '', lot.code || '', lot.date || '', Object.keys(lot.results || {}).sort().map(k => [k, String(lot.results[k])])]); }
  function testChecks(lot, product) {
    const ev = evalTests(product ? product.tests : [], lot.results);
    return [
      { key: 'product', ok: !!product, txt: 'Product with spec limits selected' },
      { key: 'entered', ok: !!product && !ev.missing.length, txt: ev.missing.length ? `Required tests entered — missing: ${ev.missing.map(r => r.t.name).join(', ')}` : 'All required tests entered' },
      { key: 'spec', ok: !ev.oos.length, txt: ev.oos.length ? `All results within spec — out of spec: ${ev.oos.map(r => r.t.name).join(', ')}` : 'All results within spec' },
    ];
  }
  const holdCheck = h => ({ key: 'hold', ok: !h, txt: h ? `No open hold — ${h.num || 'hold'} must be dispositioned in Holds & CAPA first` : 'No open hold on this lot' });
  /* Preconditions for the record-review e-signature (server mode). */
  function reviewChecks(lot, product, ctx) {
    return [...testChecks(lot, product), holdCheck(ctx && ctx.openHold),
      { key: 'notReleased', ok: lot.status !== 'Released', txt: 'Lot not already released' }];
  }
  /* Release gate. ctx: {mode:'local'|'server', openHold, userId, separate} */
  function releaseChecks(lot, product, ctx) {
    ctx = ctx || {}; const out = testChecks(lot, product); const rv = lot.review || {};
    if (ctx.mode === 'server') {
      out.push({ key: 'review', ok: !!rv.sigId, txt: rv.sigId ? `Record review e-signed by ${rv.by}` : 'Record review e-signed (Reviewed signature)' });
      if (ctx.separate) out.push({ key: 'separate', ok: !rv.sigId || !ctx.userId || rv.userId !== ctx.userId, txt: 'Releaser is a different person from the reviewer' });
    } else {
      out.push({ key: 'review', ok: !!(rv.by && validDate(rv.date)), txt: 'Record-review sign-off (reviewer + date)' });
      out.push({ key: 'releasedBy', ok: !!lot.releasedBy, txt: 'Released by recorded' });
    }
    out.push(holdCheck(ctx.openHold));
    return out;
  }
  function acceptChecks(load, material) {
    const coa = evalTests(material ? material.tests : [], load.coa);
    const internal = evalTests(material ? material.tests : [], load.internal).rows.filter(r => r.st !== 'missing');
    const iOos = internal.filter(r => r.st === 'oos');
    const missing = coa.rows.filter(r => r.st === 'missing');
    return [
      { key: 'material', ok: !!material, txt: 'Material with specification selected' },
      { key: 'coa', ok: !!load.coaReceived, txt: 'COA received' },
      { key: 'coaEntered', ok: !!load.coaReceived && !missing.length, txt: missing.length ? `COA values entered — missing: ${missing.map(r => r.t.name).join(', ')}` : 'All COA values entered' },
      { key: 'coaSpec', ok: !coa.oos.length, txt: coa.oos.length ? `COA within spec — outside: ${coa.oos.map(r => r.t.name).join(', ')}` : 'COA values within spec' },
      { key: 'internal', ok: !iOos.length, txt: iOos.length ? `Internal tests within spec — outside: ${iOos.map(r => r.t.name).join(', ')}` : 'Internal test results within spec (where tested)' },
    ];
  }
  function closureChecks(c) {
    const e = c.effectiveness || {};
    const acts = [...(c.corrective || []), ...(c.preventive || [])]; const open = acts.filter(a => !a.done);
    return [
      { key: 'rootCause', ok: !!(c.rca && c.rca.rootCause), txt: 'Root-cause statement recorded' },
      { key: 'corrective', ok: (c.corrective || []).length > 0, txt: 'At least one corrective action' },
      { key: 'actions', ok: !open.length, txt: open.length ? `All actions complete — ${open.length} still open` : 'All corrective & preventive actions complete' },
      { key: 'effRecorded', ok: !!(e.metric && validDate(e.date)), txt: 'Effectiveness check recorded (metric + check date)' },
      { key: 'effPass', ok: e.result === 'Pass', txt: e.result === 'Fail' ? 'Effectiveness check result is Fail — revisit root cause' : 'Effectiveness check result = Pass' },
    ];
  }
  const allOk = g => g.every(x => x.ok);
  return { isNum, validDate, fmtNum, checkVal, specText, evalTests, lotSignedContent, reviewChecks, releaseChecks, acceptChecks, closureChecks, allOk };
})();
/* RULES:END */
export default R;
