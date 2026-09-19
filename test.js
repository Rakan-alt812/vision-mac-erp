'use strict';
process.env.ERP_DB = '/tmp/test-erp.db';
require('node:fs').rmSync('/tmp/test-erp.db', { force: true });
require('node:fs').rmSync('/tmp/test-erp.db-wal', { force: true });
require('node:fs').rmSync('/tmp/test-erp.db-shm', { force: true });

const A = require('./server');
const L = require('./ledger');
const Z = require('./zatca');
const { q, get1 } = require('./db');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      → ' + e.message); fail++; }
}
function eq(a, b, m) {
  if (Math.abs((+a) - (+b)) > 0.011) throw new Error((m || '') + ' توقعت ' + b + ' لكن جاء ' + a);
}
function throws(fn, frag) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (frag && !e.message.includes(frag)) throw new Error('رسالة خطأ مختلفة: ' + e.message);
  }
  if (!threw) throw new Error('كان يجب أن يرفض العملية');
}

const admin = A.login('admin', 'admin123').user;
const acc = A.login('noura', 'acc123').user;
const pm = A.login('ahmad', 'pm123').user;
const eng = A.login('saad', 'eng123').user;
const store = A.login('fahad', 'store123').user;

console.log('\n── المصادقة والصلاحيات ──');
t('كلمة مرور خاطئة تُرفض', () => { if (A.login('admin', 'wrong')) throw new Error('قبل كلمة خاطئة'); });
t('المهندس لا يملك صلاحية الفواتير', () => {
  if (A.can(eng, 'write', 'invoices')) throw new Error('المهندس يستطيع إصدار فواتير!');
});
t('المحاسب يملك صلاحية الفواتير', () => {
  if (!A.can(acc, 'write', 'invoices')) throw new Error('المحاسب محروم');
});
t('أمين المستودع لا يعتمد أوامر الشراء', () => {
  if (A.can(store, 'approve', 'po')) throw new Error('أمين المستودع يعتمد!');
});

console.log('\n── محرك القيد المزدوج ──');
t('يرفض القيد غير المتوازن', () => {
  throws(() => L.post({ date: '2026-09-01', lines: [
    { account: '1100', debit: 100, credit: 0 },
    { account: '4110', debit: 0, credit: 90 }] }), 'غير متوازن');
});
t('يرفض حساباً غير معرّف', () => {
  throws(() => L.post({ date: '2026-09-01', lines: [
    { account: '9999', debit: 100, credit: 0 },
    { account: '4110', debit: 0, credit: 100 }] }), 'غير معرّف');
});
t('يرفض سطراً مديناً ودائناً معاً', () => {
  throws(() => L.post({ date: '2026-09-01', lines: [
    { account: '1100', debit: 50, credit: 50 },
    { account: '4110', debit: 0, credit: 50 }] }), 'مدين أو دائن');
});
t('يقبل القيد المتوازن', () => {
  const id = L.post({ date: '2026-01-01', memo: 'رأس المال الافتتاحي',
    lines: [{ account: '1100', debit: 500000, credit: 0 },
            { account: '3100', debit: 0, credit: 500000 }], user_id: admin.id });
  if (!id) throw new Error('لم يُرجع رقم قيد');
});

