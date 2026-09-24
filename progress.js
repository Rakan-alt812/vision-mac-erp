'use strict';
/* ═══════════════════════════════════════════════════════════════
   المستخلصات · المحتجزات · أوامر التغيير · مقاولو الباطن
   ───────────────────────────────────────────────────────────────
   هذا ما يميّز نظام المقاولات عن نظام المحاسبة العادي: العمل
   يُقاس دورياً بالكميات المنفّذة، لا بالفاتورة الواحدة، ويُحتجز
   جزء من كل دفعة ضماناً حتى التسليم النهائي.
   ═══════════════════════════════════════════════════════════════ */
const { db, q, get1, run } = require('./db');
const L = require('./ledger');

const R2 = L.R2;
const today = () => new Date().toISOString().slice(0, 10);
const S = k => (get1('SELECT v FROM settings WHERE k=?', k) || {}).v;
const num = v => Number(v) || 0;

const revAcct = t => ({ 'كهرباء': '4110', 'ميكانيكا': '4120', 'سباكة': '4130' }[t] || '4190');

function nextSeq(table, col, id) {
  return num(get1(`SELECT COALESCE(MAX(seq),0) s FROM ${table} WHERE ${col}=?`, id).s) + 1;
}
function code(prefix, n) { return prefix + String(n).padStart(4, '0'); }

/* ═══════════════ العقد وبنوده ═══════════════ */

/* ينشئ عقداً للمشروع. البنود إما تُمرَّر مباشرة أو تُستورد من عرض سعر معتمد. */
function saveContract(user, d) {
  const p = get1('SELECT * FROM projects WHERE id=?', d.project_id);
  if (!p) throw new Error('المشروع غير موجود');

  const cur = get1('SELECT * FROM contracts WHERE project_id=?', p.id);

  /* تحديث جزئي: الحقل غير المُرسل يحتفظ بقيمته. بدون هذا كان حفظ بنود
     العقد وحدها يصفّر نسبة استرداد الدفعة المقدمة فلا تُسترد أبداً. */
  const keep = (sent, old, dflt) => sent == null ? (cur ? old : dflt) : num(sent);
  const retention = keep(d.retention_pct, cur && cur.retention_pct,
                         parseFloat(S('retention_pct') || '0.05'));
  if (retention < 0 || retention > 0.5) throw new Error('نسبة المحتجزات بين 0 و 50٪');
  const advPct = keep(d.advance_pct, cur && cur.advance_pct, 0);
  if (advPct < 0 || advPct > 0.5) throw new Error('نسبة الدفعة المقدمة بين 0 و 50٪');
  const recPct = keep(d.advance_recovery_pct, cur && cur.advance_recovery_pct, advPct);
  if (recPct < 0 || recPct > 1) throw new Error('نسبة استرداد الدفعة بين 0 و 100٪');
  const cap = keep(d.retention_cap, cur && cur.retention_cap, 0);
  const vatRate = keep(d.vat_rate, cur && cur.vat_rate, parseFloat(S('vat_rate') || '0.15'));

  let cid = cur ? cur.id : null;

  if (cid) {
    run(`UPDATE contracts SET retention_pct=?, retention_cap=?, advance_pct=?,
         advance_recovery_pct=?, vat_rate=?, sdate=?, ddate=?, notes=? WHERE id=?`,
        retention, cap, advPct, recPct, vatRate,
        d.sdate || cur.sdate || p.sdate, d.ddate || cur.ddate || p.ddate,
        d.notes == null ? cur.notes : d.notes, cid);
  } else {
    const info = run(`INSERT INTO contracts(project_id,retention_pct,retention_cap,advance_pct,
      advance_amount,advance_recovery_pct,original_value,vat_rate,sdate,ddate,notes)
      VALUES(?,?,?,?,0,?,?,?,?,?,?)`,
      p.id, retention, cap, advPct, recPct,
      num(p.value), vatRate, d.sdate || p.sdate, d.ddate || p.ddate, d.notes || null);
    cid = Number(info.lastInsertRowid);
  }

  /* البنود: إمّا مُمرَّرة، أو مستوردة من عرض سعر */
  let items = d.items;
  if (!items && d.quote_id) {
    items = q('SELECT * FROM qlines WHERE quote_id=? ORDER BY sort, id', d.quote_id)
      .map(l => ({ item: l.item, descr: l.descr, trade: l.trade, unit: l.unit,
                   qty: l.qty, price: l.price }));
  }
  if (Array.isArray(items) && items.length) {
    if (get1('SELECT COUNT(*) c FROM ipcs WHERE contract_id=? AND status<>\'مسودة\'', cid).c > 0)
      throw new Error('لا يمكن تغيير بنود العقد بعد اعتماد مستخلص — استخدم أمر تغيير');
    run('DELETE FROM citems WHERE contract_id=? AND vo_id IS NULL', cid);
    const ins = db.prepare(`INSERT INTO citems(contract_id,item,descr,trade,unit,qty,price,sort)
      VALUES(?,?,?,?,?,?,?,?)`);
    items.forEach((l, i) => ins.run(cid, l.item || String(i + 1), l.descr || 'بند',
      l.trade || p.trade, l.unit || 'مقطوعية', num(l.qty), num(l.price), i));
  }

  syncContractValue(cid);
  return { id: cid };
}

