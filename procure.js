'use strict';
/* ═══════════════════════════════════════════════════════════════
   المشتريات المتقدمة — طلب عروض · مقارنة · مطابقة ثلاثية · تقييم
   ───────────────────────────────────────────────────────────────
   المطابقة الثلاثية هي الضابط الذي يمنع الدفع مقابل بضاعة لم
   تُستلم أو بسعر غير متفق عليه — وهي أهم ما يميّز نظام مشتريات
   حقيقياً عن دفتر أوامر شراء.
   ═══════════════════════════════════════════════════════════════ */
const { db, q, get1, run } = require('./db');
const L = require('./ledger');

const R2 = L.R2;
const today = () => new Date().toISOString().slice(0, 10);
const S = k => (get1('SELECT v FROM settings WHERE k=?', k) || {}).v;
const num = v => Number(v) || 0;
const VAT = () => parseFloat(S('vat_rate') || '0.15');
const nextCode = (table, prefix) =>
  prefix + String(num(get1(`SELECT COUNT(*) c FROM ${table}`).c) + 1).padStart(4, '0');

/* ═══════════════ طلب عروض الأسعار ═══════════════ */

function createRFQ(user, d) {
  if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('طلب العروض يحتاج بنداً واحداً');
  if (!Array.isArray(d.vendors) || d.vendors.length < 2)
    throw new Error('اطلب العرض من موردين اثنين على الأقل — المقارنة هي الغاية');

  d.vendors.forEach(v => {
    if (!get1("SELECT id FROM partners WHERE id=? AND kind='vendor' AND active=1", v))
      throw new Error('مورد غير موجود أو غير نشط: ' + v);
  });

  const code = nextCode('rfqs', 'RFQ-');
  const info = run(`INSERT INTO rfqs(code,project_id,rdate,deadline,descr,status,created_by)
    VALUES(?,?,?,?,?,'مُرسل',?)`, code, d.project_id || null, d.rdate || today(),
    d.deadline || null, d.descr || null, user.id);
  const id = Number(info.lastInsertRowid);

  const il = db.prepare('INSERT INTO rfqlines(rfq_id,material_id,descr,unit,qty,sort) VALUES(?,?,?,?,?,?)');
  d.lines.forEach((l, i) => {
    const m = l.material_id ? get1('SELECT * FROM materials WHERE id=?', l.material_id) : null;
    const qty = num(l.qty);
    if (qty <= 0) throw new Error('الكمية يجب أن تكون أكبر من صفر: ' + (l.descr || ''));
    il.run(id, l.material_id || null, l.descr || (m ? m.name : 'بند'),
      l.unit || (m ? m.unit : 'قطعة'), qty, i);
  });

  const iv = db.prepare(`INSERT INTO rfqvendors(rfq_id,vendor_id,status,sent_at)
    VALUES(?,?,'مُرسل',?)`);
  d.vendors.forEach(v => iv.run(id, v, new Date().toISOString()));
  return { id, code, vendors: d.vendors.length, lines: d.lines.length };
}

/* تسجيل عرض مورد: سعر لكل بند */
function recordQuote(user, d) {
  const rv = get1(`SELECT rv.*, r.status rfq_status FROM rfqvendors rv
    JOIN rfqs r ON r.id=rv.rfq_id WHERE rv.id=?`, d.rfqvendor_id);
  if (!rv) throw new Error('المورد غير مدعو لهذا الطلب');
  if (rv.rfq_status === 'مُرسى') throw new Error('الطلب أُرسي — لا تُقبل عروض جديدة');
  if (!Array.isArray(d.prices) || !d.prices.length) throw new Error('العرض بلا أسعار');

  const lines = q('SELECT * FROM rfqlines WHERE rfq_id=?', rv.rfq_id);
  run('DELETE FROM rfqquotes WHERE rfqvendor_id=?', rv.id);
  const ins = db.prepare('INSERT INTO rfqquotes(rfqvendor_id,rfqline_id,price,note) VALUES(?,?,?,?)');
  let total = 0;
  d.prices.forEach(p => {
    const ln = lines.find(l => l.id === Number(p.rfqline_id));
    if (!ln) throw new Error('بند غير موجود في الطلب: ' + p.rfqline_id);
    const price = num(p.price);
    if (price < 0) throw new Error('السعر لا يكون سالباً');
    ins.run(rv.id, ln.id, price, p.note || null);
    total = R2(total + price * ln.qty);
  });

  run(`UPDATE rfqvendors SET status='مُستلم', replied_at=?, total=?, lead_days=?, terms=?, notes=?
       WHERE id=?`, new Date().toISOString(), total, num(d.lead_days) || null,
      d.terms || null, d.notes || null, rv.id);
  return { rfqvendor_id: rv.id, total };
}

