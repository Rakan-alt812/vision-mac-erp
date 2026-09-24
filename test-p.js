'use strict';
/* اختبارات وحدة المستخلصات والمحتجزات وأوامر التغيير ومقاولي الباطن */
process.env.ERP_DB = '/tmp/pp-erp.db';
['', '-wal', '-shm'].forEach(x => require('node:fs').rmSync('/tmp/pp-erp.db' + x, { force: true }));

const A = require('./server');
const PG = require('./progress');
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
const eng = A.login('saad', 'eng123').user;
const acc = A.login('noura', 'acc123').user;
const store = A.login('fahad', 'store123').user;

/* توازن الميزانية يُفحص بعد كل مرحلة — أي قيد مختل يظهر فوراً */
const balanced = () => L.balanceSheet().balanced;

console.log('\n══════ العقد وبنوده ══════');

let CID;
t('إنشاء عقد بكشف كميات ونسبة محتجزات 5٪', () => {
  const r = PG.saveContract(admin, {
    project_id: 1, retention_pct: 0.05, advance_pct: 0.10, advance_recovery_pct: 0.20,
    items: [
      { item: '1.1', descr: 'مد كابلات التغذية', unit: 'متر طولي', qty: 2000, price: 120 },
      { item: '1.2', descr: 'لوحات توزيع فرعية', unit: 'قطعة', qty: 20, price: 8000 },
      { item: '2.1', descr: 'وحدات تكييف سبليت', unit: 'قطعة', qty: 40, price: 4500 },
      { item: '3.1', descr: 'شبكة مياه PPR', unit: 'متر طولي', qty: 1500, price: 60 },
    ] });
  CID = r.id;
  ok(CID > 0, 'لم يُنشأ العقد');
});

t('قيمة العقد = مجموع البنود وتنعكس على المشروع', () => {
  // 2000*120 + 20*8000 + 40*4500 + 1500*60 = 240000+160000+180000+90000 = 670000
  const c = PG.contractDetail(1);
  eq(c.value, 670000, 'قيمة العقد');
  eq(get1('SELECT value FROM projects WHERE id=1').value, 670000, 'قيمة المشروع');
});

t('رفض نسبة محتجزات غير منطقية', () => {
  throws(() => PG.saveContract(admin, { project_id: 1, retention_pct: 0.8 }), 'بين 0 و 50');
});

t('حفظ البنود وحدها لا يصفّر إعدادات العقد المالية', () => {
  const before = PG.contractDetail(1);
  /* حفظ البنود فقط — كما تفعل شاشة «بنود العقد» */
  PG.saveContract(admin, { project_id: 1, items: [
    { item: '1.1', descr: 'مد كابلات التغذية', unit: 'متر طولي', qty: 2000, price: 120 },
    { item: '1.2', descr: 'لوحات توزيع فرعية', unit: 'قطعة', qty: 20, price: 8000 },
    { item: '2.1', descr: 'وحدات تكييف سبليت', unit: 'قطعة', qty: 40, price: 4500 },
    { item: '3.1', descr: 'شبكة مياه PPR', unit: 'متر طولي', qty: 1500, price: 60 },
  ] });
  const after = PG.contractDetail(1);
  eq(after.retention_pct, before.retention_pct, 'نسبة المحتجزات');
  eq(after.advance_pct, before.advance_pct, 'نسبة الدفعة المقدمة');
  eq(after.advance_recovery_pct, before.advance_recovery_pct, 'نسبة الاسترداد');
  eq(after.vat_rate, before.vat_rate, 'نسبة الضريبة');
});

t('التحديث الجزئي يغيّر المُرسل فقط', () => {
  PG.saveContract(admin, { project_id: 1, retention_pct: 0.075 });
  const c = PG.contractDetail(1);
  eq(c.retention_pct, 0.075, 'المحتجزات تغيّرت');
  eq(c.advance_recovery_pct, 0.20, 'الاسترداد لم يتغيّر');
  PG.saveContract(admin, { project_id: 1, retention_pct: 0.05 });
});

t('رفض نسبة استرداد تتجاوز 100٪', () => {
  throws(() => PG.saveContract(admin, { project_id: 1, advance_recovery_pct: 1.5 }), 'بين 0 و 100');
});

console.log('\n══════ الدفعة المقدمة ══════');

t('قبض دفعة مقدمة 67,000 + ضريبة يولّد قيداً متوازناً', () => {
  const r = PG.receiveAdvance(admin, { contract_id: CID, amount: 67000 });
  eq(r.amount, 67000, 'المبلغ');
  eq(r.vat, 10050, 'الضريبة');
  eq(r.total, 77050, 'الإجمالي المقبوض');
  ok(balanced(), 'الميزانية غير متوازنة');
});