console.log('\n── دورة الفاتورة ──');
let invId, invTotals;
t('المهندس يُمنع من إصدار فاتورة', () => {
  throws(() => A.createInvoice(eng, { customer_id: 1, lines: [{ descr: 'x', price: 100 }] }), 'صلاحية');
});
t('يرفض عميلاً برقم ضريبي غير صالح', () => {
  const { run } = require('./db');
  run("INSERT INTO partners(kind,name,vat) VALUES('customer','عميل بلا رقم','123')");
  const bad = get1("SELECT id FROM partners WHERE name='عميل بلا رقم'").id;
  throws(() => A.createInvoice(acc, { customer_id: bad, lines: [{ descr: 'x', price: 100 }] }), 'الرقم الضريبي');
});
t('المحاسب ينشئ فاتورة', () => {
  invId = A.createInvoice(acc, {
    customer_id: 1, project_id: 1, idate: '2026-09-10', ddate: '2026-10-10',
    lines: [
      { descr: 'أعمال كهربائية', account: '4110', qty: 1, price: 45000 },
      { descr: 'أعمال سباكة', account: '4130', qty: 1, price: 32000 },
      { descr: 'وحدات تكييف', account: '4120', qty: 8, price: 3800 },
    ] });
  if (!invId) throw new Error('لم تُنشأ');
});
t('الإجمالي = 107,400 + ضريبة 16,110 = 123,510', () => {
  invTotals = A.invoiceTotal(invId);
  eq(invTotals.net, 107400, 'الصافي');
  eq(invTotals.vat, 16110, 'الضريبة');
  eq(invTotals.total, 123510, 'الإجمالي');
});
t('الترحيل ينشئ قيداً متوازناً', () => {
  const r = A.postInvoice(acc, invId);
  const j = q('SELECT * FROM jlines WHERE journal_id=?', r.journal_id);
  const d = j.reduce((s, l) => s + l.debit, 0), c = j.reduce((s, l) => s + l.credit, 0);
  eq(d, c, 'المدين مقابل الدائن');
  eq(d, 123510, 'إجمالي القيد');
});
t('الإيراد موزّع على ثلاثة حسابات', () => {
  const j = get1('SELECT journal_id FROM invoices WHERE id=?', invId).journal_id;
  const rev = q("SELECT account,credit FROM jlines WHERE journal_id=? AND account LIKE '4%'", j);
  if (rev.length !== 3) throw new Error('توقعت 3 حسابات إيراد، وجدت ' + rev.length);
  eq(rev.find(r => r.account === '4110').credit, 45000, 'كهرباء');
  eq(rev.find(r => r.account === '4120').credit, 30400, 'ميكانيكا');
  eq(rev.find(r => r.account === '4130').credit, 32000, 'سباكة');
});
t('لا يمكن ترحيل الفاتورة مرتين', () => {
  throws(() => A.postInvoice(acc, invId), 'مرحّلة مسبقاً');
});

console.log('\n── ZATCA ──');
let stamp;
t('الختم يولّد UUID وبصمة و QR', () => {
  stamp = A.stampZatca(acc, invId);
  if (!stamp.uuid || !stamp.hash || !stamp.qr) throw new Error('نتيجة ناقصة');
});
t('QR يُفك إلى 8 وسوم TLV', () => {
  const tags = Z.decodeQR(stamp.qr);
  if (tags.length !== 8) throw new Error('عدد الوسوم ' + tags.length);
});
t('وسم 4 = الإجمالي شامل الضريبة', () => {
  const tags = Z.decodeQR(stamp.qr);
  eq(tags.find(x => x.tag === 4).value, 123510, 'إجمالي QR');
});
t('وسم 5 = مبلغ الضريبة', () => {
  const tags = Z.decodeQR(stamp.qr);
  eq(tags.find(x => x.tag === 5).value, 16110, 'ضريبة QR');
});
t('وسم 2 = الرقم الضريبي للبائع', () => {
  const tags = Z.decodeQR(stamp.qr);
  if (tags.find(x => x.tag === 2).value !== '310098765400003') throw new Error('رقم ضريبي خاطئ');
});
t('XML يحتوي UBL والإجمالي الصحيح', () => {
  const x = get1('SELECT zatca_xml FROM invoices WHERE id=?', invId).zatca_xml;
  if (!x.includes('urn:oasis:names:specification:ubl')) throw new Error('ليس UBL');
  if (!x.includes('123510.00')) throw new Error('الإجمالي غير موجود في XML');
  if (!x.includes('310012345600003')) throw new Error('رقم العميل الضريبي غير موجود');
});
t('التحقق من الرقم الضريبي السعودي', () => {
  if (!Z.validVAT('310012345600003')) throw new Error('رفض رقماً صحيحاً');
  if (Z.validVAT('410012345600003')) throw new Error('قبل رقماً لا يبدأ بـ 3');
  if (Z.validVAT('31001234560000')) throw new Error('قبل 14 رقماً');
});