/* المقارنة: مصفوفة الأسعار مع تمييز الأرخص لكل بند */
function compareRFQ(rfq_id) {
  const rfq = get1(`SELECT r.*, p.name project, v.name awarded_name FROM rfqs r
    LEFT JOIN projects p ON p.id=r.project_id
    LEFT JOIN partners v ON v.id=r.awarded_vendor WHERE r.id=?`, rfq_id);
  if (!rfq) throw new Error('طلب العروض غير موجود');

  const lines = q('SELECT * FROM rfqlines WHERE rfq_id=? ORDER BY sort, id', rfq_id);
  const vendors = q(`SELECT rv.*, p.name vendor, p.rating, p.ontime, p.terms vendor_terms
    FROM rfqvendors rv JOIN partners p ON p.id=rv.vendor_id
    WHERE rv.rfq_id=? ORDER BY rv.id`, rfq_id);

  const quotes = {};
  q(`SELECT qq.* FROM rfqquotes qq JOIN rfqvendors rv ON rv.id=qq.rfqvendor_id
     WHERE rv.rfq_id=?`, rfq_id).forEach(x => {
    quotes[x.rfqvendor_id + ':' + x.rfqline_id] = x.price;
  });

  const replied = vendors.filter(v => v.status === 'مُستلم');
  const matrix = lines.map(l => {
    const prices = replied.map(v => ({ rfqvendor_id: v.id, vendor: v.vendor,
      price: quotes[v.id + ':' + l.id], amount: quotes[v.id + ':' + l.id] == null
        ? null : R2(quotes[v.id + ':' + l.id] * l.qty) }))
      .filter(p => p.price != null);
    const best = prices.length ? Math.min(...prices.map(p => p.price)) : null;
    return { ...l, prices: prices.map(p => ({ ...p, best: p.price === best })),
             best_price: best,
             spread: prices.length > 1
               ? R2((Math.max(...prices.map(p => p.price)) - best) / best * 100) : 0 };
  });

  /* أرخص إجمالي مقابل أرخص تفصيلي — الفرق بينهما هو ما يُكسب بالتفاوض */
  const cheapest = replied.length ? replied.reduce((a, b) => a.total <= b.total ? a : b) : null;
  const bestMix = R2(matrix.reduce((s, m) => s + (m.best_price == null ? 0 : m.best_price * m.qty), 0));

  return { ...rfq, lines: matrix, vendors,
    replied: replied.length, invited: vendors.length,
    cheapest_vendor: cheapest ? { id: cheapest.vendor_id, rfqvendor_id: cheapest.id,
      name: cheapest.vendor, total: R2(cheapest.total) } : null,
    best_mix_total: bestMix,
    saving_vs_cheapest: cheapest ? R2(cheapest.total - bestMix) : 0 };
}

