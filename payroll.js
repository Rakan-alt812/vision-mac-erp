'use strict';
/* ═══════════════════════════════════════════════════════════════
   الرواتب الكاملة — السلف · الإجازات · الإضافي · GOSI · WPS
   ───────────────────────────────────────────────────────────────
   نسب GOSI تُقرأ من الإعدادات لا من الكود، لأن النظام السعودي
   يرفعها تدريجياً سنوياً — تثبيتها في الكود يعني خطأً كل يناير.
   ═══════════════════════════════════════════════════════════════ */
const { db, q, get1, run } = require('./db');
const L = require('./ledger');

const R2 = L.R2;
const today = () => new Date().toISOString().slice(0, 10);
const S = k => (get1('SELECT v FROM settings WHERE k=?', k) || {}).v;
const num = v => Number(v) || 0;
const setNum = (k, dflt) => { const v = S(k); return v == null ? dflt : parseFloat(v); };

/* الأجر الشهري الكامل والأجر الخاضع لـ GOSI */
function wages(e) {
  const monthly = e.ptype === 'يومي'
    ? R2(num(e.basic) * 26)
    : R2(num(e.basic) + num(e.housing) + num(e.transport) + num(e.site));
  const gosiBase = e.ptype === 'يومي' ? 0 : R2(num(e.basic) + num(e.housing));
  const cap = setNum('gosi_cap', 45000);
  return { monthly, gosi_base: R2(Math.min(gosiBase, cap)) };
}

const hourlyRate = e => {
  const w = wages(e).monthly;
  return R2(w / 30 / 8);
};

/* ═══════════════ السلف ═══════════════ */

