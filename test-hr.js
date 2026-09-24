'use strict';
/* اختبارات وحدة الرواتب الكاملة — السلف والإجازات والإضافي وWPS */
process.env.ERP_DB = '/tmp/hr-erp.db';
['', '-wal', '-shm'].forEach(x => require('node:fs').rmSync('/tmp/hr-erp.db' + x, { force: true }));

const A = require('./server');
const HR = require('./payroll');
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
const hr = A.login('mai', 'hr123').user;
const acc = A.login('noura', 'acc123').user;
const eng = A.login('saad', 'eng123').user;
const balanced = () => L.balanceSheet().balanced;

/* نفتح رصيداً نقدياً حتى تكون صرف السلف واقعية */
L.post({ ref: 'OPEN', date: '2026-01-01', memo: 'رصيد افتتاحي', user_id: admin.id,
  lines: [{ account: '1100', debit: 2000000, credit: 0 },
          { account: '3100', debit: 0, credit: 2000000 }] });

console.log('\n══════ الأجور وأساس GOSI ══════');

t('الأجر الشهري للموظف الثابت = الأساسي + كل البدلات', () => {
  const e = get1('SELECT * FROM employees WHERE code=?', 'EMP-00123');   // 12000+3000+800+500
  eq(HR.wages(e).monthly, 16300, 'الأجر الشهري');
});

t('أساس GOSI = الأساسي + السكن فقط', () => {
  const e = get1('SELECT * FROM employees WHERE code=?', 'EMP-00123');
  eq(HR.wages(e).gosi_base, 15000, 'أساس GOSI');
});

t('العامل اليومي: الأجر = اليومية × 26 ولا أساس GOSI', () => {
  const e = get1('SELECT * FROM employees WHERE code=?', 'EMP-00131');   // 350/يوم
  eq(HR.wages(e).monthly, 9100, 'الأجر الشهري');
  eq(HR.wages(e).gosi_base, 0, 'أساس GOSI');
});

t('أساس GOSI محدود بالسقف النظامي', () => {
  run("UPDATE employees SET basic=60000, housing=15000 WHERE code='EMP-00118'");
  const e = get1('SELECT * FROM employees WHERE code=?', 'EMP-00118');
  eq(HR.wages(e).gosi_base, 45000, 'السقف');
  run("UPDATE employees SET basic=18000, housing=4500 WHERE code='EMP-00118'");
});

console.log('\n══════ السلف ══════');

let ADV;
t('طلب سلفة 30,000 على 6 أشهر', () => {
  const r = HR.requestAdvance(hr, { employee_id: 2, amount: 30000, months: 6 });
  ADV = r.id;
  eq(r.monthly, 5000, 'القسط الشهري');
});

t('رفض سلفة تتجاوز سقف ثلاثة رواتب', () => {
  // الراتب 16,300 → السقف 48,900 والمفتوح 30,000 → المتاح 18,900
  throws(() => HR.requestAdvance(hr, { employee_id: 2, amount: 25000 }), 'يتجاوز سقف');
});

t('السلفة لا تُصرف قبل الاعتماد', () => {
  eq(HR.advanceBalance(2).outstanding, 0, 'الرصيد قبل الاعتماد');
});

t('الاعتماد يصرف نقداً ويسجّل ذمّة على الموظف', () => {
  const r = HR.approveAdvance(admin, ADV, true);
  ok(r.journal_id > 0);
  eq(L.balanceOf('1150'), 30000, 'سلف الموظفين');
  eq(HR.advanceBalance(2).outstanding, 30000, 'المتبقي');
  ok(balanced(), 'الميزانية غير متوازنة');
});

t('لا تُعتمد السلفة مرتين', () => {
  throws(() => HR.approveAdvance(admin, ADV, true), 'محسوم');
});

console.log('\n══════ الإجازات ══════');