/* الإرساء يحوّل العرض الفائز إلى أمر شراء مباشرة */
function awardRFQ(user, d, createPO, submitPO) {
  const rv = get1('SELECT * FROM rfqvendors WHERE id=?', d.rfqvendor_id);
  if (!rv) throw new Error('العرض غير موجود');
  const rfq = get1('SELECT * FROM rfqs WHERE id=?', rv.rfq_id);
  /* حالة الطلب تُفحص أولاً: بعد الإرساء تصير حالة الخاسرين «غير فائز»،
     فلو فُحص العرض أولاً لظهرت رسالة مضلّلة عن عرض لم يُستلم. */
  if (rfq.status === 'مُرسى') throw new Error('الطلب أُرسي مسبقاً');
  if (rv.status !== 'مُستلم') throw new Error('لا يمكن إرساء عرض لم يُستلم');

  const lines = q('SELECT * FROM rfqlines WHERE rfq_id=? ORDER BY sort, id', rv.rfq_id);
  const prices = {};
  q('SELECT * FROM rfqquotes WHERE rfqvendor_id=?', rv.id).forEach(x => { prices[x.rfqline_id] = x.price; });

  const poLines = lines.filter(l => prices[l.id] != null).map(l => ({
    material_id: l.material_id, descr: l.descr, qty: l.qty, price: prices[l.id] }));
  if (!poLines.length) throw new Error('العرض بلا أسعار صالحة');

  const poId = createPO(user, { vendor_id: rv.vendor_id, project_id: rfq.project_id,
    warehouse_id: d.warehouse_id || 1, lines: poLines });
  /* الإرساء قرار شراء، فيدخل أمر الشراء دورة الاعتماد فوراً بدل أن
     يبقى مسودة منسيّة — والحدود المالية تُطبَّق كالمعتاد عند الاعتماد. */
  if (typeof submitPO === 'function') submitPO(user, poId);

  run("UPDATE rfqvendors SET selected=1 WHERE id=?", rv.id);
  run("UPDATE rfqvendors SET status='غير فائز' WHERE rfq_id=? AND id<>? AND status='مُستلم'",
      rv.rfq_id, rv.id);
  run("UPDATE rfqs SET status='مُرسى', awarded_vendor=?, awarded_at=? WHERE id=?",
      rv.vendor_id, new Date().toISOString(), rv.rfq_id);

  /* أسعار العرض الفائز تُحفظ كأسعار متعاقدة للمرة القادمة */
  const vp = db.prepare(`INSERT INTO vendorprices(vendor_id,material_id,price,valid_from,
    valid_to,lead_days,note) VALUES(?,?,?,?,?,?,?)`);
  const until = new Date(Date.now() + 180 * 86400000).toISOString().slice(0, 10);
  lines.forEach(l => { if (l.material_id && prices[l.id] != null)
    vp.run(rv.vendor_id, l.material_id, prices[l.id], today(), until, rv.lead_days,
           'من ' + rfq.code); });

  return { po_id: poId, vendor_id: rv.vendor_id, total: R2(rv.total) };
}

/* ═══════════════ الأسعار المتعاقدة ═══════════════ */

function priceFor(vendor_id, material_id, onDate) {
  const d = onDate || today();
  return get1(`SELECT * FROM vendorprices WHERE vendor_id=? AND material_id=?
    AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)
    ORDER BY id DESC LIMIT 1`, vendor_id, material_id, d, d) || null;
}

function bestPrices(material_id) {
  return q(`SELECT vp.*, p.name vendor, p.rating, p.ontime FROM vendorprices vp
    JOIN partners p ON p.id=vp.vendor_id
    WHERE vp.material_id=? AND (vp.valid_to IS NULL OR vp.valid_to >= ?)
    ORDER BY vp.price`, material_id, today());
}

function savePrice(user, d) {
  if (!get1("SELECT id FROM partners WHERE id=? AND kind='vendor'", d.vendor_id))
    throw new Error('المورد غير موجود');
  if (!get1('SELECT id FROM materials WHERE id=?', d.material_id))
    throw new Error('الصنف غير موجود');
  const price = num(d.price);
  if (price <= 0) throw new Error('السعر يجب أن يكون أكبر من صفر');
  const info = run(`INSERT INTO vendorprices(vendor_id,material_id,price,valid_from,valid_to,
    moq,lead_days,note) VALUES(?,?,?,?,?,?,?,?)`, d.vendor_id, d.material_id, price,
    d.valid_from || today(), d.valid_to || null, num(d.moq), num(d.lead_days) || null, d.note || null);
  return { id: Number(info.lastInsertRowid) };
}

/* ═══════════════ فاتورة المورد والمطابقة الثلاثية ═══════════════ */

