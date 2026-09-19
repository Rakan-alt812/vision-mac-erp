'use strict';
/* ══════════════════════════════════════════════════════════════
   Phase A modules: sales pipeline, BOQ quotations, material
   requests, stock transfers, and weighted-average costing.
   Everything that touches money posts through ledger.post().
   ══════════════════════════════════════════════════════════════ */
const { db, q, get1, run } = require('./db');
const L = require('./ledger');
const R2 = L.R2;
const today = () => new Date().toISOString().slice(0, 10);

/* ═══════════ WEIGHTED AVERAGE COST ═══════════
   Receiving at a new price moves the average; issuing uses the
   current average. This is what makes project cost honest when
   the same cable is bought twice at different prices. */
function receiveAtCost(material_id, warehouse_id, qty, unit_cost) {
  const row = get1('SELECT qty, avg_cost FROM stock WHERE material_id=? AND warehouse_id=?',
                   material_id, warehouse_id);
  if (!row) {
    run('INSERT INTO stock(material_id,warehouse_id,qty,avg_cost) VALUES(?,?,?,?)',
        material_id, warehouse_id, qty, unit_cost);
    return R2(unit_cost);
  }
  const newQty = R2(row.qty + qty);
  const newAvg = newQty > 0
    ? R2((row.qty * (row.avg_cost || unit_cost) + qty * unit_cost) / newQty)
    : R2(unit_cost);
  run('UPDATE stock SET qty=?, avg_cost=? WHERE material_id=? AND warehouse_id=?',
      newQty, newAvg, material_id, warehouse_id);
  return newAvg;
}

function costAt(material_id, warehouse_id) {
  const s = get1('SELECT avg_cost FROM stock WHERE material_id=? AND warehouse_id=?',
                 material_id, warehouse_id);
  if (s && s.avg_cost > 0) return s.avg_cost;
  const m = get1('SELECT cost FROM materials WHERE id=?', material_id);
  return m ? m.cost : 0;
}

function availableAt(material_id, warehouse_id) {
  const s = get1('SELECT qty FROM stock WHERE material_id=? AND warehouse_id=?',
                 material_id, warehouse_id);
  return s ? s.qty : 0;
}

/* ═══════════ STOCK TRANSFER between warehouses ═══════════
   Value moves with the goods so each site store carries its own
   average. No ledger entry — inventory total is unchanged. */
function transfer(user, d) {
  const qty = Number(d.qty) || 0;
  if (qty <= 0) throw new Error('الكمية يجب أن تكون أكبر من صفر');
  if (Number(d.from_wh) === Number(d.to_wh)) throw new Error('المستودع المصدر والوجهة متطابقان');
  const have = availableAt(d.material_id, d.from_wh);
  if (qty > have) throw new Error(`الكمية المتاحة ${have} فقط في المستودع المصدر`);

  const unit = costAt(d.material_id, d.from_wh);
  run('UPDATE stock SET qty=qty-? WHERE material_id=? AND warehouse_id=?', qty, d.material_id, d.from_wh);
  receiveAtCost(d.material_id, d.to_wh, qty, unit);
  run(`INSERT INTO moves(material_id,from_wh,to_wh,qty,mdate,ref,project_id,unit_cost,kind,created_by)
       VALUES(?,?,?,?,?,'نقل داخلي',?,?,'نقل',?)`,
      d.material_id, d.from_wh, d.to_wh, qty, d.mdate || today(), d.project_id || null, unit, user.id);
  return { qty, unit_cost: unit, value: R2(qty * unit) };
}

/* ═══════════ MATERIAL REQUEST ═══════════
   Site asks for material. System splits it immediately into what
   can be issued from stock and what has to be purchased — that
   split is the whole point of the document. */