function requestAdvance(user, d) {
  const e = get1('SELECT * FROM employees WHERE id=?', d.employee_id);
  if (!e) throw new Error('الموظف غير موجود');
  const amt = R2(d.amount);
  if (amt <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
  const months = Math.max(1, Math.round(num(d.months) || 1));
  if (months > 24) throw new Error('التقسيط لا يتجاوز 24 شهراً');

  const w = wages(e).monthly;
  /* الطلبات المعلّقة تُحتسب ضمن السقف — وإلا كدّس الموظف عدة طلبات
     كلٌّ منها تحت السقف وتجاوزه مجموعُها عند الاعتماد. */
  const openLeft = R2(num(get1(`SELECT COALESCE(SUM(amount-recovered),0) s FROM advances
    WHERE employee_id=? AND status IN ('معتمد','معلق')`, e.id).s));
  const cap = R2(w * setNum('advance_cap_months', 3));
  if (R2(openLeft + amt) > cap)
    throw new Error(`إجمالي السلف ${R2(openLeft + amt)} يتجاوز سقف ${cap} (${setNum('advance_cap_months', 3)} أشهر من الراتب)`);

  const n = num(get1('SELECT COUNT(*) c FROM advances').c) + 1;
  const info = run(`INSERT INTO advances(code,employee_id,adate,amount,months,monthly,
    status,note,created_by) VALUES(?,?,?,?,?,?,'معلق',?,?)`,
    'ADV-' + String(n).padStart(4, '0'), e.id, d.adate || today(), amt, months,
    R2(amt / months), d.note || null, user.id);
  return { id: Number(info.lastInsertRowid), amount: amt, monthly: R2(amt / months) };
}

/* الاعتماد يصرف السلفة نقداً ويسجّلها ذمّة على الموظف */
function approveAdvance(user, id, ok, note) {
  const a = get1('SELECT * FROM advances WHERE id=?', id);
  if (!a) throw new Error('السلفة غير موجودة');
  if (a.status !== 'معلق') throw new Error('السلفة محسومة مسبقاً');
  const e = get1('SELECT * FROM employees WHERE id=?', a.employee_id);

  if (!ok) {
    run("UPDATE advances SET status='مرفوض', approved_by=?, approved_at=?, note=? WHERE id=?",
        user.id, new Date().toISOString(), note || null, id);
    return { ok: false };
  }

  const jid = L.post({ ref: a.code, date: a.adate, memo: 'سلفة — ' + e.name,
    src_type: 'advance-emp', src_id: id, user_id: user.id,
    lines: [
      { account: '1150', debit: a.amount, credit: 0, memo: e.name },
      { account: '1100', debit: 0, credit: a.amount, memo: 'صرف سلفة ' + a.code },
    ] });
  run("UPDATE advances SET status='معتمد', approved_by=?, approved_at=?, journal_id=? WHERE id=?",
      user.id, new Date().toISOString(), jid, id);
  return { ok: true, journal_id: jid, amount: a.amount };
}

function advanceBalance(employee_id) {
  const r = get1(`SELECT COALESCE(SUM(amount),0) a, COALESCE(SUM(recovered),0) rec
    FROM advances WHERE employee_id=? AND status='معتمد'`, employee_id);
  return { total: R2(r.a), recovered: R2(r.rec), outstanding: R2(r.a - r.rec) };
}

/* القسط المستحق هذا الشهر من كل السلف النشطة */
function dueInstalment(employee_id) {
  return R2(q(`SELECT amount, recovered, monthly FROM advances
    WHERE employee_id=? AND status='معتمد' AND recovered < amount - 0.01`, employee_id)
    .reduce((s, a) => s + Math.min(num(a.monthly), R2(a.amount - a.recovered)), 0));
}

function recoverAdvances(employee_id, amount) {
  let left = R2(amount);
  q(`SELECT * FROM advances WHERE employee_id=? AND status='معتمد'
     AND recovered < amount - 0.01 ORDER BY id`, employee_id).forEach(a => {
    if (left <= 0.01) return;
    const take = R2(Math.min(left, R2(a.amount - a.recovered)));
    run('UPDATE advances SET recovered=recovered+? WHERE id=?', take, a.id);
    if (R2(a.recovered + take) >= R2(a.amount) - 0.01)
      run("UPDATE advances SET status='مسدد' WHERE id=?", a.id);
    left = R2(left - take);
  });
  return R2(amount - left);
}

/* ═══════════════ الإجازات ═══════════════ */

function daysBetween(a, b) {
  const d = Math.round((new Date(b) - new Date(a)) / 86400000) + 1;
  return d > 0 ? d : 0;
}

function requestLeave(user, d) {
  const e = get1('SELECT * FROM employees WHERE id=?', d.employee_id);
  if (!e) throw new Error('الموظف غير موجود');
  if (!d.from_date || !d.to_date) throw new Error('حدّد تاريخي البداية والنهاية');
  const days = num(d.days) || daysBetween(d.from_date, d.to_date);
  if (days <= 0) throw new Error('تاريخ النهاية قبل البداية');

  const paid = d.paid === false ? 0 : 1;
  const kind = d.kind || 'سنوية';
  if (paid && kind === 'سنوية') {
    const bal = leaveBalance(e.id);
    if (days > bal.remaining + 0.01)
      throw new Error(`الرصيد المتاح ${bal.remaining} يوماً فقط — طُلب ${days}`);
  }

  const overlap = get1(`SELECT code FROM leaves WHERE employee_id=? AND status IN ('معلق','معتمد')
    AND NOT (to_date < ? OR from_date > ?)`, e.id, d.from_date, d.to_date);
  if (overlap) throw new Error('يوجد طلب إجازة متداخل (' + overlap.code + ')');

  const n = num(get1('SELECT COUNT(*) c FROM leaves').c) + 1;
  const info = run(`INSERT INTO leaves(code,employee_id,kind,from_date,to_date,days,paid,
    status,requested_at,note) VALUES(?,?,?,?,?,?,?,'معلق',?,?)`,
    'LV-' + String(n).padStart(4, '0'), e.id, kind, d.from_date, d.to_date, days, paid,
    new Date().toISOString(), d.note || null);
  return { id: Number(info.lastInsertRowid), days };
}

function approveLeave(user, id, ok, note) {
  const lv = get1('SELECT * FROM leaves WHERE id=?', id);
  if (!lv) throw new Error('طلب الإجازة غير موجود');
  if (lv.status !== 'معلق') throw new Error('الطلب محسوم مسبقاً');
  run('UPDATE leaves SET status=?, approved_by=?, approved_at=?, note=? WHERE id=?',
      ok ? 'معتمد' : 'مرفوض', user.id, new Date().toISOString(), note || null, id);
  if (ok && lv.paid && lv.kind === 'سنوية')
    run('UPDATE employees SET leave_taken=COALESCE(leave_taken,0)+? WHERE id=?', lv.days, lv.employee_id);
  return { ok: !!ok, days: lv.days };
}

/* الرصيد = المستحق بالتناسب مع مدة الخدمة هذا العام ناقص المأخوذ */
function leaveBalance(employee_id) {
  const e = get1('SELECT * FROM employees WHERE id=?', employee_id);
  if (!e) throw new Error('الموظف غير موجود');
  const ent = num(e.leave_ent) || setNum('leave_days', 21);
  const yr = new Date().getFullYear();
  const start = new Date(e.hired) > new Date(yr + '-01-01') ? new Date(e.hired) : new Date(yr + '-01-01');
  const months = Math.max(0, (new Date() - start) / 86400000 / 30.44);
  const accrued = R2(Math.min(ent, ent * months / 12));
  const taken = num(e.leave_taken);
  return { entitlement: ent, accrued, taken: R2(taken), remaining: R2(accrued - taken) };
}

/* أيام الإجازة غير المدفوعة داخل شهر المسير */
function unpaidDaysIn(employee_id, period) {
  const from = period + '-01';
  const to = period + '-31';
  return R2(q(`SELECT from_date, to_date, days FROM leaves
    WHERE employee_id=? AND status='معتمد' AND paid=0
      AND NOT (to_date < ? OR from_date > ?)`, employee_id, from, to)
    .reduce((s, lv) => {
      const a = lv.from_date > from ? lv.from_date : from;
      const b = lv.to_date < to ? lv.to_date : to;
      return s + daysBetween(a, b);
    }, 0));
}

/* ═══════════════ بنود المسير — إضافي ومكافآت وخصومات ═══════════════ */

function addPayItem(user, d) {
  const pr = get1('SELECT * FROM payruns WHERE id=?', d.payrun_id);
  if (!pr) throw new Error('المسير غير موجود');
  if (pr.status !== 'مسودة') throw new Error('المسير معتمد — لا يقبل التعديل');
  const e = get1('SELECT * FROM employees WHERE id=?', d.employee_id);
  if (!e) throw new Error('الموظف غير موجود');
  const kind = d.kind;
  if (!['إضافي', 'مكافأة', 'خصم'].includes(kind)) throw new Error('نوع البند غير معروف');

  let amount = R2(d.amount), hours = num(d.hours);
  if (kind === 'إضافي') {
    if (hours <= 0) throw new Error('عدد ساعات الإضافي مطلوب');
    if (hours > 200) throw new Error('ساعات الإضافي غير منطقية');
    amount = R2(hours * hourlyRate(e) * setNum('overtime_rate', 1.5));
  }
  if (amount <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');

  const info = run(`INSERT INTO payitems(payrun_id,employee_id,kind,descr,hours,amount)
    VALUES(?,?,?,?,?,?)`, pr.id, e.id, kind, d.descr || kind, hours, amount);
  return { id: Number(info.lastInsertRowid), amount, hours };
}

/* ═══════════════ تشغيل المسير ═══════════════ */

function openPayrun(user, period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw new Error('الفترة بصيغة YYYY-MM');
  const ex = get1('SELECT * FROM payruns WHERE period=?', period);
  if (ex) {
    if (ex.status !== 'مسودة') throw new Error('مسير هذا الشهر معتمد مسبقاً');
    return { id: ex.id, reopened: true };
  }
  const info = run("INSERT INTO payruns(period,status,created_by,created) VALUES(?,'مسودة',?,?)",
                   period, user.id, new Date().toISOString());
  return { id: Number(info.lastInsertRowid), reopened: false };
}

/* يحسب كل قسائم المسير من بيانات الموظفين والبنود والسلف والإجازات */
function computePayrun(payrun_id) {
  const pr = get1('SELECT * FROM payruns WHERE id=?', payrun_id);
  if (!pr) throw new Error('المسير غير موجود');
  if (pr.status !== 'مسودة') throw new Error('المسير معتمد — لا يُعاد حسابه');

  const emps = q("SELECT * FROM employees WHERE status<>'منتهية خدمته' ORDER BY code");
  if (!emps.length) throw new Error('لا يوجد موظفون');

  const gE = setNum('gosi_emp', 0.10), gR = setNum('gosi_er', 0.12);
  const hazard = setNum('gosi_hazard', 0.02);

  run('DELETE FROM payslips WHERE payrun_id=?', payrun_id);
  const ins = db.prepare(`INSERT INTO payslips(payrun_id,employee_id,days,basic,housing,transport,
    site,ot_hours,ot_amount,bonus,overtime,gross,gosi_emp,gosi_er,advance_deduct,deduct,
    unpaid_days,unpaid_amount,net) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const tot = { gross: 0, gosi_emp: 0, gosi_er: 0, advance: 0, deduct: 0, net: 0, ot: 0, bonus: 0 };

  emps.forEach(e => {
    const w = wages(e);
    const items = q('SELECT * FROM payitems WHERE payrun_id=? AND employee_id=?', payrun_id, e.id);
    const sum = k => R2(items.filter(i => i.kind === k).reduce((s, i) => s + num(i.amount), 0));
    const otHours = R2(items.filter(i => i.kind === 'إضافي').reduce((s, i) => s + num(i.hours), 0));
    const ot = sum('إضافي'), bonus = sum('مكافأة'), manualDeduct = sum('خصم');

    const unpaidDays = unpaidDaysIn(e.id, pr.period);
    const unpaidAmt = R2(w.monthly / 30 * unpaidDays);

    const gross = R2(w.monthly + ot + bonus - unpaidAmt);
    /* GOSI: السعوديون اشتراك كامل، غير السعوديين أخطار مهنية على صاحب العمل فقط */
    const saudi = e.gosi_sub == null ? 1 : num(e.gosi_sub);
    const ge = saudi ? R2(w.gosi_base * gE) : 0;
    const gr = saudi ? R2(w.gosi_base * gR) : R2(w.gosi_base * hazard);

    const instal = R2(Math.min(dueInstalment(e.id), Math.max(0, R2(gross - ge - manualDeduct))));
    const net = R2(gross - ge - instal - manualDeduct);

    ins.run(payrun_id, e.id, e.ptype === 'يومي' ? 26 : 30,
      num(e.basic), num(e.housing), num(e.transport), num(e.site),
      otHours, ot, bonus, ot, gross, ge, gr, instal, manualDeduct,
      unpaidDays, unpaidAmt, net);

    tot.gross = R2(tot.gross + gross); tot.gosi_emp = R2(tot.gosi_emp + ge);
    tot.gosi_er = R2(tot.gosi_er + gr); tot.advance = R2(tot.advance + instal);
    tot.deduct = R2(tot.deduct + manualDeduct); tot.net = R2(tot.net + net);
    tot.ot = R2(tot.ot + ot); tot.bonus = R2(tot.bonus + bonus);
  });

  run('UPDATE payruns SET gross=?, net=? WHERE id=?', tot.gross, tot.net, payrun_id);
  return { ...tot, count: emps.length };
}

function approvePayrun(user, payrun_id) {
  const pr = get1('SELECT * FROM payruns WHERE id=?', payrun_id);
  if (!pr) throw new Error('المسير غير موجود');
  if (pr.status !== 'مسودة') throw new Error('المسير معتمد مسبقاً');
  const t = computePayrun(payrun_id);
  if (t.net <= 0) throw new Error('صافي المسير صفر');

  const lines = [
    { account: '5200', debit: R2(t.gross - t.deduct), credit: 0, memo: 'رواتب ' + pr.period },
    { account: '2300', debit: 0, credit: t.net, memo: 'صافي مستحق للموظفين' },
  ];
  if (t.gosi_er > 0) lines.push({ account: '5400', debit: t.gosi_er, credit: 0, memo: 'GOSI صاحب العمل' });
  if (R2(t.gosi_emp + t.gosi_er) > 0) lines.push({ account: '2400', debit: 0,
    credit: R2(t.gosi_emp + t.gosi_er), memo: 'اشتراكات GOSI مستحقة' });
  if (t.advance > 0) lines.push({ account: '1150', debit: 0, credit: t.advance, memo: 'استرداد سلف' });

  const jid = L.post({ ref: 'PAY-' + pr.period, date: pr.period + '-28',
    memo: 'مسير رواتب ' + pr.period, src_type: 'payrun', src_id: payrun_id,
    user_id: user.id, lines });

  /* استرداد السلف يُسجَّل على السلف نفسها بعد الترحيل */
  q('SELECT employee_id, advance_deduct FROM payslips WHERE payrun_id=? AND advance_deduct > 0', payrun_id)
    .forEach(p => recoverAdvances(p.employee_id, p.advance_deduct));

  run("UPDATE payruns SET status='معتمد', journal_id=? WHERE id=?", jid, payrun_id);
  return { journal_id: jid, ...t };
}

function payrunDetail(payrun_id) {
  const pr = get1('SELECT * FROM payruns WHERE id=?', payrun_id);
  if (!pr) throw new Error('المسير غير موجود');
  return { ...pr, slips: q(`SELECT ps.*, e.code, e.name, e.job, e.dept, e.iban, e.nid, e.iqama
    FROM payslips ps JOIN employees e ON e.id=ps.employee_id
    WHERE ps.payrun_id=? ORDER BY e.code`, payrun_id),
    items: q(`SELECT pi.*, e.name FROM payitems pi JOIN employees e ON e.id=pi.employee_id
      WHERE pi.payrun_id=? ORDER BY pi.id`, payrun_id) };
}

/* ═══════════════ ملف حماية الأجور WPS ═══════════════ */

/* الصيغة الرسمية لوزارة الموارد البشرية: مجموعة ترويسة واحدة ثم سطر لكل موظف.
   المرجع: WPS Wages File Technical Specification — hrsd.gov.sa */
function generateWPS(user, payrun_id) {
  const pr = get1('SELECT * FROM payruns WHERE id=?', payrun_id);
  if (!pr) throw new Error('المسير غير موجود');
  if (pr.status !== 'معتمد') throw new Error('اعتمد المسير قبل توليد ملف WPS');

  const slips = q(`SELECT ps.*, e.code, e.name, e.iban, e.nid, e.iqama, e.bank
    FROM payslips ps JOIN employees e ON e.id=ps.employee_id
    WHERE ps.payrun_id=? ORDER BY e.code`, payrun_id);
  if (!slips.length) throw new Error('المسير بلا قسائم');

  const missing = slips.filter(s => !s.iban || !String(s.iban).trim());
  if (missing.length)
    throw new Error('حساب بنكي (IBAN) ناقص لـ: ' + missing.map(m => m.name).join('، '));
  const noId = slips.filter(s => !(s.iqama || s.nid));
  if (noId.length)
    throw new Error('رقم هوية/إقامة ناقص لـ: ' + noId.map(m => m.name).join('، '));

  const total = R2(slips.reduce((s, x) => s + num(x.net), 0));
  const vdate = (pr.period + '-28').replace(/-/g, '');
  const bank = S('wps_bank') || 'BANK';
  const estb = S('wps_employer_id') || '';
  const acct = S('wps_bank_account') || '';
  const molId = S('wps_mol_id') || estb;

  const L2 = [];
  L2.push('[DEST-ID]\t' + bank);
  L2.push('[ESTB-ID]\t' + estb);
  L2.push('[BANK-ACC]\t' + acct);
  L2.push('[32A-CCY]\tSAR');
  L2.push('[32A-VAL]\t' + vdate);
  L2.push('[32A-AMT]\t' + total.toFixed(2));
  L2.push('[FILE-REF]\tWPS' + pr.period.replace('-', '') + String(payrun_id).padStart(3, '0'));
  L2.push('[MOL-ESTBID]\t' + molId);
  slips.forEach(s => {
    const other = R2(num(s.transport) + num(s.site) + num(s.ot_amount) + num(s.bonus));
    const ded = R2(num(s.gosi_emp) + num(s.advance_deduct) + num(s.deduct) + num(s.unpaid_amount));
    L2.push('');
    L2.push('[32B-AMT]\t' + R2(s.net).toFixed(2));
    L2.push('[59-ACC]\t' + String(s.iban).replace(/\s/g, '').toUpperCase());
    L2.push('[59-NAME]\t' + s.name);
    L2.push('[57-BANK]\t' + (s.bank || bank));
    L2.push('[70-DET]\tSALARY ' + pr.period);
    L2.push('[MOL-BAS]\t' + R2(s.basic).toFixed(2));
    L2.push('[MOL-HAL]\t' + R2(s.housing).toFixed(2));
    L2.push('[MOL-OEA]\t' + other.toFixed(2));
    L2.push('[MOL-DED]\t' + ded.toFixed(2));
    L2.push('[MOL-ID]\t' + (s.iqama || s.nid));
  });
  const content = L2.join('\n');

  run('DELETE FROM wpsfiles WHERE payrun_id=?', payrun_id);
  const info = run(`INSERT INTO wpsfiles(payrun_id,generated_at,bank,nlines,total,content,created_by)
    VALUES(?,?,?,?,?,?,?)`, payrun_id, new Date().toISOString(), bank, slips.length,
    total, content, user.id);
  return { id: Number(info.lastInsertRowid), nlines: slips.length, total,
           filename: 'WPS-' + pr.period + '.sif', content };
}

/* ═══════════════ تنبيهات انتهاء المستندات ═══════════════ */

function expiringDocs(days) {
  const n = num(days) || setNum('doc_expiry_warn', 60);
  const limit = new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const now = today();
  const out = [];
  const DOCS = [['iqama_exp', 'الإقامة', 'iqama'], ['passport_exp', 'جواز السفر', 'passport'],
                ['license_exp', 'رخصة المهنة', 'license'], ['contract_exp', 'العقد', null]];
  q("SELECT * FROM employees WHERE status<>'منتهية خدمته'").forEach(e => {
    DOCS.forEach(([col, label, numCol]) => {
      const exp = e[col];
      if (!exp) return;
      if (exp > limit) return;
      out.push({ employee_id: e.id, code: e.code, name: e.name, job: e.job,
        doc: label, number: numCol ? e[numCol] : null, expires: exp,
        days_left: Math.round((new Date(exp) - new Date(now)) / 86400000),
        expired: exp < now });
    });
  });
  return out.sort((a, b) => a.days_left - b.days_left);
}

/* ═══════════════ لوحة الموارد البشرية ═══════════════ */

function hrDashboard() {
  const emps = q("SELECT * FROM employees WHERE status<>'منتهية خدمته'");
  const payroll = R2(emps.reduce((s, e) => s + wages(e).monthly, 0));
  return {
    headcount: emps.length,
    by_dept: q(`SELECT dept, COUNT(*) n FROM employees WHERE status<>'منتهية خدمته'
      GROUP BY dept ORDER BY n DESC`),
    monthly_payroll: payroll,
    advances_outstanding: R2(num(get1(`SELECT COALESCE(SUM(amount-recovered),0) s
      FROM advances WHERE status='معتمد'`).s)),
    pending_advances: num(get1("SELECT COUNT(*) c FROM advances WHERE status='معلق'").c),
    pending_leaves: num(get1("SELECT COUNT(*) c FROM leaves WHERE status='معلق'").c),
    on_leave_today: q(`SELECT l.*, e.name FROM leaves l JOIN employees e ON e.id=l.employee_id
      WHERE l.status='معتمد' AND l.from_date <= ? AND l.to_date >= ?`, today(), today()),
    expiring: expiringDocs(),
    gosi_liability: L.balanceOf('2400'),
    salaries_payable: L.balanceOf('2300'),
  };
}

module.exports = {
  wages, hourlyRate,
  requestAdvance, approveAdvance, advanceBalance, dueInstalment, recoverAdvances,
  requestLeave, approveLeave, leaveBalance, unpaidDaysIn,
  addPayItem, openPayrun, computePayrun, approvePayrun, payrunDetail,
  generateWPS, expiringDocs, hrDashboard,
};
