'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, q, get1, run, hashPw, seed } = require('./db');
const L = require('./ledger');
const Z = require('./zatca');
const SL = require('./sales');
const PG = require('./progress');
const HR = require('./payroll');
const PC = require('./procure');
const DOC = require('./docs');

const PORT = process.env.PORT || 3000;
const R2 = L.R2;
const today = () => new Date().toISOString().slice(0, 10);

seed();

const S = k => (get1('SELECT v FROM settings WHERE k=?', k) || {}).v;
const VAT = () => parseFloat(S('vat_rate') || '0.15');

/* ═══════════ PERMISSIONS — enforced server-side ═══════════ */
const PERM = {
  admin:       { all: true, limit: Infinity },
  pm:          { read: ['*'], write: ['partners','projects','tasks','pos','timesheets','dailyreports','sales',
                                      'contracts','ipc','vo','subcert'],
                 approve: ['po','ipc','vo','subcert'], limit: 50000 },
  engineer:    { read: ['projects','tasks','materials','stock','partners','dailyreports','timesheets','moves',
                        'contracts','ipc'],
                 write: ['tasks','timesheets','dailyreports','ipc'], limit: 0 },
  accountant:  { read: ['*'], write: ['invoices','payments','journals','partners','sales','retention'],
                 approve: ['payment'], limit: 20000 },
  storekeeper: { read: ['materials','stock','pos','moves','partners','projects','warehouses'],
                 write: ['moves','receipt'], limit: 0 },
  hr:          { read: ['employees','payruns','projects','advances','leaves'],
                 write: ['employees','payruns','advances','leaves'],
                 approve: ['leave'], limit: 0 },
};
function can(user, action, resource) {
  if (!user) return false;
  const p = PERM[user.role];
  if (!p) return false;
  if (p.all) return true;
  const list = p[action];
  if (!list) return false;
  return list.includes('*') || list.includes(resource);
}
const limitOf = u => (PERM[u.role] || {}).limit || 0;

function audit(user, action, entity, id, detail) {
  run('INSERT INTO audit(ts,user_id,username,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?,?)',
      new Date().toISOString(), user ? user.id : null, user ? user.username : 'anon',
      action, entity, String(id == null ? '' : id), detail || null);
}

/* ═══════════ SESSIONS ═══════════ */
function login(username, password) {
  const u = get1('SELECT * FROM users WHERE username=? AND active=1', username);
  if (!u) { audit(null, 'login-fail', 'user', username, 'مستخدم غير موجود'); return null; }
  if (hashPw(password, u.salt) !== u.pw) {
    audit(null, 'login-fail', 'user', username, 'كلمة مرور خاطئة');
    return null;
  }
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)', token, u.id, Date.now() + 12 * 3600 * 1000);
  run('DELETE FROM sessions WHERE expires < ?', Date.now());
  /* تدوين الدخول هنا لا في المسار: المصادقة تُسجَّل مع المصادقة،
     فلا يفلت أي طريق آخر للدخول من السجل. */
  audit({ id: u.id, username: u.username }, 'login', 'user', u.id);
  return { token, user: { id: u.id, username: u.username, name: u.name, role: u.role,
                          must_change: !!u.must_change } };
}
function userFromToken(tok) {
  if (!tok) return null;
  const s = get1('SELECT * FROM sessions WHERE token=?', tok);
  if (!s || s.expires < Date.now()) return null;
  return get1('SELECT id,username,name,role FROM users WHERE id=? AND active=1', s.user_id) || null;
}

/* ═══════════ BUSINESS LOGIC ═══════════ */
const revAcct = t => ({ 'كهرباء': '4110', 'ميكانيكا': '4120', 'سباكة': '4130' }[t] || '4190');
const nextCode = (table, prefix) =>
  prefix + String(get1(`SELECT COUNT(*) c FROM ${table}`).c + 1).padStart(4, '0');

function invoiceTotal(id) {
  const r = get1(`SELECT COALESCE(SUM(qty*price),0) net, COALESCE(SUM(qty*price*vat),0) vat
                  FROM invlines WHERE invoice_id=?`, id);
  return { net: R2(r.net), vat: R2(r.vat), total: R2(r.net + r.vat) };
}
const poTotal = id => R2(get1('SELECT COALESCE(SUM(qty*price),0) n FROM polines WHERE po_id=?', id).n);

function createInvoice(user, d) {
  if (!can(user, 'write', 'invoices')) throw new Error('لا تملك صلاحية إصدار الفواتير');
  const cust = get1("SELECT * FROM partners WHERE id=? AND kind='customer'", d.customer_id);
  if (!cust) throw new Error('العميل غير موجود');
  if (!Z.validVAT(cust.vat)) throw new Error('الرقم الضريبي للعميل غير صالح — لا يمكن إصدار فاتورة ضريبية');
  if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('الفاتورة تحتاج بنداً واحداً على الأقل');

  const proj = d.project_id ? get1('SELECT * FROM projects WHERE id=?', d.project_id) : null;
  const code = d.code || nextCode('invoices', 'INV-' + new Date().getFullYear() + '-');
  const info = run(`INSERT INTO invoices(code,customer_id,project_id,idate,ddate,status,created_by)
    VALUES(?,?,?,?,?,'مسودة',?)`, code, cust.id, proj ? proj.id : null,
    d.idate || today(), d.ddate || today(), user.id);
  const id = Number(info.lastInsertRowid);
  const il = db.prepare('INSERT INTO invlines(invoice_id,descr,account,qty,price,vat) VALUES(?,?,?,?,?,?)');
  d.lines.forEach(l => il.run(id, l.descr || 'بند',
    l.account || revAcct(l.trade || (proj && proj.trade)),
    Number(l.qty) || 1, Number(l.price) || 0, l.vat == null ? VAT() : Number(l.vat)));
  audit(user, 'create', 'invoice', id, code);
  return id;
}

function postInvoice(user, id) {
  if (!can(user, 'write', 'invoices')) throw new Error('لا تملك صلاحية ترحيل الفواتير');
  const inv = get1('SELECT * FROM invoices WHERE id=?', id);
  if (!inv) throw new Error('الفاتورة غير موجودة');
  if (inv.journal_id) throw new Error('الفاتورة مرحّلة مسبقاً');
  const lines = q('SELECT * FROM invlines WHERE invoice_id=?', id);
  if (!lines.length) throw new Error('الفاتورة بلا بنود');
  const t = invoiceTotal(id);

  const jl = [{ account: '1200', debit: t.total, credit: 0,
                project_id: inv.project_id, partner_id: inv.customer_id, memo: 'فاتورة ' + inv.code }];
  const by = {};
  lines.forEach(l => { by[l.account] = R2((by[l.account] || 0) + l.qty * l.price); });
  Object.entries(by).forEach(([a, amt]) =>
    jl.push({ account: a, debit: 0, credit: amt, project_id: inv.project_id, partner_id: inv.customer_id }));
  if (t.vat > 0) jl.push({ account: '2200', debit: 0, credit: t.vat, partner_id: inv.customer_id, memo: 'ضريبة مخرجات' });

  const jid = L.post({ ref: inv.code, date: inv.idate, memo: 'فاتورة مبيعات ' + inv.code,
                       src_type: 'invoice', src_id: id, lines: jl, user_id: user.id });
  run("UPDATE invoices SET journal_id=?, status='معلقة' WHERE id=?", jid, id);
  audit(user, 'post', 'invoice', id, 'قيد #' + jid + ' · ' + t.total);
  return { journal_id: jid, ...t };
}

