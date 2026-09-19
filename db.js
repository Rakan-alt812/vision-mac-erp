'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');

const DB_PATH = process.env.ERP_DB || path.join(__dirname, 'erp.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');

/* ══════════════════════ SCHEMA ══════════════════════ */
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, salt TEXT NOT NULL,
  name TEXT NOT NULL, role TEXT NOT NULL, active INTEGER DEFAULT 1, created TEXT,
  must_change INTEGER DEFAULT 1, pw_changed TEXT
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, ts TEXT, user_id INTEGER, username TEXT,
  action TEXT, entity TEXT, entity_id TEXT, detail TEXT
);

CREATE TABLE IF NOT EXISTS accounts(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, normal TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journals(
  id INTEGER PRIMARY KEY, ref TEXT, jdate TEXT NOT NULL, memo TEXT,
  src_type TEXT, src_id INTEGER, posted INTEGER DEFAULT 1, created_by INTEGER, created TEXT
);
CREATE TABLE IF NOT EXISTS jlines(
  id INTEGER PRIMARY KEY, journal_id INTEGER NOT NULL, account TEXT NOT NULL,
  debit REAL DEFAULT 0, credit REAL DEFAULT 0, project_id INTEGER, partner_id INTEGER, memo TEXT,
  FOREIGN KEY(journal_id) REFERENCES journals(id) ON DELETE CASCADE,
  FOREIGN KEY(account) REFERENCES accounts(code)
);
CREATE INDEX IF NOT EXISTS ix_jl_acct ON jlines(account);
CREATE INDEX IF NOT EXISTS ix_jl_proj ON jlines(project_id);

CREATE TABLE IF NOT EXISTS partners(
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, vat TEXT,
  contact TEXT, phone TEXT, email TEXT, city TEXT, terms TEXT,
  trade TEXT, rating INTEGER, ontime INTEGER, active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  customer_id INTEGER, trade TEXT, ctype TEXT, value REAL DEFAULT 0,
  sdate TEXT, ddate TEXT, progress INTEGER DEFAULT 0, pm_id INTEGER,
  status TEXT DEFAULT 'جارٍ',
  FOREIGN KEY(customer_id) REFERENCES partners(id)
);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
  trade TEXT, zone TEXT, phase TEXT, assignee TEXT, exec TEXT,
  progress INTEGER DEFAULT 0, status TEXT DEFAULT 'لم يبدأ',
  sdate TEXT, ddate TEXT, weight REAL DEFAULT 1,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS timesheets(
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, task_id INTEGER,
  employee_id INTEGER NOT NULL, tdate TEXT, hours REAL, rate REAL, note TEXT,
  journal_id INTEGER,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS dailyreports(
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, rdate TEXT,
  elec_men INTEGER, mech_men INTEGER, plum_men INTEGER, other_men INTEGER,
  elec_pct INTEGER, mech_pct INTEGER, plum_pct INTEGER,
  work TEXT, issue TEXT, weather TEXT, temp INTEGER, created_by INTEGER,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS materials(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  spec TEXT, trade TEXT, unit TEXT, cost REAL DEFAULT 0, minq REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS warehouses(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, project_id INTEGER
);
CREATE TABLE IF NOT EXISTS stock(
  material_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, qty REAL DEFAULT 0,
  avg_cost REAL DEFAULT 0,
  PRIMARY KEY(material_id, warehouse_id)
);
CREATE TABLE IF NOT EXISTS moves(
  id INTEGER PRIMARY KEY, material_id INTEGER NOT NULL, from_wh INTEGER, to_wh INTEGER,
  qty REAL NOT NULL, mdate TEXT, ref TEXT, project_id INTEGER, unit_cost REAL,
  kind TEXT, journal_id INTEGER, created_by INTEGER
);

CREATE TABLE IF NOT EXISTS pos(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, vendor_id INTEGER NOT NULL,
  project_id INTEGER, warehouse_id INTEGER, pdate TEXT, status TEXT DEFAULT 'مسودة',
  approved_by INTEGER, approved_at TEXT, journal_id INTEGER, created_by INTEGER,
  FOREIGN KEY(vendor_id) REFERENCES partners(id)
);
CREATE TABLE IF NOT EXISTS polines(
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL, material_id INTEGER,
  descr TEXT, qty REAL, price REAL, received REAL DEFAULT 0,
  FOREIGN KEY(po_id) REFERENCES pos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invoices(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL,
  project_id INTEGER, idate TEXT, ddate TEXT, status TEXT DEFAULT 'مسودة',
  zatca_status TEXT DEFAULT 'لم تُرسل', zatca_uuid TEXT, zatca_hash TEXT,
  zatca_qr TEXT, zatca_xml TEXT, zatca_at TEXT, prev_hash TEXT,
  journal_id INTEGER, created_by INTEGER,
  FOREIGN KEY(customer_id) REFERENCES partners(id)
);
CREATE TABLE IF NOT EXISTS invlines(
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, descr TEXT,
  account TEXT, qty REAL DEFAULT 1, price REAL DEFAULT 0, vat REAL DEFAULT 0.15,
  FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, code TEXT, kind TEXT NOT NULL, partner_id INTEGER,
  invoice_id INTEGER, po_id INTEGER, pdate TEXT, amount REAL NOT NULL,
  method TEXT, bank_account TEXT, ref TEXT, journal_id INTEGER, created_by INTEGER
);

CREATE TABLE IF NOT EXISTS employees(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  job TEXT, dept TEXT, ptype TEXT, basic REAL, housing REAL DEFAULT 0,
  transport REAL DEFAULT 0, site REAL DEFAULT 0, hired TEXT, phone TEXT,
  nid TEXT, iban TEXT, user_id INTEGER, status TEXT DEFAULT 'نشط',
  cost_rate REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payruns(
  id INTEGER PRIMARY KEY, period TEXT UNIQUE NOT NULL, status TEXT DEFAULT 'مسودة',
  journal_id INTEGER, created_by INTEGER, created TEXT
);
CREATE TABLE IF NOT EXISTS payslips(
  id INTEGER PRIMARY KEY, payrun_id INTEGER NOT NULL, employee_id INTEGER NOT NULL,
  days REAL, overtime REAL DEFAULT 0, gross REAL, gosi_emp REAL, gosi_er REAL,
  deduct REAL DEFAULT 0, net REAL,
  FOREIGN KEY(payrun_id) REFERENCES payruns(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS approvals(
  id INTEGER PRIMARY KEY, doc_type TEXT NOT NULL, doc_id INTEGER NOT NULL,
  amount REAL, requested_by INTEGER, requested_at TEXT,
  status TEXT DEFAULT 'معلق', decided_by INTEGER, decided_at TEXT, note TEXT
);

/* ── Sales: opportunities → quotations (BOQ) → project ── */
CREATE TABLE IF NOT EXISTS opps(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, customer_id INTEGER,
  trade TEXT, ctype TEXT, value REAL DEFAULT 0, probability INTEGER DEFAULT 50,
  source TEXT, heat TEXT DEFAULT 'دافئ', stage TEXT DEFAULT 'جديد',
  close_date TEXT, owner_id INTEGER, lost_reason TEXT, competitor TEXT,
  project_id INTEGER, created TEXT,
  FOREIGN KEY(customer_id) REFERENCES partners(id)
);
CREATE TABLE IF NOT EXISTS quotes(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, opp_id INTEGER,
  customer_id INTEGER NOT NULL, qdate TEXT, valid_until TEXT,
  qtype TEXT DEFAULT 'كشف كميات', terms TEXT, notes TEXT,
  status TEXT DEFAULT 'مسودة', markup REAL DEFAULT 0,
  invoice_id INTEGER, created_by INTEGER,
  FOREIGN KEY(customer_id) REFERENCES partners(id)
);
CREATE TABLE IF NOT EXISTS qlines(
  id INTEGER PRIMARY KEY, quote_id INTEGER NOT NULL, item TEXT,
  descr TEXT, trade TEXT, unit TEXT, qty REAL DEFAULT 1,
  cost REAL DEFAULT 0, price REAL DEFAULT 0, vat REAL DEFAULT 0.15, sort INTEGER DEFAULT 0,
  FOREIGN KEY(quote_id) REFERENCES quotes(id) ON DELETE CASCADE
);

/* ── Material requests from site ── */
CREATE TABLE IF NOT EXISTS matreqs(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, project_id INTEGER NOT NULL,
  warehouse_id INTEGER, needed TEXT, reason TEXT, status TEXT DEFAULT 'مسودة',
  requested_by INTEGER, requested_at TEXT, decided_by INTEGER, decided_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS mrlines(
  id INTEGER PRIMARY KEY, mr_id INTEGER NOT NULL, material_id INTEGER NOT NULL,
  qty REAL NOT NULL, issued REAL DEFAULT 0, to_buy REAL DEFAULT 0,
  FOREIGN KEY(mr_id) REFERENCES matreqs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
`);

/* Migration: add columns to databases created before this version */
try { db.exec('ALTER TABLE users ADD COLUMN must_change INTEGER DEFAULT 1'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN pw_changed TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE stock ADD COLUMN avg_cost REAL DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE tasks ADD COLUMN sdate TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE tasks ADD COLUMN weight REAL DEFAULT 1'); } catch (e) {}

/* ══════════════════════ HELPERS ══════════════════════ */
const q = (sql, ...p) => db.prepare(sql).all(...p);
const get1 = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function hashPw(pw, salt) {
  return crypto.pbkdf2Sync(pw, salt, 120000, 32, 'sha256').toString('hex');
}

/* ══════════════════════ SEED ══════════════════════ */
function seeded() {
  return get1('SELECT COUNT(*) c FROM users').c > 0;
}

const COA = [
  ['1100', 'النقد والبنوك', 'asset', 'D'],
  ['1200', 'الذمم المدينة — العملاء', 'asset', 'D'],
  ['1300', 'المخزون والمواد', 'asset', 'D'],
  ['1400', 'ضريبة المدخلات', 'asset', 'D'],
  ['1600', 'المعدات والأصول الثابتة', 'asset', 'D'],
  ['2100', 'الذمم الدائنة — الموردون', 'liability', 'C'],
  ['2200', 'ضريبة المخرجات المستحقة', 'liability', 'C'],
  ['2300', 'رواتب مستحقة الدفع', 'liability', 'C'],
  ['2400', 'اشتراكات GOSI مستحقة', 'liability', 'C'],
  ['2500', 'مخصص نهاية الخدمة', 'liability', 'C'],
  ['3100', 'رأس المال', 'equity', 'C'],
  ['3200', 'الأرباح المبقاة', 'equity', 'C'],
  ['4110', 'إيرادات الأعمال الكهربائية', 'income', 'C'],
  ['4120', 'إيرادات الأعمال الميكانيكية', 'income', 'C'],
  ['4130', 'إيرادات أعمال السباكة', 'income', 'C'],
  ['4190', 'إيرادات أعمال MEP متكاملة', 'income', 'C'],
  ['5100', 'تكلفة المواد والمعدات', 'expense', 'D'],
  ['5200', 'الرواتب والأجور', 'expense', 'D'],
  ['5300', 'مدفوعات المقاولين الفرعيين', 'expense', 'D'],
  ['5400', 'اشتراكات GOSI — صاحب العمل', 'expense', 'D'],
  ['5500', 'مصروفات إدارية وعمومية', 'expense', 'D'],
  ['5600', 'مصاريف بنكية', 'expense', 'D'],
];

function seed() {
  if (seeded()) return;

  const insAcc = db.prepare('INSERT OR IGNORE INTO accounts(code,name,type,normal) VALUES(?,?,?,?)');
  COA.forEach(a => insAcc.run(...a));

  const S = db.prepare('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)');
  S.run('company_name', 'VISION — MAC');
  S.run('company_vat', '310098765400003');
  S.run('company_cr', '4030998877');
  S.run('company_city', 'جدة');
  S.run('vat_rate', '0.15');
  S.run('gosi_emp', '0.10');
  S.run('gosi_er', '0.12');
  S.run('pm_limit', '50000');
  S.run('acc_limit', '20000');

  const mkUser = db.prepare('INSERT INTO users(username,pw,salt,name,role,created) VALUES(?,?,?,?,?,?)');
  const now = new Date().toISOString();
  [
    ['admin', 'admin123', 'رَكان — المالك', 'admin'],
    ['ahmad', 'pm123', 'أحمد الزهراني', 'pm'],
    ['saad', 'eng123', 'م. سعد العتيبي', 'engineer'],
    ['noura', 'acc123', 'نورة السبيعي', 'accountant'],
    ['fahad', 'store123', 'فهد العمري', 'storekeeper'],
    ['mai', 'hr123', 'مي الشهري', 'hr'],
  ].forEach(([u, p, n, r]) => {
    const salt = crypto.randomBytes(16).toString('hex');
    mkUser.run(u, hashPw(p, salt), salt, n, r, now);
  });

  const P = db.prepare('INSERT INTO partners(kind,name,vat,contact,phone,email,city,terms,trade,rating,ontime) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  P.run('customer', 'شركة الفيصل للتطوير العقاري', '310012345600003', 'م. خالد الفيصل', '0501234567', 'k@faisal-dev.com', 'جدة', '30 يوم', null, null, null);
  P.run('customer', 'مستشفيات المملكة', '310099887700003', 'أ. سلمان العمري', '0533219876', 's@kh.sa', 'جدة', '45 يوم', null, null, null);
  P.run('customer', 'تعليم للجميع', '310055443300003', 'أ. هند الشريف', '0544445555', 'h@edu4all.sa', 'جدة', '30 يوم', null, null, null);
  P.run('vendor', 'شركة الكابلات السعودية', '310045678900003', 'أ. ماجد السلمي', '0555551234', null, 'جدة', '30 يوم', 'كهرباء', 5, 98);
  P.run('vendor', 'مؤسسة الخليج للسباكة', '310087654300003', 'أ. تركي الغامدي', '0566662345', null, 'جدة', '30 يوم', 'سباكة', 5, 96);
  P.run('vendor', 'برد الخليج للتكييف', '310023456700003', 'م. وليد الأحمدي', '0577773456', null, 'جدة', '45 يوم', 'ميكانيكا', 4, 89);
  P.run('vendor', 'حماية الجزيرة للإنذار', '310056789000003', 'أ. بندر القرني', '0588884567', null, 'جدة', 'فوري', 'إنذار حريق', 2, 58);

  const W = db.prepare('INSERT INTO warehouses(name,project_id) VALUES(?,?)');
  W.run('المستودع المركزي — جدة', null);

  const E = db.prepare('INSERT INTO employees(code,name,job,dept,ptype,basic,housing,transport,site,hired,phone,user_id,cost_rate) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  E.run('EMP-00118', 'أحمد الزهراني', 'مدير مشاريع', 'إداري', 'ثابت', 18000, 4500, 1000, 0, '2021-09-01', '0501112233', 2, 110);
  E.run('EMP-00123', 'م. سعد العتيبي', 'مهندس كهرباء', 'كهرباء', 'ثابت', 12000, 3000, 800, 500, '2022-03-15', '0559876543', 3, 75);
  E.run('EMP-00124', 'م. فيصل الدوسري', 'مهندس ميكانيكا', 'ميكانيكا', 'ثابت', 11500, 2875, 800, 500, '2022-06-02', '0553334444', null, 72);
  E.run('EMP-00131', 'خالد القحطاني', 'فني كهرباء', 'كهرباء', 'يومي', 350, 0, 0, 0, '2024-01-10', '0565556666', null, 44);
  E.run('EMP-00129', 'عبدالله الشمري', 'فني سباكة', 'سباكة', 'يومي', 320, 0, 0, 0, '2023-10-05', '0577778888', null, 40);
  E.run('EMP-00140', 'نورة السبيعي', 'محاسب', 'مالي', 'ثابت', 9500, 2375, 700, 0, '2023-02-01', '0512223333', 4, 60);

  const M = db.prepare('INSERT INTO materials(code,name,spec,trade,unit,cost,minq) VALUES(?,?,?,?,?,?,?)');
  const mats = [
    ['ELEC-001', 'كابل NYY 4×16 مم²', '0.6/1 ك.ف — نحاس', 'كهرباء', 'متر طولي', 45, 100],
    ['ELEC-002', 'مفتاح حماية MCB 16A', 'Schneider', 'كهرباء', 'قطعة', 28, 20],
    ['ELEC-003', 'لوحة كهرباء 200A', 'معدنية — 24 خط', 'كهرباء', 'قطعة', 7750, 3],
    ['PLUM-001', 'ماسورة PPR 25 مم', 'PN20 — أخضر', 'سباكة', 'متر طولي', 12.5, 50],
    ['MECH-001', 'وحدة تكييف سبليت 2 طن', 'انفرتر — R410A', 'ميكانيكا', 'قطعة', 3800, 4],
    ['MECH-002', 'غاز فريون R-410A', 'اسطوانة 11.3 كجم', 'ميكانيكا', 'قطعة', 620, 5],
  ];
  mats.forEach(m => M.run(...m));

  const ST = db.prepare('INSERT INTO stock(material_id,warehouse_id,qty,avg_cost) VALUES(?,?,?,?)');
  [[1, 45, 45], [2, 8, 28], [3, 6, 7750], [4, 30, 12.5], [5, 5, 3800], [6, 2, 620]]
    .forEach(([mid, qty, c]) => ST.run(mid, 1, qty, c));

  const PR = db.prepare('INSERT INTO projects(code,name,customer_id,trade,ctype,value,sdate,ddate,progress,pm_id,status) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  PR.run('PRJ-014', 'فيلات أبحر الشمالية', 1, 'MEP كامل', 'مقطوعية', 850000, '2026-07-01', '2026-11-20', 42, 1, 'جارٍ');
  PR.run('PRJ-011', 'مدرسة دولية — الشاطئ', 3, 'MEP كامل', 'كشف كميات', 560000, '2026-05-10', '2026-10-18', 68, 1, 'جارٍ');
  PR.run('PRJ-009', 'مركز طبي — النسيم', 2, 'كهرباء', 'مقطوعية', 390000, '2026-04-02', '2026-09-27', 91, 2, 'جارٍ');

  W.run('مستودع الموقع — أبحر', 1);
  W.run('مستودع الموقع — الشاطئ', 2);

  const T = db.prepare(`INSERT INTO tasks(project_id,name,trade,zone,phase,assignee,exec,progress,status,sdate,ddate,weight)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  T.run(1, 'تصاميم ورسومات تنفيذية', 'MEP كامل', 'الكل', 'تصميم', 'م. سعد العتيبي', 'داخلي', 100, 'منتهي', '2026-07-01', '2026-07-15', 1);
  T.run(1, 'تركيب لوحة الكهرباء الرئيسية', 'كهرباء', 'الطابق الأرضي', 'تركيب', 'م. سعد العتيبي', 'داخلي', 100, 'منتهي', '2026-08-01', '2026-08-20', 2);
  T.run(1, 'مد كابلات التغذية الرئيسية', 'كهرباء', 'كل الطوابق', 'تركيب', 'م. سعد العتيبي', 'داخلي', 70, 'جارٍ', '2026-08-15', '2026-10-05', 3);
  T.run(1, 'تركيب وحدات التكييف', 'ميكانيكا', 'الطوابق 1-3', 'تركيب', 'م. فيصل الدوسري', 'مقاول', 40, 'جارٍ', '2026-09-01', '2026-10-15', 3);
  T.run(1, 'شبكة مياه PPR', 'سباكة', 'كل الطوابق', 'تركيب', 'عبدالله الشمري', 'مقاول', 100, 'منتهي', '2026-07-20', '2026-09-01', 2);
  T.run(1, 'نظام الإنذار بالحريق', 'إنذار حريق', 'كل الطوابق', 'تركيب', 'حماية الجزيرة', 'مقاول', 15, 'متأخر', '2026-08-20', '2026-09-09', 2);
  T.run(1, 'الاختبار والتشغيل', 'MEP كامل', 'الكل', 'تشغيل', 'م. سعد العتيبي', 'داخلي', 0, 'لم يبدأ', '2026-10-20', '2026-11-10', 2);
  T.run(2, 'أعمال كهربائية — المبنى أ', 'كهرباء', 'المبنى أ', 'تركيب', 'م. سعد العتيبي', 'داخلي', 80, 'جارٍ', '2026-06-01', '2026-10-01', 3);

  const O = db.prepare(`INSERT INTO opps(code,name,customer_id,trade,ctype,value,probability,source,heat,stage,close_date,owner_id,created)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  O.run('OPP-0001', 'برج أعمال — طريق الملك', 1, 'ميكانيكا', 'مقطوعية', 1200000, 30, 'إحالة', 'حار', 'جديد', '2026-11-20', 2, now);
  O.run('OPP-0002', 'مصنع أغذية — الرياض', 2, 'MEP كامل', 'كشف كميات', 670000, 55, 'مناقصة', 'دافئ', 'مؤهل', '2026-10-30', 2, now);
  O.run('OPP-0003', 'فندق الكورنيش', 3, 'MEP كامل', 'مقطوعية', 2100000, 80, 'عميل مباشر', 'حار', 'عرض سعر', '2026-10-15', 2, now);

  // opening balances via ledger (imported at runtime by server)
  return true;
}

module.exports = { db, q, get1, run, hashPw, seed, seeded, COA, DB_PATH };