console.log('\n── المدفوعات ──');
t('يرفض دفعة أكبر من المتبقي', () => {
  throws(() => A.recordPayment(admin, { kind: 'قبض', partner_id: 1, invoice_id: invId, amount: 200000 }), 'المتبقي');
});
t('المحاسب مقيّد بحد 20,000', () => {
  throws(() => A.recordPayment(acc, { kind: 'قبض', partner_id: 1, invoice_id: invId, amount: 50000 }), 'حدّ صلاحيتك');
});
t('دفعة جزئية تُسجَّل والفاتورة تبقى معلقة', () => {
  A.recordPayment(admin, { kind: 'قبض', partner_id: 1, invoice_id: invId, amount: 44900, pdate: '2026-09-15' });
  const s = get1('SELECT status FROM invoices WHERE id=?', invId).status;
  if (s !== 'معلقة') throw new Error('الحالة ' + s);
});
t('السداد الكامل يحوّلها إلى مدفوعة', () => {
  A.recordPayment(admin, { kind: 'قبض', partner_id: 1, invoice_id: invId, amount: 78610, pdate: '2026-09-20' });
  const s = get1('SELECT status FROM invoices WHERE id=?', invId).status;
  if (s !== 'مدفوعة') throw new Error('الحالة ' + s);
});

console.log('\n── أوامر الشراء والاعتماد ──');
let poId;
t('مدير المشاريع ينشئ أمر شراء', () => {
  poId = A.createPO(pm, { vendor_id: 4, project_id: 1, warehouse_id: 1, pdate: '2026-09-12',
    lines: [{ material_id: 1, qty: 200, price: 45 }, { material_id: 2, qty: 50, price: 28 }] });
  eq(A.poTotal(poId), 10400, 'إجمالي الأمر');
});
t('لا يمكن الاستلام قبل الاعتماد', () => {
  throws(() => A.receivePO(store, poId, [{ line_id: 1, qty: 10 }]), 'غير معتمد');
});
t('التقديم يُنشئ طلب اعتماد', () => {
  const r = A.submitPO(pm, poId);
  eq(r.amount, 10400);
  if (!get1("SELECT id FROM approvals WHERE doc_id=? AND status='معلق'", poId)) throw new Error('لا يوجد طلب');
});
t('المهندس لا يستطيع الاعتماد', () => {
  throws(() => A.approvePO(eng, poId, true), 'صلاحية');
});
t('مدير المشاريع يعتمد ضمن حده', () => {
  A.approvePO(pm, poId, true);
  if (get1('SELECT status FROM pos WHERE id=?', poId).status !== 'معتمد') throw new Error('لم يُعتمد');
});
t('أمر يتجاوز 50,000 يُرفض من مدير المشاريع', () => {
  const big = A.createPO(pm, { vendor_id: 4, project_id: 1,
    lines: [{ material_id: 3, qty: 10, price: 7750 }] });
  A.submitPO(pm, big);
  throws(() => A.approvePO(pm, big, true), 'يتجاوز حدّ اعتمادك');
  A.approvePO(admin, big, true);
  if (get1('SELECT status FROM pos WHERE id=?', big).status !== 'معتمد') throw new Error('المالك لم يعتمد');
});

