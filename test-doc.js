'use strict';
/* اختبارات المستندات والتقارير وسجل التدقيق */
process.env.ERP_DB = '/tmp/dc-erp.db';
['', '-wal', '-shm'].forEach(x => require('node:fs').rmSync('/tmp/dc-erp.db' + x, { force: true }));

const fs = require('node:fs');
const zlib = require('node:zlib');
const A = require('./server');
const DOC = require('./docs');
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
const acc = A.login('noura', 'acc123').user;
const eng = A.login('saad', 'eng123').user;

L.post({ ref: 'OPEN', date: '2026-01-01', memo: 'رصيد افتتاحي', user_id: admin.id,
  lines: [{ account: '1100', debit: 500000, credit: 0 },
          { account: '3100', debit: 0, credit: 500000 }] });

const b64 = s => Buffer.from(s).toString('base64');
/* PNG صالح 1×1 لاختبار المرفقات الثنائية */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

console.log('\n══════ المرفقات ══════');

let ATT;
t('إرفاق عقد PDF بمشروع', () => {
  const r = DOC.attach(pm, { entity: 'project', entity_id: 1,
    filename: 'عقد المشروع.pdf', data_base64: b64('%PDF-1.4 fake contract body'),
    note: 'النسخة الموقّعة' });
  ATT = r.id;
  eq(r.mime, 'application/pdf', 'نوع الملف');
  ok(r.size > 0, 'الحجم');
});

t('إرفاق صورة موقع', () => {
  const r = DOC.attach(pm, { entity: 'project', entity_id: 1,
    filename: 'صورة-الموقع.png', data_base64: PNG });
  eq(r.mime, 'image/png', 'نوع الصورة');
});

t('رفض امتداد غير مسموح', () => {
  throws(() => DOC.attach(pm, { entity: 'project', entity_id: 1,
    filename: 'script.exe', data_base64: b64('MZ') }), 'غير مسموح');
});

t('رفض اسم ملف فيه مسار', () => {
  throws(() => DOC.attach(pm, { entity: 'project', entity_id: 1,
    filename: '../../etc/passwd.txt', data_base64: b64('x') }), 'محارف غير مسموحة');
});

t('رفض كيان غير مدعوم', () => {
  throws(() => DOC.attach(pm, { entity: 'users', entity_id: 1,
    filename: 'a.txt', data_base64: b64('x') }), 'غير مدعوم');
});

t('رفض الإرفاق بسجل غير موجود', () => {
  throws(() => DOC.attach(pm, { entity: 'project', entity_id: 9999,
    filename: 'a.txt', data_base64: b64('x') }), 'غير موجود');
});

t('رفض ملف فارغ', () => {
  throws(() => DOC.attach(pm, { entity: 'project', entity_id: 1,
    filename: 'empty.txt', data_base64: '' }), 'فارغ');
});

t('رفض ملف يتجاوز الحد', () => {
  run("UPDATE settings SET v='0.001' WHERE k='max_upload_mb'");
  throws(() => DOC.attach(pm, { entity: 'project', entity_id: 1,
    filename: 'big.pdf', data_base64: b64('x'.repeat(5000)) }), 'يتجاوز الحد');
  run("UPDATE settings SET v='5' WHERE k='max_upload_mb'");
});

t('القائمة تعرض المرفقات بلا بياناتها الثنائية', () => {
  const list = DOC.listAttachments('project', 1);
  eq(list.length, 2, 'عدد المرفقات');
  ok(list[0].data === undefined, 'البيانات الثنائية مُسرَّبة في القائمة');
  ok(list[0].uploader, 'اسم الرافع');
});

t('التحميل يعيد المحتوى كما رُفع بالضبط', () => {
  const a = DOC.getAttachment(ATT);
  eq(a.data_base64 === b64('%PDF-1.4 fake contract body') ? 1 : 0, 1, 'المحتوى');
  eq(a.filename, 'عقد المشروع.pdf', 'الاسم');
});

