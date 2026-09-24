'use strict';
/* ═══════════════════════════════════════════════════════════════
   المستندات والتقارير — مرفقات · تصدير Excel وPDF · سجل تدقيق
   ───────────────────────────────────────────────────────────────
   ملف xlsx الحقيقي مبني هنا من الصفر بـ zlib المدمج في Node.
   السبب: CSV يكسر العربية في Excel ويفقد الأرقام تنسيقها، والاعتماد
   على مكتبة خارجية يخالف مبدأ النظام — صفر تبعيّات.
   ═══════════════════════════════════════════════════════════════ */
const zlib = require('node:zlib');
const { db, q, get1, run } = require('./db');
const L = require('./ledger');

const R2 = L.R2;
const today = () => new Date().toISOString().slice(0, 10);
const S = k => (get1('SELECT v FROM settings WHERE k=?', k) || {}).v;
const num = v => Number(v) || 0;

/* ═══════════════ المرفقات ═══════════════ */

/* الكيانات المسموح الإرفاق بها — قائمة بيضاء تمنع كتابة صفوف
   يتيمة تشير إلى جداول لا وجود لها. */
const ENTITIES = {
  project: 'projects', invoice: 'invoices', po: 'pos', bill: 'bills',
  ipc: 'ipcs', vo: 'vos', subcert: 'subcerts', contract: 'contracts',
  employee: 'employees', partner: 'partners', quote: 'quotes',
  rfq: 'rfqs', payrun: 'payruns', task: 'tasks', matreq: 'matreqs',
};

const MIMES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  dwg: 'image/vnd.dwg', zip: 'application/zip',
};

function attach(user, d) {
  const table = ENTITIES[d.entity];
  if (!table) throw new Error('نوع المستند غير مدعوم: ' + d.entity);
  if (!get1(`SELECT 1 x FROM ${table} WHERE id=?`, d.entity_id))
    throw new Error('السجل المرتبط غير موجود');

  const name = String(d.filename || '').trim();
  if (!name) throw new Error('اسم الملف مطلوب');
  if (/[\\/\0]/.test(name)) throw new Error('اسم الملف يحتوي محارف غير مسموحة');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!MIMES[ext]) throw new Error('نوع الملف غير مسموح: ' + ext);

  let buf;
  try { buf = Buffer.from(String(d.data_base64 || ''), 'base64'); }
  catch (e) { throw new Error('محتوى الملف غير صالح'); }
  if (!buf.length) throw new Error('الملف فارغ');
  const maxMB = parseFloat(S('max_upload_mb') || '5');
  if (buf.length > maxMB * 1024 * 1024)
    throw new Error(`حجم الملف ${(buf.length / 1048576).toFixed(1)} م.ب يتجاوز الحد ${maxMB} م.ب`);

  const info = run(`INSERT INTO attachments(entity,entity_id,filename,mime,size,data,note,
    uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    d.entity, d.entity_id, name, MIMES[ext], buf.length, buf,
    d.note || null, user.id, new Date().toISOString());
  return { id: Number(info.lastInsertRowid), filename: name, size: buf.length, mime: MIMES[ext] };
}

function listAttachments(entity, entity_id) {
  return q(`SELECT a.id, a.entity, a.entity_id, a.filename, a.mime, a.size, a.note,
      a.uploaded_at, u.name uploader
    FROM attachments a LEFT JOIN users u ON u.id=a.uploaded_by
    WHERE a.entity=? AND a.entity_id=? ORDER BY a.id DESC`, entity, entity_id);
}

function getAttachment(id) {
  const a = get1('SELECT * FROM attachments WHERE id=?', id);
  if (!a) throw new Error('المرفق غير موجود');
  return { ...a, data_base64: Buffer.from(a.data).toString('base64') };
}

function deleteAttachment(user, id) {
  const a = get1('SELECT * FROM attachments WHERE id=?', id);
  if (!a) throw new Error('المرفق غير موجود');
  run('DELETE FROM attachments WHERE id=?', id);
  return { ok: true, filename: a.filename };
}

function attachmentStats() {
  return { count: num(get1('SELECT COUNT(*) c FROM attachments').c),
    bytes: num(get1('SELECT COALESCE(SUM(size),0) s FROM attachments').s),
    by_entity: q(`SELECT entity, COUNT(*) n, COALESCE(SUM(size),0) bytes
      FROM attachments GROUP BY entity ORDER BY n DESC`) };
}

/* ═══════════════ مولّد xlsx ═══════════════ */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/\x00-\x08|\x0B|\x0C|\x0E-\x1F/g, '');

function colName(n) {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
}

/* ZIP بسيط (deflate) — كل ما يحتاجه xlsx */
function zip(files) {
  const chunks = [], central = [];
  let offset = 0;

  files.forEach(f => {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 flag
    local.writeUInt16LE(8, 8);             // deflate
    local.writeUInt16LE(0, 10);            // time
    local.writeUInt16LE(0x2821, 12);       // date (2000-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  });

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/* sheets: [{ name, columns:[{header,key,type,width}], rows:[...] }] */
function buildXlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('لا توجد أوراق للتصدير');

  const sheetXml = sheets.map((sh, si) => {
    const cols = sh.columns || [];
    const rows = sh.rows || [];
    const widths = cols.map((c, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${c.width || 18}" customWidth="1"/>`).join('');

    const header = '<row r="1">' + cols.map((c, i) =>
      `<c r="${colName(i)}1" s="1" t="inlineStr"><is><t>${esc(c.header)}</t></is></c>`).join('') + '</row>';

    const body = rows.map((row, ri) => {
      const r = ri + 2;
      return '<row r="' + r + '">' + cols.map((c, i) => {
        const v = row[c.key];
        const ref = colName(i) + r;
        if (v == null || v === '') return `<c r="${ref}"/>`;
        if (c.type === 'number' || (c.type !== 'text' && typeof v === 'number'))
          return `<c r="${ref}" s="${c.money ? 2 : 0}"><v>${Number(v)}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
      }).join('') + '</row>';
    }).join('');

    const dim = cols.length ? 'A1:' + colName(cols.length - 1) + (rows.length + 1) : 'A1';
    return { si, xml:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr/></sheetPr><dimension ref="${dim}"/>
<sheetViews><sheetView rightToLeft="1" ${si === 0 ? 'tabSelected="1"' : ''} workbookViewId="0">
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${widths ? '<cols>' + widths + '</cols>' : ''}
<sheetData>${header}${body}</sheetData>
${cols.length && rows.length ? `<autoFilter ref="${dim}"/>` : ''}
</worksheet>` };
  });

  const files = [
    { name: '[Content_Types].xml', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>` },
    { name: '_rels/.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: 'xl/workbook.xml', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) =>
  `<sheet name="${esc((s.name || ('ورقة' + (i + 1))).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/styles.xml', data:
`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E5F"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
</styleSheet>` },
  ];
  sheetXml.forEach(s => files.push({ name: 'xl/worksheets/sheet' + (s.si + 1) + '.xml', data: s.xml }));
  return zip(files);
}