t('الدفعة المقدمة تظهر كالتزام في حساب 2600', () => {
  eq(L.balanceOf('2600'), 67000, 'رصيد الدفعات المقدمة');
});

console.log('\n══════ المستخلص الأول ══════');

let IPC1;
t('بناء مسودة المستخلص يحسب المنفّذ سابقاً = صفر', () => {
  const d = PG.ipcDraft(CID);
  eq(d.length, 4, 'عدد البنود');
  eq(d[0].qty_prev, 0, 'المنفّذ سابقاً');
  eq(d[0].qty_left, 2000, 'المتبقي');
});

t('إنشاء مستخلص بكميات جزئية', () => {
  const d = PG.ipcDraft(CID);
  IPC1 = PG.createIPC(pm, { contract_id: CID, to_date: '2026-08-31', lines: [
    { citem_id: d[0].citem_id, qty_this: 800 },   // 800*120  = 96,000
    { citem_id: d[1].citem_id, qty_this: 6 },     // 6*8000   = 48,000
    { citem_id: d[2].citem_id, qty_this: 10 },    // 10*4500  = 45,000
    { citem_id: d[3].citem_id, qty_this: 500 },   // 500*60   = 30,000
  ] });                                            // الإجمالي = 219,000
  ok(IPC1 > 0);
});

t('حساب المستخلص: محتجزات 5٪ واسترداد دفعة 20٪ وضريبة على الوعاء الصحيح', () => {
  const i = PG.ipcDetail(IPC1);
  eq(i.period_gross, 219000, 'قيمة الأعمال');
  eq(i.retention, 10950, 'المحتجزات 5٪');
  eq(i.advance_deduct, 43800, 'استرداد الدفعة 20٪');
  eq(i.net, 164250, 'الصافي');                      // 219000-10950-43800
  eq(i.vat, 26280, 'الضريبة');                       // (219000-43800)*0.15
  eq(i.total, 190530, 'المستحق');                    // 164250+26280
});

t('المهندس لا يستطيع اعتماد مستخلص', () => {
  throws(() => { if (!A.can(eng, 'approve', 'ipc')) throw new Error('لا تملك صلاحية'); }, 'لا تملك');
});

t('تقديم ثم اعتماد المستخلص يولّد قيداً متوازناً', () => {
  PG.submitIPC(pm, IPC1);
  const r = PG.approveIPC(admin, IPC1, true);
  ok(r.journal_id > 0, 'لم يُرحّل القيد');
  ok(balanced(), 'الميزانية غير متوازنة بعد المستخلص');
});

t('القيد يوزّع المبالغ على الحسابات الصحيحة', () => {
  const i = get1('SELECT journal_id FROM ipcs WHERE id=?', IPC1);
  const ls = q('SELECT account, debit, credit FROM jlines WHERE journal_id=?', i.journal_id);
  const by = a => ls.filter(l => l.account === a)
    .reduce((s, l) => s + l.debit - l.credit, 0);
  eq(by('1200'), 190530, 'ذمم مدينة');
  eq(by('1250'), 10950, 'محتجزات لدى العملاء');
  eq(by('2600'), 43800, 'استرداد الدفعة المقدمة');
  eq(by('4190'), -219000, 'الإيراد');
  eq(by('2200'), -26280, 'ضريبة المخرجات');
});

t('الدفعة المقدمة انخفضت بمقدار الاسترداد', () => {
  eq(L.balanceOf('2600'), 23200, 'المتبقي من الدفعة');   // 67000-43800
  const c = PG.contractDetail(1);
  eq(c.advance_outstanding, 23200, 'المتبقي في العقد');
});

t('نسبة إنجاز المشروع تُشتق من الكميات المعتمدة', () => {
  // 219000 / 670000 = 32.7%
  eq(get1('SELECT progress FROM projects WHERE id=1').progress, 33, 'نسبة الإنجاز');
});

console.log('\n══════ منع التجاوز والازدواج ══════');

t('لا يُسمح بمستخلصين مفتوحين في آن واحد', () => {
  const d = PG.ipcDraft(CID);
  PG.createIPC(pm, { contract_id: CID, lines: [{ citem_id: d[0].citem_id, qty_this: 10 }] });
  throws(() => PG.createIPC(pm, { contract_id: CID, lines: [{ citem_id: d[0].citem_id, qty_this: 10 }] }),
    'مستخلص مفتوح');
  // ننظّف المسودة
  const open = get1("SELECT id FROM ipcs WHERE contract_id=? AND status='مسودة'", CID);
  run('DELETE FROM ipcs WHERE id=?', open.id);
});

t('رفض كمية تتجاوز كمية العقد — يلزم أمر تغيير', () => {
  const d = PG.ipcDraft(CID);
  throws(() => PG.createIPC(pm, { contract_id: CID, lines: [
    { citem_id: d[0].citem_id, qty_this: 1500 } ] }), 'أمر تغيير');   // 800+1500 > 2000
});