function createMR(user, d) {
  if (!d.project_id) throw new Error('حدّد المشروع');
  if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('أضف صنفاً واحداً على الأقل');
  const code = 'MR-' + String(get1('SELECT COUNT(*) c FROM matreqs').c + 1).padStart(4, '0');
  const info = run(`INSERT INTO matreqs(code,project_id,warehouse_id,needed,reason,status,requested_by,requested_at)
    VALUES(?,?,?,?,?,'مسودة',?,?)`, code, d.project_id, d.warehouse_id || 1,
    d.needed || today(), d.reason || null, user.id, new Date().toISOString());
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare('INSERT INTO mrlines(mr_id,material_id,qty,to_buy) VALUES(?,?,?,?)');
  d.lines.forEach(l => {
    const qty = Number(l.qty) || 0;
    const have = availableAt(l.material_id, d.warehouse_id || 1);
    ins.run(id, l.material_id, qty, R2(Math.max(0, qty - have)));
  });
  return id;
}

function mrDetail(id) {
  const mr = get1(`SELECT mr.*, p.name project, w.name warehouse, u.name requester
    FROM matreqs mr JOIN projects p ON p.id=mr.project_id
    LEFT JOIN warehouses w ON w.id=mr.warehouse_id
    LEFT JOIN users u ON u.id=mr.requested_by WHERE mr.id=?`, id);
  if (!mr) throw new Error('الطلب غير موجود');
  const lines = q(`SELECT ml.*, m.code, m.name, m.unit
    FROM mrlines ml JOIN materials m ON m.id=ml.material_id WHERE ml.mr_id=?`, id)
    .map(l => {
      const have = availableAt(l.material_id, mr.warehouse_id);
      return { ...l, available: have, can_issue: R2(Math.min(l.qty - l.issued, have)),
               shortfall: R2(Math.max(0, l.qty - have)) };
    });
  return { ...mr, lines };
}

function approveMR(user, id, ok) {
  const mr = get1('SELECT * FROM matreqs WHERE id=?', id);
  if (!mr) throw new Error('الطلب غير موجود');
  if (mr.status !== 'مسودة' && mr.status !== 'بانتظار الاعتماد')
    throw new Error('الطلب غير قابل للاعتماد في حالته الحالية');
  run('UPDATE matreqs SET status=?, decided_by=?, decided_at=? WHERE id=?',
      ok ? 'معتمد' : 'مرفوض', user.id, new Date().toISOString(), id);
  return { ok };
}

/* Issue whatever is available against an approved request. */
function fulfilMR(user, id, issueMaterialFn) {
  const mr = mrDetail(id);
  if (mr.status !== 'معتمد' && mr.status !== 'صرف جزئي')
    throw new Error('الطلب غير معتمد');
  let total = 0, issuedAny = false;
  mr.lines.forEach(l => {
    const qty = R2(Math.min(l.qty - l.issued, l.available));
    if (qty <= 0) return;
    const r = issueMaterialFn(user, { material_id: l.material_id, warehouse_id: mr.warehouse_id,
                                      qty, project_id: mr.project_id, ref: mr.code });
    run('UPDATE mrlines SET issued=issued+? WHERE id=?', qty, l.id);
    total = R2(total + r.cost); issuedAny = true;
  });
  if (!issuedAny) throw new Error('لا توجد كميات متاحة للصرف — نفّذ أمر شراء أولاً');
  const after = q('SELECT qty,issued FROM mrlines WHERE mr_id=?', id);
  const done = after.every(l => l.issued >= l.qty - 0.001);
  run('UPDATE matreqs SET status=? WHERE id=?', done ? 'مصروف' : 'صرف جزئي', id);
  return { cost: total, complete: done };
}