/* ═══════════════ التقارير القابلة للتصدير ═══════════════ */

const MONEY = (h, k, w) => ({ header: h, key: k, type: 'number', money: true, width: w || 16 });
const TEXT = (h, k, w) => ({ header: h, key: k, type: 'text', width: w || 20 });

const REPORTS = {
  trial: {
    title: 'ميزان المراجعة',
    build: p => ({ columns: [TEXT('الحساب', 'code', 10), TEXT('الاسم', 'name', 32),
        TEXT('النوع', 'type', 12), MONEY('مدين', 'td'), MONEY('دائن', 'tc'), MONEY('الرصيد', 'balance')],
      rows: L.trialBalance(p.to) }),
  },
  pnl: {
    title: 'قائمة الدخل',
    build: p => { const r = L.pnl(p.from || '2000-01-01', p.to || '2100-01-01');
      return { columns: [TEXT('البند', 'name', 34), TEXT('التصنيف', 'kind', 14), MONEY('المبلغ', 'amount')],
        rows: [...r.income.map(x => ({ ...x, kind: 'إيراد' })),
               ...r.expense.map(x => ({ ...x, kind: 'مصروف' })),
               { name: 'إجمالي الإيرادات', kind: '', amount: r.total_income },
               { name: 'إجمالي المصروفات', kind: '', amount: r.total_expense },
               { name: 'صافي الربح', kind: '', amount: r.net }] }; },
  },
  bs: {
    title: 'الميزانية العمومية',
    build: p => { const b = L.balanceSheet(p.to);
      return { columns: [TEXT('الحساب', 'code', 10), TEXT('الاسم', 'name', 34),
          TEXT('القسم', 'section', 14), MONEY('الرصيد', 'balance')],
        rows: [...b.assets.map(x => ({ ...x, section: 'أصول' })),
               ...b.liabilities.map(x => ({ ...x, section: 'خصوم' })),
               ...b.equity.map(x => ({ ...x, section: 'حقوق ملكية' })),
               { code: '', name: 'الأرباح المبقاة', section: 'حقوق ملكية', balance: b.retained },
               { code: '', name: 'إجمالي الأصول', section: '', balance: b.total_assets },
               { code: '', name: 'إجمالي الخصوم وحقوق الملكية', section: '',
                 balance: R2(b.total_liabilities + b.total_equity) }] }; },
  },
  aged: {
    title: 'أعمار الذمم المدينة',
    build: p => ({ columns: [TEXT('الفاتورة', 'code', 16), TEXT('العميل', 'customer', 28),
        TEXT('الاستحقاق', 'ddate', 14), MONEY('الإجمالي', 'total'), MONEY('المسدد', 'paid'),
        MONEY('المتبقي', 'remaining'), { header: 'العمر (يوم)', key: 'age', type: 'number', width: 12 }],
      rows: L.agedReceivables(p.asof).detail }),
  },
  vat: {
    title: 'إقرار ضريبة القيمة المضافة',
    build: p => { const v = L.vatReturn(p.from || '2000-01-01', p.to || '2100-01-01');
      return { columns: [TEXT('البند', 'item', 34), MONEY('المبلغ', 'amount')],
        rows: [{ item: 'إجمالي المبيعات الخاضعة', amount: v.sales },
               { item: 'ضريبة المخرجات', amount: v.output_vat },
               { item: 'ضريبة المدخلات', amount: v.input_vat },
               { item: 'الضريبة المستحقة', amount: v.due }] }; },
  },
  ledger: {
    title: 'دفتر الأستاذ',
    build: p => { if (!p.account) throw new Error('حدّد رقم الحساب');
      return { columns: [TEXT('التاريخ', 'jdate', 12), TEXT('المرجع', 'ref', 18),
          TEXT('البيان', 'memo', 36), TEXT('المشروع', 'project', 22),
          MONEY('مدين', 'debit'), MONEY('دائن', 'credit')],
        rows: L.ledger(p.account, p.from, p.to) }; },
  },
  projects: {
    title: 'المشاريع',
    build: () => ({ columns: [TEXT('الكود', 'code', 12), TEXT('المشروع', 'name', 30),
        TEXT('العميل', 'customer', 26), TEXT('الحالة', 'status', 12),
        MONEY('قيمة العقد', 'value'), MONEY('الإيراد', 'revenue'), MONEY('التكلفة', 'cost'),
        MONEY('الربح', 'profit'), { header: 'الإنجاز ٪', key: 'progress', type: 'number', width: 11 }],
      rows: q(`SELECT p.*, pa.name customer FROM projects p
        LEFT JOIN partners pa ON pa.id=p.customer_id ORDER BY p.code`)
        .map(p => { const pl = L.projectPL(p.id);
          return { ...p, revenue: pl ? pl.revenue : 0, cost: pl ? pl.cost : 0,
                   profit: pl ? pl.profit : 0 }; }) }),
  },
  invoices: {
    title: 'الفواتير',
    build: () => ({ columns: [TEXT('الرقم', 'code', 18), TEXT('العميل', 'customer', 28),
        TEXT('المشروع', 'project', 24), TEXT('التاريخ', 'idate', 12),
        TEXT('الحالة', 'status', 12), TEXT('ZATCA', 'zatca_status', 12),
        MONEY('الصافي', 'net'), MONEY('الضريبة', 'vat'), MONEY('المسدد', 'paid')],
      rows: q(`SELECT i.*, pa.name customer, p.name project,
        (SELECT COALESCE(SUM(qty*price),0) FROM invlines WHERE invoice_id=i.id) net,
        (SELECT COALESCE(SUM(qty*price*vat),0) FROM invlines WHERE invoice_id=i.id) vat,
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=i.id) paid
        FROM invoices i JOIN partners pa ON pa.id=i.customer_id
        LEFT JOIN projects p ON p.id=i.project_id ORDER BY i.id`) }),
  },
  stock: {
    title: 'المخزون',
    build: () => ({ columns: [TEXT('الكود', 'code', 14), TEXT('الصنف', 'name', 34),
        TEXT('المستودع', 'warehouse', 24), TEXT('الوحدة', 'unit', 12),
        { header: 'الكمية', key: 'qty', type: 'number', width: 12 },
        MONEY('متوسط التكلفة', 'cost'), MONEY('القيمة', 'value')],
      rows: q(`SELECT s.qty, m.code, m.name, m.unit, w.name warehouse,
          COALESCE(NULLIF(s.avg_cost,0), m.cost) cost
        FROM stock s JOIN materials m ON m.id=s.material_id
        JOIN warehouses w ON w.id=s.warehouse_id ORDER BY m.code`)
        .map(r => ({ ...r, value: R2(r.qty * r.cost) })) }),
  },
  ipcs: {
    title: 'المستخلصات',
    build: () => ({ columns: [TEXT('الرقم', 'code', 20), TEXT('المشروع', 'project', 28),
        TEXT('من', 'from_date', 12), TEXT('إلى', 'to_date', 12), TEXT('الحالة', 'status', 12),
        MONEY('قيمة الفترة', 'period_gross'), MONEY('المحتجزات', 'retention'),
        MONEY('استرداد الدفعة', 'advance_deduct'), MONEY('الصافي', 'net'),
        MONEY('الضريبة', 'vat'), MONEY('المستحق', 'total')],
      rows: q(`SELECT i.*, p.name project FROM ipcs i
        JOIN projects p ON p.id=i.project_id ORDER BY i.id`) }),
  },
  retention: {
    title: 'المحتجزات',
    build: () => { const b = require('./progress').retentionBoard();
      return { columns: [TEXT('الجهة', 'side', 16), TEXT('المشروع', 'project', 28),
          TEXT('الطرف', 'party', 28), MONEY('المحتجز', 'held'),
          MONEY('المُفرج', 'released'), MONEY('المتبقي', 'outstanding')],
        rows: [...b.customers.map(r => ({ ...r, side: 'لدى العملاء', party: r.customer })),
               ...b.vendors.map(r => ({ ...r, side: 'لمقاولي الباطن', party: r.vendor }))] }; },
  },
  payroll: {
    title: 'مسير الرواتب',
    build: p => { if (!p.id) throw new Error('حدّد رقم المسير');
      const d = require('./payroll').payrunDetail(Number(p.id));
      return { name: 'مسير ' + d.period,
        columns: [TEXT('الكود', 'code', 14), TEXT('الموظف', 'name', 28), TEXT('الوظيفة', 'job', 22),
          MONEY('الأساسي', 'basic'), MONEY('السكن', 'housing'), MONEY('النقل', 'transport'),
          MONEY('الإضافي', 'ot_amount'), MONEY('المكافأة', 'bonus'), MONEY('الإجمالي', 'gross'),
          MONEY('GOSI موظف', 'gosi_emp'), MONEY('قسط السلفة', 'advance_deduct'),
          MONEY('خصومات', 'deduct'), MONEY('الصافي', 'net'), TEXT('الآيبان', 'iban', 28)],
        rows: d.slips }; },
  },
  employees: {
    title: 'الموظفون',
    build: () => ({ columns: [TEXT('الكود', 'code', 14), TEXT('الاسم', 'name', 28),
        TEXT('الوظيفة', 'job', 22), TEXT('القسم', 'dept', 16), TEXT('التعيين', 'hired', 12),
        TEXT('الإقامة', 'iqama', 16), TEXT('انتهاء الإقامة', 'iqama_exp', 14),
        MONEY('الأساسي', 'basic'), MONEY('السكن', 'housing'), TEXT('الحالة', 'status', 12)],
      rows: q('SELECT * FROM employees ORDER BY code') }),
  },
  vendors: {
    title: 'تقييم الموردين',
    build: () => ({ columns: [TEXT('المورد', 'name', 30), TEXT('التخصص', 'trade', 18),
        { header: 'أوامر الشراء', key: 'pos', type: 'number', width: 13 },
        MONEY('إجمالي التعامل', 'spend'),
        { header: 'الالتزام ٪', key: 'ontime', type: 'number', width: 12 },
        { header: 'دقة الفواتير ٪', key: 'invoice_accuracy', type: 'number', width: 14 },
        { header: 'الاستجابة ٪', key: 'responsiveness', type: 'number', width: 13 },
        { header: 'الدرجة', key: 'score', type: 'number', width: 10 },
        TEXT('التقدير', 'grade', 12)],
      rows: require('./procure').vendorBoard() }),
  },
  audit: {
    title: 'سجل التدقيق',
    build: p => ({ columns: [TEXT('الوقت', 'ts', 22), TEXT('المستخدم', 'username', 16),
        TEXT('العملية', 'action', 18), TEXT('الكيان', 'entity', 16),
        TEXT('المعرّف', 'entity_id', 12), TEXT('التفصيل', 'detail', 40)],
      rows: q(`SELECT * FROM audit WHERE (? IS NULL OR ts >= ?) AND (? IS NULL OR ts <= ?)
        ORDER BY id DESC LIMIT 5000`, p.from || null, p.from || null,
        p.to ? p.to + 'T23:59:59' : null, p.to ? p.to + 'T23:59:59' : null) }),
  },
};

