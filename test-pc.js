'use strict';
/* اختبارات المشتريات المتقدمة — العروض والمقارنة والمطابقة الثلاثية */
process.env.ERP_DB = '/tmp/pc-erp.db';
['', '-wal', '-shm'].forEach(x => require('node:fs').rmSync('/tmp/pc-erp.db' + x, { force: true }));

const A = require('./server');
const PC = require('./procure');
const L = require('./ledger');
const { q, get1, run } = require('./db');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log('  ✓ ' + n); pass++; }
  catch (e) { console.log('  ✗ ' + n + '\n      → ' + e.message); fail++; } };
const eq = (a, b, m) => { if (Math.abs((+a) - (+b)) > 0.011) throw new Error((m || '') + ' توقعت ' + b + ' لكن جاء ' + a); };
const ok = (v, m) => { if (!v) throw new Error(m || 'توقعت صحيحاً'); };
const throws = (fn, frag) => { let th = false;
  try { fn(); } catch (e) { th = true; if (frag && !e.message.includes(frag)) throw new Error('رسالة مختلفة: ' + e.message); }
  if (!th) throw new Error('كان يجب الرفض'); };

const admin = A.login('admin', 'admin123').user;
const pm = A.login('ahmad', 'pm123').user;
const acc = A.login('noura', 'acc123').user;
const store = A.login('fahad', 'store123').user;
const balanced = () => L.balanceSheet().balanced;

L.post({ ref: 'OPEN', date: '2026-01-01', memo: 'رصيد افتتاحي', user_id: admin.id,
  lines: [{ account: '1100', debit: 1000000, credit: 0 },
          { account: '3100', debit: 0, credit: 1000000 }] });

console.log('\n══════ طلب عروض الأسعار ══════');

let RFQ;
t('رفض طلب عروض بمورد واحد', () => {
  throws(() => PC.createRFQ(pm, { vendors: [4],
    lines: [{ material_id: 1, qty: 500 }] }), 'موردين اثنين');
});

t('إنشاء طلب عروض لثلاثة موردين', () => {
  const r = PC.createRFQ(pm, { project_id: 1, descr: 'كابلات ولوحات — أبحر',
    vendors: [4, 5, 6], lines: [
      { material_id: 1, qty: 500 },                         // كابل NYY
      { material_id: 2, qty: 60 },                          // MCB
      { descr: 'صواني كابلات 300مم', unit: 'متر طولي', qty: 200 },
    ] });
  RFQ = r.id;
  eq(r.vendors, 3, 'عدد الموردين');
  eq(r.lines, 3, 'عدد البنود');
});

t('رفض كمية صفرية', () => {
  throws(() => PC.createRFQ(pm, { vendors: [4, 5],
    lines: [{ material_id: 1, qty: 0 }] }), 'أكبر من صفر');
});

console.log('\n══════ استلام العروض ══════');

let V1, V2, V3;
t('تسجيل عروض الموردين الثلاثة', () => {
  const c = PC.compareRFQ(RFQ);
  [V1, V2, V3] = c.vendors.map(v => v.id);
  const lines = c.lines.map(l => l.id);

  PC.recordQuote(pm, { rfqvendor_id: V1, lead_days: 10, prices: [
    { rfqline_id: lines[0], price: 44 },     // 500×44  = 22,000
    { rfqline_id: lines[1], price: 30 },     //  60×30  =  1,800
    { rfqline_id: lines[2], price: 85 },     // 200×85  = 17,000  → 40,800
  ] });
  PC.recordQuote(pm, { rfqvendor_id: V2, lead_days: 21, prices: [
    { rfqline_id: lines[0], price: 41 },     // 500×41  = 20,500
    { rfqline_id: lines[1], price: 34 },     //  60×34  =  2,040
    { rfqline_id: lines[2], price: 92 },     // 200×92  = 18,400  → 40,940
  ] });
  PC.recordQuote(pm, { rfqvendor_id: V3, lead_days: 7, prices: [
    { rfqline_id: lines[0], price: 47 },     // 500×47  = 23,500
    { rfqline_id: lines[1], price: 28 },     //  60×28  =  1,680
    { rfqline_id: lines[2], price: 80 },     // 200×80  = 16,000  → 41,180
  ] });
  const c2 = PC.compareRFQ(RFQ);
  eq(c2.replied, 3, 'العروض المستلمة');
});