console.log('\n── الاستلام والمخزون ──');
t('الاستلام يزيد المخزون وينشئ قيداً', () => {
  const before = get1('SELECT qty FROM stock WHERE material_id=1 AND warehouse_id=1').qty;
  const lines = q('SELECT id FROM polines WHERE po_id=?', poId);
  const r = A.receivePO(store, poId, [{ line_id: lines[0].id, qty: 200 }, { line_id: lines[1].id, qty: 50 }]);
  eq(r.value, 10400, 'قيمة الاستلام');
  const after = get1('SELECT qty FROM stock WHERE material_id=1 AND warehouse_id=1').qty;
  eq(after - before, 200, 'الزيادة في المخزون');
});
t('قيد الاستلام يشمل ضريبة المدخلات', () => {
  const j = get1('SELECT journal_id FROM pos WHERE id=?', poId).journal_id;
  const input = q("SELECT debit FROM jlines WHERE journal_id=? AND account='1400'", j);
  eq(input[0].debit, 1560, 'ضريبة مدخلات 15% من 10,400');
});
t('يرفض استلاماً يتجاوز المطلوب', () => {
  const p2 = A.createPO(pm, { vendor_id: 4, project_id: 1, warehouse_id: 1,
    lines: [{ material_id: 2, qty: 10, price: 28 }] });
  A.submitPO(pm, p2); A.approvePO(pm, p2, true);
  const ln = get1('SELECT id FROM polines WHERE po_id=?', p2).id;
  throws(() => A.receivePO(store, p2, [{ line_id: ln, qty: 11 }]), 'تتجاوز');
});
t('يرفض صرف كمية أكبر من المتاح', () => {
  throws(() => A.issueMaterial(store, { material_id: 6, warehouse_id: 1, qty: 9999, project_id: 1 }), 'المتاحة');
});
t('الصرف ينقص المخزون ويحمّل تكلفة المشروع', () => {
  const before = L.projectPL(1).cost;
  const r = A.issueMaterial(store, { material_id: 1, warehouse_id: 1, qty: 100, project_id: 1 });
  eq(r.cost, 4500, 'تكلفة الصرف');
  const after = L.projectPL(1).cost;
  eq(after - before, 4500, 'الزيادة في تكلفة المشروع');
});

console.log('\n── ساعات العمل ──');
t('يرفض ساعات خارج النطاق', () => {
  throws(() => A.logTime(eng, { project_id: 1, employee_id: 2, hours: 30 }), 'بين 1 و 16');
});
t('الساعات تُحمّل على المشروع', () => {
  const before = L.projectPL(1).cost;
  A.logTime(eng, { project_id: 1, employee_id: 2, hours: 8, tdate: '2026-09-14' });
  eq(L.projectPL(1).cost - before, 600, '8 ساعات × 75');
});

console.log('\n── الرواتب ──');
t('مسير الرواتب ينشئ قيداً متوازناً', () => {
  const r = A.runPayroll(admin, '2026-09');
  const j = q('SELECT * FROM jlines WHERE journal_id=?', r.journal_id);
  const d = j.reduce((s, l) => s + l.debit, 0), c = j.reduce((s, l) => s + l.credit, 0);
  eq(d, c, 'توازن مسير الرواتب');
  if (r.count !== 6) throw new Error('عدد الموظفين ' + r.count);
});
t('GOSI 10% موظف و 12% صاحب عمل على الأساسي+السكن', () => {
  const p = get1('SELECT * FROM payslips WHERE employee_id=2');
  eq(p.gross, 16300, 'إجمالي سعد');
  eq(p.gosi_emp, 1500, 'GOSI موظف من 15,000');
  eq(p.gosi_er, 1800, 'GOSI صاحب عمل');
  eq(p.net, 14800, 'الصافي');
});
t('الموظف اليومي: 26 يوماً بلا GOSI', () => {
  const p = get1('SELECT * FROM payslips WHERE employee_id=4');
  eq(p.gross, 9100, '350 × 26');
  eq(p.gosi_emp, 0, 'لا GOSI على اليومي');
});
t('لا يمكن تكرار مسير نفس الشهر', () => {
  throws(() => A.runPayroll(admin, '2026-09'), 'موجود مسبقاً');
});