function reportList() {
  return Object.entries(REPORTS).map(([k, r]) => ({ key: k, title: r.title }));
}

function reportData(key, params) {
  const r = REPORTS[key];
  if (!r) throw new Error('تقرير غير معروف: ' + key);
  const built = r.build(params || {});
  return { key, title: r.title, ...built };
}

function exportXlsx(key, params) {
  const d = reportData(key, params);
  const co = S('company_name') || 'VISION — MAC';
  const buf = buildXlsx([{ name: d.name || d.title, columns: d.columns, rows: d.rows }]);
  return { filename: `${d.title} — ${co} — ${today()}.xlsx`, size: buf.length,
    mime: MIMES.xlsx, base64: buf.toString('base64'), rows: d.rows.length };
}

/* عدة تقارير في مصنّف واحد */
function exportPack(keys, params) {
  const list = (keys && keys.length ? keys : ['trial', 'pnl', 'bs', 'aged', 'vat'])
    .map(k => { const d = reportData(k, params || {});
      return { name: d.name || d.title, columns: d.columns, rows: d.rows }; });
  const buf = buildXlsx(list);
  return { filename: `تقارير ${S('company_name') || 'VISION'} — ${today()}.xlsx`,
    size: buf.length, mime: MIMES.xlsx, base64: buf.toString('base64'), sheets: list.length };
}