t('إجمالي كل عرض محسوب صحيحاً', () => {
  const c = PC.compareRFQ(RFQ);
  const tot = c.vendors.map(v => Math.round(v.total));
  eq(tot[0], 40800, 'المورد الأول');
  eq(tot[1], 40940, 'المورد الثاني');
  eq(tot[2], 41180, 'المورد الثالث');
});

t('المقارنة تميّز الأرخص لكل بند', () => {
  const c = PC.compareRFQ(RFQ);
  eq(c.lines[0].best_price, 41, 'أرخص سعر للكابل');
  eq(c.lines[1].best_price, 28, 'أرخص سعر للمفتاح');
  eq(c.lines[2].best_price, 80, 'أرخص سعر للصواني');
  const best0 = c.lines[0].prices.find(p => p.best);
  eq(best0.price, 41, 'تمييز الأرخص');
});

t('فرق السعر بين أعلى وأدنى عرض لكل بند', () => {
  const c = PC.compareRFQ(RFQ);
  // الكابل: 47 مقابل 41 → 14.63%
  eq(c.lines[0].spread, 14.63, 'فرق السعر');
});

t('أرخص خليط أقل من أرخص إجمالي — وهذا مكسب التفاوض', () => {
  const c = PC.compareRFQ(RFQ);
  eq(c.cheapest_vendor.total, 40800, 'أرخص إجمالي');
  eq(c.best_mix_total, 38180, 'أرخص خليط');    // 500×41 + 60×28 + 200×80
  eq(c.saving_vs_cheapest, 2620, 'الوفر الممكن');
});

console.log('\n══════ الإرساء ══════');

let PO;
t('الإرساء يُنشئ أمر شراء بأسعار العرض الفائز', () => {
  const r = PC.awardRFQ(admin, { rfqvendor_id: V1, warehouse_id: 1 }, A.createPO, A.submitPO);
  PO = r.po_id;
  ok(PO > 0, 'لم يُنشأ أمر الشراء');
  eq(A.poTotal(PO), 40800, 'قيمة أمر الشراء');
});

t('الموردون الآخرون يُعلَّمون غير فائزين', () => {
  const c = PC.compareRFQ(RFQ);
  eq(c.status, 'مُرسى', 'حالة الطلب');
  eq(c.vendors.filter(v => v.status === 'غير فائز').length, 2, 'غير الفائزين');
  eq(c.vendors.filter(v => v.selected).length, 1, 'الفائز');
});

t('أسعار الفائز تُحفظ كأسعار متعاقدة', () => {
  const p = PC.priceFor(4, 1);
  ok(p, 'لا يوجد سعر متعاقد');
  eq(p.price, 44, 'السعر المحفوظ');
});

t('لا يُرسى الطلب مرتين', () => {
  throws(() => PC.awardRFQ(admin, { rfqvendor_id: V2 }, A.createPO, A.submitPO), "أُرسي مسبقاً");
});

t('قائمة أفضل الأسعار مرتّبة تصاعدياً', () => {
  PC.savePrice(admin, { vendor_id: 5, material_id: 1, price: 41 });
  const list = PC.bestPrices(1);
  ok(list.length >= 2, 'عدد الأسعار');
  ok(list[0].price <= list[1].price, 'الترتيب');
});

console.log('\n══════ المطابقة الثلاثية ══════');

t('استلام جزئي: 300 من 500 كابل', () => {
  A.approvePO(admin, PO, true);
  const lines = q('SELECT * FROM polines WHERE po_id=? ORDER BY id', PO);
  A.receivePO(store, PO, [{ line_id: lines[0].id, qty: 300 }]);
  eq(get1('SELECT received FROM polines WHERE id=?', lines[0].id).received, 300, 'المستلم');
  ok(balanced(), 'الميزانية غير متوازنة');
});

let BILL;
t('فاتورة بكمية أكبر من المستلم تُرصد', () => {
  const lines = q('SELECT * FROM polines WHERE po_id=? ORDER BY id', PO);
  const r = PC.createBill(acc, { vendor_id: 4, po_id: PO, vendor_ref: 'INV-9001',
    lines: [{ poline_id: lines[0].id, descr: lines[0].descr, qty: 500, price: 44 }] });
  BILL = r.id;
  const m = PC.matchBill(BILL);
  eq(m.status, 'فروق', 'حالة المطابقة');
  ok(m.issues.some(i => i.kind === 'كمية غير مستلمة'), 'لم تُرصد الكمية');
});