function stampZatca(user, id) {
  const inv = get1('SELECT * FROM invoices WHERE id=?', id);
  if (!inv) throw new Error('الفاتورة غير موجودة');
  if (!inv.journal_id) throw new Error('رحّل الفاتورة محاسبياً قبل إرسالها لـ ZATCA');
  if (inv.zatca_status === 'مرسلة') throw new Error('الفاتورة مختومة مسبقاً');
  const cust = get1('SELECT * FROM partners WHERE id=?', inv.customer_id);
  const lines = q('SELECT * FROM invlines WHERE invoice_id=?', id);
  const prev = get1(`SELECT zatca_hash FROM invoices WHERE zatca_status='مرسلة' AND id<>?
                     ORDER BY zatca_at DESC LIMIT 1`, id);
  const out = Z.generate({
    invoice: { ...inv, itime: new Date().toTimeString().slice(0, 8) },
    seller: { name: S('company_name'), vat: S('company_vat'), cr: S('company_cr'), city: S('company_city') },
    customer: cust, lines, prevHash: prev ? prev.zatca_hash : null
  });
  run(`UPDATE invoices SET zatca_status='مرسلة', zatca_uuid=?, zatca_hash=?, zatca_qr=?,
       zatca_xml=?, zatca_at=?, prev_hash=? WHERE id=?`,
      out.uuid, out.hash, out.qr, out.xml, new Date().toISOString(), out.pih, id);
  audit(user, 'zatca', 'invoice', id, out.uuid);
  return out;
}

function createPO(user, d) {
  if (!can(user, 'write', 'pos')) throw new Error('لا تملك صلاحية إنشاء أوامر الشراء');
  const v = get1("SELECT * FROM partners WHERE id=? AND kind='vendor'", d.vendor_id);
  if (!v) throw new Error('المورد غير موجود');
  if (!Array.isArray(d.lines) || !d.lines.length) throw new Error('أمر الشراء يحتاج بنداً واحداً على الأقل');
  const code = d.code || nextCode('pos', 'PO-');
  const info = run(`INSERT INTO pos(code,vendor_id,project_id,warehouse_id,pdate,status,created_by)
    VALUES(?,?,?,?,?,'مسودة',?)`, code, v.id, d.project_id || null, d.warehouse_id || 1, d.pdate || today(), user.id);
  const id = Number(info.lastInsertRowid);
  const pl = db.prepare('INSERT INTO polines(po_id,material_id,descr,qty,price) VALUES(?,?,?,?,?)');
  d.lines.forEach(l => pl.run(id, l.material_id || null, l.descr || '', Number(l.qty) || 0, Number(l.price) || 0));
  audit(user, 'create', 'po', id, code);
  return id;
}

function submitPO(user, id) {
  const po = get1('SELECT * FROM pos WHERE id=?', id);
  if (!po) throw new Error('أمر الشراء غير موجود');
  if (po.status !== 'مسودة') throw new Error('أمر الشراء ليس مسودة');
  const amt = poTotal(id);
  run(`INSERT INTO approvals(doc_type,doc_id,amount,requested_by,requested_at,status)
       VALUES('po',?,?,?,?,'معلق')`, id, amt, user.id, new Date().toISOString());
  run("UPDATE pos SET status='بانتظار الاعتماد' WHERE id=?", id);
  audit(user, 'submit', 'po', id, String(amt));
  return { amount: amt, needs: amt > 50000 ? 'المالك' : 'مدير المشاريع' };
}

function approvePO(user, id, ok, note) {
  if (!can(user, 'approve', 'po')) throw new Error('لا تملك صلاحية الاعتماد');
  const po = get1('SELECT * FROM pos WHERE id=?', id);
  if (!po) throw new Error('أمر الشراء غير موجود');
  if (po.status !== 'بانتظار الاعتماد') throw new Error('أمر الشراء ليس بانتظار الاعتماد');
  const amt = poTotal(id);
  if (ok && amt > limitOf(user))
    throw new Error(`المبلغ ${amt} يتجاوز حدّ اعتمادك (${limitOf(user)}) — يلزم اعتماد المالك`);
  run(`UPDATE approvals SET status=?, decided_by=?, decided_at=?, note=?
       WHERE doc_type='po' AND doc_id=? AND status='معلق'`,
      ok ? 'معتمد' : 'مرفوض', user.id, new Date().toISOString(), note || null, id);
  run('UPDATE pos SET status=?, approved_by=?, approved_at=? WHERE id=?',
      ok ? 'معتمد' : 'مرفوض', user.id, new Date().toISOString(), id);
  audit(user, ok ? 'approve' : 'reject', 'po', id, String(amt));
  return { ok: true, amount: amt };
}

function receivePO(user, id, receipts) {
  if (!can(user, 'write', 'receipt')) throw new Error('لا تملك صلاحية الاستلام');
  const po = get1('SELECT * FROM pos WHERE id=?', id);
  if (!po) throw new Error('أمر الشراء غير موجود');
  if (po.status !== 'معتمد' && po.status !== 'استلام جزئي')
    throw new Error('أمر الشراء غير معتمد — لا يمكن الاستلام');
  const lines = q('SELECT * FROM polines WHERE po_id=?', id);
  let value = 0;
  const mvIns = db.prepare(`INSERT INTO moves(material_id,from_wh,to_wh,qty,mdate,ref,project_id,unit_cost,kind,created_by)
    VALUES(?,?,?,?,?,?,?,?,'استلام',?)`);
  (receipts || []).forEach(r => {
    const ln = lines.find(l => l.id === Number(r.line_id));
    if (!ln) return;
    const qty = Number(r.qty) || 0;
    if (qty <= 0) return;
    if (qty > R2(ln.qty - ln.received) + 0.001) throw new Error('الكمية المستلمة تتجاوز المطلوب');
    run('UPDATE polines SET received=received+? WHERE id=?', qty, ln.id);
    if (ln.material_id) {
      SL.receiveAtCost(ln.material_id, po.warehouse_id || 1, qty, ln.price);
      mvIns.run(ln.material_id, null, po.warehouse_id || 1, qty, today(), po.code, po.project_id, ln.price, user.id);
    }
    value = R2(value + qty * ln.price);
  });
  if (value > 0) {
    const vat = R2(value * VAT());
    const jid = L.post({ ref: po.code, date: today(), memo: 'استلام بضاعة ' + po.code,
      src_type: 'receipt', src_id: id, user_id: user.id,
      lines: [
        { account: '1300', debit: value, credit: 0, project_id: po.project_id, partner_id: po.vendor_id },
        { account: '1400', debit: vat, credit: 0, partner_id: po.vendor_id, memo: 'ضريبة مدخلات' },
        { account: '2100', debit: 0, credit: R2(value + vat), partner_id: po.vendor_id },
      ] });
    run('UPDATE pos SET journal_id=? WHERE id=?', jid, id);
  }
  const done = q('SELECT qty,received FROM polines WHERE po_id=?', id)
    .every(l => l.received >= l.qty - 0.001);
  run('UPDATE pos SET status=? WHERE id=?', done ? 'مستلم' : 'استلام جزئي', id);
  audit(user, 'receive', 'po', id, String(value));
  return { value, complete: done };
}

function issueMaterial(user, d) {
  if (!can(user, 'write', 'moves')) throw new Error('لا تملك صلاحية صرف المواد');
  const m = get1('SELECT * FROM materials WHERE id=?', d.material_id);
  if (!m) throw new Error('الصنف غير موجود');
  const have = SL.availableAt(d.material_id, d.warehouse_id);
  const qty = Number(d.qty) || 0;
  if (qty <= 0) throw new Error('الكمية يجب أن تكون أكبر من صفر');
  if (qty > have) throw new Error(`الكمية المتاحة ${have} فقط — لا يمكن صرف ${qty}`);
  const unit = SL.costAt(d.material_id, d.warehouse_id);   // weighted average
  run('UPDATE stock SET qty=qty-? WHERE material_id=? AND warehouse_id=?', qty, d.material_id, d.warehouse_id);
  const cost = R2(qty * unit);
  const jid = L.post({ ref: 'ISSUE-' + m.code, date: d.mdate || today(),
    memo: 'صرف ' + m.name, src_type: 'issue', user_id: user.id,
    lines: [
      { account: '5100', debit: cost, credit: 0, project_id: d.project_id, memo: m.name },
      { account: '1300', debit: 0, credit: cost, project_id: d.project_id },
    ] });
  run(`INSERT INTO moves(material_id,from_wh,to_wh,qty,mdate,ref,project_id,unit_cost,kind,journal_id,created_by)
       VALUES(?,?,NULL,?,?,'صرف',?,?,'صرف',?,?)`,
      d.material_id, d.warehouse_id, qty, d.mdate || today(), d.project_id, unit, jid, user.id);
  audit(user, 'issue', 'material', d.material_id, qty + ' ' + m.unit + ' @ ' + unit);
  return { cost, unit_cost: unit, journal_id: jid, remaining: R2(have - qty) };
}

