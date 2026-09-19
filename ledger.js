'use strict';
const { db, q, get1, run } = require('./db');

const R2 = n => Math.round((Number(n) || 0) * 100) / 100;

/* ═══════════ POST A BALANCED JOURNAL ═══════════
   lines: [{account, debit, credit, project_id, partner_id, memo}]
   Refuses to post unless debits === credits. This is the core guarantee. */
function post({ ref, date, memo, src_type, src_id, lines, user_id }) {
  if (!Array.isArray(lines) || lines.length < 2)
    throw new Error('القيد يحتاج سطرين على الأقل');

  let td = 0, tc = 0;
  const clean = lines.map(l => {
    const d = R2(l.debit), c = R2(l.credit);
    if (d < 0 || c < 0) throw new Error('لا يُسمح بقيم سالبة في القيد');
    if (d > 0 && c > 0) throw new Error('السطر إما مدين أو دائن وليس كليهما');
    if (d === 0 && c === 0) return null;
    const acct = get1('SELECT code FROM accounts WHERE code=?', String(l.account));
    if (!acct) throw new Error('حساب غير معرّف: ' + l.account);
    td += d; tc += c;
    return { account: String(l.account), debit: d, credit: c,
             project_id: l.project_id || null, partner_id: l.partner_id || null, memo: l.memo || null };
  }).filter(Boolean);

  if (clean.length < 2) throw new Error('القيد فارغ');
  if (R2(td) !== R2(tc))
    throw new Error(`القيد غير متوازن: مدين ${R2(td)} مقابل دائن ${R2(tc)}`);

  const info = run(
    'INSERT INTO journals(ref,jdate,memo,src_type,src_id,posted,created_by,created) VALUES(?,?,?,?,?,1,?,?)',
    ref || null, date, memo || null, src_type || null, src_id || null, user_id || null, new Date().toISOString()
  );
  const jid = Number(info.lastInsertRowid);
  const ins = db.prepare('INSERT INTO jlines(journal_id,account,debit,credit,project_id,partner_id,memo) VALUES(?,?,?,?,?,?,?)');
  clean.forEach(l => ins.run(jid, l.account, l.debit, l.credit, l.project_id, l.partner_id, l.memo));
  return jid;
}

/* Reverse a journal (never delete — accounting history is immutable) */
function reverse(journal_id, user_id, why) {
  const j = get1('SELECT * FROM journals WHERE id=?', journal_id);
  if (!j) throw new Error('القيد غير موجود');
  const ls = q('SELECT * FROM jlines WHERE journal_id=?', journal_id);
  return post({
    ref: 'REV-' + (j.ref || j.id),
    date: new Date().toISOString().slice(0, 10),
    memo: 'قيد عكسي: ' + (why || j.memo || ''),
    src_type: 'reversal', src_id: journal_id, user_id,
    lines: ls.map(l => ({ account: l.account, debit: l.credit, credit: l.debit,
                          project_id: l.project_id, partner_id: l.partner_id, memo: l.memo }))
  });
}

/* ═══════════ REPORTS — all derived from the ledger ═══════════ */

function trialBalance(upto) {
  const w = upto ? 'AND j.jdate <= ?' : '';
  const p = upto ? [upto] : [];
  return q(`SELECT a.code, a.name, a.type, a.normal,
      COALESCE(SUM(l.debit),0) td, COALESCE(SUM(l.credit),0) tc
    FROM accounts a
    LEFT JOIN jlines l ON l.account=a.code
    LEFT JOIN journals j ON j.id=l.journal_id AND j.posted=1 ${w}
    GROUP BY a.code ORDER BY a.code`, ...p)
   .map(r => {
     const bal = r.normal === 'D' ? r.td - r.tc : r.tc - r.td;
     return { ...r, td: R2(r.td), tc: R2(r.tc), balance: R2(bal) };
   });
}

function balanceOf(code, upto) {
  const w = upto ? 'AND j.jdate <= ?' : '';
  const p = upto ? [code, upto] : [code];
  const a = get1('SELECT normal FROM accounts WHERE code=?', code);
  const r = get1(`SELECT COALESCE(SUM(l.debit),0) td, COALESCE(SUM(l.credit),0) tc
    FROM jlines l JOIN journals j ON j.id=l.journal_id AND j.posted=1 ${w}
    WHERE l.account=?`.replace('WHERE l.account=?', 'WHERE l.account=?'), ...p.slice(0,1).concat(upto?[upto]:[]));
  if (!a) return 0;
  return R2(a.normal === 'D' ? r.td - r.tc : r.tc - r.td);
}

function pnl(from, to) {
  const rows = q(`SELECT a.code,a.name,a.type,
      COALESCE(SUM(l.debit),0) td, COALESCE(SUM(l.credit),0) tc
    FROM accounts a
    LEFT JOIN jlines l ON l.account=a.code
    LEFT JOIN journals j ON j.id=l.journal_id AND j.posted=1
      AND j.jdate >= ? AND j.jdate <= ?
    WHERE a.type IN ('income','expense')
    GROUP BY a.code ORDER BY a.code`, from, to);
  const income = rows.filter(r => r.type === 'income').map(r => ({ ...r, amount: R2(r.tc - r.td) }));
  const expense = rows.filter(r => r.type === 'expense').map(r => ({ ...r, amount: R2(r.td - r.tc) }));
  const ti = R2(income.reduce((s, r) => s + r.amount, 0));
  const te = R2(expense.reduce((s, r) => s + r.amount, 0));
  return { income, expense, total_income: ti, total_expense: te, net: R2(ti - te),
           margin: ti ? R2((ti - te) / ti * 100) : 0 };
}