t('المسودة تعكس الكميات المنفّذة فعلاً', () => {
  const d = PG.ipcDraft(CID);
  eq(d[0].qty_prev, 800, 'المنفّذ سابقاً');
  eq(d[0].qty_left, 1200, 'المتبقي');
});

console.log('\n══════ أوامر التغيير ══════');

let VO;
t('إنشاء أمر تغيير بقيمة 85,000', () => {
  const r = PG.createVO(pm, { contract_id: CID, descr: 'إضافة لوحة رئيسية وتغذية احتياطية',
    reason: 'طلب العميل', lines: [
      { descr: 'لوحة رئيسية 400A', unit: 'قطعة', qty: 1, price: 45000 },
      { descr: 'كابل تغذية احتياطي', unit: 'متر طولي', qty: 200, price: 200 },
    ] });
  VO = r.id;
  eq(r.amount, 85000, 'قيمة أمر التغيير');
});

t('أمر التغيير لا يغيّر قيمة العقد قبل الاعتماد', () => {
  eq(PG.contractDetail(1).value, 670000, 'قيمة العقد');
});

t('الاعتماد يُدخل البنود في العقد فترتفع قيمته', () => {
  const r = PG.approveVO(admin, VO, true);
  eq(r.new_contract_value, 755000, 'قيمة العقد بعد التغيير');   // 670000+85000
  const c = PG.contractDetail(1);
  eq(c.original_value, 670000, 'القيمة الأصلية محفوظة');
  eq(c.value - c.original_value, 85000, 'قيمة التغييرات');
});

t('بنود أمر التغيير صارت قابلة للاستخلاص', () => {
  const d = PG.ipcDraft(CID);
  eq(d.length, 6, 'عدد البنود بعد التغيير');
  ok(d.some(x => x.descr.includes('لوحة رئيسية 400A')), 'بند أمر التغيير غير موجود');
});

t('مدير المشاريع لا يعتمد أمر تغيير يتجاوز حدّه', () => {
  const r = PG.createVO(pm, { contract_id: CID, descr: 'توسعة كبيرة',
    lines: [{ descr: 'أعمال إضافية', unit: 'مقطوعية', qty: 1, price: 120000 }] });
  const limit = A.PERM.pm.limit;
  ok(r.amount > limit, 'المبلغ لا يتجاوز الحد');
  run("UPDATE vos SET status='ملغي' WHERE id=?", r.id);
});

console.log('\n══════ المستخلص الثاني ══════');

let IPC2;
t('مستخلص ثانٍ يعترف بالمنفّذ سابقاً ولا يكرره', () => {
  const d = PG.ipcDraft(CID);
  const c1 = d.find(x => x.descr.includes('مد كابلات'));
  eq(c1.qty_prev, 800, 'المنفّذ سابقاً');
  IPC2 = PG.createIPC(pm, { contract_id: CID, to_date: '2026-09-30', lines: [
    { citem_id: c1.citem_id, qty_this: 700 },                                    // 84,000
    { citem_id: d.find(x => x.descr.includes('لوحة رئيسية 400A')).citem_id, qty_this: 1 }, // 45,000
  ] });
  const i = PG.ipcDetail(IPC2);
  eq(i.period_gross, 129000, 'قيمة الفترة');
  eq(i.prev_gross, 219000, 'المنفّذ سابقاً');
});

t('الاسترداد لا يتجاوز المتبقي من الدفعة المقدمة', () => {
  const i = PG.ipcDetail(IPC2);
  // 20% من 129,000 = 25,800 والمتبقي 23,200 → يؤخذ 23,200 فقط
  eq(i.advance_deduct, 23200, 'الاسترداد محدود بالمتبقي');
});

t('اعتماد المستخلص الثاني — الميزانية تبقى متوازنة', () => {
  PG.submitIPC(pm, IPC2);
  PG.approveIPC(admin, IPC2, true);
  ok(balanced(), 'الميزانية غير متوازنة');
  eq(L.balanceOf('2600'), 0, 'الدفعة المقدمة استُردت بالكامل');
});

t('المحتجزات التراكمية صحيحة', () => {
  // 10,950 + 6,450 = 17,400
  const r = PG.customerRetention(1);
  eq(r.held, 17400, 'المحتجزات المحتجزة');
  eq(r.outstanding, 17400, 'المتبقي');
  eq(L.balanceOf('1250'), 17400, 'رصيد حساب المحتجزات');
});

console.log('\n══════ مقاولو الباطن ══════');