function logTime(user, d) {
  if (!can(user, 'write', 'timesheets')) throw new Error('لا تملك صلاحية تسجيل الساعات');
  const e = get1('SELECT * FROM employees WHERE id=?', d.employee_id);
  if (!e) throw new Error('الموظف غير موجود');
  const hours = Number(d.hours) || 0;
  if (hours <= 0 || hours > 16) throw new Error('عدد الساعات بين 1 و 16');
  const rate = Number(d.rate) || e.cost_rate || 0;
  const cost = R2(hours * rate);
  const jid = cost > 0 ? L.post({ ref: 'TS-' + e.code, date: d.tdate || today(),
    memo: 'ساعات عمل ' + e.name, src_type: 'timesheet', user_id: user.id,
    lines: [
      { account: '5200', debit: cost, credit: 0, project_id: d.project_id, memo: e.name },
      { account: '2300', debit: 0, credit: cost, memo: 'أجور مستحقة' },
    ] }) : null;
  run(`INSERT INTO timesheets(project_id,task_id,employee_id,tdate,hours,rate,note,journal_id)
       VALUES(?,?,?,?,?,?,?,?)`, d.project_id, d.task_id || null, d.employee_id,
      d.tdate || today(), hours, rate, d.note || null, jid);
  audit(user, 'timesheet', 'project', d.project_id, hours + 'س · ' + cost);
  return { cost, journal_id: jid };
}

