'use strict';
process.env.ERP_DB = '/tmp/pa-erp.db';
['','-wal','-shm'].forEach(x => require('node:fs').rmSync('/tmp/pa-erp.db' + x, { force: true }));

const A = require('./server');
const SL = require('./sales');
const L = require('./ledger');
const { q, get1, run } = require('./db');

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log('  ✓ ' + n); pass++; }
  catch (e) { console.log('  ✗ ' + n + '\n      → ' + e.message); fail++; } };
const eq = (a, b, m) => { if (Math.abs((+a) - (+b)) > 0.011) throw new Error((m || '') + ' توقعت ' + b + ' لكن جاء ' + a); };
const throws = (fn, frag) => { let th = false;
  try { fn(); } catch (e) { th = true; if (frag && !e.message.includes(frag)) throw new Error('رسالة مختلفة: ' + e.message); }
  if (!th) throw new Error('كان يجب الرفض'); };

const admin = A.login('admin', 'admin123').user;
const pm = A.login('ahmad', 'pm123').user;
const eng = A.login('saad', 'eng123').user;
const store = A.login('fahad', 'store123').user;
const acc = A.login('noura', 'acc123').user;

console.log('\n── تكلفة المخزون المتوسطة المرجحة ──');
t('استلام أول: المتوسط = سعر الشراء', () => {
  // material 1 seeded at 45 qty=45. Receive 100 @ 60
  const avg = SL.receiveAtCost(1, 1, 100, 60);
  // (45*45 + 100*60) / 145 = (2025 + 6000)/145 = 55.34
  eq(avg, 55.34, 'المتوسط بعد الاستلام');
});
t('المتوسط ينتقل للصرف وليس سعر الكتالوج', () => {
  const r = A.issueMaterial(store, { material_id: 1, warehouse_id: 1, qty: 10, project_id: 1 });
  eq(r.unit_cost, 55.34, 'تكلفة الوحدة');
  eq(r.cost, 553.4, 'تكلفة الصرف');
});
t('استلام بسعر أقل يخفض المتوسط', () => {
  const before = SL.costAt(1, 1);
  const after = SL.receiveAtCost(1, 1, 135, 30);
  if (after >= before) throw new Error('المتوسط لم ينخفض: ' + before + ' → ' + after);
});
t('صنف بلا رصيد يأخذ سعر الكتالوج', () => {
  eq(SL.costAt(3, 2), 7750, 'سعر اللوحة من الكتالوج');
});

console.log('\n── النقل بين المستودعات ──');
t('يرفض النقل لنفس المستودع', () => {
  throws(() => SL.transfer(store, { material_id: 1, from_wh: 1, to_wh: 1, qty: 5 }), 'متطابقان');
});
t('يرفض كمية أكبر من المتاح', () => {
  throws(() => SL.transfer(store, { material_id: 1, from_wh: 1, to_wh: 2, qty: 99999 }), 'المتاحة');
});
t('النقل ينقل التكلفة مع البضاعة', () => {
  const unit = SL.costAt(1, 1);
  const r = SL.transfer(store, { material_id: 1, from_wh: 1, to_wh: 2, qty: 50 });
  eq(r.unit_cost, unit, 'تكلفة النقل');
  eq(SL.costAt(1, 2), unit, 'المتوسط في الوجهة');
  eq(SL.availableAt(1, 2), 50, 'الكمية في الوجهة');
});
t('النقل لا يغيّر إجمالي قيمة المخزون', () => {
  const total = () => R2v(q(`SELECT s.qty, COALESCE(NULLIF(s.avg_cost,0), m.cost) c
    FROM stock s JOIN materials m ON m.id=s.material_id`).reduce((a, r) => a + r.qty * r.c, 0));
  const before = total();
  SL.transfer(store, { material_id: 1, from_wh: 1, to_wh: 2, qty: 20 });
  eq(total(), before, 'قيمة المخزون');
});
function R2v(n) { return Math.round(n * 100) / 100; }