t('الرصيد يتراكم بالتناسب مع مدة الخدمة', () => {
  const b = HR.leaveBalance(2);
  eq(b.entitlement, 21, 'الاستحقاق السنوي');
  ok(b.accrued > 0 && b.accrued <= 21, 'المتراكم خارج المدى: ' + b.accrued);
});

let LV;
t('طلب إجازة سنوية 10 أيام', () => {
  const r = HR.requestLeave(hr, { employee_id: 2, from_date: '2026-10-05',
    to_date: '2026-10-14', kind: 'سنوية' });
  LV = r.id;
  eq(r.days, 10, 'عدد الأيام');
});

t('رفض إجازة تتجاوز الرصيد', () => {
  throws(() => HR.requestLeave(hr, { employee_id: 2, from_date: '2026-11-01',
    to_date: '2026-12-31', kind: 'سنوية' }), 'الرصيد المتاح');
});

t('رفض إجازة متداخلة مع طلب قائم', () => {
  throws(() => HR.requestLeave(hr, { employee_id: 2, from_date: '2026-10-10',
    to_date: '2026-10-12' }), 'متداخل');
});

t('الاعتماد يخصم من الرصيد', () => {
  const before = HR.leaveBalance(2).remaining;
  HR.approveLeave(hr, LV, true);
  eq(HR.leaveBalance(2).remaining, before - 10, 'الرصيد بعد الاعتماد');
});

t('الإجازة غير المدفوعة تُحسب ضمن شهر المسير', () => {
  const r = HR.requestLeave(hr, { employee_id: 3, from_date: '2026-11-10',
    to_date: '2026-11-14', kind: 'بدون راتب', paid: false });
  HR.approveLeave(hr, r.id, true);
  eq(HR.unpaidDaysIn(3, '2026-11'), 5, 'أيام بدون راتب');
  eq(HR.unpaidDaysIn(3, '2026-10'), 0, 'شهر آخر');
});

console.log('\n══════ المسير: إضافي ومكافآت وخصومات ══════');

let PR;
t('فتح مسير نوفمبر', () => {
  const r = HR.openPayrun(hr, '2026-11');
  PR = r.id;
  ok(PR > 0);
});

t('الإضافي يُحسب بمعامل 1.5 من أجر الساعة', () => {
  // سعد: 16,300/30/8 = 67.92 ريال/ساعة × 1.5 × 20 ساعة = 2,037.60
  const r = HR.addPayItem(hr, { payrun_id: PR, employee_id: 2, kind: 'إضافي', hours: 20 });
  eq(r.amount, 2037.6, 'قيمة الإضافي');
});

t('رفض ساعات إضافي غير منطقية', () => {
  throws(() => HR.addPayItem(hr, { payrun_id: PR, employee_id: 2, kind: 'إضافي', hours: 500 }),
    'غير منطقية');
});

t('إضافة مكافأة وخصم', () => {
  HR.addPayItem(hr, { payrun_id: PR, employee_id: 2, kind: 'مكافأة', amount: 3000, descr: 'إنجاز مشروع' });
  HR.addPayItem(hr, { payrun_id: PR, employee_id: 2, kind: 'خصم', amount: 500, descr: 'تأخير' });
  const items = q('SELECT * FROM payitems WHERE payrun_id=? AND employee_id=2', PR);
  eq(items.length, 3, 'عدد البنود');
});

console.log('\n══════ حساب المسير ══════');

let TOT;
t('حساب المسير يجمع كل المكوّنات', () => {
  TOT = HR.computePayrun(PR);
  ok(TOT.count >= 6, 'عدد الموظفين: ' + TOT.count);
  ok(TOT.gross > 0 && TOT.net > 0);
});