function createBill(user, d) {
  const v = get1("SELECT * FROM partners WHERE id=? AND kind='vendor'", d.vendor_id);
  if (!v) throw new Error('المورد غير موجود');
  if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('الفاتورة تحتاج بنداً واحداً');

  let po = null;
  if (d.po_id) {
    po = get1('SELECT * FROM pos WHERE id=?', d.po_id);
    if (!po) throw new Error('أمر الشراء غير موجود');
    if (po.vendor_id !== v.id) throw new Error('أمر الشراء يخص مورداً آخر');
  }
  if (d.vendor_ref && get1('SELECT id FROM bills WHERE vendor_id=? AND vendor_ref=?',
                           v.id, d.vendor_ref))
    throw new Error('فاتورة بنفس رقم المورد مسجّلة مسبقاً — منع ازدواج السداد');

  const code = nextCode('bills', 'BILL-');
  const net = R2(d.lines.reduce((s, l) => s + num(l.qty) * num(l.price), 0));
  const vat = d.vat == null ? R2(net * VAT()) : R2(d.vat);

  const info = run(`INSERT INTO bills(code,vendor_id,po_id,vendor_ref,bdate,ddate,net,vat,total,
    status,created_by) VALUES(?,?,?,?,?,?,?,?,?,'مسودة',?)`,
    code, v.id, d.po_id || null, d.vendor_ref || null, d.bdate || today(),
    d.ddate || null, net, vat, R2(net + vat), user.id);
  const id = Number(info.lastInsertRowid);

  const ins = db.prepare('INSERT INTO billlines(bill_id,poline_id,descr,qty,price) VALUES(?,?,?,?,?)');
  d.lines.forEach(l => ins.run(id, l.poline_id || null, l.descr || 'بند', num(l.qty), num(l.price)));

  if (po) matchBill(id);
  return { id, code, net, vat, total: R2(net + vat) };
}

/* المطابقة الثلاثية: أمر الشراء ← الاستلام ← الفاتورة.
   الفروق تُصنَّف ولا تُبتلع صامتة. */
function matchBill(bill_id) {
  const b = get1('SELECT * FROM bills WHERE id=?', bill_id);
  if (!b) throw new Error('الفاتورة غير موجودة');
  if (!b.po_id) {
    run("UPDATE bills SET match_status='بلا أمر شراء', match_note=? WHERE id=?",
        'فاتورة مباشرة بلا أمر شراء', bill_id);
    return { status: 'بلا أمر شراء', issues: [] };
  }

  const polines = q('SELECT * FROM polines WHERE po_id=?', b.po_id);
  const bl = q('SELECT * FROM billlines WHERE bill_id=?', bill_id);
  const tolPct = parseFloat(S('match_tolerance_pct') || '0.02');
  const tolAmt = parseFloat(S('match_tolerance_amt') || '5');
  const issues = [];

  bl.forEach(l => {
    const pl = l.poline_id ? polines.find(p => p.id === l.poline_id)
      : polines.find(p => (p.descr || '') === (l.descr || ''));
    if (!pl) {
      issues.push({ kind: 'بند زائد', descr: l.descr,
        note: 'البند غير موجود في أمر الشراء' });
      return;
    }
    /* السعر: أي فرق عن المتعاقد عليه */
    const dp = R2(num(l.price) - num(pl.price));
    if (Math.abs(dp) > Math.max(tolAmt, R2(num(pl.price) * tolPct)))
      issues.push({ kind: 'فرق سعر', descr: l.descr, po: R2(pl.price),
        bill: R2(l.price), diff: dp,
        note: `السعر في الفاتورة ${R2(l.price)} مقابل ${R2(pl.price)} في أمر الشراء` });

    /* الكمية: الفاتورة لا تتجاوز المستلم فعلاً — هذا جوهر الضابط */
    const billedBefore = R2(num(get1(`SELECT COALESCE(SUM(bl2.qty),0) s FROM billlines bl2
      JOIN bills b2 ON b2.id=bl2.bill_id
      WHERE bl2.poline_id=? AND b2.id<>? AND b2.status<>'ملغاة'`, pl.id, bill_id).s));
    const cum = R2(billedBefore + num(l.qty));
    if (cum > R2(num(pl.received)) + 0.001)
      issues.push({ kind: 'كمية غير مستلمة', descr: l.descr,
        received: R2(pl.received), billed: cum,
        diff: R2(cum - num(pl.received)),
        note: `المفوتر التراكمي ${cum} والمستلم ${R2(pl.received)} فقط` });
    if (cum > R2(num(pl.qty)) + 0.001)
      issues.push({ kind: 'تجاوز أمر الشراء', descr: l.descr,
        ordered: R2(pl.qty), billed: cum,
        note: `المفوتر ${cum} والمطلوب ${R2(pl.qty)}` });
  });

  const status = issues.length ? 'فروق' : 'مطابقة';
  run('UPDATE bills SET match_status=?, match_note=? WHERE id=?',
      status, issues.length ? JSON.stringify(issues) : null, bill_id);
  return { status, issues };
}