function recordPayment(user, d) {
  if (!can(user, 'write', 'payments')) throw new Error('لا تملك صلاحية تسجيل المدفوعات');
  const amt = R2(d.amount);
  if (amt <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
  if (amt > limitOf(user)) throw new Error(`المبلغ يتجاوز حدّ صلاحيتك (${limitOf(user)})`);
  const isIn = d.kind === 'قبض';
  if (isIn && d.invoice_id) {
    const t = invoiceTotal(d.invoice_id);
    const paid = get1('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?', d.invoice_id).s;
    if (amt > R2(t.total - paid) + 0.01) throw new Error(`المتبقي على الفاتورة ${R2(t.total - paid)} فقط`);
  }
  const jid = L.post({ ref: d.ref || null, date: d.pdate || today(),
    memo: (isIn ? 'قبض' : 'صرف') + ' ' + (d.ref || ''), src_type: 'payment', user_id: user.id,
    lines: isIn
      ? [{ account: '1100', debit: amt, credit: 0, partner_id: d.partner_id },
         { account: '1200', debit: 0, credit: amt, partner_id: d.partner_id }]
      : [{ account: '2100', debit: amt, credit: 0, partner_id: d.partner_id },
         { account: '1100', debit: 0, credit: amt, partner_id: d.partner_id }] });
  const info = run(`INSERT INTO payments(code,kind,partner_id,invoice_id,po_id,pdate,amount,method,bank_account,ref,journal_id,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, nextCode('payments', 'PAY-'), d.kind, d.partner_id || null,
    d.invoice_id || null, d.po_id || null, d.pdate || today(), amt, d.method || 'تحويل بنكي',
    d.bank_account || null, d.ref || null, jid, user.id);
  if (d.invoice_id) {
    const t = invoiceTotal(d.invoice_id);
    const paid = get1('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE invoice_id=?', d.invoice_id).s;
    run('UPDATE invoices SET status=? WHERE id=?', R2(paid) >= t.total - 0.01 ? 'مدفوعة' : 'معلقة', d.invoice_id);
  }
  audit(user, 'payment', d.kind, Number(info.lastInsertRowid), String(amt));
  return { journal_id: jid, amount: amt };
}

function runPayroll(user, period) {
  if (!can(user, 'write', 'payruns')) throw new Error('لا تملك صلاحية تشغيل الرواتب');
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw new Error('الفترة بصيغة YYYY-MM');
  if (get1('SELECT id FROM payruns WHERE period=?', period)) throw new Error('مسير هذا الشهر موجود مسبقاً');
  const emps = q("SELECT * FROM employees WHERE status<>'منتهية خدمته'");
  if (!emps.length) throw new Error('لا يوجد موظفون');
  const info = run("INSERT INTO payruns(period,status,created_by,created) VALUES(?,'مسودة',?,?)",
                   period, user.id, new Date().toISOString());
  const prid = Number(info.lastInsertRowid);
  const ps = db.prepare(`INSERT INTO payslips(payrun_id,employee_id,days,overtime,gross,gosi_emp,gosi_er,deduct,net)
    VALUES(?,?,?,0,?,?,?,0,?)`);
  const gE = parseFloat(S('gosi_emp') || '0.10'), gR = parseFloat(S('gosi_er') || '0.12');
  let tg = 0, te = 0, tr = 0, tn = 0;
  emps.forEach(e => {
    let gross, base;
    if (e.ptype === 'يومي') { gross = R2(e.basic * 26); base = 0; }
    else { base = R2(e.basic + e.housing); gross = R2(e.basic + e.housing + e.transport + e.site); }
    const ge = R2(base * gE), gr = R2(base * gR), net = R2(gross - ge);
    ps.run(prid, e.id, e.ptype === 'يومي' ? 26 : 30, gross, ge, gr, net);
    tg = R2(tg + gross); te = R2(te + ge); tr = R2(tr + gr); tn = R2(tn + net);
  });
  const jid = L.post({ ref: 'PAY-' + period, date: period + '-28', memo: 'مسير رواتب ' + period,
    src_type: 'payrun', src_id: prid, user_id: user.id,
    lines: [
      { account: '5200', debit: tg, credit: 0, memo: 'رواتب ' + period },
      { account: '5400', debit: tr, credit: 0, memo: 'GOSI صاحب العمل' },
      { account: '2300', debit: 0, credit: tn, memo: 'صافي مستحق' },
      { account: '2400', debit: 0, credit: R2(te + tr), memo: 'GOSI مستحقة' },
    ] });
  run("UPDATE payruns SET journal_id=?, status='معتمد' WHERE id=?", jid, prid);
  audit(user, 'payroll', 'payrun', prid, period);
  return { id: prid, journal_id: jid, gross: tg, gosi_emp: te, gosi_er: tr, net: tn, count: emps.length };
}

/* Service length in calendar years. Day-count division (÷365.25) drifts —
   2022-03-15 → 2026-09-15 is exactly 4.5 years, not 4.5037. */
function serviceYears(fromISO, toISO) {
  const a = new Date(fromISO), b = new Date(toISO);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  let dayFrac = 0;
  if (b.getDate() >= a.getDate()) {
    const inMonth = new Date(b.getFullYear(), b.getMonth() + 1, 0).getDate();
    dayFrac = (b.getDate() - a.getDate()) / inMonth;
  } else {
    months -= 1;
    const prev = new Date(b.getFullYear(), b.getMonth(), 0).getDate();
    dayFrac = (prev - a.getDate() + b.getDate()) / prev;
  }
  return (months + dayFrac) / 12;
}

function eos(employee_id, endDate, reason) {
  const e = get1('SELECT * FROM employees WHERE id=?', employee_id);
  if (!e) throw new Error('الموظف غير موجود');
  const years = serviceYears(e.hired, endDate || today());
  if (years <= 0) throw new Error('تاريخ الانتهاء قبل تاريخ التعيين');
  const wage = e.ptype === 'يومي' ? R2(e.basic * 26) : R2(e.basic + e.housing + e.transport + e.site);
  const gratuity = R2(Math.min(years, 5) * wage * 0.5 + Math.max(0, years - 5) * wage);
  let factor = 1, rule = 'كاملة';
  if (reason === 'استقالة') {
    if (years < 2) { factor = 0; rule = 'لا تستحق (أقل من سنتين)'; }
    else if (years < 5) { factor = 1 / 3; rule = 'الثلث (2–5 سنوات)'; }
    else if (years < 10) { factor = 2 / 3; rule = 'الثلثان (5–10 سنوات)'; }
  }
  return { employee: e.name, years: Math.round(years * 100) / 100, wage,
           gratuity_full: gratuity, rule, payable: R2(gratuity * factor) };
}

/* ═══════════ ROUTES ═══════════ */
const routes = {};
const R = (m, p, h, o) => { routes[m + ' ' + p] = { h, o: o || {} }; };

R('POST', '/api/login', c => {
  /* النجاح والفشل كلاهما مُدوَّن داخل login() — لا تكرار هنا */
  const s = login(c.body.username, c.body.password);
  if (!s) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة');
  return s;
}, { open: true });
R('POST', '/api/logout', c => { run('DELETE FROM sessions WHERE token=?', c.token); return { ok: true }; });
R('GET', '/api/me', c => {
  const u = get1('SELECT must_change FROM users WHERE id=?', c.user.id);
  return { user: { ...c.user, must_change: !!(u && u.must_change) },
           perms: PERM[c.user.role], limit: limitOf(c.user) };
});

/* Password change. Requires the current password even when forced —
   a stolen session token alone must not be enough to lock the owner out. */
R('POST', '/api/password/change', c => {
  const { current, next } = c.body;
  const u = get1('SELECT * FROM users WHERE id=?', c.user.id);
  if (!u) throw new Error('المستخدم غير موجود');
  if (hashPw(String(current || ''), u.salt) !== u.pw) throw new Error('كلمة المرور الحالية غير صحيحة');

  const pw = String(next || '');
  if (pw.length < 8) throw new Error('كلمة المرور يجب ألا تقل عن 8 خانات');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new Error('يجب أن تحتوي على حرف ورقم على الأقل');
  if (pw === String(current)) throw new Error('كلمة المرور الجديدة مطابقة للحالية');
  const weak = ['admin123','pm123','eng123','acc123','store123','hr123','password','12345678','11111111'];
  if (weak.includes(pw.toLowerCase())) throw new Error('كلمة المرور ضعيفة ومعروفة — اختر غيرها');

  const salt = crypto.randomBytes(16).toString('hex');
  run('UPDATE users SET pw=?, salt=?, must_change=0, pw_changed=? WHERE id=?',
      hashPw(pw, salt), salt, new Date().toISOString(), c.user.id);
  // every other session for this user is invalidated
  run('DELETE FROM sessions WHERE user_id=? AND token<>?', c.user.id, c.token);
  audit(c.user, 'password-change', 'user', c.user.id, 'تم تغيير كلمة المرور');
  return { ok: true };
});

/* Owner can reset any user back to a temporary password. */
R('POST', '/api/password/reset', c => {
  if (c.user.role !== 'admin') throw new Error('المالك فقط يستطيع إعادة تعيين كلمات المرور');
  const target = get1('SELECT * FROM users WHERE id=?', c.body.user_id);
  if (!target) throw new Error('المستخدم غير موجود');
  const temp = 'Temp' + crypto.randomInt(100000, 999999);
  const salt = crypto.randomBytes(16).toString('hex');
  run('UPDATE users SET pw=?, salt=?, must_change=1 WHERE id=?', hashPw(temp, salt), salt, target.id);
  run('DELETE FROM sessions WHERE user_id=?', target.id);
  audit(c.user, 'password-reset', 'user', target.id, target.username);
  return { username: target.username, temp };
});

R('GET', '/api/users', c => {
  if (c.user.role !== 'admin') throw new Error('المالك فقط يستطيع عرض المستخدمين');
  return q(`SELECT id,username,name,role,active,must_change,pw_changed FROM users ORDER BY id`);
});

R('GET', '/api/dashboard', c => {
  const projects = q(`SELECT p.*, pa.name customer FROM projects p
    LEFT JOIN partners pa ON pa.id=p.customer_id WHERE p.status='جارٍ'`)
    .map(p => { const pl = L.projectPL(p.id);
      return { ...p, cost: pl.cost, revenue: pl.revenue, cost_pct: pl.cost_pct, risk: pl.risk }; });
  const yr = new Date().getFullYear();
  return {
    projects, receivables: L.agedReceivables(),
    pnl: L.pnl(yr + '-01-01', yr + '-12-31'),
    vat: L.vatReturn(yr + '-01-01', yr + '-12-31'),
    cash: L.balanceOf('1100'),
    low_stock: q(`SELECT m.*, COALESCE(SUM(s.qty),0) qty FROM materials m
      LEFT JOIN stock s ON s.material_id=m.id GROUP BY m.id HAVING qty < m.minq`),
    pending_approvals: q(`SELECT a.*, p.code, p.id po_id, v.name vendor FROM approvals a
      JOIN pos p ON p.id=a.doc_id JOIN partners v ON v.id=p.vendor_id
      WHERE a.doc_type='po' AND a.status='معلق'`),
    stock_value: R2(q(`SELECT s.qty, COALESCE(NULLIF(s.avg_cost,0), m.cost) cost
      FROM stock s JOIN materials m ON m.id=s.material_id`).reduce((a, r) => a + r.qty * r.cost, 0)),
    balanced: L.balanceSheet().balanced
  };
});

const LISTS = {
  partners: 'SELECT * FROM partners WHERE active=1 ORDER BY name',
  customers: "SELECT * FROM partners WHERE kind='customer' AND active=1 ORDER BY name",
  vendors: "SELECT * FROM partners WHERE kind='vendor' AND active=1 ORDER BY name",
  projects: 'SELECT p.*, pa.name customer FROM projects p LEFT JOIN partners pa ON pa.id=p.customer_id ORDER BY p.code DESC',
  tasks: 'SELECT t.*, p.name project FROM tasks t JOIN projects p ON p.id=t.project_id ORDER BY t.id',
  materials: 'SELECT m.*, COALESCE(SUM(s.qty),0) qty FROM materials m LEFT JOIN stock s ON s.material_id=m.id GROUP BY m.id ORDER BY m.code',
  warehouses: 'SELECT * FROM warehouses ORDER BY id',
  stock: `SELECT s.*, m.code, m.name, m.unit, m.minq, m.cost list_cost,
    COALESCE(NULLIF(s.avg_cost,0), m.cost) cost, w.name warehouse
    FROM stock s JOIN materials m ON m.id=s.material_id
    JOIN warehouses w ON w.id=s.warehouse_id ORDER BY m.code`,
  employees: 'SELECT * FROM employees ORDER BY code',
  moves: 'SELECT mv.*, m.code, m.name FROM moves mv JOIN materials m ON m.id=mv.material_id ORDER BY mv.id DESC LIMIT 200',
  journals: 'SELECT j.*, u.name author FROM journals j LEFT JOIN users u ON u.id=j.created_by ORDER BY j.id DESC LIMIT 200',
  audit: 'SELECT * FROM audit ORDER BY id DESC LIMIT 300',
  payruns: 'SELECT * FROM payruns ORDER BY period DESC',
  approvals: 'SELECT a.*, u.name requester FROM approvals a LEFT JOIN users u ON u.id=a.requested_by ORDER BY a.id DESC',
  accounts: 'SELECT * FROM accounts ORDER BY code',
};
Object.entries(LISTS).forEach(([n, sql]) => R('GET', '/api/' + n, c => {
  if (!can(c.user, 'read', n)) throw new Error('لا تملك صلاحية عرض هذه البيانات');
  return q(sql);
}));

R('GET', '/api/invoices', c => {
  if (!can(c.user, 'read', 'invoices')) throw new Error('لا تملك صلاحية عرض الفواتير');
  return q(`SELECT i.*, pa.name customer, p.name project,
    (SELECT COALESCE(SUM(qty*price),0) FROM invlines WHERE invoice_id=i.id) net,
    (SELECT COALESCE(SUM(qty*price*vat),0) FROM invlines WHERE invoice_id=i.id) vat,
    (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=i.id) paid
  FROM invoices i JOIN partners pa ON pa.id=i.customer_id
  LEFT JOIN projects p ON p.id=i.project_id ORDER BY i.id DESC`);
});
R('GET', '/api/pos', c => {
  if (!can(c.user, 'read', 'pos')) throw new Error('لا تملك صلاحية عرض أوامر الشراء');
  return q(`SELECT po.*, v.name vendor, p.name project,
    (SELECT COALESCE(SUM(qty*price),0) FROM polines WHERE po_id=po.id) net
  FROM pos po JOIN partners v ON v.id=po.vendor_id
  LEFT JOIN projects p ON p.id=po.project_id ORDER BY po.id DESC`);
});
R('GET', '/api/payments', c => q(`SELECT pm.*, pa.name partner, i.code invoice
  FROM payments pm LEFT JOIN partners pa ON pa.id=pm.partner_id
  LEFT JOIN invoices i ON i.id=pm.invoice_id ORDER BY pm.id DESC`));

R('GET', '/api/invoice', c => {
  const inv = get1(`SELECT i.*, pa.name customer, pa.vat customer_vat, p.name project
    FROM invoices i JOIN partners pa ON pa.id=i.customer_id
    LEFT JOIN projects p ON p.id=i.project_id WHERE i.id=?`, c.query.id);
  if (!inv) throw new Error('الفاتورة غير موجودة');
  return { ...inv, lines: q('SELECT * FROM invlines WHERE invoice_id=?', inv.id),
    totals: invoiceTotal(inv.id), payments: q('SELECT * FROM payments WHERE invoice_id=?', inv.id),
    qr_tags: inv.zatca_qr ? Z.decodeQR(inv.zatca_qr).map(t => ({ ...t, name: Z.TAG_NAMES[t.tag] })) : null };
});
R('GET', '/api/po', c => {
  const po = get1(`SELECT po.*, v.name vendor, p.name project, w.name warehouse FROM pos po
    JOIN partners v ON v.id=po.vendor_id LEFT JOIN projects p ON p.id=po.project_id
    LEFT JOIN warehouses w ON w.id=po.warehouse_id WHERE po.id=?`, c.query.id);
  if (!po) throw new Error('أمر الشراء غير موجود');
  return { ...po, total: poTotal(po.id), lines: q(`SELECT pl.*, m.code, m.name mat_name, m.unit
    FROM polines pl LEFT JOIN materials m ON m.id=pl.material_id WHERE pl.po_id=?`, po.id) };
});
R('GET', '/api/journal', c => {
  const j = get1('SELECT * FROM journals WHERE id=?', c.query.id);
  if (!j) throw new Error('القيد غير موجود');
  return { ...j, lines: q(`SELECT l.*, a.name account_name, p.name project FROM jlines l
    JOIN accounts a ON a.code=l.account LEFT JOIN projects p ON p.id=l.project_id
    WHERE l.journal_id=?`, j.id) };
});

/* Financial reports expose the whole ledger — restrict to roles that read '*'. */
const fin = fn => c => {
  if (!can(c.user, 'read', 'journals') && !can(c.user, 'read', '*'))
    throw new Error('لا تملك صلاحية عرض التقارير المالية');
  return fn(c);
};
R('GET', '/api/report/trial', fin(c => L.trialBalance(c.query.to)));
R('GET', '/api/report/pnl', fin(c => L.pnl(c.query.from || '2000-01-01', c.query.to || '2100-01-01')));
R('GET', '/api/report/bs', fin(c => L.balanceSheet(c.query.to)));
R('GET', '/api/report/vat', fin(c => L.vatReturn(c.query.from || '2000-01-01', c.query.to || '2100-01-01')));
R('GET', '/api/report/aged', fin(c => L.agedReceivables(c.query.asof)));
R('GET', '/api/report/ledger', fin(c => L.ledger(c.query.account, c.query.from, c.query.to)));
R('GET', '/api/report/project', c => {
  if (!can(c.user, 'read', 'projects')) throw new Error('لا تملك صلاحية عرض المشاريع');
  return L.projectPL(Number(c.query.id));
});
R('GET', '/api/eos', c => {
  if (!can(c.user, 'read', 'employees')) throw new Error('لا تملك صلاحية عرض بيانات الموظفين');
  return eos(Number(c.query.id), c.query.end, c.query.reason);
});

R('POST', '/api/invoice/create', c => ({ id: createInvoice(c.user, c.body) }));
R('POST', '/api/invoice/post', c => postInvoice(c.user, Number(c.body.id)));
R('POST', '/api/invoice/zatca', c => {
  const o = stampZatca(c.user, Number(c.body.id));
  return { uuid: o.uuid, hash: o.hash, qr: o.qr, simulated: o.simulated,
    tags: Z.decodeQR(o.qr).map(t => ({ ...t, name: Z.TAG_NAMES[t.tag] })) };
});
R('POST', '/api/po/create', c => ({ id: createPO(c.user, c.body) }));
R('POST', '/api/po/submit', c => submitPO(c.user, Number(c.body.id)));
R('POST', '/api/po/approve', c => approvePO(c.user, Number(c.body.id), c.body.ok !== false, c.body.note));
R('POST', '/api/po/receive', c => receivePO(c.user, Number(c.body.id), c.body.receipts));
R('POST', '/api/material/issue', c => issueMaterial(c.user, c.body));
R('POST', '/api/timesheet', c => logTime(c.user, c.body));
R('POST', '/api/payment', c => recordPayment(c.user, c.body));
R('POST', '/api/payroll/run', c => runPayroll(c.user, c.body.period));
R('POST', '/api/journal/manual', c => {
  if (!can(c.user, 'write', 'journals')) throw new Error('لا تملك صلاحية إنشاء القيود');
  return { id: L.post({ ...c.body, user_id: c.user.id, src_type: 'manual' }) };
});
R('POST', '/api/journal/reverse', c => {
  if (!can(c.user, 'write', 'journals')) throw new Error('لا تملك صلاحية عكس القيود');
  return { id: L.reverse(Number(c.body.id), c.user.id, c.body.why) };
});

/* ═══════════ Phase A routes: sales · projects · materials ═══════════ */
const needs = (res, fn) => c => {
  if (!can(c.user, 'read', res) && !can(c.user, 'read', '*'))
    throw new Error('لا تملك صلاحية الوصول');
  return fn(c);
};
const writes = (res, fn) => c => {
  if (!can(c.user, 'write', res)) throw new Error('لا تملك صلاحية التعديل');
  return fn(c);
};

/* — opportunities — */
R('GET', '/api/pipeline', needs('sales', () => SL.pipeline()));
R('POST', '/api/opp/save', writes('sales', c => SL.saveOpp(c.user, c.body)));
R('POST', '/api/opp/lose', writes('sales', c => {
  run("UPDATE opps SET stage='خسر', lost_reason=?, competitor=? WHERE id=?",
      c.body.reason || null, c.body.competitor || null, c.body.id);
  audit(c.user, 'lost', 'opp', c.body.id, c.body.reason);
  return { ok: true };
}));

/* — quotations / BOQ — */
R('GET', '/api/quotes', needs('sales', () => q(`SELECT q.*, p.name customer,
    (SELECT COALESCE(SUM(qty*price),0) FROM qlines WHERE quote_id=q.id) net,
    (SELECT COALESCE(SUM(qty*cost),0) FROM qlines WHERE quote_id=q.id) cost
  FROM quotes q JOIN partners p ON p.id=q.customer_id ORDER BY q.id DESC`)));
R('GET', '/api/quote', needs('sales', c => SL.quoteDetail(Number(c.query.id))));
R('POST', '/api/quote/create', writes('sales', c => ({ id: SL.createQuote(c.user, c.body) })));
R('POST', '/api/quote/send', writes('sales', c => SL.sendQuote(c.user, Number(c.body.id))));
R('POST', '/api/quote/win', writes('projects', c => {
  const r = SL.winQuote(c.user, Number(c.body.id), c.body);
  audit(c.user, 'win-quote', 'quote', c.body.id, 'مشروع ' + r.code);
  return r;
}));
R('POST', '/api/quote/invoice', c => {
  if (!can(c.user, 'write', 'invoices')) throw new Error('لا تملك صلاحية إصدار الفواتير');
  return SL.quoteToInvoice(c.user, Number(c.body.id), createInvoice);
});

/* — tasks & progress — */
R('POST', '/api/task/save', writes('tasks', c => SL.saveTask(c.user, c.body)));
R('GET', '/api/project/tasks', needs('projects', c =>
  q('SELECT * FROM tasks WHERE project_id=? ORDER BY sdate, id', c.query.id)));
R('POST', '/api/project/rollup', writes('tasks', c => ({ progress: SL.rollupProgress(Number(c.body.id)) })));

/* — daily reports — */
R('POST', '/api/daily/save', writes('dailyreports', c => SL.saveDaily(c.user, c.body)));
R('GET', '/api/daily', needs('dailyreports', c => SL.dailyStats(Number(c.query.id), Number(c.query.days) || 30)));

/* — timesheets list — */
R('GET', '/api/timesheets', needs('timesheets', c => q(`SELECT t.*, e.name employee, p.name project
  FROM timesheets t JOIN employees e ON e.id=t.employee_id
  JOIN projects p ON p.id=t.project_id ORDER BY t.id DESC LIMIT 200`)));

/* — material requests — */
R('GET', '/api/matreqs', needs('materials', () => q(`SELECT mr.*, p.name project, u.name requester,
    (SELECT COUNT(*) FROM mrlines WHERE mr_id=mr.id) n
  FROM matreqs mr JOIN projects p ON p.id=mr.project_id
  LEFT JOIN users u ON u.id=mr.requested_by ORDER BY mr.id DESC`)));
R('GET', '/api/matreq', needs('materials', c => SL.mrDetail(Number(c.query.id))));
R('POST', '/api/matreq/create', c => {
  if (!can(c.user, 'write', 'dailyreports') && !can(c.user, 'write', 'moves') && !can(c.user, 'write', 'pos'))
    throw new Error('لا تملك صلاحية طلب المواد');
  const id = SL.createMR(c.user, c.body);
  audit(c.user, 'create', 'matreq', id, '');
  return { id };
});
R('POST', '/api/matreq/approve', c => {
  if (!can(c.user, 'approve', 'po')) throw new Error('لا تملك صلاحية اعتماد طلبات المواد');
  return SL.approveMR(c.user, Number(c.body.id), c.body.ok !== false);
});
R('POST', '/api/matreq/fulfil', writes('moves', c => SL.fulfilMR(c.user, Number(c.body.id), issueMaterial)));

/* — stock transfer — */
R('POST', '/api/stock/transfer', writes('moves', c => {
  const r = SL.transfer(c.user, c.body);
  audit(c.user, 'transfer', 'material', c.body.material_id, r.qty + ' @ ' + r.unit_cost);
  return r;
}));

/* ═══════════ v1.2 — المستخلصات والمحتجزات وأوامر التغيير ═══════════ */

R('GET', '/api/contracts', needs('contracts', () => q(`SELECT c.*, p.code project_code,
    p.name project, p.status project_status, pa.name customer,
    (SELECT COALESCE(SUM(qty*price),0) FROM citems WHERE contract_id=c.id) value,
    (SELECT COUNT(*) FROM ipcs WHERE contract_id=c.id AND status='معتمد') ipc_count
  FROM contracts c JOIN projects p ON p.id=c.project_id
  LEFT JOIN partners pa ON pa.id=p.customer_id ORDER BY p.code DESC`)));

R('GET', '/api/contract', needs('contracts', c => PG.contractDetail(Number(c.query.project_id))));
R('POST', '/api/contract/save', writes('contracts', c => PG.saveContract(c.user, c.body)));
R('POST', '/api/contract/advance', c => {
  if (!can(c.user, 'write', 'payments') && !can(c.user, 'write', 'contracts'))
    throw new Error('لا تملك صلاحية تسجيل الدفعة المقدمة');
  const r = PG.receiveAdvance(c.user, c.body);
  audit(c.user, 'advance', 'contract', c.body.contract_id, String(r.amount));
  return r;
});

R('GET', '/api/ipcs', needs('ipc', () => q(`SELECT i.*, p.code project_code, p.name project,
    pa.name customer FROM ipcs i JOIN projects p ON p.id=i.project_id
  LEFT JOIN partners pa ON pa.id=p.customer_id ORDER BY i.id DESC`)));
R('GET', '/api/ipc', needs('ipc', c => PG.ipcDetail(Number(c.query.id))));
R('GET', '/api/ipc/draft', needs('ipc', c => PG.ipcDraft(Number(c.query.contract_id))));
R('POST', '/api/ipc/create', writes('ipc', c => {
  const id = PG.createIPC(c.user, c.body);
  audit(c.user, 'create', 'ipc', id, '');
  return { id };
}));
R('POST', '/api/ipc/submit', writes('ipc', c => {
  const r = PG.submitIPC(c.user, Number(c.body.id));
  audit(c.user, 'submit', 'ipc', c.body.id, String(r.total));
  return r;
}));
R('POST', '/api/ipc/approve', c => {
  if (!can(c.user, 'approve', 'ipc')) throw new Error('لا تملك صلاحية اعتماد المستخلصات');
  const ipc = get1('SELECT total FROM ipcs WHERE id=?', c.body.id);
  if (!ipc) throw new Error('المستخلص غير موجود');
  const ok = c.body.ok !== false;
  if (ok && R2(ipc.total) > limitOf(c.user))
    throw new Error(`قيمة المستخلص ${R2(ipc.total)} تتجاوز حدّ اعتمادك (${limitOf(c.user)}) — يلزم اعتماد المالك`);
  const r = PG.approveIPC(c.user, Number(c.body.id), ok, c.body.note);
  audit(c.user, ok ? 'approve' : 'reject', 'ipc', c.body.id, String(ipc.total));
  return r;
});

R('GET', '/api/vos', needs('contracts', () => q(`SELECT v.*, p.code project_code, p.name project,
    u.name approver FROM vos v JOIN projects p ON p.id=v.project_id
  LEFT JOIN users u ON u.id=v.approved_by ORDER BY v.id DESC`)));
R('GET', '/api/vo', needs('contracts', c => {
  const v = get1(`SELECT v.*, p.code project_code, p.name project FROM vos v
    JOIN projects p ON p.id=v.project_id WHERE v.id=?`, c.query.id);
  if (!v) throw new Error('أمر التغيير غير موجود');
  return { ...v, lines: q('SELECT * FROM volines WHERE vo_id=? ORDER BY id', v.id) };
}));
R('POST', '/api/vo/create', writes('vo', c => {
  const r = PG.createVO(c.user, c.body);
  audit(c.user, 'create', 'vo', r.id, r.code + ' · ' + r.amount);
  return r;
}));
R('POST', '/api/vo/approve', c => {
  if (!can(c.user, 'approve', 'vo')) throw new Error('لا تملك صلاحية اعتماد أوامر التغيير');
  const vo = get1('SELECT amount FROM vos WHERE id=?', c.body.id);
  if (!vo) throw new Error('أمر التغيير غير موجود');
  const ok = c.body.ok !== false;
  if (ok && R2(vo.amount) > limitOf(c.user))
    throw new Error(`قيمة أمر التغيير ${R2(vo.amount)} تتجاوز حدّ اعتمادك (${limitOf(c.user)})`);
  const r = PG.approveVO(c.user, Number(c.body.id), ok, c.body.note);
  audit(c.user, ok ? 'approve' : 'reject', 'vo', c.body.id, String(vo.amount));
  return r;
});

R('GET', '/api/subcerts', needs('subcert', () => q(`SELECT s.*, p.code project_code,
    p.name project, v.name vendor FROM subcerts s JOIN projects p ON p.id=s.project_id
  JOIN partners v ON v.id=s.vendor_id ORDER BY s.id DESC`)));
R('GET', '/api/subcert', needs('subcert', c => PG.subcertDetail(Number(c.query.id))));
R('POST', '/api/subcert/create', writes('subcert', c => {
  const id = PG.createSubcert(c.user, c.body);
  audit(c.user, 'create', 'subcert', id, '');
  return { id };
}));
R('POST', '/api/subcert/approve', c => {
  if (!can(c.user, 'approve', 'subcert')) throw new Error('لا تملك صلاحية اعتماد شهادات المقاولين');
  const sc = get1('SELECT total FROM subcerts WHERE id=?', c.body.id);
  if (!sc) throw new Error('الشهادة غير موجودة');
  const ok = c.body.ok !== false;
  if (ok && R2(sc.total) > limitOf(c.user))
    throw new Error(`قيمة الشهادة ${R2(sc.total)} تتجاوز حدّ اعتمادك (${limitOf(c.user)})`);
  const r = PG.approveSubcert(c.user, Number(c.body.id), ok, c.body.note);
  audit(c.user, ok ? 'approve' : 'reject', 'subcert', c.body.id, String(sc.total));
  return r;
});

R('GET', '/api/retention', needs('contracts', () => PG.retentionBoard()));
R('POST', '/api/retention/release', c => {
  if (!can(c.user, 'write', 'retention') && !can(c.user, 'write', 'payments'))
    throw new Error('لا تملك صلاحية الإفراج عن المحتجزات');
  const amt = R2(c.body.amount);
  if (amt > limitOf(c.user))
    throw new Error(`المبلغ ${amt} يتجاوز حدّ صلاحيتك (${limitOf(c.user)})`);
  const r = PG.releaseRetention(c.user, c.body);
  audit(c.user, 'retention-release', c.body.kind, c.body.project_id, String(amt));
  return r;
});
R('GET', '/api/project/status', needs('projects', c => PG.projectStatus(Number(c.query.id))));

/* ═══════════ v1.2 — الرواتب الكاملة ═══════════ */

R('GET', '/api/hr/dashboard', needs('employees', () => HR.hrDashboard()));
R('GET', '/api/hr/expiring', needs('employees', c => HR.expiringDocs(c.query.days)));

R('GET', '/api/advances', needs('advances', () => q(`SELECT a.*, e.name employee, e.code emp_code,
    u.name approver FROM advances a JOIN employees e ON e.id=a.employee_id
  LEFT JOIN users u ON u.id=a.approved_by ORDER BY a.id DESC`)));
R('GET', '/api/advance/balance', needs('advances', c => HR.advanceBalance(Number(c.query.employee_id))));
R('POST', '/api/advance/request', writes('advances', c => {
  const r = HR.requestAdvance(c.user, c.body);
  audit(c.user, 'create', 'advance', r.id, String(r.amount));
  return r;
}));
R('POST', '/api/advance/approve', c => {
  /* صرف السلفة نقد — يلزم صلاحية مالية، لا صلاحية موارد بشرية */
  if (!can(c.user, 'approve', 'payment') && c.user.role !== 'admin')
    throw new Error('اعتماد السلف يحتاج صلاحية مالية');
  const a = get1('SELECT amount FROM advances WHERE id=?', c.body.id);
  if (!a) throw new Error('السلفة غير موجودة');
  const ok = c.body.ok !== false;
  if (ok && R2(a.amount) > limitOf(c.user))
    throw new Error(`مبلغ السلفة ${R2(a.amount)} يتجاوز حدّ صلاحيتك (${limitOf(c.user)})`);
  const r = HR.approveAdvance(c.user, Number(c.body.id), ok, c.body.note);
  audit(c.user, ok ? 'approve' : 'reject', 'advance', c.body.id, String(a.amount));
  return r;
});

R('GET', '/api/leaves', needs('leaves', () => q(`SELECT l.*, e.name employee, e.code emp_code,
    u.name approver FROM leaves l JOIN employees e ON e.id=l.employee_id
  LEFT JOIN users u ON u.id=l.approved_by ORDER BY l.id DESC`)));
R('GET', '/api/leave/balance', needs('leaves', c => HR.leaveBalance(Number(c.query.employee_id))));
R('POST', '/api/leave/request', writes('leaves', c => {
  const r = HR.requestLeave(c.user, c.body);
  audit(c.user, 'create', 'leave', r.id, r.days + ' يوم');
  return r;
}));
R('POST', '/api/leave/approve', c => {
  if (!can(c.user, 'approve', 'leave') && c.user.role !== 'admin')
    throw new Error('لا تملك صلاحية اعتماد الإجازات');
  const r = HR.approveLeave(c.user, Number(c.body.id), c.body.ok !== false, c.body.note);
  audit(c.user, r.ok ? 'approve' : 'reject', 'leave', c.body.id, r.days + ' يوم');
  return r;
});

R('POST', '/api/payrun/open', writes('payruns', c => HR.openPayrun(c.user, c.body.period)));
R('POST', '/api/payrun/item', writes('payruns', c => HR.addPayItem(c.user, c.body)));
R('POST', '/api/payrun/compute', writes('payruns', c => HR.computePayrun(Number(c.body.id))));
R('GET', '/api/payrun', needs('payruns', c => HR.payrunDetail(Number(c.query.id))));
R('POST', '/api/payrun/approve', c => {
  /* اعتماد المسير يُرحّل قيداً مالياً — المالك أو المحاسب فقط */
  if (c.user.role !== 'admin' && !can(c.user, 'write', 'journals'))
    throw new Error('اعتماد المسير يحتاج صلاحية مالية');
  const r = HR.approvePayrun(c.user, Number(c.body.id));
  audit(c.user, 'approve', 'payrun', c.body.id, String(r.net));
  return r;
});
R('POST', '/api/payrun/wps', c => {
  if (!can(c.user, 'write', 'payruns') && c.user.role !== 'admin')
    throw new Error('لا تملك صلاحية توليد ملف الأجور');
  const r = HR.generateWPS(c.user, Number(c.body.id));
  audit(c.user, 'wps', 'payrun', c.body.id, r.nlines + ' موظف · ' + r.total);
  return r;
});

/* ═══════════ v1.2 — المشتريات المتقدمة ═══════════ */

R('GET', '/api/rfqs', needs('pos', () => q(`SELECT r.*, p.name project, v.name awarded,
    (SELECT COUNT(*) FROM rfqvendors WHERE rfq_id=r.id) invited,
    (SELECT COUNT(*) FROM rfqvendors WHERE rfq_id=r.id AND status='مُستلم') replied
  FROM rfqs r LEFT JOIN projects p ON p.id=r.project_id
  LEFT JOIN partners v ON v.id=r.awarded_vendor ORDER BY r.id DESC`)));
R('GET', '/api/rfq', needs('pos', c => PC.compareRFQ(Number(c.query.id))));
R('POST', '/api/rfq/create', writes('pos', c => {
  const r = PC.createRFQ(c.user, c.body);
  audit(c.user, 'create', 'rfq', r.id, r.code + ' · ' + r.vendors + ' موردين');
  return r;
}));
R('POST', '/api/rfq/quote', writes('pos', c => {
  const r = PC.recordQuote(c.user, c.body);
  audit(c.user, 'quote', 'rfq', c.body.rfqvendor_id, String(r.total));
  return r;
}));
R('POST', '/api/rfq/award', c => {
  if (!can(c.user, 'approve', 'po')) throw new Error('لا تملك صلاحية إرساء طلبات العروض');
  const r = PC.awardRFQ(c.user, c.body, createPO, submitPO);
  audit(c.user, 'award', 'rfq', c.body.rfqvendor_id, 'أمر شراء #' + r.po_id);
  return r;
});

R('GET', '/api/prices', needs('materials', c => PC.bestPrices(Number(c.query.material_id))));
R('POST', '/api/price/save', writes('pos', c => PC.savePrice(c.user, c.body)));

R('GET', '/api/bills', needs('pos', () => q(`SELECT b.*, v.name vendor, p.code po_code
  FROM bills b JOIN partners v ON v.id=b.vendor_id
  LEFT JOIN pos p ON p.id=b.po_id ORDER BY b.id DESC`)));
R('GET', '/api/bill', needs('pos', c => PC.billDetail(Number(c.query.id))));
R('POST', '/api/bill/create', c => {
  if (!can(c.user, 'write', 'invoices') && !can(c.user, 'write', 'pos'))
    throw new Error('لا تملك صلاحية تسجيل فواتير الموردين');
  const r = PC.createBill(c.user, c.body);
  audit(c.user, 'create', 'bill', r.id, r.code + ' · ' + r.total);
  return r;
});
R('POST', '/api/bill/match', needs('pos', c => PC.matchBill(Number(c.body.id))));
R('POST', '/api/bill/post', c => {
  if (!can(c.user, 'write', 'journals')) throw new Error('ترحيل فواتير الموردين يحتاج صلاحية محاسبية');
  /* التجاوز عن فروق المطابقة صلاحية المالك وحده */
  if (c.body.override === true && c.user.role !== 'admin')
    throw new Error('تجاوز فروق المطابقة الثلاثية للمالك فقط');
  const r = PC.postBill(c.user, Number(c.body.id), c.body);
  audit(c.user, 'post', 'bill', c.body.id,
    r.total + (r.overridden ? ' · تجاوز: ' + c.body.reason : ''));
  return r;
});

R('GET', '/api/vendors/scores', needs('partners', () => PC.vendorBoard()));
R('GET', '/api/vendor/score', needs('partners', c => PC.vendorScore(Number(c.query.id))));

/* ═══════════ v1.2 — المستندات والتقارير وسجل التدقيق ═══════════ */

/* المرفق يتبع صلاحية الكيان المرتبط به: من يقرأ الفاتورة يقرأ مرفقاتها */
const ENT_RES = { project: 'projects', invoice: 'invoices', po: 'pos', bill: 'pos',
  ipc: 'ipc', vo: 'contracts', subcert: 'subcert', contract: 'contracts',
  employee: 'employees', partner: 'partners', quote: 'sales', rfq: 'pos',
  payrun: 'payruns', task: 'tasks', matreq: 'materials' };
const entRes = e => ENT_RES[e] || 'journals';

R('GET', '/api/attachments', c => {
  const res = entRes(c.query.entity);
  if (!can(c.user, 'read', res) && !can(c.user, 'read', '*'))
    throw new Error('لا تملك صلاحية عرض مرفقات هذا السجل');
  return DOC.listAttachments(c.query.entity, Number(c.query.entity_id));
});
R('GET', '/api/attachment', c => {
  const a = get1('SELECT entity FROM attachments WHERE id=?', c.query.id);
  if (!a) throw new Error('المرفق غير موجود');
  if (!can(c.user, 'read', entRes(a.entity)) && !can(c.user, 'read', '*'))
    throw new Error('لا تملك صلاحية تحميل هذا المرفق');
  return DOC.getAttachment(Number(c.query.id));
});
R('POST', '/api/attachment/add', c => {
  if (!can(c.user, 'write', entRes(c.body.entity)))
    throw new Error('لا تملك صلاحية الإرفاق بهذا السجل');
  const r = DOC.attach(c.user, c.body);
  audit(c.user, 'attach', c.body.entity, c.body.entity_id, r.filename + ' · ' + r.size + ' بايت');
  return r;
});
R('POST', '/api/attachment/delete', c => {
  const a = get1('SELECT * FROM attachments WHERE id=?', c.body.id);
  if (!a) throw new Error('المرفق غير موجود');
  /* الحذف للمالك أو لمن رفعه — لا يمحو أحد مستند غيره */
  if (c.user.role !== 'admin' && a.uploaded_by !== c.user.id)
    throw new Error('لا يمكنك حذف مرفق رفعه غيرك');
  const r = DOC.deleteAttachment(c.user, Number(c.body.id));
  audit(c.user, 'attach-delete', a.entity, a.entity_id, r.filename);
  return r;
});
R('GET', '/api/attachments/stats', c => {
  if (c.user.role !== 'admin') throw new Error('المالك فقط');
  return DOC.attachmentStats();
});

R('GET', '/api/reports', c => DOC.reportList());
R('GET', '/api/report/data', fin(c => DOC.reportData(c.query.key, c.query)));
R('POST', '/api/report/xlsx', fin(c => {
  const r = DOC.exportXlsx(c.body.key, c.body);
  audit(c.user, 'export', 'report', c.body.key, r.rows + ' سجل');
  return r;
}));
R('POST', '/api/report/pack', fin(c => {
  const r = DOC.exportPack(c.body.keys, c.body);
  audit(c.user, 'export', 'report-pack', (c.body.keys || []).join(','), r.sheets + ' ورقة');
  return r;
}));

/* صفحة الطباعة: المتصفح يحوّلها PDF — التوكن في الرابط لأن الطباعة
   تُفتح في نافذة جديدة لا تحمل ترويسة المصادقة. */
R('GET', '/api/report/print', c => {
  const u = c.user || userFromToken(c.query.token);
  if (!u) throw new Error('الجلسة منتهية — سجّل الدخول');
  if (!can(u, 'read', 'journals') && !can(u, 'read', '*'))
    throw new Error('لا تملك صلاحية عرض التقارير');
  audit(u, 'print', 'report', c.query.key, '');
  return { __html: DOC.printable(c.query.key, c.query) };
}, { open: true });

R('GET', '/api/audit/trail', c => {
  if (c.user.role !== 'admin' && !can(c.user, 'read', '*'))
    throw new Error('سجل التدقيق للمالك والمحاسب فقط');
  return DOC.auditTrail(c.query);
});
R('GET', '/api/audit/entity', c => {
  if (!can(c.user, 'read', entRes(c.query.entity)) && !can(c.user, 'read', '*'))
    throw new Error('لا تملك صلاحية عرض أثر هذا السجل');
  return DOC.entityTrail(c.query.entity, Number(c.query.entity_id));
});
R('GET', '/api/audit/stats', c => {
  if (c.user.role !== 'admin') throw new Error('المالك فقط');
  return DOC.auditStats(c.query.days);
});

const CRUD = {
  partners: ['kind','name','vat','contact','phone','email','city','terms','trade','rating','ontime'],
  projects: ['code','name','customer_id','trade','ctype','value','sdate','ddate','progress','pm_id','status'],
  materials: ['code','name','spec','trade','unit','cost','minq'],
  employees: ['code','name','job','dept','ptype','basic','housing','transport','site','hired','phone','nid','iban','status','cost_rate',
              'nationality','iqama','iqama_exp','passport','passport_exp','license','license_exp','contract_exp','bank','gosi_sub','leave_ent'],
  tasks: ['project_id','name','trade','zone','phase','assignee','exec','progress','status','ddate'],
};
Object.entries(CRUD).forEach(([t, cols]) => R('POST', '/api/' + t + '/save', c => {
  if (!can(c.user, 'write', t)) throw new Error('لا تملك صلاحية التعديل');
  const b = c.body, vals = cols.map(k => b[k] === undefined ? null : b[k]);
  if (b.id) {
    run(`UPDATE ${t} SET ${cols.map(k => k + '=?').join(',')} WHERE id=?`, ...vals, b.id);
    audit(c.user, 'update', t, b.id, b.name || b.code || '');
    return { id: b.id };
  }
  const info = run(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...vals);
  audit(c.user, 'create', t, Number(info.lastInsertRowid), b.name || b.code || '');
  return { id: Number(info.lastInsertRowid) };
}));

/* ═══════════ HTTP ═══════════ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function send(res, code, data, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type ? data : JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', d => { raw += d; if (raw.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'JSON غير صالح' }); }
      const route = routes[req.method + ' ' + u.pathname];
      if (!route) return send(res, 404, { error: 'مسار غير موجود' });
      const user = userFromToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!route.o.open && !user) return send(res, 401, { error: 'الجلسة منتهية — سجّل الدخول' });
      try {
        const out = route.h({ user, body, query: Object.fromEntries(u.searchParams),
                              token: (req.headers.authorization || '').replace(/^Bearer\s+/i, '') });
        /* بعض المسارات تُرجع صفحة للطباعة بدل JSON */
        if (out && typeof out === 'object' && typeof out.__html === 'string')
          return send(res, 200, out.__html, 'text/html; charset=utf-8');
        send(res, 200, out === undefined ? { ok: true } : out);
      } catch (e) { send(res, 400, { error: e.message }); }
    });
    return;
  }
  let f = u.pathname === '/' ? '/index.html' : u.pathname;
  const full = path.join(__dirname, 'public', path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(path.join(__dirname, 'public'))) return send(res, 403, { error: 'ممنوع' });
  fs.readFile(full, (err, data) => err
    ? send(res, 404, 'Not found', 'text/plain; charset=utf-8')
    : send(res, 200, data, MIME[path.extname(full)] || 'application/octet-stream'));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('VISION ERP → http://localhost:' + PORT);
    console.log('admin/admin123 · ahmad/pm123 · saad/eng123 · noura/acc123 · fahad/store123 · mai/hr123');
  });
}
module.exports = { server, login, can, createInvoice, postInvoice, stampZatca, createPO,
  submitPO, approvePO, receivePO, issueMaterial, logTime, recordPayment, runPayroll, eos,
  invoiceTotal, poTotal, PERM };