t('قسيمة سعد: الأجر + الإضافي + المكافأة − GOSI − قسط السلفة − الخصم', () => {
  const s = get1('SELECT * FROM payslips WHERE payrun_id=? AND employee_id=2', PR);
  eq(s.gross, 21337.6, 'الإجمالي');            // 16300 + 2037.6 + 3000
  eq(s.gosi_emp, 1500, 'حصة الموظف GOSI');     // 15000 × 10%
  eq(s.gosi_er, 1800, 'حصة صاحب العمل');       // 15000 × 12%
  eq(s.advance_deduct, 5000, 'قسط السلفة');
  eq(s.deduct, 500, 'الخصم');
  eq(s.net, 14337.6, 'الصافي');                 // 21337.6 − 1500 − 5000 − 500
});

t('الإجازة بدون راتب تخصم بالتناسب', () => {
  const e = get1('SELECT * FROM employees WHERE id=3');
  const s = get1('SELECT * FROM payslips WHERE payrun_id=? AND employee_id=3', PR);
  eq(s.unpaid_days, 5, 'أيام بدون راتب');
  eq(s.unpaid_amount, Math.round(HR.wages(e).monthly / 30 * 5 * 100) / 100, 'قيمة الخصم');
  eq(s.gross, Math.round((HR.wages(e).monthly - s.unpaid_amount) * 100) / 100, 'الإجمالي بعد الخصم');
});

t('العامل اليومي غير خاضع لاشتراك الموظف', () => {
  const e = get1("SELECT id FROM employees WHERE code='EMP-00131'");
  const s = get1('SELECT * FROM payslips WHERE payrun_id=? AND employee_id=?', PR, e.id);
  eq(s.gosi_emp, 0, 'حصة الموظف');
});

console.log('\n══════ اعتماد المسير ══════');

t('الاعتماد يُرحّل قيداً متوازناً', () => {
  const r = HR.approvePayrun(admin, PR);
  ok(r.journal_id > 0);
  ok(balanced(), 'الميزانية غير متوازنة بعد المسير');
});

t('القيد يوزّع على الحسابات الصحيحة', () => {
  const pr = get1('SELECT journal_id FROM payruns WHERE id=?', PR);
  const ls = q('SELECT account, debit, credit FROM jlines WHERE journal_id=?', pr.journal_id);
  const by = a => ls.filter(l => l.account === a).reduce((s, l) => s + l.debit - l.credit, 0);
  eq(by('2300'), -TOT.net, 'صافي مستحق');
  eq(by('2400'), -(TOT.gosi_emp + TOT.gosi_er), 'GOSI مستحقة');
  eq(by('1150'), -TOT.advance, 'استرداد السلف');
  eq(by('5400'), TOT.gosi_er, 'GOSI صاحب العمل');
});

t('السلفة انخفضت بمقدار القسط المسترد', () => {
  eq(HR.advanceBalance(2).outstanding, 25000, 'المتبقي من السلفة');
  eq(L.balanceOf('1150'), 25000, 'رصيد حساب السلف');
});

t('لا يُعتمد المسير مرتين', () => {
  throws(() => HR.approvePayrun(admin, PR), 'معتمد');
});

t('المسير المعتمد لا يقبل بنوداً جديدة', () => {
  throws(() => HR.addPayItem(hr, { payrun_id: PR, employee_id: 2, kind: 'مكافأة', amount: 100 }),
    'لا يقبل التعديل');
});

console.log('\n══════ ملف حماية الأجور WPS ══════');

t('يرفض التوليد قبل اكتمال الحسابات البنكية', () => {
  throws(() => HR.generateWPS(admin, PR), 'IBAN');
});

t('يولّد الملف بعد استكمال البيانات', () => {
  q('SELECT id, code FROM employees').forEach((e, i) => {
    run('UPDATE employees SET iban=?, iqama=?, bank=? WHERE id=?',
        'SA' + String(3000000000000000000000 + e.id).slice(0, 22), '23456789' + String(10 + i), 'الأهلي', e.id);
  });
  const r = HR.generateWPS(admin, PR);
  ok(r.nlines >= 6, 'عدد السطور');
  eq(r.total, TOT.net, 'إجمالي الملف = صافي المسير');
});