/* ═══════════════ التقرير المطبوع (PDF عبر المتصفح) ═══════════════ */

/* صفحة HTML عربية جاهزة للطباعة — المتصفح يحوّلها PDF بضغطة.
   أنسب من توليد PDF برمجياً: الخطوط العربية وتشكيل الحروف
   يتكفّل بها المتصفح، ولا تحتاج تضمين خط بحجم ميغابايتات. */
function printable(key, params) {
  const d = reportData(key, params || {});
  const co = S('company_name') || 'VISION — MAC';
  const vat = S('company_vat') || '';
  const isNum = c => c.type === 'number';
  const fmt = (v, c) => v == null || v === '' ? ''
    : isNum(c) ? Number(v).toLocaleString('en-US',
        { minimumFractionDigits: c.money ? 2 : 0, maximumFractionDigits: c.money ? 2 : 0 })
    : esc(v);

  const totals = {};
  d.columns.forEach(c => { if (c.money)
    totals[c.key] = R2(d.rows.reduce((s, r) => s + num(r[c.key]), 0)); });

  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${esc(d.title)} — ${esc(co)}</title>
<style>
  @page { size: A4 landscape; margin: 14mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Tahoma, "Noto Naskh Arabic", sans-serif;
         margin: 0; color: #16232b; font-size: 12px; }
  header { display: flex; justify-content: space-between; align-items: flex-end;
           border-bottom: 2.5px solid #1f4e5f; padding-bottom: 10px; margin-bottom: 14px; }
  h1 { margin: 0 0 4px; font-size: 19px; color: #1f4e5f; }
  .meta { font-size: 11px; color: #5b6b73; line-height: 1.7; text-align: left; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { background: #1f4e5f; color: #fff; padding: 7px 8px; text-align: right;
       font-weight: 600; font-size: 11px; }
  td { padding: 6px 8px; border-bottom: 1px solid #e3e9ec; }
  tr:nth-child(even) td { background: #f7fafb; }
  .num { text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tfoot td { background: #eef3f5; font-weight: 700; border-top: 2px solid #1f4e5f;
             border-bottom: none; }
  footer { margin-top: 14px; padding-top: 8px; border-top: 1px solid #e3e9ec;
           font-size: 10px; color: #7b8a91; display: flex; justify-content: space-between; }
  @media print { .noprint { display: none; } tr { break-inside: avoid; } }
  .noprint { position: fixed; inset: auto 16px 16px auto; }
  .noprint button { background: #1f4e5f; color: #fff; border: 0; border-radius: 8px;
    padding: 11px 22px; font-size: 14px; font-family: inherit; cursor: pointer; }
</style></head><body>
<header>
  <div><h1>${esc(d.title)}</h1><div>${esc(co)}</div></div>
  <div class="meta">الرقم الضريبي: ${esc(vat)}<br>تاريخ التقرير: ${today()}<br>
  عدد السجلات: ${d.rows.length}</div>
</header>
<table>
  <thead><tr>${d.columns.map(c =>
    `<th class="${isNum(c) ? 'num' : ''}">${esc(c.header)}</th>`).join('')}</tr></thead>
  <tbody>${d.rows.map(r => '<tr>' + d.columns.map(c =>
    `<td class="${isNum(c) ? 'num' : ''}">${fmt(r[c.key], c)}</td>`).join('') + '</tr>').join('')}</tbody>
  ${Object.keys(totals).length ? `<tfoot><tr>${d.columns.map((c, i) =>
    c.money ? `<td class="num">${fmt(totals[c.key], c)}</td>`
            : `<td>${i === 0 ? 'الإجمالي' : ''}</td>`).join('')}</tr></tfoot>` : ''}
</table>
<footer><span>${esc(co)} — نظام VISION MAC</span><span>صُدِّر في ${new Date().toLocaleString('ar-SA')}</span></footer>
<div class="noprint"><button onclick="window.print()">طباعة / حفظ PDF</button></div>
</body></html>`;
}

/* ═══════════════ سجل التدقيق ═══════════════ */

function auditTrail(f) {
  const p = f || {};
  return q(`SELECT a.*, u.name fullname FROM audit a LEFT JOIN users u ON u.id=a.user_id
    WHERE (? IS NULL OR a.username = ?)
      AND (? IS NULL OR a.entity = ?)
      AND (? IS NULL OR a.action = ?)
      AND (? IS NULL OR a.ts >= ?)
      AND (? IS NULL OR a.ts <= ?)
    ORDER BY a.id DESC LIMIT ?`,
    p.user || null, p.user || null, p.entity || null, p.entity || null,
    p.action || null, p.action || null, p.from || null, p.from || null,
    p.to ? p.to + 'T23:59:59' : null, p.to ? p.to + 'T23:59:59' : null,
    Math.min(num(p.limit) || 300, 2000));
}

/* أثر سجل واحد: من أنشأه ومن عدّله ومتى */
function entityTrail(entity, entity_id) {
  return { audit: q(`SELECT a.*, u.name fullname FROM audit a LEFT JOIN users u ON u.id=a.user_id
      WHERE a.entity=? AND a.entity_id=? ORDER BY a.id`, entity, String(entity_id)),
    attachments: listAttachments(entity, entity_id),
    journals: q(`SELECT j.*, u.name author FROM journals j LEFT JOIN users u ON u.id=j.created_by
      WHERE j.src_type=? AND j.src_id=? ORDER BY j.id`, entity, entity_id) };
}

function auditStats(days) {
  const since = new Date(Date.now() - (num(days) || 30) * 86400000).toISOString();
  return {
    total: num(get1('SELECT COUNT(*) c FROM audit WHERE ts >= ?', since).c),
    by_user: q(`SELECT username, COUNT(*) n FROM audit WHERE ts >= ?
      GROUP BY username ORDER BY n DESC`, since),
    by_action: q(`SELECT action, COUNT(*) n FROM audit WHERE ts >= ?
      GROUP BY action ORDER BY n DESC LIMIT 20`, since),
    failed_logins: q(`SELECT * FROM audit WHERE action='login-fail' AND ts >= ?
      ORDER BY id DESC LIMIT 50`, since),
    overrides: q(`SELECT * FROM audit WHERE detail LIKE '%تجاوز%' AND ts >= ?
      ORDER BY id DESC LIMIT 50`, since),
  };
}

module.exports = {
  attach, listAttachments, getAttachment, deleteAttachment, attachmentStats, ENTITIES, MIMES,
  buildXlsx, zip, crc32, colName,
  reportList, reportData, exportXlsx, exportPack, printable,
  auditTrail, entityTrail, auditStats,
};