let SC;
t('إنشاء شهادة دفع لمقاول باطن مع محتجزات 5٪', () => {
  SC = PG.createSubcert(pm, { project_id: 1, vendor_id: 6, to_date: '2026-09-30',
    retention_pct: 0.05, lines: [
      { descr: 'تركيب وحدات تكييف', unit: 'قطعة', qty: 10, price: 2800 },
      { descr: 'مواسير نحاس ومجاري', unit: 'مقطوعية', qty: 1, price: 22000 },
    ] });                                              // 28,000 + 22,000 = 50,000
  const s = PG.subcertDetail(SC);
  eq(s.period_gross, 50000, 'قيمة الأعمال');
  eq(s.retention, 2500, 'المحتجزات');
  eq(s.net, 47500, 'الصافي');
  eq(s.vat, 7500, 'الضريبة');
  eq(s.total, 55000, 'المستحق');
});

t('اعتماد الشهادة يولّد قيداً متوازناً بحسابات صحيحة', () => {
  const r = PG.approveSubcert(admin, SC, true);
  ok(r.journal_id > 0);
  const ls = q('SELECT account, debit, credit FROM jlines WHERE journal_id=?', r.journal_id);
  const by = a => ls.filter(l => l.account === a).reduce((s, l) => s + l.debit - l.credit, 0);
  eq(by('5300'), 50000, 'تكلفة مقاولي الباطن');
  eq(by('1400'), 7500, 'ضريبة المدخلات');
  eq(by('2150'), -2500, 'محتجزات المقاول');
  eq(by('2100'), -55000, 'المستحق للمقاول');
  ok(balanced(), 'الميزانية غير متوازنة');
});

t('تكلفة المقاول تُحمَّل على المشروع', () => {
  const pl = L.projectPL(1);
  ok(pl.cost >= 50000, 'تكلفة المشروع لا تشمل المقاول: ' + pl.cost);
});

console.log('\n══════ إفراج المحتجزات ══════');

t('لا يُسمح بالإفراج عن أكثر من المحتجز', () => {
  throws(() => PG.releaseRetention(admin, { kind: 'customer', project_id: 1, amount: 50000 }),
    'المتبقية');
});

t('إفراج جزئي عن محتجزات العميل', () => {
  const r = PG.releaseRetention(admin, { kind: 'customer', project_id: 1, amount: 10000 });
  eq(r.remaining, 7400, 'المتبقي بعد الإفراج');
  eq(L.balanceOf('1250'), 7400, 'رصيد الحساب');
  ok(balanced(), 'الميزانية غير متوازنة');
});

t('إفراج عن محتجزات مقاول الباطن', () => {
  const r = PG.releaseRetention(admin, { kind: 'subcontractor', project_id: 1,
    partner_id: 6, amount: 1500 });
  eq(r.remaining, 1000, 'المتبقي');
  eq(L.balanceOf('2150'), 1000, 'رصيد محتجزات المقاولين');
  ok(balanced(), 'الميزانية غير متوازنة');
});

t('لوحة المحتجزات تطابق دفتر الأستاذ', () => {
  const b = PG.retentionBoard();
  eq(b.total_receivable, b.ledger_1250, 'محتجزات العملاء');
  eq(b.total_payable, b.ledger_2150, 'محتجزات المقاولين');
});

console.log('\n══════ ملخص المشروع ══════');

t('ملخص المشروع يجمع العقد والمنفّذ والمحتجز', () => {
  const s = PG.projectStatus(1);
  eq(s.contract_value, 755000, 'قيمة العقد');
  eq(s.variations, 85000, 'أوامر التغيير');
  eq(s.certified, 348000, 'المنفّذ المعتمد');           // 219000+129000
  eq(s.retention, 7400, 'المحتجزات المتبقية');
  eq(s.subcontract_cost, 50000, 'تكلفة مقاولي الباطن');
  eq(s.advance_outstanding, 0, 'الدفعة المقدمة');
});

t('الإيراد المعترف به يطابق المستخلصات المعتمدة', () => {
  const pl = L.projectPL(1);
  eq(pl.revenue, 348000, 'إيراد المشروع');
});

console.log('\n══════ سلامة الدفتر ══════');

t('الميزانية متوازنة في النهاية', () => ok(L.balanceSheet().balanced));
t('كل القيود متوازنة سطراً بسطر', () => {
  const bad = q(`SELECT journal_id, ROUND(SUM(debit)-SUM(credit),2) d
    FROM jlines GROUP BY journal_id HAVING ABS(d) > 0.011`);
  if (bad.length) throw new Error('قيود غير متوازنة: ' + JSON.stringify(bad));
});
t('لا قيد بسطر واحد', () => {
  const bad = q('SELECT journal_id, COUNT(*) n FROM jlines GROUP BY journal_id HAVING n < 2');
  if (bad.length) throw new Error('قيود ناقصة: ' + JSON.stringify(bad));
});

console.log(`\n${'═'.repeat(46)}`);
console.log(`  ناجح: ${pass}   ·   فاشل: ${fail}`);
console.log('═'.repeat(46) + '\n');
process.exit(fail ? 1 : 0);