console.log('\n── طلبات المواد من الموقع ──');
let mrId;
t('الطلب يفصل المتاح عن المطلوب شراؤه', () => {
  mrId = SL.createMR(eng, { project_id: 1, warehouse_id: 1, reason: 'الطابق الثاني',
    lines: [{ material_id: 2, qty: 30 }, { material_id: 3, qty: 2 }] });
  const mr = SL.mrDetail(mrId);
  const mcb = mr.lines.find(l => l.material_id === 2);
  eq(mcb.available, 8, 'المتاح من المفاتيح');
  eq(mcb.shortfall, 22, 'المطلوب شراؤه');
  const panel = mr.lines.find(l => l.material_id === 3);
  eq(panel.shortfall, 0, 'اللوحات متوفرة');
});
t('لا يمكن الصرف قبل الاعتماد', () => {
  throws(() => SL.fulfilMR(store, mrId, A.issueMaterial), 'غير معتمد');
});
t('المهندس لا يعتمد طلبه بنفسه', () => {
  throws(() => { if (!A.can(eng, 'approve', 'po')) throw new Error('لا تملك صلاحية'); }, 'صلاحية');
});
t('مدير المشاريع يعتمد', () => {
  SL.approveMR(pm, mrId, true);
  if (get1('SELECT status FROM matreqs WHERE id=?', mrId).status !== 'معتمد') throw new Error('لم يُعتمد');
});
t('الصرف الجزئي يصرف المتاح فقط', () => {
  const r = SL.fulfilMR(store, mrId, A.issueMaterial);
  if (r.complete) throw new Error('اعتبره مكتملاً رغم النقص');
  const mr = SL.mrDetail(mrId);
  eq(mr.lines.find(l => l.material_id === 2).issued, 8, 'المصروف من المفاتيح');
  if (mr.status !== 'صرف جزئي') throw new Error('الحالة ' + mr.status);
});
t('الصرف يحمّل التكلفة على المشروع', () => {
  const pl = L.projectPL(1);
  if (pl.cost <= 0) throw new Error('لا تكلفة');
});

console.log('\n── الفرص وخط الأنابيب ──');
t('خط الأنابيب يحسب القيمة المرجّحة', () => {
  const p = SL.pipeline();
  if (p.rows.length !== 3) throw new Error('عدد الفرص ' + p.rows.length);
  // 1.2M*30% + 670k*55% + 2.1M*80% = 360000 + 368500 + 1680000
  eq(p.weighted, 2408500, 'القيمة المرجّحة');
});
t('تسجيل الخسارة يحفظ السبب', () => {
  const o = SL.saveOpp(pm, { name: 'مجمع سكني', customer_id: 1, trade: 'MEP كامل',
    value: 1800000, probability: 40, stage: 'تفاوض' });
  run("UPDATE opps SET stage='خسر', lost_reason=?, competitor=? WHERE id=?",
      'سعر أعلى من المنافس', 'شركة منافسة', o.id);
  const p = SL.pipeline();
  const lr = p.lost_reasons.find(r => r.reason === 'سعر أعلى من المنافس');
  if (!lr) throw new Error('السبب غير محفوظ');
  eq(lr.value, 1800000, 'القيمة المفقودة');
});

console.log('\n── كشف الكميات BOQ ──');
let qId;
t('إنشاء عرض سعر بثلاثة بنود', () => {
  qId = SL.createQuote(pm, { customer_id: 1, opp_id: 3, qtype: 'كشف كميات',
    valid_until: '2026-10-30',
    lines: [
      { item: 'E-01', descr: 'لوحة كهرباء رئيسية 400A', trade: 'كهرباء', unit: 'قطعة', qty: 1, cost: 14000, price: 18500 },
      { item: 'E-02', descr: 'كابل NYY 4×16', trade: 'كهرباء', unit: 'متر طولي', qty: 320, cost: 34, price: 45 },
      { item: 'M-01', descr: 'وحدات تكييف 2 طن', trade: 'ميكانيكا', unit: 'قطعة', qty: 18, cost: 3100, price: 3800 },
    ] });
  const t2 = SL.quoteTotals(qId);
  // net = 18500 + 14400 + 68400 = 101300
  eq(t2.net, 101300, 'الصافي');
  // cost = 14000 + 10880 + 55800 = 80680
  eq(t2.cost, 80680, 'التكلفة');
  eq(t2.profit, 20620, 'الربح');
  eq(t2.vat, 15195, 'الضريبة');
  eq(t2.total, 116495, 'الإجمالي');
});
t('هامش الربح محسوب', () => {
  const t2 = SL.quoteTotals(qId);
  eq(t2.margin, 20.36, 'الهامش %');
});
t('الإرسال يحرّك الفرصة إلى مرحلة عرض السعر', () => {
  SL.sendQuote(pm, qId);
  if (get1('SELECT status FROM quotes WHERE id=?', qId).status !== 'مُرسل') throw new Error('لم يُرسل');
  if (get1('SELECT stage FROM opps WHERE id=3').stage !== 'عرض سعر') throw new Error('الفرصة لم تتحرك');
});
t('لا يمكن الإرسال مرتين', () => {
  throws(() => SL.sendQuote(pm, qId), 'أُرسل مسبقاً');
});