/* الترحيل ممنوع ما لم تكن المطابقة سليمة — إلا بتجاوز صريح موثّق */
function postBill(user, id, opts) {
  const b = get1('SELECT * FROM bills WHERE id=?', id);
  if (!b) throw new Error('الفاتورة غير موجودة');
  if (b.journal_id) throw new Error('الفاتورة مرحّلة مسبقاً');

  const m = matchBill(id);
  const override = opts && opts.override === true;
  if (m.issues.length && !override)
    throw new Error('المطابقة الثلاثية فشلت: ' +
      m.issues.map(i => i.kind + ' — ' + i.descr).join(' · ') +
      ' — صحّح الفاتورة أو اطلب تجاوزاً صريحاً');
  if (m.issues.length && override && !(opts.reason && String(opts.reason).trim()))
    throw new Error('التجاوز يحتاج سبباً مكتوباً');

  const po = b.po_id ? get1('SELECT * FROM pos WHERE id=?', b.po_id) : null;
  /* البضاعة سُجّلت مخزوناً عند الاستلام مقابل ذمم دائنة، فالفاتورة
     هنا تثبّت المستحق للمورد ولا تكرّر تحميل المخزون. */
  const lines = po
    ? [{ account: '2100', debit: b.net, credit: 0, partner_id: b.vendor_id,
         project_id: po.project_id, memo: 'تسوية فاتورة ' + b.code },
       { account: '2100', debit: 0, credit: R2(b.net + b.vat), partner_id: b.vendor_id,
         project_id: po.project_id, memo: 'فاتورة مورد ' + b.code },
       { account: '1400', debit: b.vat, credit: 0, partner_id: b.vendor_id,
         memo: 'ضريبة مدخلات' }]
    : [{ account: '5500', debit: b.net, credit: 0, partner_id: b.vendor_id,
         memo: 'مصروف ' + b.code },
       { account: '1400', debit: b.vat, credit: 0, partner_id: b.vendor_id,
         memo: 'ضريبة مدخلات' },
       { account: '2100', debit: 0, credit: R2(b.net + b.vat), partner_id: b.vendor_id,
         memo: 'فاتورة مورد ' + b.code }];

  const jid = L.post({ ref: b.code, date: b.bdate, memo: 'فاتورة مورد ' + b.code,
    src_type: 'bill', src_id: id, user_id: user.id, lines: lines.filter(l => l.debit || l.credit) });

  run("UPDATE bills SET status='مرحّلة', journal_id=?, match_note=? WHERE id=?",
      jid, override && m.issues.length
        ? 'تجاوز: ' + opts.reason + ' | ' + JSON.stringify(m.issues) : b.match_note, id);
  return { journal_id: jid, total: R2(b.total), match: m.status,
           overridden: !!(override && m.issues.length) };
}