/* قيمة العقد = مجموع البنود (الأصلية + بنود أوامر التغيير المعتمدة) */
function syncContractValue(contract_id) {
  const c = get1('SELECT * FROM contracts WHERE id=?', contract_id);
  if (!c) return 0;
  const total = R2(num(get1(`SELECT COALESCE(SUM(qty*price),0) t FROM citems WHERE contract_id=?`, contract_id).t));
  const orig = R2(num(get1(`SELECT COALESCE(SUM(qty*price),0) t FROM citems
    WHERE contract_id=? AND vo_id IS NULL`, contract_id).t));
  run('UPDATE contracts SET original_value=? WHERE id=?', orig, contract_id);
  run('UPDATE projects SET value=? WHERE id=?', total, c.project_id);
  return total;
}

function contractDetail(project_id) {
  const c = get1(`SELECT c.*, p.code project_code, p.name project, p.trade, p.status project_status,
      pa.name customer, pa.id customer_id
    FROM contracts c JOIN projects p ON p.id=c.project_id
    LEFT JOIN partners pa ON pa.id=p.customer_id WHERE c.project_id=?`, project_id);
  if (!c) return null;

  const items = q(`SELECT ci.*, v.code vo_code FROM citems ci
    LEFT JOIN vos v ON v.id=ci.vo_id WHERE ci.contract_id=? ORDER BY ci.sort, ci.id`, c.id)
    .map(i => {
      const done = R2(num(get1(`SELECT COALESCE(SUM(il.qty_this),0) s FROM ipclines il
        JOIN ipcs ip ON ip.id=il.ipc_id WHERE il.citem_id=? AND ip.status='معتمد'`, i.id).s));
      return { ...i, amount: R2(i.qty * i.price), qty_done: done,
               amount_done: R2(done * i.price),
               pct: i.qty ? R2(done / i.qty * 100) : 0,
               qty_left: R2(i.qty - done) };
    });

  const value = R2(items.reduce((s, i) => s + i.amount, 0));
  const certified = R2(items.reduce((s, i) => s + i.amount_done, 0));
  const held = R2(num(get1(`SELECT COALESCE(SUM(retention),0) s FROM ipcs
    WHERE contract_id=? AND status='معتمد'`, c.id).s));
  const released = R2(num(get1(`SELECT COALESCE(SUM(amount),0) s FROM retreleases
    WHERE kind='customer' AND project_id=?`, c.project_id).s));

  return { ...c, items, value, certified,
    remaining_work: R2(value - certified),
    pct_complete: value ? R2(certified / value * 100) : 0,
    retention_held: held, retention_released: released,
    retention_outstanding: R2(held - released),
    advance_outstanding: R2(c.advance_amount - c.advance_recovered),
    ipcs: q(`SELECT id,code,seq,from_date,to_date,status,period_gross,retention,
      advance_deduct,net,vat,total,approved_at FROM ipcs WHERE contract_id=? ORDER BY seq`, c.id),
    vos: q(`SELECT id,code,vdate,descr,amount,status FROM vos WHERE contract_id=? ORDER BY id`, c.id) };
}

/* ═══════════════ الدفعة المقدمة ═══════════════ */