/* ═══════════ QUOTATIONS / BOQ ═══════════ */
function createQuote(user, d) {
  const cust = get1("SELECT * FROM partners WHERE id=? AND kind='customer'", d.customer_id);
  if (!cust) throw new Error('العميل غير موجود');
  if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('كشف الكميات يحتاج بنداً واحداً');
  const code = d.code || 'QT-' + new Date().getFullYear() + '-' +
    String(get1('SELECT COUNT(*) c FROM quotes').c + 1).padStart(4, '0');
  const info = run(`INSERT INTO quotes(code,opp_id,customer_id,qdate,valid_until,qtype,terms,notes,status,markup,created_by)
    VALUES(?,?,?,?,?,?,?,?,'مسودة',?,?)`, code, d.opp_id || null, cust.id,
    d.qdate || today(), d.valid_until || null, d.qtype || 'كشف كميات',
    d.terms || null, d.notes || null, Number(d.markup) || 0, user.id);
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare(`INSERT INTO qlines(quote_id,item,descr,trade,unit,qty,cost,price,vat,sort)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  d.lines.forEach((l, i) => ins.run(id, l.item || '', l.descr || '', l.trade || null,
    l.unit || 'قطعة', Number(l.qty) || 1, Number(l.cost) || 0, Number(l.price) || 0,
    l.vat == null ? 0.15 : Number(l.vat), i));
  return id;
}

function quoteTotals(id) {
  const ls = q('SELECT * FROM qlines WHERE quote_id=?', id);
  const cost = R2(ls.reduce((s, l) => s + l.qty * l.cost, 0));
  const net = R2(ls.reduce((s, l) => s + l.qty * l.price, 0));
  const vat = R2(ls.reduce((s, l) => s + l.qty * l.price * l.vat, 0));
  return { cost, net, vat, total: R2(net + vat),
           margin: net ? R2((net - cost) / net * 100) : 0, profit: R2(net - cost) };
}

function quoteDetail(id) {
  const qt = get1(`SELECT q.*, p.name customer, p.vat customer_vat, o.name opp
    FROM quotes q JOIN partners p ON p.id=q.customer_id
    LEFT JOIN opps o ON o.id=q.opp_id WHERE q.id=?`, id);
  if (!qt) throw new Error('عرض السعر غير موجود');
  return { ...qt, lines: q('SELECT * FROM qlines WHERE quote_id=? ORDER BY sort, id', id),
           totals: quoteTotals(id) };
}

function sendQuote(user, id) {
  const qt = get1('SELECT * FROM quotes WHERE id=?', id);
  if (!qt) throw new Error('عرض السعر غير موجود');
  if (qt.status !== 'مسودة') throw new Error('عرض السعر أُرسل مسبقاً');
  run("UPDATE quotes SET status='مُرسل' WHERE id=?", id);
  if (qt.opp_id) run("UPDATE opps SET stage='عرض سعر' WHERE id=?", qt.opp_id);
  return { ok: true };
}

/* Winning a quote creates the project and carries every BOQ line
   across as a task — this is the handover that normally gets
   retyped by hand. */
function winQuote(user, id, d) {
  const qt = get1('SELECT * FROM quotes WHERE id=?', id);
  if (!qt) throw new Error('عرض السعر غير موجود');
  if (qt.status === 'مقبول') throw new Error('عرض السعر مقبول مسبقاً');
  const t = quoteTotals(id);
  const code = (d && d.code) || 'PRJ-' + String(get1('SELECT COUNT(*) c FROM projects').c + 1).padStart(3, '0');
  const opp = qt.opp_id ? get1('SELECT * FROM opps WHERE id=?', qt.opp_id) : null;
  const name = (d && d.name) || (opp ? opp.name : 'مشروع ' + qt.code);

  const info = run(`INSERT INTO projects(code,name,customer_id,trade,ctype,value,sdate,ddate,progress,pm_id,status)
    VALUES(?,?,?,?,?,?,?,?,0,?,'جارٍ')`, code, name, qt.customer_id,
    (opp && opp.trade) || 'MEP كامل', qt.qtype === 'كشف كميات' ? 'كشف كميات' : 'مقطوعية',
    t.net, (d && d.sdate) || today(), (d && d.ddate) || null, user.id);
  const pid = Number(info.lastInsertRowid);

  const ins = db.prepare(`INSERT INTO tasks(project_id,name,trade,phase,progress,status,weight)
    VALUES(?,?,?,'تركيب',0,'لم يبدأ',?)`);
  q('SELECT * FROM qlines WHERE quote_id=? ORDER BY sort, id', id)
    .forEach(l => ins.run(pid, (l.item ? l.item + ' — ' : '') + (l.descr || 'بند'),
                          l.trade || null, Math.max(1, Math.round(l.qty * l.price / 10000))));

  run("UPDATE quotes SET status='مقبول' WHERE id=?", id);
  if (qt.opp_id) run("UPDATE opps SET stage='فاز', project_id=? WHERE id=?", pid, qt.opp_id);
  return { project_id: pid, code, tasks: get1('SELECT COUNT(*) c FROM tasks WHERE project_id=?', pid).c };
}

/* Turn an accepted quote into a posted-ready invoice. */
function quoteToInvoice(user, id, createInvoiceFn) {
  const qt = get1('SELECT * FROM quotes WHERE id=?', id);
  if (!qt) throw new Error('عرض السعر غير موجود');
  if (qt.status !== 'مقبول') throw new Error('حوّل عرض السعر إلى فائز أولاً');
  if (qt.invoice_id) throw new Error('صدرت فاتورة لهذا العرض مسبقاً');
  const acct = { 'كهرباء': '4110', 'ميكانيكا': '4120', 'سباكة': '4130' };
  const lines = q('SELECT * FROM qlines WHERE quote_id=? ORDER BY sort, id', id)
    .map(l => ({ descr: (l.item ? l.item + ' — ' : '') + (l.descr || 'بند'),
                 account: acct[l.trade] || '4190', qty: l.qty, price: l.price, vat: l.vat }));
  const opp = qt.opp_id ? get1('SELECT project_id FROM opps WHERE id=?', qt.opp_id) : null;
  const invId = createInvoiceFn(user, { customer_id: qt.customer_id,
    project_id: opp ? opp.project_id : null, idate: today(), lines });
  run('UPDATE quotes SET invoice_id=? WHERE id=?', invId, id);
  return { invoice_id: invId };
}

/* ═══════════ OPPORTUNITIES ═══════════ */
function saveOpp(user, d) {
  const cols = ['name','customer_id','trade','ctype','value','probability','source',
                'heat','stage','close_date','owner_id','lost_reason','competitor'];
  const vals = cols.map(k => d[k] === undefined ? null : d[k]);
  if (d.id) {
    run(`UPDATE opps SET ${cols.map(k => k + '=?').join(',')} WHERE id=?`, ...vals, d.id);
    return { id: d.id };
  }
  const code = 'OPP-' + String(get1('SELECT COUNT(*) c FROM opps').c + 1).padStart(4, '0');
  const info = run(`INSERT INTO opps(code,${cols.join(',')},created) VALUES(?,${cols.map(() => '?').join(',')},?)`,
                   code, ...vals, new Date().toISOString());
  return { id: Number(info.lastInsertRowid), code };
}

function pipeline() {
  const rows = q(`SELECT o.*, p.name customer, u.name owner FROM opps o
    LEFT JOIN partners p ON p.id=o.customer_id
    LEFT JOIN users u ON u.id=o.owner_id ORDER BY o.id DESC`);
  const stages = ['جديد', 'مؤهل', 'عرض سعر', 'تفاوض', 'فاز', 'خسر'];
  const byStage = {};
  stages.forEach(s => byStage[s] = rows.filter(r => r.stage === s));
  const open = rows.filter(r => !['فاز', 'خسر'].includes(r.stage));
  const won = rows.filter(r => r.stage === 'فاز'), lost = rows.filter(r => r.stage === 'خسر');
  return {
    stages, byStage, rows,
    total_open: R2(open.reduce((s, r) => s + r.value, 0)),
    weighted: R2(open.reduce((s, r) => s + r.value * (r.probability || 0) / 100, 0)),
    won_value: R2(won.reduce((s, r) => s + r.value, 0)),
    lost_value: R2(lost.reduce((s, r) => s + r.value, 0)),
    win_rate: (won.length + lost.length) ? R2(won.length / (won.length + lost.length) * 100) : 0,
    lost_reasons: Object.entries(lost.reduce((a, r) => {
      const k = r.lost_reason || 'غير محدد';
      a[k] = a[k] || { n: 0, value: 0 };
      a[k].n++; a[k].value = R2(a[k].value + r.value);
      return a;
    }, {})).map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.value - a.value)
  };
}

/* ═══════════ PROJECT PROGRESS ROLLUP ═══════════
   Weighted by task weight so a 3-week cable pull counts more than
   a 1-day sign-off. Keeps the header % honest. */
function rollupProgress(project_id) {
  const ts = q('SELECT progress, weight FROM tasks WHERE project_id=?', project_id);
  if (!ts.length) return null;
  const tw = ts.reduce((s, t) => s + (t.weight || 1), 0);
  const pct = Math.round(ts.reduce((s, t) => s + (t.progress || 0) * (t.weight || 1), 0) / tw);
  run('UPDATE projects SET progress=? WHERE id=?', pct, project_id);
  return pct;
}

function saveTask(user, d) {
  const cols = ['project_id','name','trade','zone','phase','assignee','exec',
                'progress','status','sdate','ddate','weight'];
  const vals = cols.map(k => d[k] === undefined ? null : d[k]);
  let id;
  if (d.id) { run(`UPDATE tasks SET ${cols.map(k => k + '=?').join(',')} WHERE id=?`, ...vals, d.id); id = d.id; }
  else { id = Number(run(`INSERT INTO tasks(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals).lastInsertRowid); }
  const pid = d.project_id || get1('SELECT project_id FROM tasks WHERE id=?', id).project_id;
  return { id, progress: rollupProgress(pid) };
}