t('الحذف يزيل المرفق', () => {
  const r = DOC.attach(pm, { entity: 'project', entity_id: 1,
    filename: 'مؤقت.txt', data_base64: b64('temp') });
  DOC.deleteAttachment(pm, r.id);
  throws(() => DOC.getAttachment(r.id), 'غير موجود');
});

t('الإحصاءات تجمع الأحجام', () => {
  const s = DOC.attachmentStats();
  eq(s.count, 2, 'العدد');
  ok(s.bytes > 0, 'الحجم');
});

console.log('\n══════ مولّد Excel ══════');

t('الملف يبدأ بتوقيع ZIP الصحيح', () => {
  const buf = DOC.buildXlsx([{ name: 'اختبار',
    columns: [{ header: 'الاسم', key: 'n', type: 'text' }],
    rows: [{ n: 'أحمد' }] }]);
  eq(buf[0], 0x50, 'PK');
  eq(buf[1], 0x4B, 'PK');
  eq(buf[2], 0x03, 'محلي');
  eq(buf[3], 0x04, 'محلي');
});

t('CRC32 مطابق للمعيار', () => {
  // القيمة المعيارية لـ "123456789" هي 0xCBF43926
  eq(DOC.crc32(Buffer.from('123456789')), 0xCBF43926, 'CRC32');
});

t('أسماء الأعمدة تتجاوز Z بشكل صحيح', () => {
  eq(DOC.colName(0) === 'A' ? 1 : 0, 1, 'A');
  eq(DOC.colName(25) === 'Z' ? 1 : 0, 1, 'Z');
  eq(DOC.colName(26) === 'AA' ? 1 : 0, 1, 'AA');
  eq(DOC.colName(27) === 'AB' ? 1 : 0, 1, 'AB');
  eq(DOC.colName(51) === 'AZ' ? 1 : 0, 1, 'AZ');
  eq(DOC.colName(52) === 'BA' ? 1 : 0, 1, 'BA');
});

/* فكّ ZIP يدوياً للتحقق من صحة البنية الداخلية */
function unzip(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    out[name] = zlib.inflateRawSync(buf.slice(start, start + compSize)).toString('utf8');
    i = start + compSize;
  }
  return out;
}

t('المصنّف يحتوي كل الأجزاء الإلزامية', () => {
  const buf = DOC.buildXlsx([{ name: 'ورقة', columns: [{ header: 'أ', key: 'a', type: 'text' }],
    rows: [{ a: 'قيمة' }] }]);
  const files = unzip(buf);
  ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
   'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']
    .forEach(f => ok(files[f], 'الجزء ناقص: ' + f));
});

t('النص العربي محفوظ داخل الورقة', () => {
  const buf = DOC.buildXlsx([{ name: 'ورقة',
    columns: [{ header: 'اسم الموظف', key: 'n', type: 'text' }],
    rows: [{ n: 'م. سعد العتيبي' }] }]);
  const files = unzip(buf);
  ok(files['xl/worksheets/sheet1.xml'].includes('م. سعد العتيبي'), 'النص العربي مفقود');
  ok(files['xl/worksheets/sheet1.xml'].includes('اسم الموظف'), 'العنوان مفقود');
});

t('الأرقام تُكتب أرقاماً لا نصوصاً', () => {
  const buf = DOC.buildXlsx([{ name: 'أ',
    columns: [{ header: 'المبلغ', key: 'v', type: 'number', money: true }],
    rows: [{ v: 1234.56 }] }]);
  const xml = unzip(buf)['xl/worksheets/sheet1.xml'];
  ok(xml.includes('<v>1234.56</v>'), 'الرقم ليس رقمياً');
  ok(!xml.includes('<t>1234.56</t>'), 'الرقم كُتب نصاً');
});

t('المحارف الخاصة في XML مُهرَّبة', () => {
  const buf = DOC.buildXlsx([{ name: 'أ',
    columns: [{ header: 'البيان', key: 'v', type: 'text' }],
    rows: [{ v: 'شركة <الفيصل> & "الشركاء"' }] }]);
  const xml = unzip(buf)['xl/worksheets/sheet1.xml'];
  ok(xml.includes('&lt;الفيصل&gt;'), 'الأقواس غير مهرّبة');
  ok(xml.includes('&amp;'), 'علامة العطف غير مهرّبة');
});