function receiveAdvance(user, d) {
  const c = get1('SELECT * FROM contracts WHERE id=?', d.contract_id);
  if (!c) throw new Error('العقد غير موجود');
  const amt = R2(d.amount);
  if (amt <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
  const p = get1('SELECT * FROM projects WHERE id=?', c.project_id);
  const vat = R2(amt * c.vat_rate);

  const jid = L.post({ ref: 'ADV-' + p.code, date: d.pdate || today(),
    memo: 'دفعة مقدمة — ' + p.name, src_type: 'advance', src_id: c.id, user_id: user.id,
    lines: [
      { account: '1100', debit: R2(amt + vat), credit: 0, project_id: p.id, partner_id: p.customer_id },
      { account: '2600', debit: 0, credit: amt, project_id: p.id, partner_id: p.customer_id, memo: 'دفعة مقدمة' },
      { account: '2200', debit: 0, credit: vat, partner_id: p.customer_id, memo: 'ضريبة مخرجات' },
    ] });
  run('UPDATE contracts SET advance_amount=advance_amount+? WHERE id=?', amt, c.id);
  run(`INSERT INTO payments(code,kind,partner_id,pdate,amount,method,ref,journal_id,created_by)
       VALUES(?,'قبض',?,?,?,?,?,?,?)`,
      code('PAY-ADV-', c.id), p.customer_id, d.pdate || today(), R2(amt + vat),
      d.method || 'تحويل بنكي', 'دفعة مقدمة ' + p.code, jid, user.id);
  return { journal_id: jid, amount: amt, vat, total: R2(amt + vat) };
}

/* ═══════════════ المستخلص ═══════════════ */

/* يبني مسودة مستخلص: لكل بند، الكمية المنفّذة سابقاً محسوبة آلياً
   والكمية الحالية يُدخلها المهندس. */
function ipcDraft(contract_id) {
  const c = get1('SELECT * FROM contracts WHERE id=?', contract_id);
  if (!c) throw new Error('العقد غير موجود');
  const items = q('SELECT * FROM citems WHERE contract_id=? ORDER BY sort, id', contract_id);
  return items.map(i => {
    const prev = R2(num(get1(`SELECT COALESCE(SUM(il.qty_this),0) s FROM ipclines il
      JOIN ipcs ip ON ip.id=il.ipc_id WHERE il.citem_id=? AND ip.status IN ('معتمد','مُقدَّم')`, i.id).s));
    return { citem_id: i.id, item: i.item, descr: i.descr, unit: i.unit,
             qty_total: i.qty, qty_prev: prev, qty_left: R2(i.qty - prev),
             price: i.price, qty_this: 0 };
  });
}

function createIPC(user, d) {
  const c = get1('SELECT * FROM contracts WHERE id=?', d.contract_id);
  if (!c) throw new Error('العقد غير موجود');
  if (c.status !== 'ساري') throw new Error('العقد غير ساري');
  if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('المستخلص يحتاج بنداً واحداً على الأقل');

  const open = get1(`SELECT code FROM ipcs WHERE contract_id=? AND status IN ('مسودة','مُقدَّم')`, c.id);
  if (open) throw new Error('يوجد مستخلص مفتوح (' + open.code + ') — اعتمده أو ألغه أولاً');

  /* كل البنود تُفحص قبل كتابة أي سطر — وإلا بقي مستخلص ناقص في القاعدة
     عند رفض بند في منتصف الحلقة، فيمنع إنشاء أي مستخلص لاحق. */
  const ready = [];
  d.lines.forEach(l => {
    const ci = get1('SELECT * FROM citems WHERE id=? AND contract_id=?', l.citem_id, c.id);
    if (!ci) throw new Error('بند غير موجود في العقد: ' + l.citem_id);
    const qthis = num(l.qty_this);
    if (qthis < 0) throw new Error('الكمية لا تكون سالبة: ' + ci.descr);
    const prev = R2(num(get1(`SELECT COALESCE(SUM(il.qty_this),0) s FROM ipclines il
      JOIN ipcs ip ON ip.id=il.ipc_id WHERE il.citem_id=? AND ip.status='معتمد'`, ci.id).s));
    if (R2(prev + qthis) > R2(ci.qty) + 0.001)
      throw new Error(`«${ci.descr}»: الكمية التراكمية ${R2(prev + qthis)} تتجاوز كمية العقد ${ci.qty} — يلزم أمر تغيير`);
    if (qthis > 0) ready.push({ ci, qthis, prev });
  });
  if (!ready.length) throw new Error('المستخلص بلا كميات — أدخل كمية واحدة على الأقل');

  const seq = nextSeq('ipcs', 'contract_id', c.id);
  const p = get1('SELECT * FROM projects WHERE id=?', c.project_id);
  const ipcCode = p.code + '-IPC-' + String(seq).padStart(2, '0');

  const info = run(`INSERT INTO ipcs(code,contract_id,project_id,seq,from_date,to_date,status,
    other_deduct,submitted_by,notes) VALUES(?,?,?,?,?,?,'مسودة',?,?,?)`,
    ipcCode, c.id, c.project_id, seq, d.from_date || null, d.to_date || today(),
    num(d.other_deduct), user.id, d.notes || null);
  const id = Number(info.lastInsertRowid);

  const ins = db.prepare(`INSERT INTO ipclines(ipc_id,citem_id,descr,unit,qty_total,qty_prev,
    qty_this,price,amount) VALUES(?,?,?,?,?,?,?,?,?)`);
  ready.forEach(({ ci, qthis, prev }) =>
    ins.run(id, ci.id, ci.descr, ci.unit, ci.qty, prev, qthis, ci.price, R2(qthis * ci.price)));

  recalcIPC(id);
  return id;
}

/* الحساب المالي للمستخلص — هذا قلب الوحدة */
function recalcIPC(id) {
  const ipc = get1('SELECT * FROM ipcs WHERE id=?', id);
  if (!ipc) throw new Error('المستخلص غير موجود');
  const c = get1('SELECT * FROM contracts WHERE id=?', ipc.contract_id);

  const periodGross = R2(num(get1('SELECT COALESCE(SUM(amount),0) s FROM ipclines WHERE ipc_id=?', id).s));
  const prevGross = R2(num(get1(`SELECT COALESCE(SUM(period_gross),0) s FROM ipcs
    WHERE contract_id=? AND status='معتمد' AND id<>?`, c.id, id).s));
  const gross = R2(prevGross + periodGross);

  /* المحتجزات: نسبة من قيمة هذه الفترة، بسقف تراكمي إن وُجد */
  let retention = R2(periodGross * c.retention_pct);
  if (c.retention_cap > 0) {
    const heldBefore = R2(num(get1(`SELECT COALESCE(SUM(retention),0) s FROM ipcs
      WHERE contract_id=? AND status='معتمد' AND id<>?`, c.id, id).s));
    retention = R2(Math.max(0, Math.min(retention, c.retention_cap - heldBefore)));
  }

  /* استرداد الدفعة المقدمة: نسبة من قيمة الفترة، بحد المتبقي */
  const advLeft = R2(c.advance_amount - c.advance_recovered);
  let advance = R2(periodGross * (c.advance_recovery_pct || 0));
  advance = R2(Math.max(0, Math.min(advance, advLeft)));

  const other = R2(ipc.other_deduct);
  const net = R2(periodGross - retention - advance - other);
  /* الوعاء الضريبي: قيمة الأعمال ناقص استرداد الدفعة المقدمة (ضريبتها حُصّلت عند قبضها) */
  const vat = R2((periodGross - advance) * c.vat_rate);
  const total = R2(net + vat);

  run(`UPDATE ipcs SET gross=?, prev_gross=?, period_gross=?, retention=?,
       advance_deduct=?, net=?, vat=?, total=? WHERE id=?`,
      gross, prevGross, periodGross, retention, advance, net, vat, total, id);
  return { gross, prev_gross: prevGross, period_gross: periodGross, retention,
           advance_deduct: advance, other_deduct: other, net, vat, total };
}

function ipcDetail(id) {
  const ipc = get1(`SELECT i.*, p.code project_code, p.name project, p.trade,
      pa.name customer, pa.id customer_id, u.name submitter, a.name approver
    FROM ipcs i JOIN projects p ON p.id=i.project_id
    LEFT JOIN partners pa ON pa.id=p.customer_id
    LEFT JOIN users u ON u.id=i.submitted_by
    LEFT JOIN users a ON a.id=i.approved_by WHERE i.id=?`, id);
  if (!ipc) throw new Error('المستخلص غير موجود');
  const c = get1('SELECT * FROM contracts WHERE id=?', ipc.contract_id);
  return { ...ipc, contract: c,
    lines: q(`SELECT il.*, ci.item FROM ipclines il
      LEFT JOIN citems ci ON ci.id=il.citem_id WHERE il.ipc_id=? ORDER BY ci.sort, il.id`, id)
      .map(l => ({ ...l, qty_cum: R2(l.qty_prev + l.qty_this),
                   pct_cum: l.qty_total ? R2((l.qty_prev + l.qty_this) / l.qty_total * 100) : 0 })) };
}

function submitIPC(user, id) {
  const ipc = get1('SELECT * FROM ipcs WHERE id=?', id);
  if (!ipc) throw new Error('المستخلص غير موجود');
  if (ipc.status !== 'مسودة') throw new Error('المستخلص ليس مسودة');
  const t = recalcIPC(id);
  if (t.period_gross <= 0) throw new Error('قيمة المستخلص صفر');
  run(`INSERT INTO approvals(doc_type,doc_id,amount,requested_by,requested_at,status)
       VALUES('ipc',?,?,?,?,'معلق')`, id, t.total, user.id, new Date().toISOString());
  run("UPDATE ipcs SET status='مُقدَّم', submitted_by=?, submitted_at=? WHERE id=?",
      user.id, new Date().toISOString(), id);
  return { ...t, status: 'مُقدَّم' };
}

/* الاعتماد يُرحّل القيد ويحدّث المحتجزات والدفعة المقدمة ونسبة إنجاز المشروع */
function approveIPC(user, id, ok, note) {
  const ipc = get1('SELECT * FROM ipcs WHERE id=?', id);
  if (!ipc) throw new Error('المستخلص غير موجود');
  if (ipc.status !== 'مُقدَّم') throw new Error('المستخلص ليس بانتظار الاعتماد');

  run(`UPDATE approvals SET status=?, decided_by=?, decided_at=?, note=?
       WHERE doc_type='ipc' AND doc_id=? AND status='معلق'`,
      ok ? 'معتمد' : 'مرفوض', user.id, new Date().toISOString(), note || null, id);

  if (!ok) {
    run("UPDATE ipcs SET status='مرفوض', approved_by=?, approved_at=? WHERE id=?",
        user.id, new Date().toISOString(), id);
    return { ok: false };
  }

  const t = recalcIPC(id);
  const c = get1('SELECT * FROM contracts WHERE id=?', ipc.contract_id);
  const p = get1('SELECT * FROM projects WHERE id=?', ipc.project_id);
  const acct = revAcct(p.trade);

  const lines = [
    { account: '1200', debit: t.total, credit: 0, project_id: p.id,
      partner_id: p.customer_id, memo: 'مستخلص ' + ipc.code },
    { account: acct, debit: 0, credit: t.period_gross, project_id: p.id,
      partner_id: p.customer_id, memo: 'أعمال منفّذة ' + ipc.code },
  ];
  if (t.retention > 0) lines.push({ account: '1250', debit: t.retention, credit: 0,
    project_id: p.id, partner_id: p.customer_id, memo: 'محتجزات ' + ipc.code });
  if (t.advance_deduct > 0) lines.push({ account: '2600', debit: t.advance_deduct, credit: 0,
    project_id: p.id, partner_id: p.customer_id, memo: 'استرداد دفعة مقدمة' });
  if (t.other_deduct > 0) lines.push({ account: '5500', debit: t.other_deduct, credit: 0,
    project_id: p.id, memo: 'خصومات أخرى ' + ipc.code });
  if (t.vat > 0) lines.push({ account: '2200', debit: 0, credit: t.vat,
    partner_id: p.customer_id, memo: 'ضريبة مخرجات' });

  const jid = L.post({ ref: ipc.code, date: ipc.to_date || today(),
    memo: 'مستخلص ' + ipc.code + ' — ' + p.name,
    src_type: 'ipc', src_id: id, user_id: user.id, lines });

  run("UPDATE ipcs SET status='معتمد', journal_id=?, approved_by=?, approved_at=? WHERE id=?",
      jid, user.id, new Date().toISOString(), id);
  if (t.advance_deduct > 0)
    run('UPDATE contracts SET advance_recovered=advance_recovered+? WHERE id=?', t.advance_deduct, c.id);
  run('UPDATE projects SET retention_held=retention_held+? WHERE id=?', t.retention, p.id);

  /* نسبة الإنجاز المالية تُشتق من الكميات المعتمدة */
  const val = R2(num(get1('SELECT COALESCE(SUM(qty*price),0) t FROM citems WHERE contract_id=?', c.id).t));
  if (val > 0) run('UPDATE projects SET progress=? WHERE id=?',
    Math.min(100, Math.round(R2(ipc.prev_gross + t.period_gross) / val * 100)), p.id);

  return { journal_id: jid, ...t };
}

/* ═══════════════ أوامر التغيير ═══════════════ */

function createVO(user, d) {
  const c = get1('SELECT * FROM contracts WHERE id=?', d.contract_id);
  if (!c) throw new Error('العقد غير موجود');
  if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('أمر التغيير يحتاج بنداً واحداً');
  const p = get1('SELECT * FROM projects WHERE id=?', c.project_id);
  const n = num(get1('SELECT COUNT(*) c FROM vos WHERE contract_id=?', c.id).c) + 1;
  const voCode = p.code + '-VO-' + String(n).padStart(2, '0');

  const amount = R2(d.lines.reduce((s, l) => s + num(l.qty) * num(l.price), 0));
  const info = run(`INSERT INTO vos(code,contract_id,project_id,vdate,descr,reason,amount,
    status,requested_by,note) VALUES(?,?,?,?,?,?,?,'مسودة',?,?)`,
    voCode, c.id, c.project_id, d.vdate || today(), d.descr || 'أمر تغيير',
    d.reason || null, amount, user.id, d.note || null);
  const id = Number(info.lastInsertRowid);
  const ins = db.prepare('INSERT INTO volines(vo_id,item,descr,trade,unit,qty,price) VALUES(?,?,?,?,?,?,?)');
  d.lines.forEach((l, i) => ins.run(id, l.item || 'VO' + n + '-' + (i + 1),
    l.descr || 'بند', l.trade || p.trade, l.unit || 'مقطوعية', num(l.qty), num(l.price)));
  return { id, code: voCode, amount };
}

/* الاعتماد يُدخل بنود أمر التغيير في العقد فتتغيّر قيمته — وهذا ما يجعل
   المستخلصات اللاحقة تعترف بالأعمال الإضافية. */
function approveVO(user, id, ok, note) {
  const vo = get1('SELECT * FROM vos WHERE id=?', id);
  if (!vo) throw new Error('أمر التغيير غير موجود');
  if (vo.status !== 'مسودة' && vo.status !== 'مُقدَّم')
    throw new Error('أمر التغيير محسوم مسبقاً');

  if (!ok) {
    run("UPDATE vos SET status='مرفوض', approved_by=?, approved_at=?, note=? WHERE id=?",
        user.id, new Date().toISOString(), note || null, id);
    return { ok: false };
  }

  const lines = q('SELECT * FROM volines WHERE vo_id=?', id);
  const maxSort = num(get1('SELECT COALESCE(MAX(sort),0) s FROM citems WHERE contract_id=?', vo.contract_id).s);
  const ins = db.prepare(`INSERT INTO citems(contract_id,vo_id,item,descr,trade,unit,qty,price,sort)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  lines.forEach((l, i) => ins.run(vo.contract_id, id, l.item, l.descr, l.trade, l.unit,
    l.qty, l.price, maxSort + i + 1));

  run("UPDATE vos SET status='معتمد', approved_by=?, approved_at=?, note=? WHERE id=?",
      user.id, new Date().toISOString(), note || null, id);
  const value = syncContractValue(vo.contract_id);
  return { ok: true, amount: vo.amount, new_contract_value: value };
}

/* ═══════════════ شهادات مقاولي الباطن ═══════════════ */

function createSubcert(user, d) {
  const v = get1("SELECT * FROM partners WHERE id=? AND kind='vendor'", d.vendor_id);
  if (!v) throw new Error('المقاول غير موجود');
  const p = get1('SELECT * FROM projects WHERE id=?', d.project_id);
  if (!p) throw new Error('المشروع غير موجود');
  if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('الشهادة تحتاج بنداً واحداً');

  const seq = num(get1(`SELECT COALESCE(MAX(seq),0) s FROM subcerts
    WHERE project_id=? AND vendor_id=?`, p.id, v.id).s) + 1;
  const scCode = p.code + '-SC' + String(v.id).padStart(2, '0') + '-' + String(seq).padStart(2, '0');

  const retPct = d.retention_pct == null
    ? parseFloat(S('sub_retention_pct') || '0.05') : num(d.retention_pct);
  if (retPct < 0 || retPct > 0.5) throw new Error('نسبة المحتجزات بين 0 و 50٪');

  const info = run(`INSERT INTO subcerts(code,project_id,vendor_id,seq,from_date,to_date,
    retention_pct,other_deduct,advance_deduct,status,submitted_by,notes)
    VALUES(?,?,?,?,?,?,?,?,?,'مسودة',?,?)`,
    scCode, p.id, v.id, seq, d.from_date || null, d.to_date || today(),
    retPct, num(d.other_deduct), num(d.advance_deduct), user.id, d.notes || null);
  const id = Number(info.lastInsertRowid);

  const ins = db.prepare(`INSERT INTO subcertlines(subcert_id,descr,unit,qty,price,amount)
    VALUES(?,?,?,?,?,?)`);
  d.lines.forEach(l => ins.run(id, l.descr || 'بند', l.unit || 'مقطوعية',
    num(l.qty), num(l.price), R2(num(l.qty) * num(l.price))));

  recalcSubcert(id);
  return id;
}

function recalcSubcert(id) {
  const sc = get1('SELECT * FROM subcerts WHERE id=?', id);
  if (!sc) throw new Error('الشهادة غير موجودة');
  const vatRate = parseFloat(S('vat_rate') || '0.15');

  const periodGross = R2(num(get1('SELECT COALESCE(SUM(amount),0) s FROM subcertlines WHERE subcert_id=?', id).s));
  const prevGross = R2(num(get1(`SELECT COALESCE(SUM(period_gross),0) s FROM subcerts
    WHERE project_id=? AND vendor_id=? AND status='معتمد' AND id<>?`, sc.project_id, sc.vendor_id, id).s));

  const retention = R2(periodGross * sc.retention_pct);
  const advance = R2(Math.min(num(sc.advance_deduct), periodGross - retention));
  const other = R2(sc.other_deduct);
  const net = R2(periodGross - retention - advance - other);
  const vat = R2((periodGross - advance) * vatRate);
  const total = R2(net + vat);

  run(`UPDATE subcerts SET gross=?, prev_gross=?, period_gross=?, retention=?,
       advance_deduct=?, net=?, vat=?, total=? WHERE id=?`,
      R2(prevGross + periodGross), prevGross, periodGross, retention, advance, net, vat, total, id);
  return { period_gross: periodGross, retention, advance_deduct: advance,
           other_deduct: other, net, vat, total };
}

function approveSubcert(user, id, ok, note) {
  const sc = get1('SELECT * FROM subcerts WHERE id=?', id);
  if (!sc) throw new Error('الشهادة غير موجودة');
  if (sc.status === 'معتمد') throw new Error('الشهادة معتمدة مسبقاً');

  if (!ok) {
    run("UPDATE subcerts SET status='مرفوض', approved_by=?, approved_at=?, notes=? WHERE id=?",
        user.id, new Date().toISOString(), note || null, id);
    return { ok: false };
  }

  const t = recalcSubcert(id);
  if (t.period_gross <= 0) throw new Error('قيمة الشهادة صفر');
  const p = get1('SELECT * FROM projects WHERE id=?', sc.project_id);

  const lines = [
    { account: '5300', debit: t.period_gross, credit: 0, project_id: p.id,
      partner_id: sc.vendor_id, memo: 'أعمال مقاول باطن ' + sc.code },
    { account: '2100', debit: 0, credit: t.total, project_id: p.id,
      partner_id: sc.vendor_id, memo: 'مستحق ' + sc.code },
  ];
  if (t.vat > 0) lines.push({ account: '1400', debit: t.vat, credit: 0,
    partner_id: sc.vendor_id, memo: 'ضريبة مدخلات' });
  if (t.retention > 0) lines.push({ account: '2150', debit: 0, credit: t.retention,
    project_id: p.id, partner_id: sc.vendor_id, memo: 'محتجزات ' + sc.code });
  if (t.advance_deduct > 0) lines.push({ account: '1280', debit: 0, credit: t.advance_deduct,
    partner_id: sc.vendor_id, memo: 'استرداد دفعة مقدمة' });
  if (t.other_deduct > 0) lines.push({ account: '4200', debit: 0, credit: t.other_deduct,
    project_id: p.id, partner_id: sc.vendor_id, memo: 'خصومات على المقاول' });

  const jid = L.post({ ref: sc.code, date: sc.to_date || today(),
    memo: 'شهادة دفع مقاول باطن ' + sc.code, src_type: 'subcert', src_id: id,
    user_id: user.id, lines });

  run("UPDATE subcerts SET status='معتمد', journal_id=?, approved_by=?, approved_at=? WHERE id=?",
      jid, user.id, new Date().toISOString(), id);
  return { journal_id: jid, ...t };
}

function subcertDetail(id) {
  const sc = get1(`SELECT s.*, p.code project_code, p.name project, v.name vendor,
      u.name approver FROM subcerts s JOIN projects p ON p.id=s.project_id
    JOIN partners v ON v.id=s.vendor_id LEFT JOIN users u ON u.id=s.approved_by
    WHERE s.id=?`, id);
  if (!sc) throw new Error('الشهادة غير موجودة');
  return { ...sc, lines: q('SELECT * FROM subcertlines WHERE subcert_id=? ORDER BY id', id) };
}

/* ═══════════════ إفراج المحتجزات ═══════════════ */

function releaseRetention(user, d) {
  const amt = R2(d.amount);
  if (amt <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
  const p = get1('SELECT * FROM projects WHERE id=?', d.project_id);
  if (!p) throw new Error('المشروع غير موجود');
  const isCust = d.kind === 'customer';

  const out = isCust ? customerRetention(p.id) : vendorRetention(p.id, d.partner_id);
  if (amt > out.outstanding + 0.01)
    throw new Error(`المحتجزات المتبقية ${out.outstanding} فقط`);

  const lines = isCust
    ? [{ account: '1100', debit: amt, credit: 0, project_id: p.id, partner_id: p.customer_id },
       { account: '1250', debit: 0, credit: amt, project_id: p.id, partner_id: p.customer_id }]
    : [{ account: '2150', debit: amt, credit: 0, project_id: p.id, partner_id: d.partner_id },
       { account: '1100', debit: 0, credit: amt, project_id: p.id, partner_id: d.partner_id }];

  const jid = L.post({ ref: 'RET-' + p.code, date: d.rdate || today(),
    memo: (isCust ? 'إفراج محتجزات من العميل — ' : 'إفراج محتجزات لمقاول الباطن — ') + p.name,
    src_type: 'retention', src_id: p.id, user_id: user.id, lines });

  run(`INSERT INTO retreleases(kind,project_id,partner_id,rdate,amount,journal_id,note,created_by)
       VALUES(?,?,?,?,?,?,?,?)`, isCust ? 'customer' : 'subcontractor', p.id,
      isCust ? p.customer_id : d.partner_id, d.rdate || today(), amt, jid, d.note || null, user.id);
  if (isCust) run('UPDATE projects SET retention_held=retention_held-? WHERE id=?', amt, p.id);
  return { journal_id: jid, amount: amt, remaining: R2(out.outstanding - amt) };
}

function customerRetention(project_id) {
  const held = R2(num(get1(`SELECT COALESCE(SUM(retention),0) s FROM ipcs
    WHERE project_id=? AND status='معتمد'`, project_id).s));
  const rel = R2(num(get1(`SELECT COALESCE(SUM(amount),0) s FROM retreleases
    WHERE kind='customer' AND project_id=?`, project_id).s));
  return { held, released: rel, outstanding: R2(held - rel) };
}

function vendorRetention(project_id, vendor_id) {
  const held = R2(num(get1(`SELECT COALESCE(SUM(retention),0) s FROM subcerts
    WHERE project_id=? AND vendor_id=? AND status='معتمد'`, project_id, vendor_id).s));
  const rel = R2(num(get1(`SELECT COALESCE(SUM(amount),0) s FROM retreleases
    WHERE kind='subcontractor' AND project_id=? AND partner_id=?`, project_id, vendor_id).s));
  return { held, released: rel, outstanding: R2(held - rel) };
}

/* لوحة المحتجزات — ما لنا وما علينا */
function retentionBoard() {
  const customers = q(`SELECT p.id project_id, p.code, p.name project, p.status,
      pa.name customer, pa.id partner_id,
      COALESCE((SELECT SUM(retention) FROM ipcs WHERE project_id=p.id AND status='معتمد'),0) held,
      COALESCE((SELECT SUM(amount) FROM retreleases WHERE kind='customer' AND project_id=p.id),0) released
    FROM projects p LEFT JOIN partners pa ON pa.id=p.customer_id`)
    .map(r => ({ ...r, held: R2(r.held), released: R2(r.released),
                 outstanding: R2(r.held - r.released) }))
    .filter(r => r.outstanding > 0.01);

  const vendors = q(`SELECT s.project_id, p.code, p.name project, s.vendor_id partner_id,
      v.name vendor,
      COALESCE(SUM(CASE WHEN s.status='معتمد' THEN s.retention ELSE 0 END),0) held,
      COALESCE((SELECT SUM(amount) FROM retreleases r WHERE r.kind='subcontractor'
        AND r.project_id=s.project_id AND r.partner_id=s.vendor_id),0) released
    FROM subcerts s JOIN projects p ON p.id=s.project_id JOIN partners v ON v.id=s.vendor_id
    GROUP BY s.project_id, s.vendor_id`)
    .map(r => ({ ...r, held: R2(r.held), released: R2(r.released),
                 outstanding: R2(r.held - r.released) }))
    .filter(r => r.outstanding > 0.01);

  return { customers, vendors,
    total_receivable: R2(customers.reduce((s, r) => s + r.outstanding, 0)),
    total_payable: R2(vendors.reduce((s, r) => s + r.outstanding, 0)),
    ledger_1250: L.balanceOf('1250'), ledger_2150: L.balanceOf('2150') };
}

/* ملخص تنفيذي للمشروع: العقد · المنفّذ · المفوتر · المحصّل · المحتجز */
function projectStatus(project_id) {
  const c = contractDetail(project_id);
  if (!c) return null;
  const pl = L.projectPL(project_id);
  const billed = R2(num(get1(`SELECT COALESCE(SUM(total),0) s FROM ipcs
    WHERE project_id=? AND status='معتمد'`, project_id).s));
  const subs = R2(num(get1(`SELECT COALESCE(SUM(period_gross),0) s FROM subcerts
    WHERE project_id=? AND status='معتمد'`, project_id).s));
  return {
    contract_value: c.value, original_value: c.original_value,
    variations: R2(c.value - c.original_value),
    certified: c.certified, pct_complete: c.pct_complete,
    billed_total: billed, retention: c.retention_outstanding,
    advance_outstanding: c.advance_outstanding,
    subcontract_cost: subs, total_cost: pl ? pl.cost : 0,
    revenue: pl ? pl.revenue : 0, profit: pl ? pl.profit : 0,
    margin: pl ? pl.margin : 0,
    cost_vs_progress: pl && c.pct_complete
      ? R2(pl.cost / (c.value * c.pct_complete / 100) * 100) : 0
  };
}

module.exports = {
  saveContract, contractDetail, syncContractValue, receiveAdvance,
  ipcDraft, createIPC, recalcIPC, ipcDetail, submitIPC, approveIPC,
  createVO, approveVO,
  createSubcert, recalcSubcert, approveSubcert, subcertDetail,
  releaseRetention, customerRetention, vendorRetention, retentionBoard, projectStatus,
};