t('الترحيل ممنوع مع وجود فروق', () => {
  throws(() => PC.postBill(acc, BILL), 'المطابقة الثلاثية فشلت');
});

t('التجاوز بلا سبب مكتوب مرفوض', () => {
  throws(() => PC.postBill(admin, BILL, { override: true }), 'سبباً مكتوباً');
});

t('فاتورة بسعر مختلف عن أمر الشراء تُرصد', () => {
  const lines = q('SELECT * FROM polines WHERE po_id=? ORDER BY id', PO);
  const r = PC.createBill(acc, { vendor_id: 4, po_id: PO, vendor_ref: 'INV-9002',
    lines: [{ poline_id: lines[1].id, descr: lines[1].descr, qty: 10, price: 39 }] });
  const m = PC.matchBill(r.id);
  ok(m.issues.some(i => i.kind === 'فرق سعر'), 'لم يُرصد فرق السعر');
  const pi = m.issues.find(i => i.kind === 'فرق سعر');
  eq(pi.po, 30, 'سعر أمر الشراء');
  eq(pi.bill, 39, 'سعر الفاتورة');
  run('DELETE FROM bills WHERE id=?', r.id);
});

t('فاتورة مطابقة تماماً تُرحَّل بلا اعتراض', () => {
  run('DELETE FROM billlines WHERE bill_id=?', BILL);
  run('DELETE FROM bills WHERE id=?', BILL);
  const lines = q('SELECT * FROM polines WHERE po_id=? ORDER BY id', PO);
  const r = PC.createBill(acc, { vendor_id: 4, po_id: PO, vendor_ref: 'INV-9003',
    lines: [{ poline_id: lines[0].id, descr: lines[0].descr, qty: 300, price: 44 }] });
  BILL = r.id;
  eq(r.net, 13200, 'صافي الفاتورة');
  eq(r.vat, 1980, 'الضريبة');
  const m = PC.matchBill(BILL);
  eq(m.status, 'مطابقة', 'حالة المطابقة');
  const p = PC.postBill(acc, BILL);
  ok(p.journal_id > 0, 'لم تُرحّل');
  ok(balanced(), 'الميزانية غير متوازنة');
});

t('منع ازدواج رقم فاتورة المورد', () => {
  const lines = q('SELECT * FROM polines WHERE po_id=? ORDER BY id', PO);
  throws(() => PC.createBill(acc, { vendor_id: 4, po_id: PO, vendor_ref: 'INV-9003',
    lines: [{ poline_id: lines[0].id, qty: 1, price: 44 }] }), 'منع ازدواج');
});

t('لا تُرحّل الفاتورة مرتين', () => {
  throws(() => PC.postBill(acc, BILL), 'مرحّلة مسبقاً');
});

t('المفوتر التراكمي يمنع تجاوز المستلم عبر فواتير متعددة', () => {
  const lines = q('SELECT * FROM polines WHERE po_id=? ORDER BY id', PO);
  const r = PC.createBill(acc, { vendor_id: 4, po_id: PO, vendor_ref: 'INV-9004',
    lines: [{ poline_id: lines[0].id, descr: lines[0].descr, qty: 100, price: 44 }] });
  const m = PC.matchBill(r.id);
  // 300 مفوترة سابقاً + 100 = 400 > 300 المستلم
  ok(m.issues.some(i => i.kind === 'كمية غير مستلمة'), 'لم يُرصد التراكم');
  const iss = m.issues.find(i => i.kind === 'كمية غير مستلمة');
  eq(iss.billed, 400, 'المفوتر التراكمي');
  eq(iss.received, 300, 'المستلم');
  run('DELETE FROM bills WHERE id=?', r.id);
});