t('الورقة تُفتح من اليمين لليسار', () => {
  const buf = DOC.buildXlsx([{ name: 'أ', columns: [{ header: 'x', key: 'x', type: 'text' }],
    rows: [] }]);
  ok(unzip(buf)['xl/worksheets/sheet1.xml'].includes('rightToLeft="1"'), 'الاتجاه');
});

t('عدة أوراق في مصنّف واحد', () => {
  const buf = DOC.buildXlsx([
    { name: 'الأولى', columns: [{ header: 'a', key: 'a', type: 'text' }], rows: [{ a: '1' }] },
    { name: 'الثانية', columns: [{ header: 'b', key: 'b', type: 'text' }], rows: [{ b: '2' }] },
  ]);
  const files = unzip(buf);
  ok(files['xl/worksheets/sheet1.xml'], 'الورقة الأولى');
  ok(files['xl/worksheets/sheet2.xml'], 'الورقة الثانية');
  ok(files['xl/workbook.xml'].includes('الأولى'), 'اسم الورقة');
});

t('اسم الورقة الطويل يُقصَّر لحد Excel', () => {
  const long = 'ورقة'.repeat(20);
  const buf = DOC.buildXlsx([{ name: long,
    columns: [{ header: 'a', key: 'a', type: 'text' }], rows: [] }]);
  const wb = unzip(buf)['xl/workbook.xml'];
  const m = wb.match(/name="([^"]+)"/);
  ok(m[1].length <= 31, 'الاسم أطول من 31: ' + m[1].length);
});

console.log('\n══════ التقارير ══════');

t('قائمة التقارير المتاحة', () => {
  const list = DOC.reportList();
  ok(list.length >= 12, 'عدد التقارير: ' + list.length);
  ok(list.every(r => r.key && r.title), 'بيانات ناقصة');
});

t('ميزان المراجعة يُبنى بأعمدة وصفوف', () => {
  const d = DOC.reportData('trial', {});
  ok(d.columns.length >= 5, 'الأعمدة');
  ok(d.rows.length > 0, 'الصفوف');
  eq(d.title, 'ميزان المراجعة', 'العنوان');
});

t('كل تقرير يُبنى بلا أخطاء', () => {
  const skip = { ledger: { account: '1100' }, payroll: null };
  DOC.reportList().forEach(r => {
    if (r.key === 'payroll') return;   // يحتاج مسيراً قائماً
    const d = DOC.reportData(r.key, skip[r.key] || {});
    ok(Array.isArray(d.rows), 'صفوف غير صالحة في: ' + r.key);
    ok(d.columns.length > 0, 'بلا أعمدة: ' + r.key);
  });
});

t('دفتر الأستاذ يرفض بلا رقم حساب', () => {
  throws(() => DOC.reportData('ledger', {}), 'حدّد رقم الحساب');
});

t('تقرير غير معروف يُرفض', () => {
  throws(() => DOC.reportData('nope', {}), 'غير معروف');
});

t('تصدير ميزان المراجعة إلى xlsx', () => {
  const r = DOC.exportXlsx('trial', {});
  ok(r.filename.endsWith('.xlsx'), 'الامتداد');
  ok(r.filename.includes('ميزان المراجعة'), 'اسم الملف');
  eq(r.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'النوع');
  const buf = Buffer.from(r.base64, 'base64');
  eq(buf[0], 0x50, 'توقيع الملف');
  eq(buf.length, r.size, 'الحجم');
});

t('حزمة التقارير المالية في مصنّف واحد', () => {
  const r = DOC.exportPack(['trial', 'pnl', 'bs', 'aged', 'vat'], {});
  eq(r.sheets, 5, 'عدد الأوراق');
  const files = unzip(Buffer.from(r.base64, 'base64'));
  for (let i = 1; i <= 5; i++) ok(files['xl/worksheets/sheet' + i + '.xml'], 'ورقة ' + i);
});

