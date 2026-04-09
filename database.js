/**
 * database.js — SQLite via sql.js (pure-JS, no native build needed)
 * Provides a synchronous-style API similar to better-sqlite3
 */
const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');

const DB_PATH = path.join(__dirname, 'csdb.sqlite');

let sqliteDb = null; // the sql.js Database instance

// ── Save helper (call after every write) ──────────────────
function save() {
  const data = sqliteDb.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Compatibility wrapper ─────────────────────────────────
/**
 * prepare(sql) → { run, get, all }
 *  - run(...params)  → { lastInsertRowid, changes }
 *  - get(...params)  → first row as object, or undefined
 *  - all(...params)  → array of row objects
 */
function prepare(sql) {
  return {
    run(...params) {
      sqliteDb.run(sql, flattenParams(params));
      const rowid = sqliteDb.exec('SELECT last_insert_rowid() AS r')[0]?.values[0][0] ?? 0;
      save();
      return { lastInsertRowid: rowid, changes: 1 };
    },
    get(...params) {
      return getRows(sql, flattenParams(params))[0];
    },
    all(...params) {
      return getRows(sql, flattenParams(params));
    }
  };
}

function flattenParams(params) {
  // params can be [a,b,c] or [[a,b,c]] (spread array)
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

function getRows(sql, params = []) {
  const stmt = sqliteDb.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function exec(sql) {
  sqliteDb.run(sql);
  save();
}

function pragma(str) {
  sqliteDb.run(`PRAGMA ${str}`);
}

// transaction(fn) — run fn, save once at end
function transaction(fn) {
  return function() {
    sqliteDb.run('BEGIN');
    fn();
    sqliteDb.run('COMMIT');
    save();
  };
}

// ── Init ──────────────────────────────────────────────────
async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    sqliteDb = new SQL.Database(fileBuffer);
    console.log('📂 Loaded existing database');
  } else {
    sqliteDb = new SQL.Database();
    console.log('🆕 Created new database');
  }

  const db = { prepare, exec, pragma, transaction };

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ─── Create Tables ───────────────────────────────────────
  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      team TEXT CHECK(team IN ('call_center','helpdesk','repair')) NOT NULL,
      role TEXT CHECK(role IN ('staff','team_lead','department_head')) NOT NULL DEFAULT 'staff',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER REFERENCES employees(id),
      shift_type TEXT CHECK(shift_type IN ('morning','afternoon','night')) NOT NULL,
      shift_date TEXT NOT NULL,
      status TEXT CHECK(status IN ('scheduled','leave','approved_leave')) DEFAULT 'scheduled'
    )
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER REFERENCES employees(id),
      leave_date TEXT NOT NULL,
      reason TEXT,
      status TEXT CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
      approved_by INTEGER REFERENCES employees(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      team TEXT CHECK(team IN ('call_center','helpdesk','repair')) NOT NULL,
      status TEXT CHECK(status IN ('open','in_progress','waiting_vendor','closed')) DEFAULT 'open',
      priority TEXT CHECK(priority IN ('low','normal','high')) DEFAULT 'normal',
      assigned_to INTEGER REFERENCES employees(id),
      vendor_name TEXT,
      escalated_from INTEGER REFERENCES tickets(id),
      opened_at TEXT DEFAULT (datetime('now','localtime')),
      closed_at TEXT
    )
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS kpi_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER REFERENCES employees(id),
      month TEXT NOT NULL,
      total_cases INTEGER DEFAULT 0,
      avg_resolve_minutes INTEGER DEFAULT 0,
      satisfaction_score REAL,
      comment TEXT,
      recorded_by INTEGER REFERENCES employees(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  save();

  // ─── Seed Data (only if empty) ───────────────────────────
  const count = getRows('SELECT COUNT(*) as c FROM employees')[0].c;
  if (count === 0) {
    // ── Employees ──
    const empData = [
      ['สมชาย มั่นคง',      'call_center', 'team_lead'],
      ['วิภา เพชรดี',        'call_center', 'staff'],
      ['ธนกร ใจดี',          'call_center', 'staff'],
      ['พิมพ์ใจ สุขสม',      'call_center', 'staff'],
      ['อนุชา วงศ์สมบัติ',   'call_center', 'staff'],
      ['นภา แก้วสว่าง',      'call_center', 'staff'],
      ['กานดา รุ่งเรือง',    'helpdesk', 'team_lead'],
      ['ภานุ ศรีสุข',        'helpdesk', 'staff'],
      ['จิตรา อ่อนหวาน',     'helpdesk', 'staff'],
      ['ณัฐพล ทองดี',        'helpdesk', 'staff'],
      ['สุดา พรมมา',         'helpdesk', 'staff'],
      ['ประสิทธิ์ ช่างซ่อม', 'repair',   'staff'],
      ['วันเพ็ญ ดูแลดี',     'repair',   'staff'],
    ];
    sqliteDb.run('BEGIN');
    empData.forEach(([name, team, role]) => {
      sqliteDb.run('INSERT INTO employees (name, team, role) VALUES (?, ?, ?)', [name, team, role]);
    });
    sqliteDb.run('COMMIT');

    // ── Shifts for this week ──
    const today = new Date();
    const day   = today.getDay();
    const diff  = day === 0 ? -6 : 1 - day;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diff);

    sqliteDb.run('BEGIN');
    for (let d = 0; d < 7; d++) {
      const dt = new Date(monday);
      dt.setDate(monday.getDate() + d);
      const ds = dt.toISOString().split('T')[0];

      // Call Center: id 1-6
      [[1,'morning'],[2,'morning'],[3,'afternoon'],[4,'night'],[5,'morning'],[6,'afternoon']].forEach(([id,t])=>{
        sqliteDb.run('INSERT INTO shifts (employee_id, shift_type, shift_date) VALUES (?,?,?)', [id,t,ds]);
      });
      // Helpdesk: id 7-11
      [[7,'morning'],[8,'morning'],[9,'morning'],[10,'afternoon'],[11,'afternoon']].forEach(([id,t])=>{
        sqliteDb.run('INSERT INTO shifts (employee_id, shift_type, shift_date) VALUES (?,?,?)', [id,t,ds]);
      });
      // Repair: id 12-13
      [[12,'morning'],[13,'morning']].forEach(([id,t])=>{
        sqliteDb.run('INSERT INTO shifts (employee_id, shift_type, shift_date) VALUES (?,?,?)', [id,t,ds]);
      });
    }
    sqliteDb.run('COMMIT');

    // ── Demo Tickets ──
    const ticketData = [
      ['อินเทอร์เน็ตขัดข้อง','ลูกค้าแจ้งอินเทอร์เน็ตไม่ทำงาน','call_center','open','high',2,null,-2],
      ['เครื่องพิมพ์ไม่ทำงาน','ปริ้นไม่ออก ติดอยู่ที่คิว','helpdesk','in_progress','normal',8,null,-5],
      ['อุปกรณ์ชำรุด','เราเตอร์เสีย ส่งซ่อมภายนอก','repair','waiting_vendor','high',12,'TechFix Co.',-26],
      ['รีเซ็ตรหัสผ่าน','ลูกค้าลืมรหัสผ่านระบบ','call_center','closed','low',3,null,-3],
      ['ติดตั้งซอฟต์แวร์','ติดตั้ง VPN ไม่ได้','helpdesk','open','normal',9,null,-1],
      ['เน็ตช้า แจ้ง ISP','ความเร็วต่ำกว่า SLA ส่งต่อ vendor','repair','waiting_vendor','high',13,'True Online',-30],
      ['โทรศัพท์ไม่มีสัญญาณ','ลูกค้าโทรเข้าไม่ได้','call_center','in_progress','high',4,null,-4],
      ['ขอเพิ่ม License','ต้องการ Office 365 เพิ่ม 5 ใบ','helpdesk','open','low',10,null,0],
    ];
    sqliteDb.run('BEGIN');
    ticketData.forEach(([title,desc,team,status,priority,assigned,vendor,hrOffset]) => {
      const opened = new Date(Date.now() + hrOffset*3600000).toISOString().replace('T',' ').substring(0,19);
      sqliteDb.run(
        `INSERT INTO tickets (title,description,team,status,priority,assigned_to,vendor_name,opened_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [title, desc, team, status, priority, assigned, vendor, opened]
      );
    });
    sqliteDb.run('COMMIT');

    // ── KPI records (3 months) ──
    const months = ['2026-02-01','2026-03-01','2026-04-01'];
    const empIds = [2,3,4,5,6,8,9,10,11,12,13];
    sqliteDb.run('BEGIN');
    months.forEach(m => {
      empIds.forEach(eid => {
        const cases = Math.floor(Math.random()*80)+40;
        const mins  = Math.floor(Math.random()*30)+10;
        const score = +(Math.random()*2+3).toFixed(1);
        sqliteDb.run(
          'INSERT INTO kpi_records (employee_id,month,total_cases,avg_resolve_minutes,satisfaction_score,recorded_by) VALUES (?,?,?,?,?,?)',
          [eid, m, cases, mins, score, 1]
        );
      });
    });
    sqliteDb.run('COMMIT');

    // ── Pending Leave Requests ──
    sqliteDb.run('BEGIN');
    const day2 = new Date(Date.now()+86400000*2).toISOString().split('T')[0];
    const day3 = new Date(Date.now()+86400000*3).toISOString().split('T')[0];
    sqliteDb.run("INSERT INTO leave_requests (employee_id,leave_date,reason) VALUES (?,?,?)", [3, day2, 'ธุระส่วนตัว']);
    sqliteDb.run("INSERT INTO leave_requests (employee_id,leave_date,reason) VALUES (?,?,?)", [9, day3, 'ป่วย']);
    sqliteDb.run('COMMIT');

    save();
    console.log('✅ Database seeded');
  }

  return db;
}

module.exports = { init };