function billDetail(id) {
  const b = get1(`SELECT b.*, v.name vendor, p.code po_code, u.name author FROM bills b
    JOIN partners v ON v.id=b.vendor_id LEFT JOIN pos p ON p.id=b.po_id
    LEFT JOIN users u ON u.id=b.created_by WHERE b.id=?`, id);
  if (!b) throw new Error('الفاتورة غير موجودة');
  let issues = [];
  try { issues = b.match_note ? JSON.parse(b.match_note.replace(/^تجاوز:.*?\| /, '')) : []; }
  catch (e) { issues = []; }
  return { ...b, lines: q(`SELECT bl.*, pl.qty po_qty, pl.price po_price, pl.received
    FROM billlines bl LEFT JOIN polines pl ON pl.id=bl.poline_id
    WHERE bl.bill_id=? ORDER BY bl.id`, id), issues };
}

/* ═══════════════ تقييم الموردين ═══════════════ */

/* التقييم مشتق من السلوك الفعلي: الالتزام بالتسليم · دقة الفواتير · السعر */
function vendorScore(vendor_id) {
  const v = get1("SELECT * FROM partners WHERE id=? AND kind='vendor'", vendor_id);
  if (!v) throw new Error('المورد غير موجود');

  const pos = q(`SELECT po.*, (SELECT COALESCE(SUM(qty*price),0) FROM polines WHERE po_id=po.id) net
    FROM pos po WHERE po.vendor_id=?`, vendor_id);
  const done = pos.filter(p => p.status === 'مستلم').length;
  const spend = R2(pos.filter(p => p.status !== 'مرفوض' && p.status !== 'مسودة')
    .reduce((s, p) => s + num(p.net), 0));

  const bills = q('SELECT * FROM bills WHERE vendor_id=?', vendor_id);
  const clean = bills.filter(b => b.match_status === 'مطابقة').length;
  const disputed = bills.filter(b => b.match_status === 'فروق').length;
  const accuracy = bills.length ? R2(clean / bills.length * 100) : null;

  /* السعر: كم مرة كان الأرخص في المقارنات التي شارك فيها */
  const invited = num(get1(`SELECT COUNT(*) c FROM rfqvendors WHERE vendor_id=?
    AND status IN ('مُستلم','غير فائز')`, vendor_id).c);
  const won = num(get1('SELECT COUNT(*) c FROM rfqvendors WHERE vendor_id=? AND selected=1',
    vendor_id).c);
  const winRate = invited ? R2(won / invited * 100) : null;

  const rfqAsked = num(get1('SELECT COUNT(*) c FROM rfqvendors WHERE vendor_id=?', vendor_id).c);
  const replied = num(get1("SELECT COUNT(*) c FROM rfqvendors WHERE vendor_id=? AND status<>'مُرسل'",
    vendor_id).c);
  const responsiveness = rfqAsked ? R2(replied / rfqAsked * 100) : null;

  /* درجة مركّبة 0–100 من المؤشرات المتاحة فقط */
  const parts = [];
  if (v.ontime != null) parts.push({ w: 0.4, v: num(v.ontime) });
  if (accuracy != null) parts.push({ w: 0.3, v: accuracy });
  if (responsiveness != null) parts.push({ w: 0.2, v: responsiveness });
  if (winRate != null) parts.push({ w: 0.1, v: winRate });
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  const score = wsum ? R2(parts.reduce((s, p) => s + p.w * p.v, 0) / wsum) : null;

  return { vendor_id, name: v.name, trade: v.trade, rating: v.rating,
    ontime: v.ontime, pos: pos.length, pos_completed: done, spend,
    bills: bills.length, bills_clean: clean, bills_disputed: disputed,
    invoice_accuracy: accuracy, rfq_invited: rfqAsked, rfq_replied: replied,
    responsiveness, win_rate: winRate, score,
    grade: score == null ? 'غير مقيَّم'
      : score >= 85 ? 'ممتاز' : score >= 70 ? 'جيد' : score >= 50 ? 'مقبول' : 'ضعيف' };
}

function vendorBoard() {
  return q("SELECT id FROM partners WHERE kind='vendor' AND active=1")
    .map(v => vendorScore(v.id))
    .sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
}

module.exports = {
  createRFQ, recordQuote, compareRFQ, awardRFQ,
  priceFor, bestPrices, savePrice,
  createBill, matchBill, postBill, billDetail,
  vendorScore, vendorBoard,
};