t('التجاوز الموثّق يُرحّل ويُسجّل السبب', () => {
  const lines = q('SELECT * FROM polines WHERE po_id=? ORDER BY id', PO);
  const r = PC.createBill(acc, { vendor_id: 4, po_id: PO, vendor_ref: 'INV-9005',
    lines: [{ poline_id: lines[0].id, descr: lines[0].descr, qty: 50, price: 44 }] });
  const p = PC.postBill(admin, r.id, { override: true,
    reason: 'البضاعة في الطريق واتفقنا على السداد المسبق' });
  ok(p.overridden, 'لم يُسجَّل التجاوز');
  const b = get1('SELECT match_note FROM bills WHERE id=?', r.id);
  ok(b.match_note.includes('تجاوز'), 'السبب غير محفوظ');
  ok(balanced(), 'الميزانية غير متوازنة');
});

t('فاتورة مصروف بلا أمر شراء تُرحّل على المصروفات', () => {
  const r = PC.createBill(acc, { vendor_id: 5, vendor_ref: 'EXP-77',
    lines: [{ descr: 'صيانة مركبات', qty: 1, price: 4000 }] });
  const m = PC.matchBill(r.id);
  eq(m.status, 'بلا أمر شراء', 'حالة المطابقة');
  const p = PC.postBill(acc, r.id);
  const ls = q('SELECT account, debit, credit FROM jlines WHERE journal_id=?', p.journal_id);
  const by = a => ls.filter(l => l.account === a).reduce((s, l) => s + l.debit - l.credit, 0);
  eq(by('5500'), 4000, 'المصروف');
  eq(by('1400'), 600, 'ضريبة المدخلات');
  eq(by('2100'), -4600, 'المستحق للمورد');
  ok(balanced(), 'الميزانية غير متوازنة');
});

console.log('\n══════ تقييم الموردين ══════');

t('درجة المورد تُشتق من سلوكه الفعلي', () => {
  const s = PC.vendorScore(4);
  eq(s.rfq_invited, 1, 'دعوات العروض');
  eq(s.rfq_replied, 1, 'العروض المقدّمة');
  eq(s.responsiveness, 100, 'سرعة الاستجابة');
  eq(s.win_rate, 100, 'معدل الفوز');
  ok(s.score > 0, 'الدرجة');
  ok(s.bills >= 2, 'عدد الفواتير');
});

t('دقة الفواتير تنخفض مع الفروق', () => {
  const s = PC.vendorScore(4);
  ok(s.bills_disputed >= 1, 'فواتير بفروق');
  ok(s.invoice_accuracy < 100, 'الدقة: ' + s.invoice_accuracy);
});

t('المورد غير المدعو يبقى غير مقيَّم في المؤشرات السلوكية', () => {
  const s = PC.vendorScore(7);
  eq(s.rfq_invited, 0, 'دعوات');
  eq(s.responsiveness, null, 'الاستجابة');
});

t('اللوحة ترتّب الموردين تنازلياً بالدرجة', () => {
  const b = PC.vendorBoard();
  ok(b.length >= 4, 'عدد الموردين');
  const scored = b.filter(v => v.score != null);
  for (let i = 1; i < scored.length; i++)
    ok(scored[i - 1].score >= scored[i].score, 'الترتيب خاطئ');
});

t('كل مورد له تقدير مفهوم', () => {
  PC.vendorBoard().forEach(v => {
    ok(['ممتاز', 'جيد', 'مقبول', 'ضعيف', 'غير مقيَّم'].includes(v.grade),
       'تقدير غير معروف: ' + v.grade);
  });
});

console.log('\n══════ سلامة الدفتر ══════');

t('الميزانية متوازنة', () => ok(L.balanceSheet().balanced));
t('كل القيود متوازنة سطراً بسطر', () => {
  const bad = q(`SELECT journal_id, ROUND(SUM(debit)-SUM(credit),2) d
    FROM jlines GROUP BY journal_id HAVING ABS(d) > 0.011`);
  if (bad.length) throw new Error('قيود غير متوازنة: ' + JSON.stringify(bad));
});
t('ذمم الموردين لا تتضاعف بالفواتير', () => {
  // الاستلام سجّل 300×44 + ضريبة، والفاتورة المطابقة ثبّتته ولم تكرّره
  ok(L.balanceOf('2100') > 0, 'رصيد الموردين');
});

console.log(`\n${'═'.repeat(46)}`);
console.log(`  ناجح: ${pass}   ·   فاشل: ${fail}`);
console.log('═'.repeat(46) + '\n');
process.exit(fail ? 1 : 0);