t('الملف يتبع صيغة وزارة الموارد البشرية', () => {
  const w = get1('SELECT content FROM wpsfiles WHERE payrun_id=?', PR);
  const c = w.content;
  ['[DEST-ID]', '[ESTB-ID]', '[32A-CCY]', '[32A-AMT]', '[MOL-ESTBID]',
   '[32B-AMT]', '[59-ACC]', '[59-NAME]', '[MOL-BAS]', '[MOL-HAL]',
   '[MOL-OEA]', '[MOL-DED]', '[MOL-ID]'].forEach(tag => {
     if (!c.includes(tag)) throw new Error('الوسم ناقص: ' + tag);
   });
  ok(c.includes('SAR'), 'العملة');
});

t('إجمالي الترويسة = مجموع صافي القسائم', () => {
  const w = get1('SELECT content FROM wpsfiles WHERE payrun_id=?', PR);
  const head = +(w.content.match(/\[32A-AMT\]\t([\d.]+)/) || [])[1];
  const sum = (w.content.match(/\[32B-AMT\]\t([\d.]+)/g) || [])
    .reduce((s, m) => s + parseFloat(m.split('\t')[1]), 0);
  eq(head, Math.round(sum * 100) / 100, 'تطابق الإجمالي');
});

t('كل موظف له سطر واحد بحساب بنكي', () => {
  const w = get1('SELECT content FROM wpsfiles WHERE payrun_id=?', PR);
  const accs = (w.content.match(/\[59-ACC\]\t(\S+)/g) || []);
  eq(accs.length, TOT.count, 'عدد الحسابات');
  ok(accs.every(a => a.includes('SA')), 'صيغة IBAN');
});

console.log('\n══════ تنبيهات انتهاء المستندات ══════');

t('يرصد الإقامات المنتهية والقريبة من الانتهاء', () => {
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const past = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const far = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
  run('UPDATE employees SET iqama_exp=? WHERE id=2', soon);
  run('UPDATE employees SET iqama_exp=? WHERE id=3', past);
  run('UPDATE employees SET iqama_exp=? WHERE id=4', far);
  const list = HR.expiringDocs(60);
  const ids = list.map(x => x.employee_id);
  ok(ids.includes(2), 'القريبة لم تُرصد');
  ok(ids.includes(3), 'المنتهية لم تُرصد');
  ok(!ids.includes(4), 'البعيدة رُصدت خطأً');
});

t('المنتهية تُعلَّم وتأتي أولاً', () => {
  const list = HR.expiringDocs(60);
  ok(list[0].expired, 'الترتيب خاطئ');
  ok(list[0].days_left < 0, 'الأيام المتبقية');
});

console.log('\n══════ لوحة الموارد البشرية ══════');

t('اللوحة تجمع الأعداد والالتزامات', () => {
  const d = HR.hrDashboard();
  ok(d.headcount >= 6, 'عدد الموظفين');
  eq(d.advances_outstanding, 25000, 'السلف القائمة');
  eq(d.gosi_liability, TOT.gosi_emp + TOT.gosi_er, 'التزام GOSI');
  ok(d.expiring.length >= 2, 'التنبيهات');
});

console.log('\n══════ سلامة الدفتر ══════');

t('الميزانية متوازنة', () => ok(L.balanceSheet().balanced));
t('كل القيود متوازنة سطراً بسطر', () => {
  const bad = q(`SELECT journal_id, ROUND(SUM(debit)-SUM(credit),2) d
    FROM jlines GROUP BY journal_id HAVING ABS(d) > 0.011`);
  if (bad.length) throw new Error('قيود غير متوازنة: ' + JSON.stringify(bad));
});

console.log(`\n${'═'.repeat(46)}`);
console.log(`  ناجح: ${pass}   ·   فاشل: ${fail}`);
console.log('═'.repeat(46) + '\n');
process.exit(fail ? 1 : 0);
