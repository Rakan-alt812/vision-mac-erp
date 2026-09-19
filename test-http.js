const B = 'http://localhost:3000';
const call = async (p, tok, body) => {
  const r = await fetch(B + '/api/' + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { code: r.status, data: await r.json() };
};
const login = async (u, p) => (await (await fetch(B + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: p }) })).json()).token;

let pass = 0, fail = 0;
const t = (n, ok, x) => { console.log((ok ? '  ✓ ' : '  ✗ ') + n + (x ? '  → ' + x : '')); ok ? pass++ : fail++; };

(async () => {
  const adm = await login('admin', 'admin123');
  const pm = await login('ahmad', 'pm123');
  const eng = await login('saad', 'eng123');
  const store = await login('fahad', 'store123');
  const acc = await login('noura', 'acc123');

  console.log('\n── نقاط النهاية الجديدة ──');
  for (const ep of ['pipeline', 'quotes', 'matreqs', 'timesheets']) {
    const r = await call(ep, adm);
    t(ep + ' يستجيب', r.code === 200, Array.isArray(r.data) ? r.data.length + ' سجل' : 'كائن');
  }
  const pl = await call('pipeline', adm);
  t('خط الأنابيب يحسب القيمة المرجّحة', pl.data.weighted > 0, pl.data.weighted);
  const tk = await call('project/tasks?id=1', adm);
  t('مهام المشروع تُرجع قائمة', tk.code === 200 && tk.data.length >= 7, tk.data.length + ' مهمة');
  const dl = await call('daily?id=1&days=30', adm);
  t('إحصاءات التقرير اليومي', dl.code === 200);

  console.log('\n── دورة كاملة عبر HTTP: فرصة ← BOQ ← مشروع ← فاتورة ──');
  const opp = await call('opp/save', pm, { name: 'مجمع تجاري — الحمراء', customer_id: 1,
    trade: 'MEP كامل', ctype: 'كشف كميات', value: 900000, probability: 60, stage: 'مؤهل' });
  t('إنشاء فرصة', opp.code === 200, opp.data.code);

  const qt = await call('quote/create', pm, { customer_id: 1, opp_id: opp.data.id,
    qtype: 'كشف كميات', lines: [
      { item: 'E-01', descr: 'لوحة رئيسية', trade: 'كهرباء', unit: 'قطعة', qty: 2, cost: 14000, price: 18500 },
      { item: 'P-01', descr: 'شبكة مياه', trade: 'سباكة', unit: 'نظام', qty: 1, cost: 26000, price: 32000 } ] });
  t('إنشاء كشف كميات', qt.code === 200);
  const qd = await call('quote?id=' + qt.data.id, pm);
  // net = 37000 + 32000 = 69000 ; cost = 28000+26000 = 54000
  t('الإجماليات صحيحة', qd.data.totals.net === 69000 && qd.data.totals.cost === 54000,
    'صافي ' + qd.data.totals.net + ' · تكلفة ' + qd.data.totals.cost);
  t('الهامش محسوب', Math.abs(qd.data.totals.margin - 21.74) < 0.05, qd.data.totals.margin + '٪');

  await call('quote/send', pm, { id: qt.data.id });
  const win = await call('quote/win', pm, { id: qt.data.id, name: 'مجمع الحمراء — MEP', ddate: '2027-06-30' });
  t('الفوز أنشأ مشروعاً', win.code === 200, win.data.code + ' · ' + win.data.tasks + ' مهمة');

  const inv = await call('quote/invoice', acc, { id: qt.data.id });
  t('تحويل العرض إلى فاتورة', inv.code === 200, 'فاتورة #' + inv.data.invoice_id);
  const posted = await call('invoice/post', acc, { id: inv.data.invoice_id });
  t('ترحيل الفاتورة', posted.code === 200, 'إجمالي ' + posted.data.total);

  console.log('\n── طلب مواد عبر HTTP ──');
  const mr = await call('matreq/create', eng, { project_id: 1, warehouse_id: 1,
    reason: 'اختبار', lines: [{ material_id: 2, qty: 40 }] });
  t('المهندس يقدّم طلب مواد', mr.code === 200);
  const mrd = await call('matreq?id=' + mr.data.id, eng);
  t('الطلب يحسب النقص', mrd.data.lines[0].shortfall > 0, 'نقص ' + mrd.data.lines[0].shortfall);
  const badApprove = await call('matreq/approve', eng, { id: mr.data.id, ok: true });
  t('المهندس لا يعتمد طلبه', badApprove.code === 400, badApprove.data.error);
  const okApprove = await call('matreq/approve', pm, { id: mr.data.id, ok: true });
  t('مدير المشاريع يعتمد', okApprove.code === 200);

  console.log('\n── النقل بين المستودعات ──');
  const tr = await call('stock/transfer', store, { material_id: 1, from_wh: 1, to_wh: 2, qty: 10 });
  t('أمين المستودع ينقل', tr.code === 200, 'بتكلفة ' + tr.data.unit_cost + '/وحدة');
  const badTr = await call('stock/transfer', acc, { material_id: 1, from_wh: 1, to_wh: 2, qty: 5 });
  t('المحاسب لا ينقل مخزوناً', badTr.code === 400);

  console.log('\n── صلاحيات الشاشات الجديدة ──');
  const engQuotes = await call('quotes', eng);
  t('المهندس ممنوع من عروض الأسعار', engQuotes.code === 400);
  const storePipe = await call('pipeline', store);
  t('أمين المستودع ممنوع من خط الأنابيب', storePipe.code === 400);
  const engTasks = await call('project/tasks?id=1', eng);
  t('المهندس مسموح له بالمهام', engTasks.code === 200);
  const engDaily = await call('daily?id=1', eng);
  t('المهندس مسموح له بالتقرير اليومي', engDaily.code === 200);

  console.log('\n── سلامة الدفاتر ──');
  const tb = await call('report/trial', adm);
  const td = tb.data.reduce((s, r) => s + r.td, 0), tc = tb.data.reduce((s, r) => s + r.tc, 0);
  t('ميزان المراجعة متوازن', Math.abs(td - tc) < 0.01, Math.round(td));
  const bs = await call('report/bs', adm);
  t('الميزانية العمومية متوازنة', bs.data.balanced === true);

  console.log('\n' + '─'.repeat(44));
  console.log(`نجح ${pass} · فشل ${fail}`);
  process.exit(fail ? 1 : 0);
})();