/* ═══════════ DAILY SITE REPORT ═══════════ */
function saveDaily(user, d) {
  if (!d.project_id) throw new Error('حدّد المشروع');
  const exists = get1('SELECT id FROM dailyreports WHERE project_id=? AND rdate=?',
                      d.project_id, d.rdate || today());
  const cols = ['project_id','rdate','elec_men','mech_men','plum_men','other_men',
                'elec_pct','mech_pct','plum_pct','work','issue','weather','temp','created_by'];
  const vals = [d.project_id, d.rdate || today(), +d.elec_men || 0, +d.mech_men || 0,
    +d.plum_men || 0, +d.other_men || 0, +d.elec_pct || 0, +d.mech_pct || 0, +d.plum_pct || 0,
    d.work || null, d.issue || null, d.weather || null, +d.temp || null, user.id];
  if (exists) {
    run(`UPDATE dailyreports SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`, ...vals, exists.id);
    return { id: exists.id, updated: true };
  }
  return { id: Number(run(`INSERT INTO dailyreports(${cols.join(',')})
    VALUES(${cols.map(() => '?').join(',')})`, ...vals).lastInsertRowid), updated: false };
}

function dailyStats(project_id, days) {
  const n = days || 30;
  const rows = q(`SELECT * FROM dailyreports WHERE project_id=? ORDER BY rdate DESC LIMIT ?`, project_id, n);
  const workdays = rows.length;
  const manhours = rows.reduce((s, r) => s + (r.elec_men + r.mech_men + r.plum_men + r.other_men) * 8, 0);
  const withIssues = rows.filter(r => r.issue && r.issue.trim()).length;
  return { rows, workdays, manhours, withIssues,
           compliance: n ? R2(workdays / n * 100) : 0 };
}

module.exports = {
  receiveAtCost, costAt, availableAt, transfer,
  createMR, mrDetail, approveMR, fulfilMR,
  createQuote, quoteTotals, quoteDetail, sendQuote, winQuote, quoteToInvoice,
  saveOpp, pipeline, rollupProgress, saveTask, saveDaily, dailyStats
};