function balanceSheet(upto) {
  const tb = trialBalance(upto);
  const pick = t => tb.filter(r => r.type === t && r.balance !== 0);
  const assets = pick('asset'), liab = pick('liability'), eq = pick('equity');
  const ta = R2(assets.reduce((s, r) => s + r.balance, 0));
  const tl = R2(liab.reduce((s, r) => s + r.balance, 0));
  const te = R2(eq.reduce((s, r) => s + r.balance, 0));
  // retained earnings = cumulative income - expense
  const inc = tb.filter(r => r.type === 'income').reduce((s, r) => s + r.balance, 0);
  const exp = tb.filter(r => r.type === 'expense').reduce((s, r) => s + r.balance, 0);
  const retained = R2(inc - exp);
  return { assets, liabilities: liab, equity: eq,
           total_assets: ta, total_liabilities: tl, total_equity: R2(te + retained),
           retained, balanced: Math.abs(ta - (tl + te + retained)) < 0.01 };
}

function vatReturn(from, to) {
  const out = get1(`SELECT COALESCE(SUM(l.credit-l.debit),0) v FROM jlines l
    JOIN journals j ON j.id=l.journal_id AND j.posted=1
    WHERE l.account='2200' AND j.jdate>=? AND j.jdate<=?`, from, to).v;
  const inp = get1(`SELECT COALESCE(SUM(l.debit-l.credit),0) v FROM jlines l
    JOIN journals j ON j.id=l.journal_id AND j.posted=1
    WHERE l.account='1400' AND j.jdate>=? AND j.jdate<=?`, from, to).v;
  const sales = get1(`SELECT COALESCE(SUM(l.credit-l.debit),0) v FROM jlines l
    JOIN journals j ON j.id=l.journal_id AND j.posted=1
    JOIN accounts a ON a.code=l.account AND a.type='income'
    WHERE j.jdate>=? AND j.jdate<=?`, from, to).v;
  return { from, to, sales: R2(sales), output_vat: R2(out), input_vat: R2(inp), due: R2(out - inp) };
}

function agedReceivables(asof) {
  const d = asof || new Date().toISOString().slice(0, 10);
  const rows = q(`SELECT i.id,i.code,i.ddate,p.name customer,
      (SELECT COALESCE(SUM(qty*price*(1+vat)),0) FROM invlines WHERE invoice_id=i.id) total,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=i.id) paid
    FROM invoices i JOIN partners p ON p.id=i.customer_id
    WHERE i.status<>'مسودة'`);
  const buckets = { current: 0, d30: 0, d60: 0, d90: 0, d90p: 0 };
  const detail = [];
  rows.forEach(r => {
    const rem = R2(r.total - r.paid);
    if (rem <= 0.01) return;
    const age = Math.floor((new Date(d) - new Date(r.ddate)) / 86400000);
    let b = 'current';
    if (age > 90) b = 'd90p'; else if (age > 60) b = 'd90';
    else if (age > 30) b = 'd60'; else if (age > 0) b = 'd30';
    buckets[b] = R2(buckets[b] + rem);
    detail.push({ ...r, remaining: rem, age, bucket: b });
  });
  return { buckets, detail, total: R2(Object.values(buckets).reduce((a, b) => a + b, 0)) };
}

function projectPL(project_id) {
  const p = get1('SELECT * FROM projects WHERE id=?', project_id);
  if (!p) return null;
  const rows = q(`SELECT a.code,a.name,a.type,
      COALESCE(SUM(l.debit),0) td, COALESCE(SUM(l.credit),0) tc
    FROM jlines l JOIN journals j ON j.id=l.journal_id AND j.posted=1
    JOIN accounts a ON a.code=l.account
    WHERE l.project_id=? AND a.type IN ('income','expense')
    GROUP BY a.code`, project_id);
  const rev = R2(rows.filter(r => r.type === 'income').reduce((s, r) => s + (r.tc - r.td), 0));
  const cost = R2(rows.filter(r => r.type === 'expense').reduce((s, r) => s + (r.td - r.tc), 0));
  return {
    project: p, lines: rows.map(r => ({ ...r, amount: R2(r.type === 'income' ? r.tc - r.td : r.td - r.tc) })),
    revenue: rev, cost: cost, profit: R2(rev - cost),
    margin: rev ? R2((rev - cost) / rev * 100) : 0,
    contract_value: R2(p.value),
    cost_pct: p.value ? R2(cost / p.value * 100) : 0,
    progress: p.progress,
    risk: p.value ? (cost / p.value * 100) > (p.progress + 15) : false
  };
}

function ledger(account, from, to) {
  return q(`SELECT j.id,j.ref,j.jdate,j.memo,l.debit,l.credit,l.memo lmemo,
      pr.name project, pa.name partner
    FROM jlines l JOIN journals j ON j.id=l.journal_id AND j.posted=1
    LEFT JOIN projects pr ON pr.id=l.project_id
    LEFT JOIN partners pa ON pa.id=l.partner_id
    WHERE l.account=? AND j.jdate>=? AND j.jdate<=?
    ORDER BY j.jdate, j.id`, account, from || '0000-01-01', to || '9999-12-31');
}

module.exports = { post, reverse, trialBalance, balanceOf, pnl, balanceSheet,
                   vatReturn, agedReceivables, projectPL, ledger, R2 };