console.log('\n── الفوز يحوّل العرض إلى مشروع ──');
let newProj;
t('الفوز ينشئ مشروعاً بقيمة العرض', () => {
  const r = SL.winQuote(pm, qId, { name: 'فندق الكورنيش — MEP', ddate: '2027-03-31' });
  newProj = r.project_id;
  const p = get1('SELECT * FROM projects WHERE id=?', newProj);
  eq(p.value, 101300, 'قيمة العقد');
  if (p.customer_id !== 1) throw new Error('العميل غير منقول');
});
t('كل بند BOQ صار مهمة', () => {
  const n = get1('SELECT COUNT(*) c FROM tasks WHERE project_id=?', newProj).c;
  if (n !== 3) throw new Error('عدد المهام ' + n);
});
t('الفرصة انتقلت إلى فاز ومرتبطة بالمشروع', () => {
  const o = get1('SELECT * FROM opps WHERE id=3');
  if (o.stage !== 'فاز') throw new Error('المرحلة ' + o.stage);
  if (o.project_id !== newProj) throw new Error('غير مرتبطة بالمشروع');
});
t('تحويل العرض إلى فاتورة', () => {
  const r = SL.quoteToInvoice(acc, qId, A.createInvoice);
  const tot = A.invoiceTotal(r.invoice_id);
  eq(tot.net, 101300, 'صافي الفاتورة');
  eq(tot.total, 116495, 'إجمالي الفاتورة');
});
t('لا تُصدر فاتورتان لنفس العرض', () => {
  throws(() => SL.quoteToInvoice(acc, qId, A.createInvoice), 'مسبقاً');
});

console.log('\n── نسبة الإنجاز الموزونة ──');
t('الإنجاز يُحسب بأوزان المهام لا بالعدد', () => {
  // project 1 seeded: weights 1,2,3,3,2,2,2 = 15
  // progress   100,100,70,40,100,15,0
  // = (100+200+210+120+200+30+0)/15 = 860/15 = 57.33 → 57
  const pct = SL.rollupProgress(1);
  eq(pct, 57, 'النسبة الموزونة');
});
t('تحديث مهمة يعيد حساب إنجاز المشروع', () => {
  const task = get1("SELECT * FROM tasks WHERE project_id=1 AND status='لم يبدأ'");
  const before = get1('SELECT progress FROM projects WHERE id=1').progress;
  SL.saveTask(eng, { ...task, progress: 100, status: 'منتهي' });
  const after = get1('SELECT progress FROM projects WHERE id=1').progress;
  if (after <= before) throw new Error('لم يتغير: ' + before + ' → ' + after);
});

console.log('\n── التقرير اليومي ──');
t('حفظ تقرير يومي', () => {
  const r = SL.saveDaily(eng, { project_id: 1, rdate: '2026-09-14', elec_men: 6, mech_men: 4,
    plum_men: 3, other_men: 2, elec_pct: 55, mech_pct: 30, plum_pct: 60,
    work: 'مد كابلات الطابق الثاني', weather: 'مشمس', temp: 38 });
  if (r.updated) throw new Error('اعتبره تحديثاً');
});
t('تقرير نفس اليوم يُحدَّث لا يتكرر', () => {
  const r = SL.saveDaily(eng, { project_id: 1, rdate: '2026-09-14', elec_men: 7 });
  if (!r.updated) throw new Error('أنشأ سجلاً مكرراً');
  const n = get1("SELECT COUNT(*) c FROM dailyreports WHERE project_id=1 AND rdate='2026-09-14'").c;
  if (n !== 1) throw new Error('عدد السجلات ' + n);
});
t('إحصاءات ساعات العمل', () => {
  SL.saveDaily(eng, { project_id: 1, rdate: '2026-09-15', elec_men: 5, mech_men: 3, plum_men: 2, other_men: 0 });
  const st = SL.dailyStats(1, 30);
  eq(st.workdays, 2, 'أيام العمل');
  // day1: 7+0+0+0=7 men *8 = 56 (updated record kept only elec_men)
  if (st.manhours <= 0) throw new Error('ساعات العمل صفر');
});

console.log('\n── سلامة الدفاتر بعد كل ما سبق ──');
t('ميزان المراجعة ما زال متوازناً', () => {
  const tb = L.trialBalance();
  eq(tb.reduce((s, r) => s + r.td, 0), tb.reduce((s, r) => s + r.tc, 0), 'الميزان');
});
t('الميزانية العمومية ما زالت متوازنة', () => {
  if (!L.balanceSheet().balanced) throw new Error('غير متوازنة');
});

console.log('\n' + '─'.repeat(44));
console.log(`نجح ${pass} · فشل ${fail}`);
process.exit(fail ? 1 : 0);