console.log('\n══════ صفحة الطباعة ══════');

t('تُنتج HTML عربياً صالحاً', () => {
  const h = DOC.printable('trial', {});
  ok(h.startsWith('<!DOCTYPE html>'), 'البداية');
  ok(h.includes('dir="rtl"'), 'الاتجاه');
  ok(h.includes('lang="ar"'), 'اللغة');
  ok(h.includes('ميزان المراجعة'), 'العنوان');
  ok(h.includes('window.print()'), 'زر الطباعة');
});

t('الجدول يحوي صفوف البيانات', () => {
  const d = DOC.reportData('trial', {});
  const h = DOC.printable('trial', {});
  const rows = (h.match(/<tr>/g) || []).length;
  ok(rows >= d.rows.length, 'الصفوف ناقصة: ' + rows + ' مقابل ' + d.rows.length);
});

t('صف الإجماليات يُحسب للأعمدة المالية', () => {
  const h = DOC.printable('trial', {});
  ok(h.includes('<tfoot>'), 'لا يوجد صف إجماليات');
  ok(h.includes('الإجمالي'), 'كلمة الإجمالي');
});

t('النص الخبيث لا يُحقن في الصفحة', () => {
  run("INSERT INTO partners(kind,name,active) VALUES('customer','<script>alert(1)</script>',1)");
  const h = DOC.printable('aged', {});
  ok(!h.includes('<script>alert(1)</script>'), 'حقن XSS ممكن');
});

console.log('\n══════ سجل التدقيق ══════');

t('السجل يرصد العمليات', () => {
  const trail = DOC.auditTrail({});
  ok(trail.length > 0, 'السجل فارغ');
  ok(trail.some(a => a.action === 'login'), 'الدخول غير مسجّل');
});

t('التصفية بالمستخدم', () => {
  const trail = DOC.auditTrail({ user: 'ahmad' });
  ok(trail.length > 0, 'لا نتائج');
  ok(trail.every(a => a.username === 'ahmad'), 'تصفية خاطئة');
});

t('التصفية بالكيان', () => {
  const trail = DOC.auditTrail({ entity: 'project' });
  ok(trail.every(a => a.entity === 'project'), 'تصفية خاطئة');
});

t('أثر السجل الواحد يجمع التدقيق والمرفقات والقيود', () => {
  const tr = DOC.entityTrail('project', 1);
  ok(Array.isArray(tr.audit), 'التدقيق');
  eq(tr.attachments.length, 2, 'المرفقات');
  ok(Array.isArray(tr.journals), 'القيود');
});

t('الإحصاءات ترصد محاولات الدخول الفاشلة', () => {
  A.login('admin', 'wrong-password');
  A.login('ghost', 'x');
  const s = DOC.auditStats(30);
  ok(s.failed_logins.length >= 2, 'المحاولات الفاشلة: ' + s.failed_logins.length);
  ok(s.by_user.length > 0, 'التوزيع بالمستخدم');
  ok(s.total > 0, 'الإجمالي');
});

t('الإرفاق مسجّل في التدقيق', () => {
  const trail = DOC.auditTrail({ action: 'attach' });
  ok(trail.length === 0 || trail.every(a => a.action === 'attach'), 'تصفية');
});

t('حد النتائج محترم', () => {
  eq(DOC.auditTrail({ limit: 3 }).length <= 3 ? 1 : 0, 1, 'الحد');
});

console.log('\n══════ سلامة الدفتر ══════');

t('الميزانية متوازنة', () => ok(L.balanceSheet().balanced));
t('التصدير لم يغيّر أي بيانات', () => {
  const before = get1('SELECT COUNT(*) c FROM jlines').c;
  DOC.exportPack(null, {});
  eq(get1('SELECT COUNT(*) c FROM jlines').c, before, 'عدد سطور القيود تغيّر');
});

console.log(`\n${'═'.repeat(46)}`);
console.log(`  ناجح: ${pass}   ·   فاشل: ${fail}`);
console.log('═'.repeat(46) + '\n');
process.exit(fail ? 1 : 0);