console.log('\n── نهاية الخدمة ──');
t('4.5 سنة استقالة = ثلث المكافأة', () => {
  const r = A.eos(2, '2026-09-15', 'استقالة');
  eq(r.years, 4.5, 'سنوات الخدمة');
  eq(r.wage, 16300, 'الأجر الشامل');
  eq(r.gratuity_full, 36675, 'نصف شهر × 4.5');
  eq(r.payable, 12225, 'الثلث');
});
t('إنهاء من صاحب العمل = المكافأة كاملة', () => {
  const r = A.eos(2, '2026-09-15', 'إنهاء');
  eq(r.payable, 36675, 'كاملة');
});

console.log('\n── التقارير المالية ──');
t('ميزان المراجعة متوازن', () => {
  const tb = L.trialBalance();
  const d = tb.reduce((s, r) => s + r.td, 0), c = tb.reduce((s, r) => s + r.tc, 0);
  eq(d, c, 'ميزان المراجعة');
});
t('الميزانية العمومية متوازنة (أصول = خصوم + حقوق)', () => {
  const bs = L.balanceSheet();
  if (!bs.balanced) throw new Error('غير متوازنة: أصول ' + bs.total_assets +
    ' مقابل ' + (bs.total_liabilities + bs.total_equity));
});
t('قائمة الدخل تعكس الإيراد الفعلي', () => {
  const pl = L.pnl('2026-01-01', '2026-12-31');
  eq(pl.total_income, 107400, 'الإيراد');
  if (pl.total_expense <= 0) throw new Error('لا مصروفات');
});
t('إقرار الضريبة = مخرجات − مدخلات', () => {
  const v = L.vatReturn('2026-01-01', '2026-12-31');
  eq(v.output_vat, 16110, 'ضريبة المخرجات');
  eq(v.due, v.output_vat - v.input_vat, 'الصافي');
});
t('أعمار الذمم تُصنّف حسب التأخير', () => {
  const inv2 = A.createInvoice(acc, { customer_id: 2, idate: '2026-05-01', ddate: '2026-05-15',
    lines: [{ descr: 'أعمال', account: '4110', qty: 1, price: 40000 }] });
  A.postInvoice(acc, inv2);
  const a = L.agedReceivables('2026-09-15');
  if (a.buckets.d90p <= 0) throw new Error('لم تُصنَّف في +90 يوم');
});
t('ربحية المشروع تكشف تجاوز الصرف', () => {
  const pl = L.projectPL(1);
  if (pl.cost <= 0) throw new Error('لا تكلفة على المشروع');
  if (typeof pl.risk !== 'boolean') throw new Error('مؤشر الخطر مفقود');
});

console.log('\n── القيد العكسي ──');
t('العكس ينشئ قيداً معاكساً ولا يحذف', () => {
  const before = get1('SELECT COUNT(*) c FROM journals').c;
  const j = get1('SELECT journal_id FROM invoices WHERE id=?', invId).journal_id;
  L.reverse(j, admin.id, 'اختبار');
  const after = get1('SELECT COUNT(*) c FROM journals').c;
  if (after !== before + 1) throw new Error('لم يُنشأ قيد عكسي');
  if (!get1('SELECT id FROM journals WHERE id=?', j)) throw new Error('حُذف القيد الأصلي!');
  const tb = L.trialBalance();
  eq(tb.reduce((s, r) => s + r.td, 0), tb.reduce((s, r) => s + r.tc, 0), 'التوازن بعد العكس');
});

console.log('\n── سجل التدقيق ──');
t('العمليات الحساسة مسجّلة', () => {
  const n = get1("SELECT COUNT(*) c FROM audit WHERE action IN ('post','zatca','approve','payment','payroll')").c;
  if (n < 5) throw new Error('عدد السجلات ' + n);
});
t('محاولة الدخول الفاشلة مسجّلة', () => {
  if (!get1("SELECT id FROM audit WHERE action='login-fail'")) throw new Error('غير مسجّلة');
});

console.log('\n' + '─'.repeat(46));
console.log(`نجح ${pass} · فشل ${fail}`);
process.exit(fail ? 1 : 0);
