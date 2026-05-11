require('dotenv').config();
const express                    = require('express');
const cors                       = require('cors');
const path                       = require('path');
const fs                         = require('fs');
const bcrypt                     = require('bcryptjs');
const jwt                        = require('jsonwebtoken');
const crypto                     = require('crypto');
const multer                     = require('multer');
const nodemailer                 = require('nodemailer');
const axios                      = require('axios');
const { init, getPool, getExtPool, getInfoPool, sql } = require('./database');
const Anthropic                  = require('@anthropic-ai/sdk');

const app        = express();
const PORT       = process.env.PORT || 3010;
const AI_MODEL   = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const JWT_SECRET = process.env.JWT_SECRET || 'cs-team-jwt-secret-change-in-prod';
const claude     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── File upload config ────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, String(req.params.repairId || 'tmp'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9ก-๙_-]/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

// ── Follow Up attachment upload config ───────────────────
const fuStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, 'fu', String(req.params.id || 'tmp'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9ก-๙_-]/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});
const fuUpload = multer({
  storage: fuStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|pdf/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

// ── Notification helpers ──────────────────────────────────
async function sendLineNotify(message) {
  const token = process.env.LINE_NOTIFY_TOKEN;
  if (!token) return;
  try {
    await axios.post('https://notify-api.line.me/api/notify',
      new URLSearchParams({ message }),
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch(e) { console.error('Line Notify error:', e.message); }
}

async function sendEmail(to, subject, html) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass || !to) return;
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail', auth: { user, pass }
    });
    await transporter.sendMail({ from: `CS Team <${user}>`, to, subject, html });
  } catch(e) { console.error('Email error:', e.message); }
}

async function notifyRepairStatus(repairId, jobNo, companyName, newStatus, changedByName) {
  const statusLabel = {
    received:         'รับเรื่อง',
    spared:           'สแปร์แล้ว',
    assessing:        'ประเมินงานซ่อม',
    quoted:           'ทำเสนอราคางานซ่อม',
    waiting_approval: 'รออนุมัติ',
    repairing:        'อยู่ระหว่างซ่อมแซม',
    waiting_return:   'รอส่งคืน',
    returned:         'ส่งคืนเครื่องเรียบร้อย',
    cancelled:        'ยกเลิก',
    // legacy
    device_received:'รับเครื่องแล้ว', sent_supplier:'ส่ง Supplier',
    returned_from_supplier:'ได้เครื่องคืน', returned_to_customer:'ส่งคืนลูกค้า',
    closed:'ปิดงาน'
  };
  const label = statusLabel[newStatus] || newStatus;
  const msg   = `\n🔧 [${jobNo}] ${companyName}\nสถานะ: ${label}\nอัพเดทโดย: ${changedByName}\n${new Date().toLocaleString('th-TH')}`;
  await sendLineNotify(msg);
  // log to DB
  try {
    await req().input('rid', sql.Int, repairId).input('ch', sql.NVarChar, 'line')
      .input('msg', sql.NVarChar, msg).input('st', sql.NVarChar, 'sent')
      .query(`INSERT INTO repair_notification_log (repair_id,channel,message,status)
              VALUES (@rid,'line',@msg,@st)`);
  } catch {}
}

app.use(cors());
app.use(express.json());
// Serve HTML files without caching so clients always get the latest version
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploaded files
app.use('/uploads', express.static(UPLOAD_DIR));

const req    = () => getPool().request();
const extReq = () => getExtPool().request();

// ── Auth Middleware ───────────────────────────────────────
function authRequired(request, res, next) {
  const auth = request.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    request.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function managerRequired(request, res, next) {
  if (!['manager', 'team_lead', 'admin'].includes(request.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
}

function leadRequired(request, res, next) {
  if (!['team_lead', 'manager', 'admin'].includes(request.user?.role)) {
    return res.status(403).json({ error: 'Team lead or above required' });
  }
  next();
}

async function getScopedUsernames(user) {
  if (!user) return null;
  if (['manager', 'admin'].includes(user.role)) return undefined; // no restriction
  if (user.role === 'staff') {
    return user.ext_username ? [user.ext_username] : null;
  }
  if (user.role === 'team_lead') {
    const rows = (await req()
      .input('tm', sql.NVarChar, user.team)
      .query(`SELECT DISTINCT au.ext_username FROM app_users au
              JOIN employees e ON e.id = au.employee_id
              WHERE e.team = @tm AND au.active = 1 AND e.active = 1
                AND au.ext_username IS NOT NULL`)).recordset;
    return rows.map(r => r.ext_username);
  }
  return undefined;
}

function appendScopeClause(r, scopeUsernames) {
  if (scopeUsernames === undefined) return '';
  if (!scopeUsernames || scopeUsernames.length === 0) return ' AND 1=0';
  if (scopeUsernames.length === 1) {
    r.input('_su0', sql.NVarChar, scopeUsernames[0]);
    return ' AND u.UserName = @_su0';
  }
  scopeUsernames.forEach((u, i) => r.input(`_su${i}`, sql.NVarChar, u));
  return ` AND u.UserName IN (${scopeUsernames.map((_, i) => `@_su${i}`).join(',')})`;
}

// ── Calllog base query (LicenseDB) ───────────────────────
const CALLLOG_SELECT = `
  SELECT
    cl.CalllogId        AS id,
    cr.CompanyName,
    cl.ReceiveDate      AS opened_at,
    cl.CloseDate        AS CloseDate,
    CASE
      WHEN cl.CloseDate IS NOT NULL AND cl.ReceiveDate IS NOT NULL
      THEN DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate)
      ELSE NULL
    END                 AS TimeDiff_Minutes,
    cl.Stars,
    cl.Comment          AS ticket_comment,
    cl.CalllogDesc      AS description,
    cl.Solution,
    cs.StatusName       AS status,
    cl.Subject                  AS category,
    u.UserName                  AS assigned_name,
    cl.IssueURL,
    cl.Subject                  AS title,
    pt.Note                     AS problem_type,
    pt.ProblemTypeDetail        AS problem_type_detail,
    cl.InformName, cl.InformTel, cl.InformType,
    cl.OnsiteRemark             AS line_contact,
    cl.ProjectId                AS project_id,
    cl.ProblemTypeId            AS problem_type_id,
    cl.StatusId                 AS status_id,
    cl.SupportId                AS support_id,
    s.TimeToResolve             AS time_to_resolve
  FROM Calllog cl
  INNER JOIN CustomerRegistration cr ON cr.RegistrationId  = cl.RegistrationId
  LEFT  JOIN CallStatus           cs ON cs.StatusId        = cl.StatusId
  INNER JOIN Users                u  ON u.UserId           = cl.SupportId
  LEFT  JOIN Project              p  ON p.ProjectId        = cl.ProjectId
  LEFT  JOIN ProblemType          pt ON pt.ProblemTypeId   = cl.ProblemTypeId
  LEFT  JOIN Subject              s  ON s.SubjectName      = cl.Subject AND s.Active = 1
`;

// ══════════════════════════════════════════════════════════
//  EMPLOYEES (cs_team)
// ══════════════════════════════════════════════════════════
app.get('/api/employees', authRequired, async (request, res) => {
  try {
    const { team, include_inactive } = request.query;
    const role = request.user?.role;
    const r = req();
    let q = `SELECT id, name, nickname, team, role, phone, start_date, active, created_at
             FROM employees`;
    const conds = [];
    if (!include_inactive) conds.push('active=1');
    // staff: only see themselves
    if (role === 'staff') {
      conds.push('id=@myEmpId');
      r.input('myEmpId', sql.Int, request.user.employee_id || 0);
    } else if (role === 'team_lead') {
      // team_lead: only their team
      conds.push('team=@myTeam');
      r.input('myTeam', sql.NVarChar, request.user.team || '');
    } else if (team) {
      conds.push('team=@team'); r.input('team', sql.NVarChar, team);
    }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY team, role DESC, id';
    res.json((await r.query(q)).recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/employees', authRequired, managerRequired, async (request, res) => {
  try {
    const { name, nickname, team, role, phone, start_date } = request.body;
    const result = await req()
      .input('name',       sql.NVarChar, name)
      .input('nickname',   sql.NVarChar, nickname   || null)
      .input('team',       sql.NVarChar, team)
      .input('role',       sql.NVarChar, role       || 'staff')
      .input('phone',      sql.NVarChar, phone      || null)
      .input('start_date', sql.Date,     start_date ? new Date(start_date) : null)
      .query(`INSERT INTO employees (name,nickname,team,role,phone,start_date)
              OUTPUT INSERTED.id VALUES (@name,@nickname,@team,@role,@phone,@start_date)`);
    res.json({ id: result.recordset[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/employees/:id', authRequired, managerRequired, async (request, res) => {
  try {
    const { name, nickname, team, role, phone, start_date, active } = request.body;
    await req()
      .input('name',       sql.NVarChar, name)
      .input('nickname',   sql.NVarChar, nickname   || null)
      .input('team',       sql.NVarChar, team)
      .input('role',       sql.NVarChar, role)
      .input('phone',      sql.NVarChar, phone      || null)
      .input('start_date', sql.Date,     start_date ? new Date(start_date) : null)
      .input('active',     sql.Bit,      active ?? 1)
      .input('id',         sql.Int,      request.params.id)
      .query(`UPDATE employees
              SET name=@name, nickname=@nickname, team=@team, role=@role,
                  phone=@phone, start_date=@start_date, active=@active
              WHERE id=@id`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/employees/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await req()
      .input('id', sql.Int, request.params.id)
      .query('UPDATE employees SET active=0 WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  SHIFTS (cs_team)
// ══════════════════════════════════════════════════════════
function getMonday(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().split('T')[0];
}

app.get('/api/shifts', authRequired, async (request, res) => {
  try {
    const { week_start, team } = request.query;
    const role = request.user?.role;
    const startDate = getMonday(week_start);
    const endD = new Date(startDate); endD.setDate(endD.getDate() + 6);
    const endDate = endD.toISOString().split('T')[0];
    const r = req().input('s', sql.Date, startDate).input('e', sql.Date, endDate);
    let q = `SELECT s.*, e.name, e.team, e.role
             FROM shifts s JOIN employees e ON e.id=s.employee_id
             WHERE e.active=1 AND s.shift_date BETWEEN @s AND @e`;
    if (role === 'staff') {
      q += ' AND e.id=@myEmpId';
      r.input('myEmpId', sql.Int, request.user.employee_id || 0);
    } else if (role === 'team_lead') {
      q += ' AND e.team=@myTeam';
      r.input('myTeam', sql.NVarChar, request.user.team || '');
    } else if (team) {
      q += ' AND e.team=@team'; r.input('team', sql.NVarChar, team);
    }
    q += ' ORDER BY s.shift_date, e.team, s.shift_type, e.id';
    res.json((await r.query(q)).recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Shift Type Settings ────────────────────────────────────
app.get('/api/shift-types', authRequired, async (_, res) => {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='shift_types')
      CREATE TABLE shift_types (
        id         INT PRIMARY KEY IDENTITY,
        shift_key  NVARCHAR(20) NOT NULL UNIQUE,
        name       NVARCHAR(50) NOT NULL,
        start_time NVARCHAR(5)  NULL,
        end_time   NVARCHAR(5)  NULL,
        color_bg   NVARCHAR(10) DEFAULT '#f1f5f9',
        color_text NVARCHAR(10) DEFAULT '#334155',
        sort_order INT          DEFAULT 0
      )`);
    // Seed defaults if empty
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM shift_types)
      BEGIN
        INSERT INTO shift_types (shift_key,name,start_time,end_time,color_bg,color_text,sort_order) VALUES
          ('morning',  N'เช้า',   '08:30','17:30','#dcfce7','#166534',1),
          ('afternoon',N'บ่าย',   '12:00','21:00','#ffedd5','#c2410c',2),
          ('night',    N'ดึก',    '15:00','00:00','#e2e8f0','#475569',3),
          ('dayoff',   N'DayOFF', NULL,    NULL,  '#fef2f2','#b91c1c',4)
      END`);
    // Always sync canonical values (times + colors) for all built-in shift types
    await req().query(`
      UPDATE shift_types SET start_time='08:30',end_time='17:30',color_bg='#dcfce7',color_text='#166534' WHERE shift_key='morning';
      UPDATE shift_types SET start_time='10:00',end_time='19:00',color_bg='#e0f2fe',color_text='#0369a1' WHERE shift_key='mid';
      UPDATE shift_types SET start_time='12:00',end_time='21:00',color_bg='#ffedd5',color_text='#c2410c' WHERE shift_key='afternoon';
      UPDATE shift_types SET start_time='15:00',end_time='00:00',color_bg='#e2e8f0',color_text='#475569' WHERE shift_key='night';
      UPDATE shift_types SET color_bg='#fef2f2',color_text='#b91c1c' WHERE shift_key='dayoff';
      UPDATE shift_types SET start_time=NULL,end_time=NULL,color_bg='#fef9c3',color_text='#854d0e' WHERE shift_key='leave_personal';
      UPDATE shift_types SET start_time=NULL,end_time=NULL,color_bg='#fee2e2',color_text='#991b1b' WHERE shift_key='leave_sick';
      UPDATE shift_types SET start_time=NULL,end_time=NULL,color_bg='#f3e8ff',color_text='#6b21a8' WHERE shift_key='leave_annual';
    `);
    // Insert new shift/leave types if not exists
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM shift_types WHERE shift_key='mid')
        INSERT INTO shift_types (shift_key,name,start_time,end_time,color_bg,color_text,sort_order)
        VALUES ('mid',N'กลางวัน','10:00','19:00','#e0f2fe','#0369a1',2);
      IF NOT EXISTS (SELECT 1 FROM shift_types WHERE shift_key='leave_personal')
        INSERT INTO shift_types (shift_key,name,start_time,end_time,color_bg,color_text,sort_order)
        VALUES ('leave_personal',N'ลากิจ',NULL,NULL,'#fef9c3','#854d0e',5);
      IF NOT EXISTS (SELECT 1 FROM shift_types WHERE shift_key='leave_sick')
        INSERT INTO shift_types (shift_key,name,start_time,end_time,color_bg,color_text,sort_order)
        VALUES ('leave_sick',N'ลาป่วย',NULL,NULL,'#fee2e2','#991b1b',6);
      IF NOT EXISTS (SELECT 1 FROM shift_types WHERE shift_key='leave_annual')
        INSERT INTO shift_types (shift_key,name,start_time,end_time,color_bg,color_text,sort_order)
        VALUES ('leave_annual',N'ลาพักร้อน',NULL,NULL,'#f3e8ff','#6b21a8',7);
    `);
    const rows = (await req().query('SELECT * FROM shift_types ORDER BY sort_order')).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/shift-types/:id', authRequired, async (request, res) => {
  try {
    const { name, start_time, end_time, color_bg, color_text } = request.body;
    await req()
      .input('id',   sql.Int,      parseInt(request.params.id))
      .input('name', sql.NVarChar, name)
      .input('st',   sql.NVarChar, start_time || null)
      .input('et',   sql.NVarChar, end_time   || null)
      .input('cbg',  sql.NVarChar, color_bg   || null)
      .input('ctxt', sql.NVarChar, color_text || null)
      .query(`UPDATE shift_types SET name=@name,start_time=@st,end_time=@et,
              color_bg=ISNULL(@cbg,color_bg),color_text=ISNULL(@ctxt,color_text)
              WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shifts/month', authRequired, async (request, res) => {
  try {
    const { year, month, team } = request.query;
    const role = request.user?.role;
    const y = parseInt(year) || new Date().getFullYear();
    const m = parseInt(month) || (new Date().getMonth() + 1);
    const startDate = `${y}-${String(m).padStart(2,'0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const endDate = `${y}-${String(m).padStart(2,'0')}-${lastDay}`;
    const r = req().input('s', sql.Date, startDate).input('e', sql.Date, endDate);
    let q = `SELECT s.*, e.name, e.team, e.role
             FROM shifts s JOIN employees e ON e.id=s.employee_id
             WHERE e.active=1 AND s.shift_date BETWEEN @s AND @e`;
    if (role === 'staff') {
      q += ' AND e.id=@myEmpId';
      r.input('myEmpId', sql.Int, request.user.employee_id || 0);
    } else if (role === 'team_lead') {
      q += ' AND e.team=@myTeam';
      r.input('myTeam', sql.NVarChar, request.user.team || '');
    } else if (team) {
      q += ' AND e.team=@team'; r.input('team', sql.NVarChar, team);
    }
    q += ' ORDER BY s.shift_date, e.team, e.id';
    res.json((await r.query(q)).recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shifts', async (request, res) => {
  try {
    const { employee_id, shift_type, shift_date } = request.body;
    const isLeaveOrOff = shift_type === 'dayoff' || shift_type.startsWith('leave_');

    // detect any existing shift on this date (regardless of status)
    const existing = await req().input('eid', sql.Int, employee_id).input('date', sql.Date, shift_date)
      .query('SELECT id FROM shifts WHERE employee_id=@eid AND shift_date=@date');
    const isReplace = existing.recordset.length > 0;

    // 5-shift limit applies only to actual work shifts (not dayoff/leave)
    if (!isReplace && !isLeaveOrOff) {
      const d = new Date(shift_date);
      const day = d.getDay();
      const diffToMon = (day === 0 ? -6 : 1 - day);
      const weekStart = new Date(d); weekStart.setDate(d.getDate() + diffToMon);
      const weekEnd   = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
      const countRes = await req()
        .input('eid2', sql.Int, employee_id)
        .input('ws',   sql.Date, weekStart.toISOString().split('T')[0])
        .input('we',   sql.Date, weekEnd.toISOString().split('T')[0])
        .query(`SELECT COUNT(*) AS cnt FROM shifts
                WHERE employee_id=@eid2
                  AND shift_date >= @ws AND shift_date <= @we
                  AND shift_type NOT IN ('dayoff','leave_personal','leave_sick','leave_annual')
                  AND (status IS NULL OR status NOT IN ('leave','approved_leave'))`);
      const weekShifts = countRes.recordset[0].cnt;
      if (weekShifts >= 5) {
        return res.status(400).json({ error: `พนักงานมีกะครบ 5 วันแล้วในสัปดาห์นี้` });
      }
    }

    await req().input('eid', sql.Int, employee_id).input('date', sql.Date, shift_date)
      .query('DELETE FROM shifts WHERE employee_id=@eid AND shift_date=@date');
    const result = await req()
      .input('eid', sql.Int, employee_id).input('stype', sql.NVarChar, shift_type)
      .input('date', sql.Date, shift_date)
      .query('INSERT INTO shifts (employee_id,shift_type,shift_date) OUTPUT INSERTED.id VALUES (@eid,@stype,@date)');
    res.json({ id: result.recordset[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/shifts/:id', async (request, res) => {
  try {
    const { shift_type, status } = request.body;
    await req().input('stype', sql.NVarChar, shift_type).input('status', sql.NVarChar, status)
      .input('id', sql.Int, request.params.id)
      .query('UPDATE shifts SET shift_type=@stype,status=@status WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/shifts/:id', async (request, res) => {
  try {
    await req().input('id', sql.Int, request.params.id).query('DELETE FROM shifts WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk clear shifts for a week (optionally filtered by team)
app.delete('/api/shifts', authRequired, async (request, res) => {
  try {
    const { week_start, team } = request.query;
    if (!week_start) return res.status(400).json({ error: 'week_start required' });
    const startDate = getMonday(week_start);
    const endD = new Date(startDate); endD.setDate(endD.getDate() + 6);
    let q = req()
      .input('s', sql.Date, startDate)
      .input('e', sql.Date, endD.toISOString().split('T')[0]);
    let where = 'WHERE s.shift_date >= @s AND s.shift_date <= @e';
    if (team) {
      q = q.input('team', sql.NVarChar, team);
      where += ' AND e.team = @team';
    }
    const result = await q.query(
      `DELETE s FROM shifts s JOIN employees e ON e.id = s.employee_id ${where}`
    );
    res.json({ ok: true, deleted: result.rowsAffected[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shifts/coverage', authRequired, async (request, res) => {
  try {
    const startDate = getMonday(request.query.week_start);
    const endD = new Date(startDate); endD.setDate(endD.getDate() + 6);
    const result = await req().input('s', sql.Date, startDate)
      .input('e', sql.Date, endD.toISOString().split('T')[0])
      .query(`SELECT s.shift_date, e.team, s.shift_type, COUNT(*) AS cnt
              FROM shifts s JOIN employees e ON e.id=s.employee_id
              WHERE e.active=1 AND s.shift_date BETWEEN @s AND @e
                AND s.status NOT IN ('leave','approved_leave')
              GROUP BY s.shift_date, e.team, s.shift_type`);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  LEAVE REQUESTS (cs_team)
// ══════════════════════════════════════════════════════════
app.get('/api/leave-requests', authRequired, async (request, res) => {
  try {
    const role = request.user?.role;
    const r = req();
    let where = '';
    if (role === 'staff') {
      where = ' WHERE lr.employee_id=@myEmpId';
      r.input('myEmpId', sql.Int, request.user.employee_id || 0);
    } else if (role === 'team_lead') {
      where = ' WHERE e.team=@myTeam';
      r.input('myTeam', sql.NVarChar, request.user.team || '');
    }
    const result = await r.query(`
      SELECT lr.*, e.name AS emp_name, e.team, a.name AS approver_name
      FROM leave_requests lr
      JOIN employees e ON e.id=lr.employee_id
      LEFT JOIN employees a ON a.id=lr.approved_by
      ${where}
      ORDER BY lr.created_at DESC`);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leave-requests', authRequired, async (request, res) => {
  try {
    const { employee_id, leave_date, reason } = request.body;
    const result = await req()
      .input('eid', sql.Int, employee_id).input('date', sql.Date, leave_date)
      .input('reason', sql.NVarChar, reason)
      .query('INSERT INTO leave_requests (employee_id,leave_date,reason) OUTPUT INSERTED.id VALUES (@eid,@date,@reason)');
    res.json({ id: result.recordset[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leave-requests/:id/approve', authRequired, async (request, res) => {
  try {
    const { approved_by } = request.body;
    const lr = (await req().input('id', sql.Int, request.params.id)
      .query('SELECT * FROM leave_requests WHERE id=@id')).recordset[0];
    if (!lr) return res.status(404).json({ error: 'not found' });
    await req().input('by', sql.Int, approved_by).input('id', sql.Int, request.params.id)
      .query("UPDATE leave_requests SET status='approved',approved_by=@by WHERE id=@id");
    await req().input('eid', sql.Int, lr.employee_id).input('date', sql.Date, lr.leave_date)
      .query("UPDATE shifts SET status='approved_leave' WHERE employee_id=@eid AND shift_date=@date");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leave-requests/:id/reject', authRequired, async (request, res) => {
  try {
    await req().input('by', sql.Int, request.body.approved_by).input('id', sql.Int, request.params.id)
      .query("UPDATE leave_requests SET status='rejected',approved_by=@by WHERE id=@id");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  TICKETS — ดึงจาก LicenseDB (read-only)
// ══════════════════════════════════════════════════════════
app.get('/api/tickets', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { status, search, dateFrom, dateTo, team, problemType, subject } = request.query;
    const defaultFrom = dateFrom || new Date().toISOString().split('T')[0];

    // RBAC scope
    let scope = await getScopedUsernames(request.user);
    if (scope === null) return res.json([]);
    if (team) {
      const teamRows = (await req().input('tm', sql.NVarChar, team).query(
        `SELECT DISTINCT au.ext_username FROM app_users au JOIN employees e ON e.id=au.employee_id
         WHERE e.team=@tm AND au.active=1 AND e.active=1 AND au.ext_username IS NOT NULL`
      )).recordset;
      const teamScope = teamRows.map(r => r.ext_username);
      scope = scope === undefined ? teamScope : scope.filter(u => teamScope.includes(u));
    }

    const r = extReq();
    const isIdSearch = search && /^\s*#?(\d+)\s*$/.test(search);

    let q;
    if (isIdSearch) {
      // ID search — no date filter, no other conditions, find across all history
      const numId = parseInt(search.replace('#','').trim());
      q = CALLLOG_SELECT + ' WHERE cl.Active=1 AND cl.CalllogId=@sid';
      r.input('sid', sql.Int, numId);
      q += appendScopeClause(r, scope);
    } else {
      q = CALLLOG_SELECT + ' WHERE cl.Active=1 AND cl.ReceiveDate >= @df';
      r.input('df', sql.DateTime, new Date(defaultFrom));
      if (status)      { q += ' AND cs.StatusName=@status'; r.input('status', sql.NVarChar, status); }
      if (search)      { q += ' AND (cl.Subject LIKE @s OR cr.CompanyName LIKE @s OR u.UserName LIKE @s OR pt.ProblemTypeDetail LIKE @s)';
                                                             r.input('s', sql.NVarChar, `%${search}%`); }
      if (dateTo)      { q += ' AND cl.ReceiveDate < @dt'; r.input('dt', sql.DateTime, new Date(new Date(dateTo).getTime() + 86400000)); }
      if (problemType) { q += ' AND pt.ProblemTypeDetail=@pt'; r.input('pt', sql.NVarChar, problemType); }
      if (subject)     { q += ' AND cl.Subject=@subj';        r.input('subj', sql.NVarChar, subject); }
      q += appendScopeClause(r, scope);
    }
    q += ' ORDER BY cl.ReceiveDate DESC';
    const tickets = (await r.query(q)).recordset;

    // Enrich with specialist_log info (for "assign to specialist" tickets)
    if (tickets.length) {
      const spRows = (await req().query(`
        SELECT sl.id AS sp_id, sl.calllog_id,
               sl.assigned_at, sl.resolved_at,
               e.name AS sp_assigned_by,
               e2.name AS sp_resolved_by,
               sl.status AS sp_status
        FROM specialist_log sl
        LEFT JOIN app_users au  ON au.id = sl.original_agent
        LEFT JOIN employees e   ON e.id  = au.employee_id
        LEFT JOIN app_users au2 ON au2.id = sl.resolved_by
        LEFT JOIN employees e2  ON e2.id  = au2.employee_id
        WHERE sl.calllog_id IN (${tickets.map(t => t.id).join(',')})
          AND sl.status NOT IN ('cancelled')
      `)).recordset;
      const spMap = {};
      spRows.forEach(s => { spMap[s.calllog_id] = s; });
      tickets.forEach(t => { if (spMap[t.id]) t.specialist = spMap[t.id]; });
    }

    res.json(tickets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Overdue tickets — must be BEFORE /:id route
// Lightweight endpoint — just solution+description (for specialist detail)
app.get('/api/tickets/quick/:id', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.json({});
    const r = await extReq().input('id', sql.Int, parseInt(request.params.id))
      .query(`SELECT cl.CalllogId AS id, cl.CalllogDesc AS description, cl.Solution,
                     u.UserName AS agent, cs.StatusName AS status
              FROM Calllog cl
              LEFT JOIN Users u  ON u.UserId  = cl.SupportId
              LEFT JOIN CallStatus cs ON cs.StatusId = cl.StatusId
              WHERE cl.CalllogId = @id`);
    res.json(r.recordset[0] || {});
  } catch(e) { res.json({}); }
});

app.get('/api/tickets/overdue', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    let scope = await getScopedUsernames(request.user);
    if (scope === null) return res.json({ count: 0, tickets: [] });
    const r = extReq();
    const sc = appendScopeClause(r, scope);
    const result = await r.query(`
      SELECT cl.CalllogId AS id, cr.CompanyName, cl.ReceiveDate AS opened_at,
             cs.StatusName AS status, cl.Subject AS title, u.UserName AS assigned_name
      FROM Calllog cl
      INNER JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
      INNER JOIN CallStatus cs ON cs.StatusId = cl.StatusId
      INNER JOIN Users u ON u.UserId = cl.SupportId
      WHERE cs.StatusName NOT LIKE '%close%'
        AND cs.StatusName NOT LIKE '%complete%'
        AND DATEDIFF(hour, cl.ReceiveDate, GETDATE()) > 24${sc}
      ORDER BY cl.ReceiveDate ASC`);
    res.json({ count: result.recordset.length, tickets: result.recordset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id', async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const result = await extReq().input('id', sql.Int, request.params.id)
      .query(CALLLOG_SELECT + ' WHERE cl.Active=1 AND cl.CalllogId=@id');
    if (!result.recordset[0]) return res.status(404).json({ error: 'not found' });
    res.json(result.recordset[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ticket review: save stars + comment back to LicenseDB ─
// Full update of a Calllog ticket
app.put('/api/tickets/:id', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const b  = request.body;
    const id = parseInt(request.params.id);
    await extReq()
      .input('id',    sql.Int,      id)
      .input('rd',    sql.DateTime, faceValueDate(b.receive_date))
      .input('cd',    sql.DateTime, faceValueDate(b.close_date))
      .input('desc',  sql.NVarChar, b.description   ?? null)
      .input('sol',   sql.NVarChar, b.solution       ?? null)
      .input('subj',  sql.NVarChar, b.subject        ?? null)
      .input('ptid',  sql.Int,      b.problem_type_id ? parseInt(b.problem_type_id) : null)
      .input('pid',   sql.Int,      b.project_id      ? parseInt(b.project_id)      : null)
      .input('stid',  sql.Int,      b.status_id       ? parseInt(b.status_id)       : null)
      .input('sid',   sql.Int,      b.support_id      ? parseInt(b.support_id)       : null)
      .input('iname',   sql.NVarChar, b.inform_name     ?? null)
      .input('itel',    sql.NVarChar, b.inform_tel      ?? null)
      .input('itype',   sql.NVarChar, b.inform_type     ?? null)
      .input('line',    sql.NVarChar, b.line_contact    ?? null)
      .input('solvety', sql.NVarChar, b.inform_type ? (['Walk-in','Onsite'].includes(b.inform_type) ? 'Walk-in' : 'Remote') : null)
      .input('uid',     sql.Int,      request.user.calluserid || null)
      .query(`UPDATE Calllog SET
        ReceiveDate  = ISNULL(@rd,       ReceiveDate),
        CloseDate    = ISNULL(@cd,       CloseDate),
        DueDate      = ISNULL(@cd,       DueDate),
        CalllogDesc  = ISNULL(@desc,     CalllogDesc),
        Solution     = ISNULL(@sol,      Solution),
        Subject      = ISNULL(@subj,     Subject),
        ProblemTypeId= ISNULL(@ptid,     ProblemTypeId),
        ProjectId    = ISNULL(@pid,      ProjectId),
        StatusId     = ISNULL(@stid,     StatusId),
        SupportId    = ISNULL(@sid,      SupportId),
        UserId       = ISNULL(@uid,      UserId),
        SolveType    = ISNULL(@solvety,  SolveType),
        InformName   = ISNULL(@iname,    InformName),
        InformTel    = ISNULL(@itel,     InformTel),
        InformType   = ISNULL(@itype,    InformType),
        OnsiteRemark = ISNULL(@line,     OnsiteRemark),
        UpdateDate   = GETDATE()
        WHERE CalllogId=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Close calllog after specialist resolves it
app.post('/api/tickets/:id/sp-close', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const calllogId = parseInt(request.params.id);
    const { solution } = request.body;

    // Find the specialist job for this calllog
    const spRow = (await req().input('cid', sql.Int, calllogId)
      .query(`SELECT sl.id AS sp_id, sl.resolved_by, sl.resolution_note,
                     e.name AS resolver_name
              FROM specialist_log sl
              LEFT JOIN app_users au ON au.id = sl.resolved_by
              LEFT JOIN employees e  ON e.id  = au.employee_id
              WHERE sl.calllog_id=@cid AND sl.status='resolved'`)).recordset[0];
    if (!spRow) return res.status(400).json({ error: 'ยังไม่มีงาน Specialist ที่แก้ไขแล้วสำหรับเคสนี้' });

    // Find a "close" status ID from LicenseDB
    const closeStatus = (await extReq()
      .query(`SELECT TOP 1 StatusId FROM CallStatus
              WHERE StatusName LIKE '%close%' OR StatusName LIKE '%complete%'
              ORDER BY StatusName`)).recordset[0];
    if (!closeStatus) return res.status(500).json({ error: 'ไม่พบสถานะ Close ใน CallStatus' });

    const resolverNote = spRow.resolver_name
      ? `[แก้ไขโดย Specialist: ${spRow.resolver_name}]${solution ? ' ' + solution : ''}${spRow.resolution_note ? '\n' + spRow.resolution_note : ''}`
      : solution || null;

    // Update Calllog: close it, set CloseDate, record solution
    await extReq()
      .input('id',    sql.Int,      calllogId)
      .input('stid',  sql.Int,      closeStatus.StatusId)
      .input('cd',    sql.DateTime, new Date())
      .input('sol',   sql.NVarChar, resolverNote)
      .query(`UPDATE Calllog
              SET StatusId=@stid, CloseDate=@cd, DueDate=@cd,
                  Solution=ISNULL(@sol, Solution), UpdateDate=GETDATE()
              WHERE CalllogId=@id`);

    res.json({ ok: true, sp_id: spRow.sp_id, resolver_name: spRow.resolver_name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/tickets/:id/review', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { stars, comment } = request.body;
    await extReq()
      .input('id',      sql.Int,      parseInt(request.params.id))
      .input('stars',   sql.TinyInt,  (stars != null && stars !== '') ? parseInt(stars) : null)
      .input('comment', sql.NVarChar, comment ?? null)
      .query(`UPDATE Calllog
              SET Stars=@stars, Comment=@comment, UpdateDate=GETDATE()
              WHERE CalllogId=@id`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  SERVER TIME (UTC+7 / ICT)
// ══════════════════════════════════════════════════════════
app.get('/api/server-time', authRequired, (_, res) => {
  const ict = new Date(Date.now() + 7 * 60 * 60 * 1000); // shift to UTC+7
  const pad = n => String(n).padStart(2, '0');
  res.json({
    datetime: `${ict.getUTCFullYear()}-${pad(ict.getUTCMonth()+1)}-${pad(ict.getUTCDate())}T${pad(ict.getUTCHours())}:${pad(ict.getUTCMinutes())}`,
  });
});

// ══════════════════════════════════════════════════════════
//  CREATE CASE (INSERT into LicenseDB Calllog)
// ══════════════════════════════════════════════════════════

// Form dropdown data
app.get('/api/cases/form-data', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'LicenseDB not connected' });
    const [statuses, projects, users, subjects, ptypes] = await Promise.all([
      extReq().query(`SELECT StatusId AS id, StatusName AS name FROM CallStatus ORDER BY StatusName`),
      extReq().query(`SELECT ProjectId AS id, ProjectName AS name FROM Project WHERE Active=1 ORDER BY ProjectName`),
      extReq().query(`SELECT UserId AS id, UserName AS name FROM Users WHERE Active=1 ORDER BY UserName`),
      extReq().query(`SELECT s.SubjectId AS id, s.SubjectName AS name,
                             s.ProblemTypeId AS problem_type_id, s.TimeToResolve AS time_to_resolve
                      FROM Subject s WHERE s.Active=1 ORDER BY s.SubjectName`),
      extReq().query(`SELECT ProblemTypeId AS id, ProblemTypeDetail AS name FROM ProblemType ORDER BY ProblemTypeDetail`),
    ]);
    res.json({
      statuses:     statuses.recordset,
      projects:     projects.recordset,
      users:        users.recordset,
      subjects:     subjects.recordset,
      problemTypes: ptypes.recordset,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create Case — INSERT into Calllog
app.post('/api/cases', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'LicenseDB not connected' });
    const b = request.body;

    // Resolve SupportId: use calluserid from JWT, fallback to ext_username lookup
    let supportId = b.support_id || request.user.calluserid || null;
    if (!supportId && request.user.ext_username) {
      const uRow = await extReq().input('un', sql.NVarChar, request.user.ext_username)
        .query('SELECT TOP 1 UserId FROM Users WHERE UserName=@un');
      if (uRow.recordset.length) supportId = uRow.recordset[0].UserId;
    }

    const result = await extReq()
      .input('rid',   sql.Int,      b.registration_id  || null)
      .input('rd',    sql.DateTime, faceValueDate(b.receive_date))
      .input('cd',    sql.DateTime, faceValueDate(b.close_date))
      .input('desc',  sql.NVarChar, b.description       || null)
      .input('iname', sql.NVarChar, b.inform_name        || null)
      .input('itel',  sql.NVarChar, b.inform_tel         || null)
      .input('itype', sql.NVarChar, b.inform_type        || null)
      .input('line',  sql.NVarChar, b.line_contact       || null) // stored in OnsiteRemark
      .input('sid',   sql.Int,      supportId)
      .input('stid',  sql.Int,      b.status_id         || null)
      .input('pid',   sql.Int,      b.project_id        || null)
      .input('ptid',  sql.Int,      b.problem_type_id   || null)
      .input('subj',    sql.NVarChar, b.subject            || null)
      .input('sol',     sql.NVarChar, b.solution           || null)
      .input('uid',     sql.Int,      request.user.calluserid || null)  // UserId
      .input('cbid',    sql.Int,      b.close_date ? (request.user.calluserid || null) : null) // CloseById when closed
      .input('solvety', sql.NVarChar, (['Walk-in','Onsite'].includes(b.inform_type) ? 'Walk-in' : 'Remote'))
      .query(`INSERT INTO Calllog
        (RegistrationId, ReceiveDate, CloseDate, DueDate, CalllogDesc, InformName, InformTel,
         InformType, OnsiteRemark, SupportId, StatusId, ProjectId, ProblemTypeId,
         Subject, Solution, SolveType, UserId, CloseById, Active, InsertDate, UpdateDate)
        OUTPUT INSERTED.CalllogId AS id
        VALUES
        (@rid,
         ISNULL(@rd,GETDATE()),
         @cd,
         @cd,
         @desc, @iname, @itel,
         @itype, @line, @sid, @stid, @pid, @ptid,
         @subj, @sol, @solvety, @uid, @cbid, 1, GETDATE(), GETDATE())`);

    res.json({ id: result.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/meta/statuses', async (_, res) => {
  try {
    if (!getExtPool()) return res.json([]);
    const result = await extReq().query('SELECT DISTINCT StatusName FROM CallStatus ORDER BY StatusName');
    res.json(result.recordset.map(r => r.StatusName));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/meta/categories', async (_, res) => {
  try {
    if (!getExtPool()) return res.json([]);
    const result = await extReq().query(
      `SELECT s.SubjectName AS category, pt.ProblemTypeDetail AS problem_type
       FROM Subject s
       LEFT JOIN ProblemType pt ON pt.ProblemTypeId = s.ProblemTypeId
       WHERE s.Active = 1
       ORDER BY pt.ProblemTypeDetail, s.SubjectName`);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/meta/problem-types', async (_, res) => {
  try {
    if (!getExtPool()) return res.json([]);
    const result = await extReq().query(
      `SELECT DISTINCT pt.ProblemTypeDetail
       FROM ProblemType pt WHERE pt.ProblemTypeDetail IS NOT NULL
       ORDER BY pt.ProblemTypeDetail`);
    res.json(result.recordset.map(r => r.ProblemTypeDetail));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  SETTINGS — Subject & ProblemType (LicenseDB)
// ══════════════════════════════════════════════════════════

// ── Subject ───────────────────────────────────────────────
app.get('/api/settings/subjects', authRequired, async (_, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'LicenseDB not connected' });
    const r = await extReq().query(
      `SELECT s.SubjectId AS id, s.SubjectName AS name, s.Grade AS grade,
              s.WeightScore AS weight_score, s.Active AS active,
              s.TimeToResolve AS time_to_resolve,
              s.ProblemTypeId AS problem_type_id,
              pt.ProblemTypeDetail AS problem_type_name
       FROM Subject s
       LEFT JOIN ProblemType pt ON pt.ProblemTypeId = s.ProblemTypeId
       WHERE s.Active = 1
       ORDER BY pt.ProblemTypeDetail, s.SubjectName`);
    res.json(r.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/subjects', authRequired, managerRequired, async (request, res) => {
  try {
    const { name, grade, weight_score, time_to_resolve, problem_type_id } = request.body;
    if (!name) return res.status(400).json({ error: 'SubjectName required' });
    const r = await extReq()
      .input('n',   sql.NVarChar, name)
      .input('g',   sql.NVarChar, grade || null)
      .input('ws',  sql.Float,    weight_score != null ? parseFloat(weight_score) : null)
      .input('t',   sql.Int,      time_to_resolve != null ? parseInt(time_to_resolve) : null)
      .input('pid', sql.Int,      problem_type_id ? parseInt(problem_type_id) : null)
      .query(`INSERT INTO Subject (SubjectName, Grade, WeightScore, Active, TimeToResolve, ProblemTypeId)
              OUTPUT INSERTED.SubjectId AS id, INSERTED.SubjectName AS name
              VALUES (@n, @g, @ws, 1, @t, @pid)`);
    res.json(r.recordset[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings/subjects/:id', authRequired, managerRequired, async (request, res) => {
  try {
    const { name, grade, weight_score, time_to_resolve, active, problem_type_id } = request.body;
    await extReq()
      .input('id',  sql.Int,      parseInt(request.params.id))
      .input('n',   sql.NVarChar, name)
      .input('g',   sql.NVarChar, grade || null)
      .input('ws',  sql.Float,    weight_score != null ? parseFloat(weight_score) : null)
      .input('t',   sql.Int,      time_to_resolve != null ? parseInt(time_to_resolve) : null)
      .input('ac',  sql.Bit,      active != null ? (active ? 1 : 0) : 1)
      .input('pid', sql.Int,      problem_type_id ? parseInt(problem_type_id) : null)
      .query(`UPDATE Subject SET SubjectName=@n, Grade=@g, WeightScore=@ws,
              Active=@ac, TimeToResolve=@t, ProblemTypeId=@pid WHERE SubjectId=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/settings/subjects/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await extReq().input('id', sql.Int, parseInt(request.params.id))
      .query('DELETE FROM Subject WHERE SubjectId=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ProblemType ────────────────────────────────────────────
app.get('/api/settings/problem-types', authRequired, async (_, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'LicenseDB not connected' });
    const r = await extReq().query(
      `SELECT ProblemTypeId AS id, ProblemTypeDetail AS name, Note AS note
       FROM ProblemType ORDER BY ProblemTypeDetail`);
    res.json(r.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/problem-types', authRequired, managerRequired, async (request, res) => {
  try {
    const { name, note } = request.body;
    if (!name) return res.status(400).json({ error: 'ProblemTypeDetail required' });
    const r = await extReq()
      .input('n', sql.NVarChar, name)
      .input('nt', sql.NVarChar, note || null)
      .query(`INSERT INTO ProblemType (ProblemTypeDetail, Note)
              OUTPUT INSERTED.ProblemTypeId AS id, INSERTED.ProblemTypeDetail AS name
              VALUES (@n, @nt)`);
    res.json(r.recordset[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings/problem-types/:id', authRequired, managerRequired, async (request, res) => {
  try {
    const { name, note } = request.body;
    await extReq()
      .input('id', sql.Int,      parseInt(request.params.id))
      .input('n',  sql.NVarChar, name)
      .input('nt', sql.NVarChar, note || null)
      .query('UPDATE ProblemType SET ProblemTypeDetail=@n, Note=@nt WHERE ProblemTypeId=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/settings/problem-types/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await extReq().input('id', sql.Int, parseInt(request.params.id))
      .query('DELETE FROM ProblemType WHERE ProblemTypeId=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Name Map: ext_username → employee name ────────────────
app.get('/api/name-map', authRequired, async (_, res) => {
  try {
    const rows = (await req().query(`
      SELECT au.ext_username, e.name
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const map = {};
    rows.forEach(r => { map[r.ext_username] = r.name; });
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  KPI — คำนวณจาก LicenseDB + comment จาก cs_team
// ══════════════════════════════════════════════════════════
app.get('/api/kpi', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { month, team, dateFrom, dateTo } = request.query;

    // Support both month-picker and date-range
    let startDate, endDate;
    const isValidDate = d => d instanceof Date && !isNaN(d);

    if (dateFrom && dateTo) {
      startDate = new Date(dateFrom);
      endDate   = new Date(new Date(dateTo).getTime() + 86400000);
    }
    // Fallback to current month if dates are missing or invalid
    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      const ym = (month && /^\d{4}-\d{2}$/.test(month))
        ? month
        : new Date().toISOString().substring(0, 7);
      startDate = new Date(ym + '-01');
      endDate   = new Date(new Date(ym + '-01').setMonth(startDate.getMonth() + 1));
    }
    const monthStart = startDate.toISOString().split('T')[0];

    let scope = await getScopedUsernames(request.user);
    if (scope === null) return res.json([]);
    if (team) {
      const teamRows = (await req().input('tm', sql.NVarChar, team).query(
        `SELECT DISTINCT au.ext_username FROM app_users au JOIN employees e ON e.id=au.employee_id
         WHERE e.team=@tm AND au.active=1 AND e.active=1 AND au.ext_username IS NOT NULL`
      )).recordset;
      const teamScope = teamRows.map(r => r.ext_username);
      scope = scope === undefined ? teamScope : scope.filter(u => teamScope.includes(u));
    }

    // Previous period (same duration, shifted back)
    const durationMs  = endDate - startDate;
    const prevEnd     = new Date(startDate);
    const prevStart   = new Date(startDate.getTime() - durationMs);

    const mk  = () => extReq().input('s', sql.DateTime, startDate).input('e', sql.DateTime, endDate);
    const mkP = () => extReq().input('s', sql.DateTime, prevStart).input('e', sql.DateTime, prevEnd);
    const r1 = mk();  const sc1 = appendScopeClause(r1, scope);
    const r2 = mk();  const sc2 = appendScopeClause(r2, scope);
    const r3 = mk();  const sc3 = appendScopeClause(r3, scope);
    const r4 = mk();  const sc4 = appendScopeClause(r4, scope);
    const r5 = mkP(); const sc5 = appendScopeClause(r5, scope);
    const r6 = mk();  const sc6 = appendScopeClause(r6, scope);

    const [d1, d2, d3, d4, d5, d6] = await Promise.all([
      // Main KPI per agent
      r1.query(`
        SELECT u.UserName,
          COUNT(cl.CalllogId)  AS total_cases,
          SUM(CASE WHEN cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%complete%' THEN 1 ELSE 0 END) AS closed_cases,
          AVG(CASE WHEN cl.CloseDate IS NOT NULL AND cl.ReceiveDate IS NOT NULL AND cl.CloseDate >= cl.ReceiveDate
                   THEN DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate) END) AS avg_resolve_min,
          AVG(CAST(cl.Stars AS FLOAT)) AS avg_stars,
          SUM(CASE WHEN cs.StatusName NOT LIKE '%close%' AND cs.StatusName NOT LIKE '%complete%'
                        AND DATEDIFF(hour, cl.ReceiveDate, GETDATE()) > 24 THEN 1 ELSE 0 END) AS overdue_cases,
          MIN(cl.ReceiveDate) AS first_case,
          MAX(cl.ReceiveDate) AS last_case
        FROM Calllog cl
        INNER JOIN Users u  ON u.UserId  = cl.SupportId
        INNER JOIN CallStatus cs ON cs.StatusId = cl.StatusId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e${sc1}
        GROUP BY u.UserName ORDER BY total_cases DESC`),
      // Top problem type per agent
      r2.query(`
        SELECT u.UserName, pt.ProblemTypeDetail, COUNT(*) AS cnt,
          ROW_NUMBER() OVER (PARTITION BY u.UserName ORDER BY COUNT(*) DESC) AS rn
        FROM Calllog cl
        INNER JOIN Users u ON u.UserId = cl.SupportId
        LEFT  JOIN ProblemType pt ON pt.ProblemTypeId = cl.ProblemTypeId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e${sc2}
        GROUP BY u.UserName, pt.ProblemTypeDetail`),
      // Complaint count per company → map to agent (best effort by ticket)
      r3.query(`
        SELECT u.UserName, COUNT(DISTINCT tc.id) AS complaints
        FROM Calllog cl
        INNER JOIN Users u ON u.UserId = cl.SupportId
        INNER JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
        INNER JOIN ticket_complaints tc ON tc.company_name = cr.CompanyName
        WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e${sc3}
        GROUP BY u.UserName`),
      // Stars distribution
      r4.query(`
        SELECT cl.Stars, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e AND cl.Stars IS NOT NULL${sc4}
        GROUP BY cl.Stars ORDER BY cl.Stars`),
      // Previous period per agent (for trend comparison)
      r5.query(`
        SELECT u.UserName,
          COUNT(cl.CalllogId) AS total_cases,
          SUM(CASE WHEN cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%complete%' THEN 1 ELSE 0 END) AS closed_cases,
          AVG(CASE WHEN cl.CloseDate IS NOT NULL AND cl.ReceiveDate IS NOT NULL AND cl.CloseDate >= cl.ReceiveDate
                   THEN DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate) END) AS avg_resolve_min,
          AVG(CAST(cl.Stars AS FLOAT)) AS avg_stars
        FROM Calllog cl
        INNER JOIN Users u ON u.UserId = cl.SupportId
        INNER JOIN CallStatus cs ON cs.StatusId = cl.StatusId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e${sc5}
        GROUP BY u.UserName`),
      // Daily cases per agent (for sparkline + consistency)
      r6.query(`
        SELECT u.UserName, CAST(cl.ReceiveDate AS DATE) AS day, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e${sc6}
        GROUP BY u.UserName, CAST(cl.ReceiveDate AS DATE)
        ORDER BY u.UserName, day`),
    ]);

    // Build top problem type map
    const topProblemMap = {};
    d2.recordset.forEach(r => {
      if (r.rn === 1) topProblemMap[r.UserName] = r.ProblemTypeDetail || 'อื่นๆ';
    });
    const complaintMap = {};
    d3.recordset.forEach(r => { complaintMap[r.UserName] = r.complaints; });

    const comments = await req().input('month', sql.Date, monthStart)
      .query(`SELECT ext_username, comment, recorded_by, e.name AS recorder_name
              FROM kpi_comments kc LEFT JOIN employees e ON e.id=kc.recorded_by
              WHERE month=@month`);
    const commentMap = {};
    comments.recordset.forEach(c => { commentMap[c.ext_username] = c; });

    // Build prev period map
    const prevMap = {};
    d5.recordset.forEach(r => { prevMap[r.UserName] = r; });

    // Build daily map per agent (for sparkline + consistency)
    const dailyMap = {};
    d6.recordset.forEach(r => {
      if (!dailyMap[r.UserName]) dailyMap[r.UserName] = [];
      dailyMap[r.UserName].push({ day: r.day, cnt: r.cnt });
    });

    const result = d1.recordset.map(r => {
      const prev      = prevMap[r.UserName] || {};
      const daily     = dailyMap[r.UserName] || [];
      const close_rate = r.total_cases ? Math.round((r.closed_cases / r.total_cases) * 100) : 0;

      // Consistency: coefficient of variation of daily counts
      const cnts = daily.map(d => d.cnt);
      const mean = cnts.length ? cnts.reduce((a,b) => a+b, 0) / cnts.length : 0;
      const variance = cnts.length > 1
        ? cnts.reduce((s,c) => s + Math.pow(c - mean, 2), 0) / cnts.length : 0;
      const cv = mean > 0 ? Math.round(Math.sqrt(variance) / mean * 100) : 0;

      return {
        ...r,
        month:        monthStart,
        top_problem:  topProblemMap[r.UserName] || '—',
        complaints:   complaintMap[r.UserName] || 0,
        close_rate,
        comment:      commentMap[r.UserName]?.comment || null,
        // Trend vs previous period
        prev_cases:   prev.total_cases || 0,
        prev_close:   prev.total_cases ? Math.round((prev.closed_cases / prev.total_cases) * 100) : 0,
        prev_stars:   prev.avg_stars || null,
        prev_resolve: prev.avg_resolve_min || null,
        // Daily sparkline data
        daily_counts: cnts,
        consistency_cv: cv,   // lower = more consistent
      };
    });
    res.json({ agents: result, starsDist: d4.recordset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KPI Agent Detail drill-down ──────────────────────────
app.get('/api/kpi/agent-detail', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { username, month, dateFrom, dateTo } = request.query;
    if (!username) return res.status(400).json({ error: 'username required' });

    const isValid = d => d instanceof Date && !isNaN(d);
    let startDate, endDate;

    if (dateFrom && dateTo) {
      startDate = new Date(dateFrom);
      endDate   = new Date(new Date(dateTo).getTime() + 86400000);
    }
    if (!isValid(startDate) || !isValid(endDate)) {
      const ym = (month && /^\d{4}-\d{2}$/.test(month))
        ? month : new Date().toISOString().substring(0, 7);
      startDate = new Date(ym + '-01');
      endDate   = new Date(new Date(ym + '-01').setMonth(startDate.getMonth() + 1));
    }

    const r = extReq()
      .input('s',  sql.DateTime, startDate)
      .input('e',  sql.DateTime, endDate)
      .input('un', sql.NVarChar, username);

    const [cats, daily, timing] = await Promise.all([
      // Top categories by ProblemTypeDetail
      r.query(`SELECT ISNULL(pt.ProblemTypeDetail, 'อื่นๆ') AS category,
                      COUNT(*) AS cnt,
                      AVG(CAST(cl.Stars AS FLOAT)) AS avg_stars
               FROM Calllog cl
               INNER JOIN Users u ON u.UserId = cl.SupportId
               LEFT  JOIN ProblemType pt ON pt.ProblemTypeId = cl.ProblemTypeId
               WHERE cl.ReceiveDate >= @s AND cl.ReceiveDate < @e
                 AND u.UserName = @un
               GROUP BY pt.ProblemTypeDetail
               ORDER BY cnt DESC`),
      // Daily trend
      extReq().input('s', sql.DateTime, startDate).input('e', sql.DateTime, endDate)
        .input('un', sql.NVarChar, username)
        .query(`SELECT CAST(cl.ReceiveDate AS DATE) AS day, COUNT(*) AS cnt
                FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
                WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e AND u.UserName = @un
                GROUP BY CAST(cl.ReceiveDate AS DATE) ORDER BY day`),
      // Avg resolution time + stars
      extReq().input('s', sql.DateTime, startDate).input('e', sql.DateTime, endDate)
        .input('un', sql.NVarChar, username)
        .query(`SELECT
                  COUNT(*) AS total,
                  AVG(CASE WHEN cl.CloseDate IS NOT NULL
                       THEN DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate) END) AS avg_minutes,
                  AVG(CAST(cl.Stars AS FLOAT)) AS avg_stars,
                  COUNT(CASE WHEN cl.Stars IS NOT NULL THEN 1 END) AS rated_count
                FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
                WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e AND u.UserName = @un`)
    ]);

    res.json({
      categories:  cats.recordset,
      dailyTrend:  daily.recordset,
      summary:     timing.recordset[0] || {}
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kpi/comment', authRequired, async (request, res) => {
  try {
    const { ext_username, month, comment, recorded_by } = request.body;
    const monthDate = month + '-01';
    const existing = await req()
      .input('u', sql.NVarChar, ext_username).input('m', sql.Date, monthDate)
      .query('SELECT id FROM kpi_comments WHERE ext_username=@u AND month=@m');
    if (existing.recordset[0]) {
      await req()
        .input('cmt',   sql.NVarChar, comment)
        .input('recby', sql.Int,      recorded_by || null)
        .input('id',    sql.Int,      existing.recordset[0].id)
        .query('UPDATE kpi_comments SET comment=@cmt, recorded_by=@recby WHERE id=@id');
      res.json({ id: existing.recordset[0].id, updated: true });
    } else {
      const result = await req()
        .input('u',     sql.NVarChar, ext_username)
        .input('m',     sql.Date,     monthDate)
        .input('cmt',   sql.NVarChar, comment)
        .input('recby', sql.Int,      recorded_by || null)
        .query(`INSERT INTO kpi_comments (ext_username,month,comment,recorded_by)
                OUTPUT INSERTED.id VALUES (@u,@m,@cmt,@recby)`);
      res.json({ id: result.recordset[0].id });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/duty/live — today's shifts + per-person case counts ─────────────
app.get('/api/duty/live', authRequired, managerRequired, async (request, res) => {
  try {
    // 1. Today's shifts with employee + shift type info
    const shiftsRes = await req().query(`
      SELECT s.shift_type, e.id AS emp_id, e.name, e.team,
             st.name AS shift_name, st.start_time, st.end_time,
             st.color_bg, st.color_text, st.sort_order,
             au.ext_username
      FROM shifts s
      JOIN employees e      ON e.id = s.employee_id
      JOIN shift_types st   ON st.shift_key = s.shift_type
      LEFT JOIN app_users au ON au.employee_id = e.id AND au.active = 1
      WHERE s.shift_date = CAST(GETDATE() AS DATE)
        AND s.shift_type NOT IN ('dayoff','leave_personal','leave_sick','leave_annual')
        AND e.active = 1
      ORDER BY st.sort_order, e.name`);

    const rows = shiftsRes.recordset;
    const usernames = [...new Set(rows.map(r => r.ext_username).filter(Boolean))];

    // 2. Case counts from LicenseDB
    let caseCounts = {};
    if (getExtPool() && usernames.length) {
      const inList = usernames.map((_, i) => `@u${i}`).join(',');
      const qr = extReq();
      usernames.forEach((u, i) => qr.input(`u${i}`, sql.NVarChar, u));
      const cRes = await qr.query(`
        SELECT u.UserName,
          COUNT(CASE WHEN CAST(cl.ReceiveDate AS DATE) = CAST(GETDATE() AS DATE) THEN 1 END) AS today_cases,
          COUNT(CASE WHEN cs.StatusName NOT LIKE '%close%' AND cs.StatusName NOT LIKE '%complete%'
                          AND cs.StatusName NOT LIKE '%cancel%' THEN 1 END) AS open_cases
        FROM Calllog cl
        JOIN Users u       ON u.UserId    = cl.SupportId
        JOIN CallStatus cs ON cs.StatusId = cl.StatusId
        WHERE cl.Active = 1
          AND u.UserName IN (${inList})
          AND (CAST(cl.ReceiveDate AS DATE) = CAST(GETDATE() AS DATE)
            OR (cs.StatusName NOT LIKE '%close%' AND cs.StatusName NOT LIKE '%complete%'
                AND cs.StatusName NOT LIKE '%cancel%'))
        GROUP BY u.UserName`);
      cRes.recordset.forEach(r => { caseCounts[r.UserName] = r; });
    }

    // 3. Merge and group by shift_type
    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.shift_type]) {
        grouped[r.shift_type] = {
          shift_key: r.shift_type, shift_name: r.shift_name,
          start_time: r.start_time, end_time: r.end_time,
          color_bg: r.color_bg, color_text: r.color_text,
          sort_order: r.sort_order, members: []
        };
      }
      const cc = caseCounts[r.ext_username] || { today_cases: 0, open_cases: 0 };
      grouped[r.shift_type].members.push({
        emp_id: r.emp_id, name: r.name, team: r.team,
        today_cases: cc.today_cases || 0, open_cases: cc.open_cases || 0
      });
    }

    const shifts = Object.values(grouped).sort((a, b) => a.sort_order - b.sort_order);
    res.json({ shifts, generated_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/duty/hourly — cases per hour today (all team) ───────────────────
app.get('/api/duty/hourly', authRequired, managerRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.json([]);
    const result = await extReq().query(`
      SELECT DATEPART(HOUR, cl.ReceiveDate) AS hr, COUNT(*) AS cnt
      FROM Calllog cl
      WHERE cl.Active = 1
        AND CAST(cl.ReceiveDate AS DATE) = CAST(GETDATE() AS DATE)
      GROUP BY DATEPART(HOUR, cl.ReceiveDate)
      ORDER BY hr`);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/kpi/history', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { months = 6 } = request.query;
    const role = request.user?.role;
    let scopeClause = '';
    const r = extReq().input('months', sql.Int, parseInt(months));
    if (role === 'staff') {
      if (!request.user.ext_username) return res.json([]);
      r.input('_ku0', sql.NVarChar, request.user.ext_username);
      scopeClause = ' AND u.UserName = @_ku0';
    } else if (role === 'team_lead') {
      const rows = (await req().input('tm', sql.NVarChar, request.user.team || '')
        .query(`SELECT DISTINCT au.ext_username FROM app_users au
                JOIN employees e ON e.id=au.employee_id
                WHERE e.team=@tm AND au.active=1 AND e.active=1 AND au.ext_username IS NOT NULL`)).recordset;
      const names = rows.map(r => r.ext_username);
      if (names.length === 0) return res.json([]);
      names.forEach((u, i) => r.input(`_ku${i}`, sql.NVarChar, u));
      scopeClause = ` AND u.UserName IN (${names.map((_, i) => `@_ku${i}`).join(',')})`;
    }
    const result = await r.query(`
      SELECT
        FORMAT(cl.ReceiveDate,'yyyy-MM') AS month,
        u.UserName,
        COUNT(cl.CalllogId) AS total_cases
      FROM Calllog cl
      INNER JOIN Users u ON u.UserId = cl.SupportId
      WHERE cl.ReceiveDate >= '2026-01-01'${scopeClause}
      GROUP BY FORMAT(cl.ReceiveDate,'yyyy-MM'), u.UserName
      ORDER BY month, total_cases DESC
    `);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  DASHBOARD — Calllog (LicenseDB) + shifts/leaves (cs_team)
// ══════════════════════════════════════════════════════════
app.get('/api/dashboard', authRequired, async (_, res) => {
  try {
    const now     = new Date();
    const today   = now.toISOString().split('T')[0];
    const hour    = now.getHours(), minute = now.getMinutes();
    const timeVal = hour * 60 + minute;
    const currentShifts = [];
    if (timeVal >= 8*60+30 && timeVal <= 16*60+30)  currentShifts.push('morning');
    if (timeVal >= 15*60+30 && timeVal <= 23*60+30) currentShifts.push('afternoon');
    if (timeVal >= 16*60 || timeVal <= 0)            currentShifts.push('night');
    if (currentShifts.length === 0) currentShifts.push('morning');
    const ext = getExtPool();
    let ticketsToday = [], overdueTickets = [], ticketStats = [], kpiSummary = [];
    let dailyTrend = [], monthTotal = 0, lastMonthTotal = 0, totalYear = 0, closedThisMonth = 0;
    let todayTotal = 0, weekTotal = 0, weekStart = '';
    if (ext) {
      ticketsToday = (await extReq()
        .input('today', sql.Date, today)
        .query(`SELECT cs.StatusName AS status, COUNT(*) AS cnt
                FROM Calllog cl
                INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
                WHERE CAST(cl.ReceiveDate AS DATE)=@today
                GROUP BY cs.StatusName`)).recordset;
      todayTotal = ticketsToday.reduce((s,r) => s + r.cnt, 0);

      // This week (Mon–today)
      weekStart = getMonday(today);
      weekTotal = (await extReq()
        .input('ws', sql.Date, weekStart).input('we', sql.Date, today)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl
                WHERE CAST(cl.ReceiveDate AS DATE) BETWEEN @ws AND @we`)).recordset[0]?.cnt || 0;

      overdueTickets = (await extReq()
        .query(`SELECT TOP 20
                  cl.CalllogId AS id, cl.Subject AS title,
                  cr.CompanyName, cs.StatusName AS status,
                  u.UserName AS assigned_name, cl.ReceiveDate AS opened_at
                FROM Calllog cl
                INNER JOIN CustomerRegistration cr ON cr.RegistrationId=cl.RegistrationId
                INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
                INNER JOIN Users u ON u.UserId=cl.SupportId
                INNER JOIN Project p ON p.ProjectId=cl.ProjectId
                INNER JOIN ProblemType pt ON pt.ProblemTypeId=cl.ProblemTypeId
                WHERE cl.ReceiveDate >= '2026-01-01'
                  AND cl.ReceiveDate <= DATEADD(hour,-24,GETDATE())
                  AND cs.StatusName NOT LIKE '%close%'
                  AND cs.StatusName NOT LIKE '%ปิด%'
                  AND cs.StatusName NOT LIKE '%complete%'
                ORDER BY cl.ReceiveDate ASC`)).recordset;
      ticketStats = (await extReq()
        .query(`SELECT cs.StatusName AS status, COUNT(*) AS cnt
                FROM Calllog cl
                INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
                WHERE cl.ReceiveDate >= '2026-01-01'
                GROUP BY cs.StatusName`)).recordset;
      const ms = today.substring(0,7) + '-01';
      const me = new Date(new Date(ms).setMonth(new Date(ms).getMonth()+1));
      kpiSummary = (await extReq()
        .input('s', sql.DateTime, new Date(ms)).input('e', sql.DateTime, me)
        .query(`SELECT TOP 10 u.UserName, COUNT(cl.CalllogId) AS total_cases
                FROM Calllog cl INNER JOIN Users u ON u.UserId=cl.SupportId
                WHERE cl.ReceiveDate >= @s AND cl.ReceiveDate < @e
                GROUP BY u.UserName ORDER BY total_cases DESC`)).recordset;
      dailyTrend = (await extReq()
        .query(`SELECT CAST(cl.ReceiveDate AS DATE) AS day, COUNT(*) AS cnt
                FROM Calllog cl
                WHERE cl.ReceiveDate >= DATEADD(day,-30,GETDATE())
                GROUP BY CAST(cl.ReceiveDate AS DATE)
                ORDER BY day`)).recordset;
      const lastMonthStart = new Date(new Date(ms).setMonth(new Date(ms).getMonth()-1)).toISOString().split('T')[0].substring(0,7)+'-01';
      const lastMonthEnd   = new Date(ms);
      monthTotal = (await extReq()
        .input('ms', sql.DateTime, new Date(ms)).input('me', sql.DateTime, me)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me`)).recordset[0]?.cnt || 0;
      lastMonthTotal = (await extReq()
        .input('lms', sql.DateTime, new Date(lastMonthStart)).input('lme', sql.DateTime, lastMonthEnd)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl WHERE cl.ReceiveDate >= @lms AND cl.ReceiveDate < @lme`)).recordset[0]?.cnt || 0;
      totalYear = (await extReq()
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl WHERE cl.ReceiveDate >= '2026-01-01'`)).recordset[0]?.cnt || 0;
      closedThisMonth = (await extReq()
        .input('ms', sql.DateTime, new Date(ms)).input('me', sql.DateTime, me)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl
                INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
                WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me
                  AND (cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%ปิด%' OR cs.StatusName LIKE '%complete%')`)).recordset[0]?.cnt || 0;
    }
    const shiftIn  = currentShifts.map((_,i) => `@st${i}`).join(',');
    const shiftReq = req().input('today', sql.Date, today);
    currentShifts.forEach((s,i) => shiftReq.input(`st${i}`, sql.NVarChar, s));
    const onShift = (await shiftReq.query(`
      SELECT s.shift_type, e.name, e.team, e.role
      FROM shifts s JOIN employees e ON e.id=s.employee_id
      WHERE s.shift_date=@today AND s.shift_type IN (${shiftIn})
        AND s.status='scheduled' AND e.active=1
      ORDER BY e.team, s.shift_type`)).recordset;
    const pendingLeaves = (await req()
      .query(`SELECT lr.*, e.name AS emp_name, e.team
              FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id
              WHERE lr.status='pending' ORDER BY lr.leave_date`)).recordset;
    // Build ext_username → employee name map
    const nameMapRows = (await req().query(`
      SELECT au.ext_username, e.name
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const nameMap = {};
    nameMapRows.forEach(r => { nameMap[r.ext_username] = r.name; });

    res.json({
      ticketsToday, overdueTickets, ticketStats,
      kpiSummary, onShift, pendingLeaves,
      currentShifts, serverTime: now.toISOString(),
      extConnected: !!ext,
      dailyTrend, monthTotal, lastMonthTotal, totalYear, closedThisMonth,
      todayTotal, weekTotal, weekStart, nameMap
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  AI — Helper: ดึงข้อมูล context จาก DB
// ══════════════════════════════════════════════════════════
async function getDashboardContext() {
  const now   = new Date();
  const today = now.toISOString().split('T')[0];
  const hour  = now.getHours(), minute = now.getMinutes();
  const timeVal = hour * 60 + minute;
  const currentShifts = [];
  if (timeVal >= 8*60+30 && timeVal <= 16*60+30)  currentShifts.push('morning');
  if (timeVal >= 15*60+30 && timeVal <= 23*60+30) currentShifts.push('afternoon');
  if (timeVal >= 16*60 || timeVal <= 0)            currentShifts.push('night');
  if (currentShifts.length === 0) currentShifts.push('morning');

  const ext = getExtPool();
  let ticketsToday = [], overdueTickets = [], kpiSummary = [], monthTotal = 0;

  if (ext) {
    ticketsToday = (await extReq()
      .input('today', sql.Date, today)
      .query(`SELECT cs.StatusName AS status, COUNT(*) AS cnt
              FROM Calllog cl INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
              WHERE CAST(cl.ReceiveDate AS DATE)=@today GROUP BY cs.StatusName`)).recordset;

    overdueTickets = (await extReq()
      .query(`SELECT TOP 10 cl.CalllogId AS id, cl.Subject AS title,
                cr.CompanyName, cs.StatusName AS status,
                u.UserName AS assigned_name, cl.ReceiveDate AS opened_at
              FROM Calllog cl
              INNER JOIN CustomerRegistration cr ON cr.RegistrationId=cl.RegistrationId
              INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
              INNER JOIN Users u ON u.UserId=cl.SupportId
              WHERE cl.ReceiveDate >= '2026-01-01'
                AND cl.ReceiveDate <= DATEADD(hour,-24,GETDATE())
                AND cs.StatusName NOT LIKE '%close%'
                AND cs.StatusName NOT LIKE '%ปิด%'
                AND cs.StatusName NOT LIKE '%complete%'
              ORDER BY cl.ReceiveDate ASC`)).recordset;

    const ms = today.substring(0,7) + '-01';
    const me = new Date(new Date(ms).setMonth(new Date(ms).getMonth()+1));
    kpiSummary = (await extReq()
      .input('s', sql.DateTime, new Date(ms)).input('e', sql.DateTime, me)
      .query(`SELECT TOP 10 u.UserName, COUNT(cl.CalllogId) AS total_cases
              FROM Calllog cl INNER JOIN Users u ON u.UserId=cl.SupportId
              WHERE cl.ReceiveDate >= @s AND cl.ReceiveDate < @e
              GROUP BY u.UserName ORDER BY total_cases DESC`)).recordset;

    monthTotal = (await extReq()
      .input('ms', sql.DateTime, new Date(ms)).input('me', sql.DateTime, me)
      .query(`SELECT COUNT(*) AS cnt FROM Calllog cl
              WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me`)).recordset[0]?.cnt || 0;
  }

  const shiftIn  = currentShifts.map((_,i) => `@st${i}`).join(',');
  const shiftReq = req().input('today', sql.Date, today);
  currentShifts.forEach((s,i) => shiftReq.input(`st${i}`, sql.NVarChar, s));
  const onShift = (await shiftReq.query(`
    SELECT s.shift_type, e.name, e.team, e.role
    FROM shifts s JOIN employees e ON e.id=s.employee_id
    WHERE s.shift_date=@today AND s.shift_type IN (${shiftIn})
      AND s.status='scheduled' AND e.active=1
    ORDER BY e.team, s.shift_type`)).recordset;

  const pendingLeaves = (await req()
    .query(`SELECT lr.leave_date, e.name, e.team
            FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id
            WHERE lr.status='pending' ORDER BY lr.leave_date`)).recordset;

  return `
ข้อมูลระบบ CS Team ณ วันที่ ${today} เวลา ${now.toLocaleTimeString('th-TH')}

[กะที่กำลังทำงานอยู่]: ${currentShifts.join(', ')}
[พนักงานออนกะตอนนี้]: ${JSON.stringify(onShift)}
[Calllog วันนี้ แยกตามสถานะ]: ${JSON.stringify(ticketsToday)}
[Calllog ค้างเกิน 24h (top 10)]: ${JSON.stringify(overdueTickets)}
[KPI เดือนนี้ (top users by cases)]: ${JSON.stringify(kpiSummary)}
[Calllog เดือนนี้ทั้งหมด]: ${monthTotal} เคส
[คำขอลาที่รอ approve]: ${JSON.stringify(pendingLeaves)}
`.trim();
}

// ══════════════════════════════════════════════════════════
//  AI ENDPOINTS
// ══════════════════════════════════════════════════════════

// ── 1. AI Chat ─────────────────────────────────────────────
app.post('/api/ai/chat', authRequired, async (request, res) => {
  const { message, history = [] } = request.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const context = await getDashboardContext();
    const systemPrompt = `คุณคือผู้ช่วย AI สำหรับระบบบริหารทีม Customer Service ชื่อว่า "CS Assistant"
ตอบเป็นภาษาไทย กระชับ ชัดเจน เป็นมิตร
ข้อมูลระบบที่ใช้คือ Calllog จาก LicenseDB และข้อมูลกะจาก cs_team
ใช้ข้อมูลต่อไปนี้เพื่อตอบคำถาม:\n\n${context}`;

    const messages = [
      ...history.slice(-8),
      { role: 'user', content: message }
    ];
    const response = await claude.messages.create({
      model: AI_MODEL, max_tokens: 1024,
      system: systemPrompt, messages
    });
    res.json({ reply: response.content[0].text });
  } catch (e) {
    console.error('AI chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 2. Dashboard AI Summary ────────────────────────────────
app.get('/api/ai/dashboard-summary', authRequired, async (_, res) => {
  try {
    const context = await getDashboardContext();
    const prompt = `วิเคราะห์สถานการณ์ปัจจุบันของทีม Customer Service จากข้อมูลนี้:

${context}

กรุณาสรุปใน 3 ส่วน:
1. 🚨 ปัญหาเร่งด่วน (ถ้ามี)
2. 📊 ภาพรวมสถานการณ์
3. 💡 คำแนะนำ

ตอบเป็นภาษาไทย กระชับ อ่านง่าย ไม่เกิน 200 คำ`;

    const response = await claude.messages.create({
      model: AI_MODEL, max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ summary: response.content[0].text });
  } catch (e) {
    console.error('AI summary error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 3. AI Suggest Shifts ───────────────────────────────────
app.post('/api/ai/suggest-shifts', authRequired, async (request, res) => {
  const { week_start, team } = request.body;
  try {
    const startDate = getMonday(week_start);
    const endD = new Date(startDate); endD.setDate(endD.getDate() + 6);
    const endDate = endD.toISOString().split('T')[0];

    const empR = req();
    let empQ = 'SELECT id, name, team, role FROM employees WHERE active=1';
    if (team) { empQ += ' AND team=@team'; empR.input('team', sql.NVarChar, team); }
    const employees = (await empR.query(empQ)).recordset;

    const approvedLeaves = (await req()
      .input('s', sql.Date, startDate).input('e', sql.Date, endDate)
      .query(`SELECT lr.employee_id, lr.leave_date, e.name, e.team
              FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id
              WHERE lr.status='approved' AND lr.leave_date BETWEEN @s AND @e`)).recordset;

    const prompt = `คุณคือผู้จัดการทีม CS กรุณาวางแผนตารางกะสัปดาห์ ${startDate} ถึง ${endDate}

พนักงาน:
${JSON.stringify(employees, null, 2)}

วันลาที่อนุมัติแล้ว:
${JSON.stringify(approvedLeaves, null, 2)}

กฎการจัดกะ:
- กะ: morning (08:30-16:30), afternoon (15:30-23:30), night (23:00-07:00)
- call_center: ต้องมีอย่างน้อย 2 คน/กะ ทุกวัน, team_lead ควรอยู่กะเช้า
- helpdesk: ต้องมีอย่างน้อย 1 คน/กะ วันจันทร์-ศุกร์
- repair: morning เท่านั้น วันจันทร์-ศุกร์
- พนักงาน 1 คนทำได้ 1 กะ/วัน และไม่ควรทำติดกัน >5 วัน
- ห้ามจัดกะในวันที่ได้รับอนุมัติลา

ตอบเป็น JSON array เท่านั้น:
[{"employee_id": 1, "shift_date": "YYYY-MM-DD", "shift_type": "morning|afternoon|night"}]`;

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });
    let text = response.content[0].text.trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    res.json({ suggestions: JSON.parse(text), week_start: startDate, end_date: endDate });
  } catch (e) {
    console.error('AI shift error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 4. AI KPI Forecast ─────────────────────────────────────
app.get('/api/ai/forecast-kpi', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { months = 3 } = request.query;
    const history = (await extReq()
      .query(`SELECT FORMAT(cl.ReceiveDate,'yyyy-MM') AS month,
                     u.UserName, COUNT(cl.CalllogId) AS total_cases
              FROM Calllog cl INNER JOIN Users u ON u.UserId=cl.SupportId
              WHERE cl.ReceiveDate >= '2026-01-01'
              GROUP BY FORMAT(cl.ReceiveDate,'yyyy-MM'), u.UserName
              ORDER BY month, total_cases DESC`)).recordset;

    const prompt = `คุณคือนักวิเคราะห์ประสิทธิภาพทีม Customer Service
วิเคราะห์ข้อมูล Calllog รายเดือน:

${JSON.stringify(history, null, 2)}

กรุณาวิเคราะห์และสรุปใน 4 หัวข้อ:
1. 📈 Trend โดยรวม (ปริมาณ Calllog เพิ่มขึ้น/ลดลง?)
2. ⭐ ผู้ที่รับ Calllog สูงสุด (ระบุชื่อ+ตัวเลข)
3. ⚠️ จุดที่น่าสังเกต (ผู้ที่ load น้อยหรือมากผิดปกติ)
4. 🔮 พยากรณ์เดือนหน้า (คาดการณ์แนวโน้ม)

ตอบเป็นภาษาไทย ชัดเจน มีข้อมูลเชิงตัวเลขสนับสนุน`;

    const response = await claude.messages.create({
      model: AI_MODEL, max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ analysis: response.content[0].text });
  } catch (e) {
    console.error('AI forecast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  CUSTOMER PUBLIC LINKS
// ══════════════════════════════════════════════════════════

// Create table if not exists (run once on startup)
async function ensureCustomerLinksTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='customer_links' AND xtype='U')
      CREATE TABLE customer_links (
        id           INT PRIMARY KEY IDENTITY,
        company_name NVARCHAR(255) NOT NULL,
        token        NVARCHAR(64)  NOT NULL UNIQUE,
        created_at   DATETIME      DEFAULT GETDATE(),
        created_by   INT,
        group_id     INT NULL,
        group_name   NVARCHAR(255) NULL,
        link_type    NVARCHAR(10)  DEFAULT 'company'  -- 'company' or 'group'
      )`);
    // Add columns if table already exists but missing new columns
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('customer_links') AND name='group_id')
        ALTER TABLE customer_links ADD group_id INT NULL, group_name NVARCHAR(255) NULL, link_type NVARCHAR(10) DEFAULT 'company'`);
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ticket_complaints' AND xtype='U')
      CREATE TABLE ticket_complaints (
        id           INT PRIMARY KEY IDENTITY,
        ticket_id    INT NULL,
        company_name NVARCHAR(255),
        email        NVARCHAR(255),
        message      NVARCHAR(MAX) NOT NULL,
        status       NVARCHAR(20) DEFAULT 'pending',
        created_at   DATETIME DEFAULT GETDATE(),
        resolved_at  DATETIME,
        resolved_by  INT
      )`);
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ticket_watchers' AND xtype='U')
      CREATE TABLE ticket_watchers (
        id           INT PRIMARY KEY IDENTITY,
        company_name NVARCHAR(255) NOT NULL,
        email        NVARCHAR(255) NOT NULL,
        created_at   DATETIME DEFAULT GETDATE(),
        CONSTRAINT UQ_watcher UNIQUE (company_name, email)
      )`);
    // Fix ticket_id NOT NULL → NULL for global complaints
    try {
      await req().query(`
        IF EXISTS (SELECT 1 FROM sys.columns
                   WHERE object_id=OBJECT_ID('ticket_complaints') AND name='ticket_id'
                     AND is_nullable=0)
          ALTER TABLE ticket_complaints ALTER COLUMN ticket_id INT NULL`);
    } catch {}
  } catch(e) { console.error('customer tables error:', e.message); }
}

// Get or create public link for a company (auto-detect group)
app.post('/api/customer-links', authRequired, async (request, res) => {
  try {
    const { company_name, group_id, group_name } = request.body;

    // Direct group link creation (admin selected group explicitly)
    if (group_id) {
      const existing = await req().input('gid', sql.Int, group_id)
        .query('SELECT * FROM customer_links WHERE group_id=@gid');
      if (existing.recordset.length) return res.json({ ...existing.recordset[0], link_type: 'group' });
      const token = crypto.randomBytes(24).toString('hex');
      const result = await req()
        .input('cn',  sql.NVarChar, group_name || '')
        .input('tok', sql.NVarChar, token)
        .input('by',  sql.Int,      request.user.id || null)
        .input('gid', sql.Int,      group_id)
        .input('gn',  sql.NVarChar, group_name || '')
        .query(`INSERT INTO customer_links (company_name, token, created_by, group_id, group_name, link_type)
                OUTPUT INSERTED.*
                VALUES (@cn, @tok, @by, @gid, @gn, 'group')`);
      return res.json({ ...result.recordset[0], link_type: 'group' });
    }

    if (!company_name) return res.status(400).json({ error: 'company_name required' });

    // Auto-detect: does this company have a real GroupId (not 1)?
    let groupId = null, groupName = null, linkType = 'company';
    if (getExtPool()) {
      const grp = await extReq().input('cn', sql.NVarChar, company_name)
        .query(`SELECT TOP 1 cr.GroupId, cg.GroupName
                FROM CustomerRegistration cr
                JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
                WHERE cr.CompanyName = @cn
                  AND cr.GroupId IS NOT NULL
                  AND cr.GroupId <> 1`);
      if (grp.recordset.length) {
        groupId   = grp.recordset[0].GroupId;
        groupName = grp.recordset[0].GroupName;
        linkType  = 'group';
      }
    }

    if (linkType === 'group') {
      // Check existing group link
      const existing = await req().input('gid', sql.Int, groupId)
        .query('SELECT * FROM customer_links WHERE group_id=@gid');
      if (existing.recordset.length) return res.json({ ...existing.recordset[0], link_type: 'group' });

      const token = crypto.randomBytes(24).toString('hex');
      const result = await req()
        .input('cn',  sql.NVarChar, groupName)
        .input('tok', sql.NVarChar, token)
        .input('by',  sql.Int,      request.user.id || null)
        .input('gid', sql.Int,      groupId)
        .input('gn',  sql.NVarChar, groupName)
        .query(`INSERT INTO customer_links (company_name, token, created_by, group_id, group_name, link_type)
                OUTPUT INSERTED.*
                VALUES (@cn, @tok, @by, @gid, @gn, 'group')`);
      return res.json({ ...result.recordset[0], link_type: 'group' });
    }

    // Company-level link
    const existing = await req().input('cn', sql.NVarChar, company_name)
      .query("SELECT * FROM customer_links WHERE company_name=@cn AND (link_type='company' OR link_type IS NULL)");
    if (existing.recordset.length) return res.json({ ...existing.recordset[0], link_type: 'company' });

    const token = crypto.randomBytes(24).toString('hex');
    const result = await req()
      .input('cn',  sql.NVarChar, company_name)
      .input('tok', sql.NVarChar, token)
      .input('by',  sql.Int,      request.user.id || null)
      .query(`INSERT INTO customer_links (company_name, token, created_by, link_type)
              OUTPUT INSERTED.*
              VALUES (@cn, @tok, @by, 'company')`);
    res.json({ ...result.recordset[0], link_type: 'company' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List all customer links (for management)
app.get('/api/customer-links', authRequired, async (request, res) => {
  try {
    const result = await req().query(
      'SELECT * FROM customer_links ORDER BY created_at DESC'
    );
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete a link
app.delete('/api/customer-links/:id', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, request.params.id)
      .query('DELETE FROM customer_links WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC — get tickets by token (no auth), supports dateFrom/dateTo
app.get('/api/public/track/:token', async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'DB not available' });
    const { token } = request.params;
    const { dateFrom, dateTo } = request.query;

    const link = await req().input('tok', sql.NVarChar, token)
      .query('SELECT * FROM customer_links WHERE token=@tok');
    if (!link.recordset.length) return res.status(404).json({ error: 'Link ไม่พบหรือถูกลบแล้ว' });

    const linkRow     = link.recordset[0];
    const isGroup     = linkRow.link_type === 'group' && linkRow.group_id;
    const displayName = isGroup ? linkRow.group_name : linkRow.company_name;

    // Date range (default: last 30 days)
    const endDate   = dateTo   ? new Date(new Date(dateTo).getTime() + 86400000)
                               : new Date(new Date().getTime() + 86400000);
    const startDate = dateFrom ? new Date(dateFrom)
                               : new Date(new Date().setDate(new Date().getDate() - 29));
    const hasDates  = !!(dateFrom || dateTo);

    // Scope condition
    const scopeWhere = isGroup
      ? `AND cr.GroupId = @gid`
      : `AND cr.CompanyName LIKE @cn`;

    const mkE = () => {
      const r = extReq().input('sd', sql.DateTime, startDate).input('ed', sql.DateTime, endDate);
      if (isGroup) r.input('gid', sql.Int, linkRow.group_id);
      else         r.input('cn', sql.NVarChar, `%${linkRow.company_name}%`);
      return r;
    };

    const ticketFields = `
      SELECT cl.CalllogId AS id, cr.CompanyName,
        cl.ReceiveDate AS opened_at, cl.CloseDate,
        cs.StatusName AS status,
        cl.Subject AS title,
        pt.ProblemTypeDetail AS problem_type,
        cl.CalllogDesc AS description, cl.Solution,
        u.UserName AS agent, cl.Stars,
        CASE WHEN cl.CloseDate IS NOT NULL AND cl.ReceiveDate IS NOT NULL
             THEN DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate) END AS resolve_minutes
      FROM Calllog cl
      INNER JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
      INNER JOIN CallStatus cs ON cs.StatusId = cl.StatusId
      INNER JOIN Users u ON u.UserId = cl.SupportId
      LEFT  JOIN ProblemType pt ON pt.ProblemTypeId = cl.ProblemTypeId`;

    const dateWhere = `WHERE cl.Active=1 AND cl.ReceiveDate >= @sd AND cl.ReceiveDate < @ed ${scopeWhere}`;

    const [ticketRes, trendRes, ptRes, branchRes] = await Promise.all([
      // Tickets in date range
      mkE().query(`${ticketFields} ${dateWhere} ORDER BY cl.ReceiveDate DESC`),
      // Daily trend
      mkE().query(`SELECT CAST(cl.ReceiveDate AS DATE) AS day, COUNT(*) AS cnt
                   FROM Calllog cl INNER JOIN CustomerRegistration cr ON cr.RegistrationId=cl.RegistrationId
                   ${dateWhere} GROUP BY CAST(cl.ReceiveDate AS DATE) ORDER BY day`),
      // Problem type breakdown
      mkE().query(`SELECT ISNULL(pt.ProblemTypeDetail,'อื่นๆ') AS problem_type, COUNT(*) AS cnt
                   FROM Calllog cl INNER JOIN CustomerRegistration cr ON cr.RegistrationId=cl.RegistrationId
                   LEFT JOIN ProblemType pt ON pt.ProblemTypeId=cl.ProblemTypeId
                   ${dateWhere} GROUP BY pt.ProblemTypeDetail ORDER BY cnt DESC`),
      // Branch stats (all time for chain, filtered for date range)
      isGroup ? mkE().query(
        `SELECT cr.CompanyName,
           COUNT(cl.CalllogId) AS total,
           SUM(CASE WHEN cs.StatusName NOT LIKE '%close%' AND cs.StatusName NOT LIKE '%complete%' THEN 1 ELSE 0 END) AS open_count
         FROM CustomerRegistration cr
         LEFT JOIN Calllog cl    ON cl.RegistrationId=cr.RegistrationId AND cl.Active=1 AND cl.ReceiveDate>=@sd AND cl.ReceiveDate<@ed
         LEFT JOIN CallStatus cs ON cs.StatusId=cl.StatusId
         WHERE cr.GroupId=@gid
         GROUP BY cr.CompanyName ORDER BY total DESC`)
      : Promise.resolve({ recordset: [] })
    ]);

    const branches    = isGroup ? branchRes.recordset.map(r => r.CompanyName) : [];
    const branchStats = isGroup ? branchRes.recordset : [];

    // Complaints
    let complaints = { recordset: [] };
    if (isGroup && branches.length) {
      const r = req();
      branches.forEach((cn, i) => r.input(`cn${i}`, sql.NVarChar, cn));
      const inClause = branches.map((_, i) => `@cn${i}`).join(',');
      complaints = await r.query(
        `SELECT id, ticket_id, message, status, created_at
         FROM ticket_complaints WHERE company_name IN (${inClause}) ORDER BY created_at DESC`);
    } else if (!isGroup) {
      complaints = await req().input('cn2', sql.NVarChar, linkRow.company_name)
        .query(`SELECT id, ticket_id, message, status, created_at
                FROM ticket_complaints WHERE company_name=@cn2 ORDER BY created_at DESC`);
    }

    res.json({
      company:     displayName,
      isGroup,
      groupId:     linkRow.group_id || null,
      branches,
      branchStats,
      tickets:     ticketRes.recordset,
      trendData:   trendRes.recordset,
      problemTypes: ptRes.recordset,
      complaints:  complaints.recordset,
      dateFrom:    startDate.toISOString().split('T')[0],
      dateTo:      new Date(endDate.getTime() - 86400000).toISOString().split('T')[0],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC — submit complaint (no auth)
app.post('/api/public/complaint', async (request, res) => {
  try {
    const { token, ticket_id, email, message } = request.body;
    if (!token || !message) return res.status(400).json({ error: 'token และ message จำเป็น' });
    const link = await req().input('tok', sql.NVarChar, token)
      .query('SELECT company_name FROM customer_links WHERE token=@tok');
    if (!link.recordset.length) return res.status(404).json({ error: 'link ไม่พบ' });
    const company_name = link.recordset[0].company_name;
    await req()
      .input('tid', sql.Int,      ticket_id || null)
      .input('cn',  sql.NVarChar, company_name)
      .input('em',  sql.NVarChar, email || null)
      .input('msg', sql.NVarChar, message)
      .query(`INSERT INTO ticket_complaints (ticket_id, company_name, email, message)
              VALUES (@tid, @cn, @em, @msg)`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC — submit complaint direct (no token, no auth)
app.post('/api/public/complaint/direct', async (request, res) => {
  try {
    const { company_name, email, message } = request.body;
    if (!company_name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อร้าน / บริษัท' });
    if (!message?.trim())      return res.status(400).json({ error: 'กรุณาระบุข้อความร้องเรียน' });
    await req()
      .input('cn',  sql.NVarChar, company_name.trim())
      .input('em',  sql.NVarChar, email || null)
      .input('msg', sql.NVarChar, message.trim())
      .query(`INSERT INTO ticket_complaints (company_name, email, message)
              VALUES (@cn, @em, @msg)`);
    await sendLineNotify(`\n📣 [ร้องเรียนใหม่] ${company_name.trim()}\n"${message.trim().substring(0,100)}${message.trim().length>100?'…':''}"`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC — subscribe watcher (no auth)
app.post('/api/public/watch', async (request, res) => {
  try {
    const { token, email } = request.body;
    if (!token || !email) return res.status(400).json({ error: 'token และ email จำเป็น' });
    const link = await req().input('tok', sql.NVarChar, token)
      .query('SELECT company_name FROM customer_links WHERE token=@tok');
    if (!link.recordset.length) return res.status(404).json({ error: 'link ไม่พบ' });
    const company_name = link.recordset[0].company_name;
    // Upsert
    await req().input('cn', sql.NVarChar, company_name).input('em', sql.NVarChar, email)
      .query(`IF NOT EXISTS (SELECT 1 FROM ticket_watchers WHERE company_name=@cn AND email=@em)
              INSERT INTO ticket_watchers (company_name, email) VALUES (@cn, @em)`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// INTERNAL — get complaints for CS team
app.get('/api/complaints', authRequired, async (request, res) => {
  try {
    const result = await req().query(`
      SELECT tc.*, au.name AS resolved_by_name
      FROM ticket_complaints tc
      LEFT JOIN employees au ON au.id = tc.resolved_by
      ORDER BY tc.created_at DESC`);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// INTERNAL — delete complaint (with reason)
app.delete('/api/complaints/:id', authRequired, async (request, res) => {
  try {
    const id     = parseInt(request.params.id);
    const reason = (request.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุหมายเหตุการลบ' });

    const row = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM ticket_complaints WHERE id=@id')).recordset[0];
    if (!row) return res.status(404).json({ error: 'ไม่พบข้อมูล' });

    // Ensure audit log table exists
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='complaint_delete_log')
      CREATE TABLE complaint_delete_log (
        id           INT IDENTITY PRIMARY KEY,
        complaint_id INT,
        company_name NVARCHAR(255),
        message      NVARCHAR(MAX),
        reason       NVARCHAR(MAX),
        deleted_by   INT,
        deleted_at   DATETIME DEFAULT GETDATE()
      )`);

    await req()
      .input('cid', sql.Int,      id)
      .input('cn',  sql.NVarChar, row.company_name)
      .input('msg', sql.NVarChar, row.message)
      .input('rsn', sql.NVarChar, reason)
      .input('by',  sql.Int,      request.user.id || null)
      .query(`INSERT INTO complaint_delete_log (complaint_id,company_name,message,reason,deleted_by)
              VALUES (@cid,@cn,@msg,@rsn,@by)`);

    await req().input('id', sql.Int, id)
      .query('DELETE FROM ticket_complaints WHERE id=@id');

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// INTERNAL — resolve complaint
app.put('/api/complaints/:id/resolve', authRequired, async (request, res) => {
  try {
    await req()
      .input('id', sql.Int, request.params.id)
      .input('by', sql.Int, request.user.employee_id || null)
      .query(`UPDATE ticket_complaints
              SET status='resolved', resolved_at=GETDATE(), resolved_by=@by
              WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  REPAIR JOBS
// ══════════════════════════════════════════════════════════

// Generate job number RJ-YYYYMM-XXXX
async function genJobNo() {
  const ym = new Date().toISOString().substring(0,7).replace('-','');
  const row = await req()
    .query(`SELECT COUNT(*)+1 AS n FROM repair_jobs
            WHERE job_no LIKE 'RJ-${ym}-%'`);
  const seq = String(row.recordset[0].n).padStart(4,'0');
  return `RJ-${ym}-${seq}`;
}

// Count unread customer messages (for badge)
app.get('/api/repair/unread-messages', authRequired, async (request, res) => {
  try {
    // "Needs action" = has customer_message with NO admin_reply after it
    const result = await req().query(`
      SELECT rt.repair_id, rj.job_no, rj.company_name,
             COUNT(*) AS msg_count,
             MAX(rt.changed_at) AS last_msg
      FROM repair_timeline rt
      JOIN repair_jobs rj ON rj.id = rt.repair_id
      WHERE rt.field_changed = 'customer_message'
        AND NOT EXISTS (
          SELECT 1 FROM repair_timeline rt2
          WHERE rt2.repair_id = rt.repair_id
            AND rt2.field_changed = 'admin_reply'
            AND rt2.changed_at > rt.changed_at
        )
      GROUP BY rt.repair_id, rj.job_no, rj.company_name
      ORDER BY last_msg DESC`);

    // Also include pending complaints count
    const complaints = await req().query(
      `SELECT COUNT(*) AS cnt FROM ticket_complaints WHERE status='pending'`);

    res.json({
      repairs:    result.recordset,
      repairCount: result.recordset.reduce((s,r)=>s+r.msg_count,0),
      complaintCount: complaints.recordset[0]?.cnt || 0
    });
  } catch(e) { res.json({ repairs:[], repairCount:0, complaintCount:0 }); }
});

// Mark all messages for a repair job as read
app.post('/api/repair/:id/read-messages', authRequired, async (request, res) => {
  try {
    // Auto-add columns if missing
    for (const col of ['read_at','replied_at']) {
      try {
        await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('repair_timeline') AND name='${col}')
          ALTER TABLE repair_timeline ADD ${col} DATETIME NULL`);
      } catch {}
    }
    await req().input('id', sql.Int, request.params.id)
      .query(`UPDATE repair_timeline SET read_at=GETDATE()
              WHERE repair_id=@id AND field_changed='customer_message' AND read_at IS NULL`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reply to a customer message (admin)
app.post('/api/repair/:id/reply', authRequired, async (request, res) => {
  try {
    const repairId = parseInt(request.params.id);
    const { message, timeline_id } = request.body;
    if (!message?.trim()) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });

    const job = (await req().input('id', sql.Int, repairId)
      .query('SELECT job_no, company_name FROM repair_jobs WHERE id=@id')).recordset[0];
    if (!job) return res.status(404).json({ error: 'not found' });

    const sender = request.user.name || request.user.username;

    // Save reply as admin_reply in timeline
    await req()
      .input('rid', sql.Int,      repairId)
      .input('msg', sql.NVarChar, message.trim())
      .input('nt',  sql.NVarChar, sender)
      .input('by',  sql.Int,      request.user.id || null)
      .query(`INSERT INTO repair_timeline (repair_id, field_changed, new_value, note, changed_by)
              VALUES (@rid, 'admin_reply', @msg, @nt, @by)`);

    // Touch updated_at so customer polling detects new messages
    await req().input('rid', sql.Int, repairId)
      .query(`UPDATE repair_jobs SET updated_at=GETDATE() WHERE id=@rid`);

    // Mark specific message as replied
    if (timeline_id) {
      await req().input('tid', sql.Int, timeline_id)
        .query(`UPDATE repair_timeline SET replied_at=GETDATE() WHERE id=@tid`);
    }

    // Notify Line
    await sendLineNotify(`\n↩️ [${job.job_no}] ${job.company_name}\nAdmin ตอบ: ${sender}\n"${message.trim()}"`);

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Generate / get public token for a repair job
app.post('/api/repair/:id/token', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    // Get existing token first
    const existing = (await req().input('id', sql.Int, id)
      .query('SELECT public_token FROM repair_jobs WHERE id=@id')).recordset[0];
    if (!existing) return res.status(404).json({ error: 'not found' });
    if (existing.public_token) return res.json({ token: existing.public_token });
    // Generate new
    const tok = crypto.randomBytes(18).toString('hex');
    await req().input('id', sql.Int, id).input('tok', sql.NVarChar, tok)
      .query('UPDATE repair_jobs SET public_token=@tok WHERE id=@id');
    res.json({ token: tok });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC repair tracking — no auth required
app.get('/api/public/repair/:token', async (request, res) => {
  try {
    const { token } = request.params;
    const job = (await req().input('tok', sql.NVarChar, token)
      .query(`SELECT rj.*, e.name AS reporter_name
              FROM repair_jobs rj
              LEFT JOIN app_users au ON au.id = rj.reported_by
              LEFT JOIN employees e  ON e.id  = au.employee_id
              WHERE rj.public_token = @tok`)).recordset[0];
    if (!job) return res.status(404).json({ error: 'ไม่พบงานซ่อม หรือ link ไม่ถูกต้อง' });

    const timeline = (await req().input('id', sql.Int, job.id)
      .query(`SELECT rt.field_changed, rt.new_value, rt.note, rt.changed_at
              FROM repair_timeline rt
              WHERE rt.repair_id = @id
                AND rt.field_changed IN ('status','customer_message','admin_reply')
              ORDER BY rt.changed_at ASC`)).recordset;

    // Only expose non-sensitive fields to public
    res.json({
      job_no:        job.job_no,
      company_name:  job.company_name,
      device_type:   job.device_type,
      device_model:  job.device_model,
      serial_no:     job.serial_no,
      status:        job.status,
      reported_at:   job.reported_at,
      received_date: job.received_date,
      sent_supplier_date:          job.sent_supplier_date,
      returned_from_supplier_date: job.returned_from_supplier_date,
      returned_to_customer_date:   job.returned_to_customer_date,
      updated_at:    job.updated_at,
      timeline
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC — search customers from LicenseDB (no auth)
app.get('/api/public/license-search', async (request, res) => {
  try {
    if (!getExtPool()) return res.json([]);
    const q = (request.query.q || '').trim();
    const result = await extReq()
      .input('q', sql.NVarChar, `%${q}%`)
      .query(`
        SELECT TOP 50
          r.CompanyName,
          p.ProductName,
          lt.LicenseTypeName,
          cg.GroupName
        FROM CustomerRegistration r
        LEFT JOIN Product p       ON r.ProductId      = p.ProductId
        LEFT JOIN LicenseType lt  ON r.LicenseTypeId  = lt.LicenseTypeId
        LEFT JOIN CustomerGroup cg ON r.GroupId        = cg.GroupId
        WHERE (r.Hide != 1 OR r.Hide IS NULL)
          AND r.CompanyName LIKE @q
        ORDER BY r.InsertDate DESC
      `);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC — get link info + branch list for repair submit form (no auth)
app.get('/api/public/repair-link-info/:token', async (request, res) => {
  try {
    const link = (await req().input('tok', sql.NVarChar, request.params.token)
      .query('SELECT * FROM customer_links WHERE token=@tok')).recordset[0];
    if (!link) return res.status(404).json({ error: 'Link ไม่พบหรือถูกลบแล้ว' });

    const isGroup = link.link_type === 'group' && link.group_id;
    let branches = [];
    if (isGroup && getExtPool()) {
      const br = await extReq().input('gid', sql.Int, link.group_id)
        .query(`SELECT cr.RegistrationId, cr.CompanyName, cr.ContactName, cr.Phone, cr.MobilePhone,
                       p.ProductName, lt.LicenseTypeName
                FROM CustomerRegistration cr
                LEFT JOIN Product      p  ON p.ProductId      = cr.ProductId
                LEFT JOIN LicenseType  lt ON lt.LicenseTypeId = cr.LicenseTypeId
                WHERE cr.GroupId=@gid
                  AND (cr.Hide != 1 OR cr.Hide IS NULL)
                ORDER BY cr.CompanyName`);
      branches = br.recordset.map(r => ({
        name:            r.CompanyName,
        id:              r.RegistrationId,
        contact_name:    r.ContactName,
        phone:           r.Phone || r.MobilePhone,
        product_name:    r.ProductName,
        license_type:    r.LicenseTypeName
      }));
    }
    res.json({
      type:         isGroup ? 'group' : 'company',
      company_name: link.company_name,
      group_name:   link.group_name || link.company_name,
      branches
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all repair jobs for a customer link token (no auth)
app.get('/api/public/repairs-by-token/:token', async (request, res) => {
  try {
    const { token } = request.params;
    const link = (await req().input('tok', sql.NVarChar, token)
      .query('SELECT * FROM customer_links WHERE token=@tok')).recordset[0];
    if (!link) return res.status(404).json({ error: 'Link ไม่พบ' });

    const isGroup     = link.link_type === 'group' && link.group_id;
    const companyName = link.company_name;

    let jobs;
    if (isGroup) {
      // Get all company names in this group from LicenseDB
      if (!getExtPool()) return res.json([]);
      const brRes = await extReq().input('gid', sql.Int, link.group_id)
        .query(`SELECT DISTINCT cr.CompanyName FROM CustomerRegistration cr WHERE cr.GroupId=@gid`);
      const names = brRes.recordset.map(r => r.CompanyName);
      if (!names.length) return res.json([]);
      const r = req();
      names.forEach((cn, i) => r.input(`cn${i}`, sql.NVarChar, cn));
      const inClause = names.map((_, i) => `@cn${i}`).join(',');
      jobs = await r.query(
        `SELECT id, job_no, company_name, device_type, device_model, serial_no,
                symptom, remark,
                status, finance_status, reported_at, received_date,
                sent_supplier_date, returned_from_supplier_date,
                returned_to_customer_date, public_token, updated_at,
                CASE WHEN EXISTS (
                  SELECT 1 FROM repair_timeline cm
                  WHERE cm.repair_id = repair_jobs.id AND cm.field_changed='customer_message'
                    AND NOT EXISTS (
                      SELECT 1 FROM repair_timeline ar
                      WHERE ar.repair_id = repair_jobs.id AND ar.field_changed='admin_reply'
                        AND ar.changed_at > cm.changed_at
                    )
                ) THEN 1 ELSE 0 END AS pending_reply
         FROM repair_jobs WHERE company_name IN (${inClause})
         ORDER BY reported_at DESC`);
    } else {
      jobs = await req().input('cn', sql.NVarChar, companyName)
        .query(`SELECT id, job_no, company_name, device_type, device_model, serial_no,
                       symptom, remark,
                       status, finance_status, reported_at, received_date,
                       sent_supplier_date, returned_from_supplier_date,
                       returned_to_customer_date, public_token, updated_at,
                       CASE WHEN EXISTS (
                         SELECT 1 FROM repair_timeline cm
                         WHERE cm.repair_id = repair_jobs.id AND cm.field_changed='customer_message'
                           AND NOT EXISTS (
                             SELECT 1 FROM repair_timeline ar
                             WHERE ar.repair_id = repair_jobs.id AND ar.field_changed='admin_reply'
                               AND ar.changed_at > cm.changed_at
                           )
                       ) THEN 1 ELSE 0 END AS pending_reply
                FROM repair_jobs WHERE company_name=@cn
                ORDER BY reported_at DESC`);
    }
    res.json(jobs.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Customer message from tracking page (no auth)
// PUBLIC — Customer submits new repair request (no auth, supports file upload)
const publicUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, 'tmp');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext  = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9ก-๙_-]/g, '_');
      cb(null, `${Date.now()}_${base}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()));
  }
});

app.post('/api/public/repair/submit', publicUpload.array('attachments', 5), async (request, res) => {
  try {
    const b = request.body;
    if (!b.company_name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อร้าน/สาขา' });
    if (!b.symptom?.trim())      return res.status(400).json({ error: 'กรุณาระบุอาการ' });
    if (!b.contact_name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อผู้แจ้ง' });
    if (!b.contact_phone?.trim())return res.status(400).json({ error: 'กรุณาระบุเบอร์ติดต่อ' });

    const jobNo = await genJobNo();
    const token = crypto.randomBytes(18).toString('hex');
    const reportedAt = b.reported_date ? new Date(b.reported_date) : new Date();

    // Resolve group_name from source token
    let groupName = null;
    if (b.source_token) {
      const lk = (await req().input('tk', sql.NVarChar, b.source_token)
        .query(`SELECT group_name, company_name, link_type FROM customer_links WHERE token=@tk`)).recordset[0];
      if (lk) groupName = lk.link_type === 'group' ? lk.group_name : lk.company_name;
    }

    const result = await req()
      .input('jn',  sql.NVarChar, jobNo)
      .input('cn',  sql.NVarChar, b.company_name.trim())
      .input('gn',  sql.NVarChar, groupName)
      .input('dt',  sql.NVarChar, b.device_type    || null)
      .input('dm',  sql.NVarChar, b.device_model   || null)
      .input('sn',  sql.NVarChar, b.serial_no      || null)
      .input('sy',  sql.NVarChar, b.symptom.trim())
      .input('dl',  sql.NVarChar, b.device_location|| null)
      .input('ct',  sql.NVarChar, b.contact_name.trim())
      .input('cp',  sql.NVarChar, b.contact_phone.trim())
      .input('ra',  sql.DateTime, reportedAt)
      .input('pt',  sql.NVarChar, token)
      .query(`INSERT INTO repair_jobs
        (job_no,company_name,group_name,device_type,device_model,serial_no,symptom,
         device_location,contact_name,contact_phone,reported_at,public_token,status)
        OUTPUT INSERTED.id, INSERTED.job_no, INSERTED.public_token
        VALUES (@jn,@cn,@gn,@dt,@dm,@sn,@sy,@dl,@ct,@cp,@ra,@pt,'received')`);

    const newId    = result.recordset[0].id;
    const newJob   = result.recordset[0].job_no;
    const newToken = result.recordset[0].public_token;

    // Move uploaded files from tmp → job folder and save to repair_attachments
    if (request.files?.length) {
      const jobDir = path.join(UPLOAD_DIR, String(newId));
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
      for (const file of request.files) {
        const newPath = path.join(jobDir, file.filename);
        fs.renameSync(file.path, newPath);
        const relPath = `/uploads/${newId}/${file.filename}`;
        const ftype = /pdf/.test(path.extname(file.originalname).toLowerCase()) ? 'pdf' : 'image';
        await req()
          .input('rid',  sql.Int,      newId)
          .input('ft',   sql.NVarChar, ftype)
          .input('fn',   sql.NVarChar, file.originalname)
          .input('fp',   sql.NVarChar, relPath)
          .input('fs',   sql.Int,      file.size)
          .query(`INSERT INTO repair_attachments (repair_id,file_type,file_name,file_path,file_size)
                  VALUES (@rid,@ft,@fn,@fp,@fs)`);
      }
    }

    await req().input('rid', sql.Int, newId)
      .query(`INSERT INTO repair_timeline (repair_id,field_changed,new_value,note)
              VALUES (@rid,'status','received','ลูกค้าแจ้งซ่อมผ่านระบบออนไลน์')`);

    const fileNote = request.files?.length ? ` (แนบรูป ${request.files.length} ไฟล์)` : '';
    await sendLineNotify(`\n🔧 [แจ้งซ่อมใหม่] ${b.company_name}\nJob: ${newJob}\nอุปกรณ์: ${b.device_type||'—'} ${b.device_model||''}\nS/N: ${b.serial_no||'—'}\nอาการ: ${b.symptom}\nผู้แจ้ง: ${b.contact_name} ${b.contact_phone}${fileNote}`);

    res.json({ id: newId, job_no: newJob, token: newToken });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/public/repair/:token/message', async (request, res) => {
  try {
    const { token } = request.params;
    const { name, message } = request.body;
    if (!message?.trim()) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });
    const job = (await req().input('tok', sql.NVarChar, token)
      .query('SELECT id, job_no, company_name FROM repair_jobs WHERE public_token=@tok')).recordset[0];
    if (!job) return res.status(404).json({ error: 'ไม่พบงานซ่อม' });
    await req()
      .input('rid', sql.Int,      job.id)
      .input('fc',  sql.NVarChar, 'customer_message')
      .input('nv',  sql.NVarChar, message.trim())
      .input('nt',  sql.NVarChar, name?.trim() || 'ลูกค้า')
      .query(`INSERT INTO repair_timeline (repair_id, field_changed, new_value, note)
              VALUES (@rid, @fc, @nv, @nt)`);
    // Notify Line
    const displayName = name?.trim() || 'ลูกค้า';
    await sendLineNotify(`\n💬 [${job.job_no}] ${job.company_name}\nข้อความจาก: ${displayName}\n"${message.trim()}"`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Search S/N from INFO_BKK — must be BEFORE /api/repair/:id
app.get('/api/repair/search-sn', authRequired, async (request, res) => {
  try {
    if (!getInfoPool()) return res.status(503).json({ error: 'INFO_BKK DB ไม่ได้เชื่อมต่อ' });
    const { q } = request.query;
    if (!q || q.length < 2) return res.json([]);
    const today = new Date();
    const result = await getInfoPool().request()
      .input('q', sql.NVarChar, `%${q}%`)
      .query(`
        SELECT TOP 10
          ic.CategoryName,
          i.ItemDesc         AS device_model,
          si.ItemDesc        AS serial_no,
          si.InsertDate,
          si.ItemId,
          s.SupplierName,
          DATEADD(year, 1, si.InsertDate) AS warranty_expire
        FROM SaleItem si
        INNER JOIN Items        i  ON i.ItemId      = si.ItemId
        LEFT  JOIN SupplierXRef sx ON sx.ItemId     = si.ItemId AND sx.IsDefault = 1
        LEFT  JOIN Supplier     s  ON s.SupplierId  = sx.SupplierId
        INNER JOIN ItemCategory ic ON ic.CategoryId = i.CategoryId
        WHERE si.ItemDesc LIKE @q
        ORDER BY si.InsertDate DESC`);

    // Calculate warranty status
    const rows = result.recordset.map(r => ({
      ...r,
      under_warranty: r.warranty_expire && new Date(r.warranty_expire) > today
    }));
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Search shop from LicenseDB — must be BEFORE /api/repair/:id
app.get('/api/repair/search-shop', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.json([]);
    const { q } = request.query;
    if (!q || q.length < 2) return res.json([]);
    const result = await extReq().input('q', sql.NVarChar, `%${q}%`)
      .query(`SELECT TOP 20
                r.RegistrationId, r.CompanyName, r.Phone, r.MobilePhone,
                r.Email, r.ContactName, r.GroupId,
                p.ProductName,
                lt.LicenseTypeName,
                cg.GroupName
              FROM CustomerRegistration r
              LEFT JOIN Product       p  ON p.ProductId      = r.ProductId
              LEFT JOIN LicenseType   lt ON lt.LicenseTypeId = r.LicenseTypeId
              LEFT JOIN CustomerGroup cg ON cg.GroupId       = r.GroupId
              WHERE (r.Hide=0 OR r.Hide IS NULL)
                AND r.CompanyName LIKE @q
              ORDER BY r.CompanyName`);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List repair jobs
app.get('/api/repair', authRequired, async (request, res) => {
  try {
    const { status, finance_status, group_name, dateFrom, dateTo, search } = request.query;
    let q = `SELECT rj.*, e.name AS reporter_name, e2.name AS updater_name
             FROM repair_jobs rj
             LEFT JOIN app_users au  ON au.id = rj.reported_by
             LEFT JOIN employees e   ON e.id  = au.employee_id
             LEFT JOIN app_users au2 ON au2.id = rj.updated_by
             LEFT JOIN employees e2  ON e2.id  = au2.employee_id
             WHERE 1=1`;
    const r = req();
    if (status)         { q += ' AND rj.status=@st';             r.input('st', sql.NVarChar, status); }
    if (finance_status) { q += ' AND rj.finance_status=@fs';     r.input('fs', sql.NVarChar, finance_status); }
    if (group_name)     { q += ' AND rj.group_name=@gn';         r.input('gn', sql.NVarChar, group_name); }
    if (dateFrom)       { q += ' AND rj.reported_at>=@df';       r.input('df', sql.DateTime, new Date(dateFrom)); }
    if (dateTo)         { q += ' AND rj.reported_at<@dt';        r.input('dt', sql.DateTime, new Date(new Date(dateTo).getTime()+86400000)); }
    if (search)         { q += ' AND (rj.job_no LIKE @s OR rj.company_name LIKE @s OR rj.serial_no LIKE @s OR rj.contact_name LIKE @s OR rj.group_name LIKE @s)';
                                                                  r.input('s', sql.NVarChar, `%${search}%`); }
    q += ' ORDER BY rj.reported_at DESC';
    res.json((await r.query(q)).recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// New repair jobs since last seen ID (for notification polling)
app.get('/api/repair/new-since', authRequired, async (request, res) => {
  try {
    const since = parseInt(request.query.id) || 0;
    const rows = (await req().input('id', sql.Int, since)
      .query(`SELECT id, job_no, company_name, group_name, reported_at
              FROM repair_jobs WHERE id > @id ORDER BY id DESC`)).recordset;
    res.json({ count: rows.length, jobs: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Distinct group names for filter dropdown
app.get('/api/repair/groups', authRequired, async (request, res) => {
  try {
    const rows = (await req().query(
      `SELECT DISTINCT group_name FROM repair_jobs WHERE group_name IS NOT NULL AND group_name <> '' ORDER BY group_name`
    )).recordset;
    res.json(rows.map(r => r.group_name));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get single repair job + attachments + timeline
app.get('/api/repair/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const [job, attachments, timeline] = await Promise.all([
      req().input('id', sql.Int, id)
        .query(`SELECT rj.*, e.name AS reporter_name, e2.name AS updater_name
                FROM repair_jobs rj
                LEFT JOIN app_users au  ON au.id = rj.reported_by
                LEFT JOIN employees e   ON e.id  = au.employee_id
                LEFT JOIN app_users au2 ON au2.id = rj.updated_by
                LEFT JOIN employees e2  ON e2.id  = au2.employee_id
                WHERE rj.id=@id`),
      req().input('id', sql.Int, id)
        .query('SELECT * FROM repair_attachments WHERE repair_id=@id ORDER BY uploaded_at'),
      req().input('id', sql.Int, id)
        .query(`SELECT rt.id, rt.field_changed, rt.old_value, rt.new_value,
                       rt.note, rt.changed_at, rt.read_at, rt.replied_at,
                       e.name AS changed_by_name
                FROM repair_timeline rt
                LEFT JOIN app_users au ON au.id = rt.changed_by
                LEFT JOIN employees e  ON e.id  = au.employee_id
                WHERE rt.repair_id=@id ORDER BY rt.changed_at ASC`)
    ]);
    if (!job.recordset[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ...job.recordset[0], attachments: attachments.recordset, timeline: timeline.recordset });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create repair job
app.post('/api/repair', authRequired, async (request, res) => {
  try {
    const b = request.body;
    const jobNo = await genJobNo();
    const result = await req()
      .input('jn',  sql.NVarChar, jobNo)
      .input('dt',  sql.NVarChar, b.device_type    || null)
      .input('dm',  sql.NVarChar, b.device_model   || null)
      .input('vn',  sql.NVarChar, b.vendor         || null)
      .input('rid', sql.Int,      b.registration_id|| null)
      .input('cn',  sql.NVarChar, b.company_name   || null)
      .input('sn',  sql.NVarChar, b.serial_no      || null)
      .input('sy',  sql.NVarChar, b.symptom        || null)
      .input('if',  sql.NVarChar, b.initial_fix    || null)
      .input('ct',  sql.NVarChar, b.contact_name   || null)
      .input('cp',  sql.NVarChar, b.contact_phone  || null)
      .input('li',  sql.NVarChar, b.line_id        || null)
      .input('wa',  sql.Bit,      b.warranty ? 1 : 0)
      .input('we',  sql.Date,     b.warranty_expire|| null)
      .input('dl',  sql.NVarChar, b.device_location|| null)
      .input('by',  sql.Int,      request.user.id  || null)
      .input('pt',  sql.NVarChar, crypto.randomBytes(18).toString('hex'))
      .query(`INSERT INTO repair_jobs
        (job_no,device_type,device_model,vendor,registration_id,company_name,
         serial_no,symptom,initial_fix,contact_name,contact_phone,line_id,
         warranty,warranty_expire,device_location,reported_by,public_token)
        OUTPUT INSERTED.id, INSERTED.job_no, INSERTED.public_token
        VALUES (@jn,@dt,@dm,@vn,@rid,@cn,@sn,@sy,@if,@ct,@cp,@li,@wa,@we,@dl,@by,@pt)`);
    const newId    = result.recordset[0].id;
    const newJob   = result.recordset[0].job_no;
    const newToken = result.recordset[0].public_token;
    // Timeline
    await req().input('rid', sql.Int, newId).input('by', sql.Int, request.user.id||null)
      .input('nv', sql.NVarChar, 'received')
      .query(`INSERT INTO repair_timeline (repair_id,field_changed,new_value,changed_by,note)
              VALUES (@rid,'status',@nv,@by,'สร้างงานใหม่')`);
    // Line notify
    const uname = request.user.name || request.user.username;
    await notifyRepairStatus(newId, newJob, b.company_name||'—', 'received', uname);
    res.json({ id: newId, job_no: newJob, public_token: newToken });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update repair job (admin)
app.put('/api/repair/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b  = request.body;
    // Get current for timeline diff
    const cur = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM repair_jobs WHERE id=@id')).recordset[0];
    if (!cur) return res.status(404).json({ error: 'not found' });

    await req()
      .input('id',  sql.Int,      id)
      .input('st',  sql.NVarChar, b.status                       ?? cur.status)
      .input('fs',  sql.NVarChar, b.finance_status               ?? cur.finance_status)
      .input('qd',  sql.Date,     b.quote_date                   ?? cur.quote_date)
      .input('qn',  sql.NVarChar, b.quote_no                     ?? cur.quote_no)
      .input('rd',  sql.Date,     b.received_date                ?? cur.received_date)
      .input('sd',  sql.Date,     b.sent_supplier_date           ?? cur.sent_supplier_date)
      .input('rfd', sql.Date,     b.returned_from_supplier_date  ?? cur.returned_from_supplier_date)
      .input('rtd', sql.Date,     b.returned_to_customer_date    ?? cur.returned_to_customer_date)
      .input('ss',  sql.NVarChar, b.spare_serial_no              ?? cur.spare_serial_no)
      .input('tb',  sql.NVarChar, b.taken_back_items             ?? cur.taken_back_items)
      .input('rm',  sql.NVarChar, b.remark                       ?? cur.remark)
      .input('ub',  sql.Int,      request.user.id                || null)
      .query(`UPDATE repair_jobs SET
        status=@st, finance_status=@fs, quote_date=@qd, quote_no=@qn,
        received_date=@rd, sent_supplier_date=@sd,
        returned_from_supplier_date=@rfd, returned_to_customer_date=@rtd,
        spare_serial_no=@ss, taken_back_items=@tb, remark=@rm,
        updated_at=GETDATE(), updated_by=@ub WHERE id=@id`);

    // Log timeline for status/finance changes
    const changerName = request.user.name || request.user.username;
    for (const [field, oldVal, newVal] of [
      ['status',         cur.status,         b.status],
      ['finance_status', cur.finance_status, b.finance_status]
    ]) {
      if (newVal && newVal !== oldVal) {
        await req()
          .input('rid', sql.Int,      id)
          .input('fc',  sql.NVarChar, field)
          .input('ov',  sql.NVarChar, oldVal || '')
          .input('nv',  sql.NVarChar, newVal)
          .input('by',  sql.Int,      request.user.id || null)
          .input('nt',  sql.NVarChar, b.remark || null)
          .query(`INSERT INTO repair_timeline (repair_id,field_changed,old_value,new_value,changed_by,note)
                  VALUES (@rid,@fc,@ov,@nv,@by,@nt)`);
        if (field === 'status') {
          await notifyRepairStatus(id, cur.job_no, cur.company_name, newVal, changerName);
        }
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Upload attachment
app.post('/api/repair/:repairId/attachments', authRequired,
  upload.single('file'), async (request, res) => {
  try {
    const repairId = parseInt(request.params.repairId);
    const { file_type } = request.body;
    if (!request.file) return res.status(400).json({ error: 'No file uploaded' });
    const relPath = `/uploads/${repairId}/${request.file.filename}`;
    const result = await req()
      .input('rid',  sql.Int,      repairId)
      .input('ft',   sql.NVarChar, file_type || 'other')
      .input('fn',   sql.NVarChar, request.file.originalname)
      .input('fp',   sql.NVarChar, relPath)
      .input('fs',   sql.Int,      request.file.size)
      .input('by',   sql.Int,      request.user.id || null)
      .query(`INSERT INTO repair_attachments (repair_id,file_type,file_name,file_path,file_size,uploaded_by)
              OUTPUT INSERTED.* VALUES (@rid,@ft,@fn,@fp,@fs,@by)`);
    res.json(result.recordset[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit base info (reported fields — device, contact, symptom etc.)
app.put('/api/repair/:id/info', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b  = request.body;
    await req()
      .input('id',  sql.Int,      id)
      .input('dt',  sql.NVarChar, b.device_type     || null)
      .input('dm',  sql.NVarChar, b.device_model    || null)
      .input('vn',  sql.NVarChar, b.vendor          || null)
      .input('cn',  sql.NVarChar, b.company_name    || null)
      .input('sn',  sql.NVarChar, b.serial_no       || null)
      .input('sy',  sql.NVarChar, b.symptom         || null)
      .input('ifix',sql.NVarChar, b.initial_fix     || null)
      .input('ct',  sql.NVarChar, b.contact_name    || null)
      .input('cp',  sql.NVarChar, b.contact_phone   || null)
      .input('li',  sql.NVarChar, b.line_id         || null)
      .input('wa',  sql.Bit,      b.warranty ? 1 : 0)
      .input('we',  sql.Date,     b.warranty_expire || null)
      .input('dl',  sql.NVarChar, b.device_location || null)
      .input('ub',  sql.Int,      request.user.id   || null)
      .query(`UPDATE repair_jobs SET
        device_type=@dt, device_model=@dm, vendor=@vn, company_name=@cn,
        serial_no=@sn, symptom=@sy, initial_fix=@ifix,
        contact_name=@ct, contact_phone=@cp, line_id=@li,
        warranty=@wa, warranty_expire=@we, device_location=@dl,
        updated_at=GETDATE(), updated_by=@ub WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete repair job (manager only)
app.delete('/api/repair/:id', authRequired, managerRequired, async (request, res) => {
  try {
    const id     = parseInt(request.params.id);
    const reason = (request.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุหมายเหตุการลบ' });

    // Fetch job info before deletion (for audit log)
    const job = (await req().input('id', sql.Int, id)
      .query('SELECT job_no, company_name, status FROM repair_jobs WHERE id=@id')).recordset[0];
    if (!job) return res.status(404).json({ error: 'ไม่พบงานซ่อม' });

    // Ensure audit log table exists
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='repair_delete_log')
      CREATE TABLE repair_delete_log (
        id          INT IDENTITY PRIMARY KEY,
        repair_id   INT,
        job_no      NVARCHAR(50),
        company_name NVARCHAR(255),
        status      NVARCHAR(50),
        reason      NVARCHAR(MAX),
        deleted_by  INT,
        deleted_at  DATETIME DEFAULT GETDATE()
      )`);

    // Write audit log before deletion
    await req()
      .input('rid',  sql.Int,      id)
      .input('jno',  sql.NVarChar, job.job_no)
      .input('cn',   sql.NVarChar, job.company_name)
      .input('st',   sql.NVarChar, job.status)
      .input('rsn',  sql.NVarChar, reason)
      .input('by',   sql.Int,      request.user.id || null)
      .query(`INSERT INTO repair_delete_log (repair_id,job_no,company_name,status,reason,deleted_by)
              VALUES (@rid,@jno,@cn,@st,@rsn,@by)`);

    // Delete files on disk
    const files = (await req().input('id', sql.Int, id)
      .query('SELECT file_path FROM repair_attachments WHERE repair_id=@id')).recordset;
    for (const f of files) {
      try { const fp = path.join(UPLOAD_DIR, f.file_path.replace('/uploads/','')); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
    }
    await req().input('id', sql.Int, id).query('DELETE FROM repair_jobs WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete attachment
app.delete('/api/repair/attachments/:id', authRequired, async (request, res) => {
  try {
    const row = (await req().input('id', sql.Int, request.params.id)
      .query('SELECT * FROM repair_attachments WHERE id=@id')).recordset[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    // Delete file from disk
    const fullPath = path.join(UPLOAD_DIR, row.file_path.replace('/uploads/',''));
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    await req().input('id', sql.Int, request.params.id)
      .query('DELETE FROM repair_attachments WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Search shop from LicenseDB

// ══════════════════════════════════════════════════════════
//  TEAMS (cs_team)
// ══════════════════════════════════════════════════════════
app.get('/api/teams', authRequired, async (request, res) => {
  try {
    const result = await req().query(
      'SELECT * FROM teams WHERE active=1 ORDER BY sort_order, display_name'
    );
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/teams', authRequired, managerRequired, async (request, res) => {
  const { name, display_name, color, sort_order } = request.body;
  if (!name || !display_name) return res.status(400).json({ error: 'name and display_name required' });
  try {
    const result = await req()
      .input('name',         sql.NVarChar, name.toLowerCase().replace(/\s+/g,'_'))
      .input('display_name', sql.NVarChar, display_name)
      .input('color',        sql.NVarChar, color      || '#2563eb')
      .input('sort_order',   sql.Int,      sort_order || 0)
      .query(`INSERT INTO teams (name, display_name, color, sort_order)
              OUTPUT INSERTED.id VALUES (@name, @display_name, @color, @sort_order)`);
    res.json({ id: result.recordset[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/teams/:id', authRequired, managerRequired, async (request, res) => {
  const { name, display_name, color, sort_order, active } = request.body;
  try {
    await req()
      .input('name',         sql.NVarChar, name)
      .input('display_name', sql.NVarChar, display_name)
      .input('color',        sql.NVarChar, color      || '#2563eb')
      .input('sort_order',   sql.Int,      sort_order || 0)
      .input('active',       sql.Bit,      active     ?? 1)
      .input('id',           sql.Int,      request.params.id)
      .query(`UPDATE teams SET name=@name, display_name=@display_name,
              color=@color, sort_order=@sort_order, active=@active WHERE id=@id`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/teams/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, request.params.id)
      .query('UPDATE teams SET active=0 WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════
app.post('/api/auth/login', async (request, res) => {
  const { username, password } = request.body;
  if (!username || !password) return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  try {
    const result = await req()
      .input('uname', sql.NVarChar, username)
      .query(`SELECT au.id, au.username, au.password_hash, au.role, au.ext_username,
                     au.employee_id, au.calluserid, e.name, e.team, e.nickname
              FROM app_users au
              LEFT JOIN employees e ON e.id = au.employee_id
              WHERE au.username = @uname AND au.active = 1`);
    const user = result.recordset[0];
    if (!user) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    const payload = {
      id: user.id, username: user.username, role: user.role,
      employee_id: user.employee_id, ext_username: user.ext_username,
      calluserid: user.calluserid || null,
      name: user.name, team: user.team
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '10h' });
    res.json({ token, user: payload });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', authRequired, (request, res) => {
  res.json(request.user);
});

// ── Change own password ────────────────────────────────────
app.post('/api/auth/change-password', authRequired, async (request, res) => {
  const { old_password, new_password } = request.body;
  try {
    const result = await req()
      .input('id', sql.Int, request.user.id)
      .query('SELECT password_hash FROM app_users WHERE id=@id');
    const user = result.recordset[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await bcrypt.compare(old_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' });
    const hash = await bcrypt.hash(new_password, 10);
    await req().input('hash', sql.NVarChar, hash).input('id', sql.Int, request.user.id)
      .query('UPDATE app_users SET password_hash=@hash WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  USER MANAGEMENT (admin/manager only)
// ══════════════════════════════════════════════════════════
app.get('/api/users', authRequired, async (request, res) => {
  try {
    const result = await req().query(`
      SELECT au.id, au.username, au.role, au.ext_username, au.calluserid, au.active, au.created_at,
             au.employee_id, e.name, e.team, e.nickname
      FROM app_users au
      LEFT JOIN employees e ON e.id = au.employee_id
      ORDER BY e.team, au.username`);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', authRequired, async (request, res) => {
  const { employee_id, username, password, role, ext_username } = request.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await req()
      .input('eid',      sql.Int,      employee_id  || null)
      .input('uname',    sql.NVarChar, username)
      .input('hash',     sql.NVarChar, hash)
      .input('role',     sql.NVarChar, role         || 'staff')
      .input('extuname', sql.NVarChar, ext_username || null)
      .input('calluid',  sql.Int,      request.body.calluserid || null)
      .query(`INSERT INTO app_users (employee_id, username, password_hash, role, ext_username, calluserid)
              OUTPUT INSERTED.id VALUES (@eid,@uname,@hash,@role,@extuname,@calluid)`);
    res.json({ id: result.recordset[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', authRequired, async (request, res) => {
  const { username, password, role, ext_username, active, calluserid } = request.body;
  try {
    const r = req()
      .input('uname',    sql.NVarChar, username)
      .input('role',     sql.NVarChar, role)
      .input('extuname', sql.NVarChar, ext_username || null)
      .input('calluid',  sql.Int,      calluserid   || null)
      .input('active',   sql.Bit,      active ?? 1)
      .input('id',       sql.Int,      request.params.id);
    let q = 'UPDATE app_users SET username=@uname,role=@role,ext_username=@extuname,calluserid=@calluid,active=@active';
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      r.input('hash', sql.NVarChar, hash);
      q += ',password_hash=@hash';
    }
    await r.query(q + ' WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, request.params.id)
      .query('UPDATE app_users SET active=0 WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  DASHBOARD CHARTS — trend + category + agent workload
// ══════════════════════════════════════════════════════════
app.get('/api/dashboard/charts', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });

    const { dateFrom, dateTo, team } = request.query;
    const today = new Date().toISOString().split('T')[0];
    const msStr = dateFrom || (today.substring(0, 7) + '-01');
    const msDate = new Date(msStr);
    const meDate = dateTo ? new Date(new Date(dateTo).getTime() + 86400000) : new Date(new Date(msStr).setMonth(msDate.getMonth() + 1));

    // Previous period = same duration shifted back (fair comparison)
    const durationMs  = meDate - msDate;
    const daysThis    = Math.max(1, Math.ceil(durationMs / 86400000));
    const prevToDate  = new Date(msDate);                          // exclusive = start of current period
    const prevFromDate = new Date(msDate.getTime() - durationMs); // shift back by same duration

    // Resolve RBAC scope; apply optional team override
    let scope = await getScopedUsernames(request.user);
    if (scope === null) {
      return res.json({ catStats:[], agentThis:[], agentLast:[], agentCat:[],
                        dailyTrend:[], hourlyStats:[], dowStats:[], catDailyTrend:[], nameMap:{} });
    }
    if (team) {
      const teamRows = (await req().input('tm', sql.NVarChar, team).query(
        `SELECT DISTINCT au.ext_username FROM app_users au JOIN employees e ON e.id=au.employee_id
         WHERE e.team=@tm AND au.active=1 AND e.active=1 AND au.ext_username IS NOT NULL`
      )).recordset;
      const teamScope = teamRows.map(r => r.ext_username);
      // Intersect: if user already has a restricted scope, keep intersection
      scope = scope === undefined ? teamScope
            : scope.filter(u => teamScope.includes(u));
    }

    // Build each request separately so appendScopeClause can bind params independently
    const mkR = (from, to) => extReq()
      .input('ms', sql.DateTime, from)
      .input('me', sql.DateTime, to);

    const r1 = mkR(msDate, meDate);   const sc1 = appendScopeClause(r1, scope);
    const r2 = mkR(msDate, meDate);   const sc2 = appendScopeClause(r2, scope);
    const r3 = mkR(msDate, meDate);   const sc3 = appendScopeClause(r3, scope);
    const r4 = extReq()
      .input('ms', sql.DateTime, prevFromDate)
      .input('me', sql.DateTime, prevToDate); const sc4 = appendScopeClause(r4, scope);
    const r5 = mkR(msDate, meDate);   const sc5 = appendScopeClause(r5, scope);
    const r6 = mkR(msDate, meDate);   const sc6 = appendScopeClause(r6, scope);
    const r7 = mkR(msDate, meDate);   const sc7 = appendScopeClause(r7, scope);
    const r8 = mkR(msDate, meDate);   const sc8 = appendScopeClause(r8, scope);
    const r9 = mkR(msDate, meDate);   const sc9 = appendScopeClause(r9, scope);
    const r10 = mkR(msDate, meDate);  const sc10 = appendScopeClause(r10, scope);
    const r11 = extReq()
      .input('ms', sql.DateTime, prevFromDate)
      .input('me', sql.DateTime, prevToDate); const sc11 = appendScopeClause(r11, scope);

    const [d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11] = await Promise.all([
      // Daily trend
      r1.query(`SELECT CAST(cl.ReceiveDate AS DATE) AS day, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc1}
        GROUP BY CAST(cl.ReceiveDate AS DATE) ORDER BY day`),
      // Category stats
      r2.query(`SELECT ISNULL(pt.ProblemTypeDetail, 'อื่นๆ') AS category, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        LEFT JOIN ProblemType pt ON pt.ProblemTypeId = cl.ProblemTypeId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc2}
        GROUP BY pt.ProblemTypeDetail ORDER BY cnt DESC`),
      // Agent cases — this period
      r3.query(`SELECT u.UserName, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc3}
        GROUP BY u.UserName ORDER BY cnt DESC`),
      // Agent cases — previous period
      r4.query(`SELECT u.UserName, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc4}
        GROUP BY u.UserName`),
      // Agent × category
      r5.query(`SELECT TOP 300 u.UserName, cl.Subject AS category, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc5}
        GROUP BY u.UserName, cl.Subject ORDER BY u.UserName, cnt DESC`),
      // Hourly distribution
      r6.query(`SELECT DATEPART(hour, cl.ReceiveDate) AS hr, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc6}
        GROUP BY DATEPART(hour, cl.ReceiveDate) ORDER BY hr`),
      // Day-of-week distribution
      r7.query(`SELECT DATEPART(weekday, cl.ReceiveDate) AS dow, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc7}
        GROUP BY DATEPART(weekday, cl.ReceiveDate) ORDER BY dow`),
      // Category daily trend (top cats over time)
      r8.query(`SELECT TOP 500 CAST(cl.ReceiveDate AS DATE) AS day,
                       ISNULL(pt.ProblemTypeDetail,'อื่นๆ') AS cat, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        LEFT  JOIN ProblemType pt ON pt.ProblemTypeId = cl.ProblemTypeId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc8}
        GROUP BY CAST(cl.ReceiveDate AS DATE), pt.ProblemTypeDetail ORDER BY day, cnt DESC`),
      // Closed count this period
      r9.query(`SELECT COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        INNER JOIN CallStatus cs ON cs.StatusId = cl.StatusId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me
          AND (cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%ปิด%' OR cs.StatusName LIKE '%complete%')${sc9}`),
      // Hour × Agent heatmap
      r10.query(`SELECT DATEPART(hour, cl.ReceiveDate) AS hr, u.UserName, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc10}
        GROUP BY DATEPART(hour, cl.ReceiveDate), u.UserName
        ORDER BY hr, u.UserName`),
      // Closed count previous period
      r11.query(`SELECT COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        INNER JOIN CallStatus cs ON cs.StatusId = cl.StatusId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me
          AND (cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%ปิด%' OR cs.StatusName LIKE '%complete%')${sc11}`),
    ]);

    // Build ext_username → employee name map
    const nameMapRows = (await req().query(`
      SELECT au.ext_username, e.name
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const nameMap = {};
    nameMapRows.forEach(r => { nameMap[r.ext_username] = r.name; });

    const fmt = d => d.toISOString().split('T')[0];
    res.json({
      dailyTrend:    d1.recordset,
      catStats:      d2.recordset,
      agentThis:     d3.recordset,
      agentLast:     d4.recordset,
      agentCat:      d5.recordset,
      hourlyStats:   d6.recordset,
      dowStats:      d7.recordset,
      catDailyTrend: d8.recordset,
      closedThis:      d9.recordset[0]?.cnt || 0,
      hourlyAgentGrid: d10.recordset,
      closedLast:      d11.recordset[0]?.cnt || 0,
      nameMap,
      daysThis,
      daysPrev:  daysThis,
      thisFrom:  msStr,
      thisTo:    fmt(new Date(meDate.getTime() - 1)),
      prevFrom:  fmt(prevFromDate),
      prevTo:    fmt(new Date(prevToDate.getTime() - 1)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  AI ANALYSIS — SSE streaming (real-time situation analysis)
// ══════════════════════════════════════════════════════════
app.get('/api/ai-analysis', authRequired, async (_, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY ยังไม่ได้ตั้งค่าใน .env' });
  }

  // ── SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload = {}) =>
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);

  try {
    const now   = new Date();
    const today = now.toISOString().split('T')[0];
    const ext   = getExtPool();

    let snap = {
      date: today,
      time: now.toLocaleTimeString('th-TH'),
      extConnected: !!ext,
    };

    if (ext) {
      // Today's tickets by status
      const todayRows = (await extReq()
        .input('today', sql.Date, today)
        .query(`SELECT cs.StatusName AS status, COUNT(*) AS cnt
                FROM Calllog cl INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
                WHERE CAST(cl.ReceiveDate AS DATE)=@today
                GROUP BY cs.StatusName`)).recordset;

      // Overdue count (open > 24h)
      const overdueCount = (await extReq()
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl
                INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
                WHERE cl.ReceiveDate >= '2026-01-01'
                  AND cl.ReceiveDate <= DATEADD(hour,-24,GETDATE())
                  AND cs.StatusName NOT LIKE '%close%'
                  AND cs.StatusName NOT LIKE '%ปิด%'
                  AND cs.StatusName NOT LIKE '%complete%'`)).recordset[0]?.cnt || 0;

      // Month totals (this month vs last month)
      const ms  = today.substring(0,7) + '-01';
      const me  = new Date(new Date(ms).setMonth(new Date(ms).getMonth()+1));
      const lms = (() => { const d=new Date(ms); d.setMonth(d.getMonth()-1); return d.toISOString().split('T')[0].substring(0,7)+'-01'; })();
      const lme = new Date(ms);

      const monthTotal = (await extReq()
        .input('ms', sql.DateTime, new Date(ms)).input('me', sql.DateTime, me)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl
                WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me`)).recordset[0]?.cnt || 0;

      const lastMonthTotal = (await extReq()
        .input('lms', sql.DateTime, new Date(lms)).input('lme', sql.DateTime, lme)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl
                WHERE cl.ReceiveDate >= @lms AND cl.ReceiveDate < @lme`)).recordset[0]?.cnt || 0;

      // Top 5 agents this month
      const topAgents = (await extReq()
        .input('s', sql.DateTime, new Date(ms)).input('e', sql.DateTime, me)
        .query(`SELECT TOP 5 u.UserName, COUNT(cl.CalllogId) AS total_cases
                FROM Calllog cl INNER JOIN Users u ON u.UserId=cl.SupportId
                WHERE cl.ReceiveDate >= @s AND cl.ReceiveDate < @e
                GROUP BY u.UserName ORDER BY total_cases DESC`)).recordset;

      snap = {
        ...snap,
        todayTotal: todayRows.reduce((a,r)=>a+r.cnt, 0),
        todayByStatus: todayRows,
        overdueCount,
        monthTotal,
        lastMonthTotal,
        monthChangePercent: lastMonthTotal > 0 ? Math.round(((monthTotal-lastMonthTotal)/lastMonthTotal)*100) : null,
        topAgentsThisMonth: topAgents,
      };
    }

    // On-shift employees
    const hour    = now.getHours(), minute = now.getMinutes();
    const timeVal = hour * 60 + minute;
    const curShifts = [];
    if (timeVal >= 8*60+30  && timeVal <= 16*60+30) curShifts.push('morning');
    if (timeVal >= 15*60+30 && timeVal <= 23*60+30) curShifts.push('afternoon');
    if (timeVal >= 16*60   || timeVal <= 0)          curShifts.push('night');
    if (!curShifts.length) curShifts.push('morning');

    const shiftIn  = curShifts.map((_,i) => `@st${i}`).join(',');
    const shiftReq = req().input('today', sql.Date, today);
    curShifts.forEach((s,i) => shiftReq.input(`st${i}`, sql.NVarChar, s));
    const onShift = (await shiftReq.query(`
      SELECT s.shift_type, e.name, e.team
      FROM shifts s JOIN employees e ON e.id=s.employee_id
      WHERE s.shift_date=@today AND s.shift_type IN (${shiftIn})
        AND s.status='scheduled' AND e.active=1`)).recordset;

    const pendingLeaves = (await req()
      .query(`SELECT COUNT(*) AS cnt FROM leave_requests WHERE status='pending'`))
      .recordset[0]?.cnt || 0;

    snap = {
      ...snap,
      onShiftCount: onShift.length,
      onShiftByTeam: onShift.reduce((a,e)=>{ a[e.team]=(a[e.team]||0)+1; return a; }, {}),
      pendingLeaveRequests: pendingLeaves,
    };

    // ── Build prompt & stream ─────────────────────────────
    const prompt = `คุณคือ "CS Assistant" ผู้ช่วย AI ของผู้จัดการทีม Customer Service
วันที่: ${snap.date}  เวลา: ${snap.time}

สถานะปัจจุบัน:
${JSON.stringify(snap, null, 2)}

กรุณาวิเคราะห์และรายงานเป็นภาษาไทย ในรูปแบบต่อไปนี้ (ห้ามออกนอกหัวข้อที่กำหนด):

## 🌅 สรุปสถานการณ์วันนี้
[2-3 ประโยค ภาพรวมสิ่งที่เกิดขึ้น]

## ⚠️ จุดที่ต้องระวัง
[สิ่งที่น่ากังวล เช่น เคสค้างนาน, ปริมาณงานสูง, ขาดแคลนพนักงาน]

## 🔍 ความผิดปกติที่ตรวจพบ
[ความผิดปกติในข้อมูล เช่น การกระจายเคสไม่สม่ำเสมอ, หมวดหมู่พุ่งขึ้นผิดปกติ]

## 💡 คำแนะนำสำหรับผู้จัดการ
[การกระทำที่แนะนำ 2-3 ข้อ ระบุเป็นข้อๆ]`;

    send('start', { message: 'กำลังส่งข้อมูลให้ AI วิเคราะห์...' });

    const stream = claude.messages.stream({
      model:      AI_MODEL,
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        send('delta', { text: chunk.delta.text });
      }
    }

    const final = await stream.finalMessage();
    send('done', {
      inputTokens:  final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
    });

  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

// ══════════════════════════════════════════════════════════
//  CUSTOMER REQUIREMENTS
// ══════════════════════════════════════════════════════════
async function ensureRequirementsTables() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='customer_requirements' AND xtype='U')
      CREATE TABLE customer_requirements (
        id              INT PRIMARY KEY IDENTITY,
        req_no          NVARCHAR(20)  NOT NULL,
        reported_date   DATE          DEFAULT GETDATE(),
        work_type       NVARCHAR(100) DEFAULT 'Customize',
        ma_percent      DECIMAL(5,2)  DEFAULT 0,
        sales_person    NVARCHAR(100) NULL,
        work_status     NVARCHAR(50)  DEFAULT 'งานใหม่',
        doc_status      NVARCHAR(100) NULL,
        company_name    NVARCHAR(200) NOT NULL,
        customer_code   NVARCHAR(50)  NULL,
        track_token     NVARCHAR(64)  NOT NULL,
        title           NVARCHAR(300) NOT NULL,
        description     NVARCHAR(MAX) NULL,
        so_no           NVARCHAR(100) NULL,
        estimate_time   NVARCHAR(200) NULL,
        spec_doc        NVARCHAR(500) NULL,
        azure_id        NVARCHAR(500) NULL,
        user_manual     NVARCHAR(500) NULL,
        update_version  NVARCHAR(100) NULL,
        delivery_doc    NVARCHAR(500) NULL,
        contract_start  DATE NULL,
        contract_end    DATE NULL,
        priority        NVARCHAR(20)  DEFAULT 'medium',
        progress        INT           DEFAULT 0,
        notes           NVARCHAR(MAX) NULL,
        created_by      NVARCHAR(100) NULL,
        created_at      DATETIME      DEFAULT GETDATE(),
        updated_at      DATETIME      DEFAULT GETDATE()
      )`);
    // Add columns to existing table if missing
    const newCols = [
      ['reported_date',  'DATE NULL'],
      ['work_type',      "NVARCHAR(100) DEFAULT 'Customize'"],
      ['ma_percent',     'DECIMAL(5,2) DEFAULT 0'],
      ['sales_person',   'NVARCHAR(100) NULL'],
      ['work_status',    "NVARCHAR(50) DEFAULT 'งานใหม่'"],
      ['doc_status',     'NVARCHAR(100) NULL'],
      ['customer_code',  'NVARCHAR(50) NULL'],
      ['so_no',          'NVARCHAR(100) NULL'],
      ['estimate_time',  'NVARCHAR(200) NULL'],
      ['spec_doc',       'NVARCHAR(500) NULL'],
      ['azure_id',       'NVARCHAR(500) NULL'],
      ['user_manual',    'NVARCHAR(500) NULL'],
      ['update_version', 'NVARCHAR(100) NULL'],
      ['delivery_doc',   'NVARCHAR(500) NULL'],
      ['contract_start',     'DATE NULL'],
      ['contract_end',       'DATE NULL'],
      ['customer_link_token','NVARCHAR(64) NULL'],
    ];
    for (const [col, def] of newCols) {
      try {
        await req().query(`
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('customer_requirements') AND name='${col}')
            ALTER TABLE customer_requirements ADD ${col} ${def}`);
      } catch(e2) { console.warn(`⚠️  Could not add customer_requirements.${col}:`, e2.message); }
    }
    console.log('✅ Requirements table ready');
  } catch(e) { console.error('❌ Requirements table error:', e.message); }
}

// ── GET /api/requirements ─────────────────────────────────
app.get('/api/requirements', authRequired, async (request, res) => {
  try {
    const { company, status, priority, category } = request.query;
    const r = req();
    let q = 'SELECT * FROM customer_requirements WHERE 1=1';
    if (company)  { q += ' AND company_name LIKE @co';  r.input('co',  sql.NVarChar, `%${company}%`); }
    if (status)   { q += ' AND work_status=@st';       r.input('st',  sql.NVarChar, status); }
    if (priority) { q += ' AND priority=@pr';          r.input('pr',  sql.NVarChar, priority); }
    if (category) { q += ' AND work_type=@cat';        r.input('cat', sql.NVarChar, category); }
    q += ' ORDER BY created_at DESC';
    res.json((await r.query(q)).recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/requirements ────────────────────────────────
app.post('/api/requirements', authRequired, async (request, res) => {
  try {
    const b = request.body;
    if (!b.company_name?.trim() || !b.title?.trim()) return res.status(400).json({ error: 'company_name and title required' });
    const companyName = b.company_name.trim();
    const existing = (await req().input('co', sql.NVarChar, companyName)
      .query('SELECT TOP 1 track_token FROM customer_requirements WHERE company_name=@co')).recordset[0];
    const trackToken = existing?.track_token || crypto.randomBytes(22).toString('hex');
    const custLinkToken = b.customer_link_token || null;
    const n = (await req().query('SELECT COUNT(*)+1 AS n FROM customer_requirements')).recordset[0].n;
    const req_no = `REQ-${new Date().getFullYear()}-${String(n).padStart(3,'0')}`;
    const r = req()
      .input('req_no',               sql.NVarChar, req_no)
      .input('reported_date',        sql.Date,     b.reported_date  ? new Date(b.reported_date) : new Date())
      .input('work_type',            sql.NVarChar, b.work_type      || 'Customize')
      .input('ma_percent',           sql.Decimal,  parseFloat(b.ma_percent)||0)
      .input('sales_person',         sql.NVarChar, b.sales_person   || null)
      .input('work_status',          sql.NVarChar, b.work_status    || 'งานใหม่')
      .input('doc_status',           sql.NVarChar, b.doc_status     || null)
      .input('company_name',         sql.NVarChar, companyName)
      .input('customer_code',        sql.NVarChar, b.customer_code  || null)
      .input('track_token',          sql.NVarChar, trackToken)
      .input('customer_link_token',  sql.NVarChar, custLinkToken)
      .input('title',                sql.NVarChar, b.title.trim())
      .input('description',          sql.NVarChar, b.description    || null)
      .input('so_no',                sql.NVarChar, b.so_no          || null)
      .input('estimate_time',        sql.NVarChar, b.estimate_time  || null)
      .input('spec_doc',             sql.NVarChar, b.spec_doc       || null)
      .input('azure_id',             sql.NVarChar, b.azure_id       || null)
      .input('user_manual',          sql.NVarChar, b.user_manual    || null)
      .input('update_version',       sql.NVarChar, b.update_version || null)
      .input('delivery_doc',         sql.NVarChar, b.delivery_doc   || null)
      .input('contract_start',       sql.Date,     b.contract_start ? new Date(b.contract_start) : null)
      .input('contract_end',         sql.Date,     b.contract_end   ? new Date(b.contract_end)   : null)
      .input('priority',             sql.NVarChar, b.priority       || 'medium')
      .input('progress',             sql.Int,      parseInt(b.progress)||0)
      .input('notes',                sql.NVarChar, b.notes          || null)
      .input('created_by',           sql.NVarChar, request.user.username);
    const result = await r.query(`
      INSERT INTO customer_requirements
        (req_no,reported_date,work_type,ma_percent,sales_person,work_status,doc_status,
         company_name,customer_code,track_token,customer_link_token,title,description,so_no,
         estimate_time,spec_doc,azure_id,user_manual,update_version,delivery_doc,
         contract_start,contract_end,priority,progress,notes,created_by)
      OUTPUT INSERTED.*
      VALUES
        (@req_no,@reported_date,@work_type,@ma_percent,@sales_person,@work_status,@doc_status,
         @company_name,@customer_code,@track_token,@customer_link_token,@title,@description,@so_no,
         @estimate_time,@spec_doc,@azure_id,@user_manual,@update_version,@delivery_doc,
         @contract_start,@contract_end,@priority,@progress,@notes,@created_by)`);
    res.json(result.recordset[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/requirements/:id ─────────────────────────────
app.put('/api/requirements/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b = request.body;
    const companyName = (b.company_name || '').trim();
    const custLinkToken = b.customer_link_token || null;
    await req()
      .input('id',                   sql.Int,      id)
      .input('reported_date',        sql.Date,     b.reported_date  ? new Date(b.reported_date) : null)
      .input('work_type',            sql.NVarChar, b.work_type      || 'Customize')
      .input('ma_percent',           sql.Decimal,  parseFloat(b.ma_percent)||0)
      .input('sales_person',         sql.NVarChar, b.sales_person   || null)
      .input('work_status',          sql.NVarChar, b.work_status    || 'งานใหม่')
      .input('doc_status',           sql.NVarChar, b.doc_status     || null)
      .input('company_name',         sql.NVarChar, companyName)
      .input('customer_code',        sql.NVarChar, b.customer_code  || null)
      .input('customer_link_token',  sql.NVarChar, custLinkToken)
      .input('title',                sql.NVarChar, b.title)
      .input('description',          sql.NVarChar, b.description    || null)
      .input('so_no',                sql.NVarChar, b.so_no          || null)
      .input('estimate_time',        sql.NVarChar, b.estimate_time  || null)
      .input('spec_doc',             sql.NVarChar, b.spec_doc       || null)
      .input('azure_id',             sql.NVarChar, b.azure_id       || null)
      .input('user_manual',          sql.NVarChar, b.user_manual    || null)
      .input('update_version',       sql.NVarChar, b.update_version || null)
      .input('delivery_doc',         sql.NVarChar, b.delivery_doc   || null)
      .input('contract_start',       sql.Date,     b.contract_start ? new Date(b.contract_start) : null)
      .input('contract_end',         sql.Date,     b.contract_end   ? new Date(b.contract_end)   : null)
      .input('priority',             sql.NVarChar, b.priority       || 'medium')
      .input('progress',             sql.Int,      parseInt(b.progress)||0)
      .input('notes',                sql.NVarChar, b.notes          || null)
      .query(`UPDATE customer_requirements SET
        reported_date=@reported_date, work_type=@work_type, ma_percent=@ma_percent,
        sales_person=@sales_person, work_status=@work_status, doc_status=@doc_status,
        company_name=@company_name, customer_code=@customer_code,
        customer_link_token=@customer_link_token, title=@title,
        description=@description, so_no=@so_no, estimate_time=@estimate_time,
        spec_doc=@spec_doc, azure_id=@azure_id, user_manual=@user_manual,
        update_version=@update_version, delivery_doc=@delivery_doc,
        contract_start=@contract_start, contract_end=@contract_end,
        priority=@priority, progress=@progress, notes=@notes,
        updated_at=GETDATE() WHERE id=@id`);
    const updated = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM customer_requirements WHERE id=@id')).recordset[0];
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/requirements/:id ──────────────────────────
app.delete('/api/requirements/:id', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, parseInt(request.params.id))
      .query('DELETE FROM customer_requirements WHERE id=@id');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/requirements/portal-links ───────────────────
// Returns all customer_links for the dropdown in requirements modal
app.get('/api/requirements/portal-links', authRequired, async (_, res) => {
  try {
    const rows = (await req()
      .query('SELECT token, company_name, group_name, link_type FROM customer_links ORDER BY company_name')).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/requirements/companies ──────────────────────
app.get('/api/requirements/companies', authRequired, async (_, res) => {
  try {
    const r = (await req().query(
      'SELECT DISTINCT company_name FROM customer_requirements ORDER BY company_name'
    )).recordset.map(r => r.company_name);
    res.json(r);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/requirements/search-customer ────────────────
app.get('/api/requirements/search-customer', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.json([]);
    const q = request.query.q || '';
    if (q.length < 2) return res.json([]);
    const result = await extReq()
      .input('q', sql.NVarChar, `%${q}%`)
      .query(`SELECT TOP 20 RegistrationId AS id, CompanyName AS name
              FROM CustomerRegistration
              WHERE CompanyName LIKE @q
              ORDER BY CompanyName`);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/customer-groups?search= ────────────────────
app.get('/api/customer-groups', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.json([]);
    const q = request.query.search || '';
    const result = await extReq()
      .input('q', sql.NVarChar, q ? `%${q}%` : '%')
      .query(`SELECT TOP 30 cg.GroupId AS group_id, cg.GroupName AS group_name,
                cg.GroupCode AS group_code,
                COUNT(cr.RegistrationId) AS branch_count
              FROM CustomerGroup cg
              LEFT JOIN CustomerRegistration cr ON cr.GroupId = cg.GroupId
              WHERE cg.Active = 1 AND cg.GroupId <> 1
                AND (cg.GroupName LIKE @q OR cg.GroupCode LIKE @q)
              GROUP BY cg.GroupId, cg.GroupName, cg.GroupCode
              ORDER BY cg.GroupName`);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/public/track/:token/requirements ────────────
// Same logic as repairs-by-token: group → IN (LicenseDB companies), company → exact match

app.get('/api/public/track/:token/requirements', async (request, res) => {
  try {
    const tok  = request.params.token;
    const link = (await req().input('tok', sql.NVarChar, tok)
      .query('SELECT * FROM customer_links WHERE token=@tok')).recordset[0];
    if (!link) return res.status(404).json({ error: 'Link ไม่พบ' });

    const isGroup = link.link_type === 'group' && link.group_id;
    const COLS = `id,req_no,reported_date,work_type,sales_person,work_status,doc_status,
                  company_name,title,description,so_no,estimate_time,spec_doc,azure_id,
                  user_manual,update_version,delivery_doc,contract_start,contract_end,
                  priority,progress,created_at,updated_at`;

    let rows;
    if (isGroup) {
      if (!getExtPool()) return res.json([]);
      const names = (await extReq().input('gid', sql.Int, link.group_id)
        .query(`SELECT DISTINCT CompanyName FROM CustomerRegistration WHERE GroupId=@gid`))
        .recordset.map(r => r.CompanyName);
      if (!names.length) return res.json([]);
      const r = req();
      names.forEach((cn, i) => r.input(`cn${i}`, sql.NVarChar, cn));
      const inClause = names.map((_, i) => `@cn${i}`).join(',');
      rows = (await r.query(
        `SELECT ${COLS} FROM customer_requirements WHERE company_name IN (${inClause}) ORDER BY created_at DESC`
      )).recordset;
    } else {
      rows = (await req().input('cn', sql.NVarChar, link.company_name)
        .query(`SELECT ${COLS} FROM customer_requirements WHERE company_name=@cn ORDER BY created_at DESC`)
      ).recordset;
    }

    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/public/track/:token/issues ──────────────────
// Returns specialist_log rows that have an issue_id, for this customer/group
app.get('/api/public/track/:token/issues', async (request, res) => {
  try {
    const tok  = request.params.token;
    const link = (await req().input('tok', sql.NVarChar, tok)
      .query('SELECT * FROM customer_links WHERE token=@tok')).recordset[0];
    if (!link) return res.status(404).json({ error: 'Link ไม่พบ' });

    const isGroup = link.link_type === 'group' && link.group_id;
    const COLS = `sl.id, sl.calllog_id, sl.subject, sl.problem_type, sl.description,
                  sl.issue_id, sl.status, sl.resolution_note,
                  sl.assigned_at, sl.resolved_at, sl.accepted_at, sl.company_name,
                  e4.name AS accepted_by_name`;

    let rows;
    if (isGroup) {
      if (!getExtPool()) return res.json([]);
      const names = (await extReq().input('gid', sql.Int, link.group_id)
        .query(`SELECT DISTINCT CompanyName FROM CustomerRegistration WHERE GroupId=@gid`))
        .recordset.map(r => r.CompanyName);
      if (!names.length) return res.json([]);
      const r = req();
      names.forEach((cn, i) => r.input(`cn${i}`, sql.NVarChar, cn));
      const inClause = names.map((_, i) => `@cn${i}`).join(',');
      rows = (await r.query(
        `SELECT ${COLS}
         FROM specialist_log sl
         LEFT JOIN app_users au4 ON au4.id = sl.accepted_by
         LEFT JOIN employees e4  ON e4.id  = au4.employee_id
         WHERE sl.company_name IN (${inClause})
           AND sl.issue_id IS NOT NULL AND sl.issue_id <> ''
         ORDER BY sl.assigned_at DESC`
      )).recordset;
    } else {
      rows = (await req().input('cn', sql.NVarChar, link.company_name)
        .query(
          `SELECT ${COLS}
           FROM specialist_log sl
           LEFT JOIN app_users au4 ON au4.id = sl.accepted_by
           LEFT JOIN employees e4  ON e4.id  = au4.employee_id
           WHERE sl.company_name = @cn
             AND sl.issue_id IS NOT NULL AND sl.issue_id <> ''
           ORDER BY sl.assigned_at DESC`
        )
      ).recordset;
    }

    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/public/track/:token/fu-issues ───────────────
// Returns fu_issues from folders linked to this customer group
app.get('/api/public/track/:token/fu-issues', async (request, res) => {
  try {
    const tok  = request.params.token;
    const link = (await req().input('tok',sql.NVarChar,tok)
      .query('SELECT * FROM customer_links WHERE token=@tok')).recordset[0];
    if (!link) return res.status(404).json({ error: 'Link ไม่พบ' });
    if (!link.group_id) return res.json([]);

    const rows = (await req().input('gid',sql.Int,link.group_id).query(`
      SELECT i.id, i.detail, i.category, i.priority, i.status,
             i.due_date, i.note, i.created_at, i.updated_at,
             ea.name AS assigned_to_name,
             b.name AS board_name, f.name AS folder_name
      FROM fu_issues i
      JOIN fu_boards b ON b.id = i.board_id
      JOIN fu_folders f ON f.id = b.folder_id
      LEFT JOIN app_users ua ON ua.id = i.assigned_to
      LEFT JOIN employees ea ON ea.id = ua.employee_id
      WHERE f.group_id = @gid
      ORDER BY
        CASE i.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        i.created_at DESC
    `)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/public/requirements/:token ──────────────────
app.get('/api/public/requirements/:token', async (request, res) => {
  try {
    const tok = request.params.token;
    const rows = (await req().input('tok', sql.NVarChar, tok)
      .query(`SELECT id,req_no,title,category,description,priority,status,assigned_to,due_date,progress,created_at,updated_at
              FROM customer_requirements WHERE track_token=@tok ORDER BY created_at ASC`)).recordset;
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบข้อมูล' });
    const company = (await req().input('tok', sql.NVarChar, tok)
      .query('SELECT TOP 1 company_name FROM customer_requirements WHERE track_token=@tok')).recordset[0]?.company_name;
    res.json({ company, requirements: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────
async function ensureRepairTables() {
  try {
    const r = req();
    await r.query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='repair_jobs' AND xtype='U')
      CREATE TABLE repair_jobs (
        id INT PRIMARY KEY IDENTITY, job_no NVARCHAR(20) NOT NULL UNIQUE,
        reported_at DATETIME DEFAULT GETDATE(),
        device_type NVARCHAR(100), device_model NVARCHAR(100), vendor NVARCHAR(100),
        registration_id INT, company_name NVARCHAR(255),
        serial_no NVARCHAR(100), symptom NVARCHAR(MAX), initial_fix NVARCHAR(MAX),
        contact_name NVARCHAR(100), contact_phone NVARCHAR(50), line_id NVARCHAR(100),
        warranty BIT DEFAULT 0, warranty_expire DATE, device_location NVARCHAR(255),
        reported_by INT,
        status NVARCHAR(30) DEFAULT 'received',
        finance_status NVARCHAR(30) DEFAULT 'pending',
        quote_date DATE, quote_no NVARCHAR(50),
        received_date DATE, sent_supplier_date DATE,
        returned_from_supplier_date DATE, returned_to_customer_date DATE,
        spare_serial_no NVARCHAR(100), taken_back_items NVARCHAR(MAX), remark NVARCHAR(MAX),
        created_at DATETIME DEFAULT GETDATE(), updated_at DATETIME DEFAULT GETDATE(), updated_by INT,
        public_token NVARCHAR(48) NULL UNIQUE
      )`);
    // Add public_token column if table exists but column missing
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('repair_jobs') AND name='public_token')
        ALTER TABLE repair_jobs ADD public_token NVARCHAR(48) NULL`);
    // Add group_name column for customer group tracking
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('repair_jobs') AND name='group_name')
        ALTER TABLE repair_jobs ADD group_name NVARCHAR(255) NULL`);
    // Generate tokens for existing jobs that don't have one
    const noToken = (await req().query(
      `SELECT id FROM repair_jobs WHERE public_token IS NULL`)).recordset;
    for (const row of noToken) {
      const tok = crypto.randomBytes(18).toString('hex');
      await req().input('id', sql.Int, row.id).input('tok', sql.NVarChar, tok)
        .query(`UPDATE repair_jobs SET public_token=@tok WHERE id=@id AND public_token IS NULL`);
    }
    if (noToken.length) console.log(`✅ Generated tokens for ${noToken.length} existing repair jobs`);
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='repair_attachments' AND xtype='U')
      CREATE TABLE repair_attachments (
        id INT PRIMARY KEY IDENTITY, repair_id INT NOT NULL,
        file_type NVARCHAR(30) NOT NULL, file_name NVARCHAR(255) NOT NULL,
        file_path NVARCHAR(500) NOT NULL, file_size INT,
        uploaded_by INT, uploaded_at DATETIME DEFAULT GETDATE(),
        CONSTRAINT FK_attach_job FOREIGN KEY (repair_id) REFERENCES repair_jobs(id) ON DELETE CASCADE
      )`);
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='repair_timeline' AND xtype='U')
      CREATE TABLE repair_timeline (
        id INT PRIMARY KEY IDENTITY, repair_id INT NOT NULL,
        field_changed NVARCHAR(50), old_value NVARCHAR(255), new_value NVARCHAR(255),
        changed_by INT, changed_at DATETIME DEFAULT GETDATE(), note NVARCHAR(500),
        CONSTRAINT FK_timeline_job FOREIGN KEY (repair_id) REFERENCES repair_jobs(id) ON DELETE CASCADE
      )`);
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='repair_notification_log' AND xtype='U')
      CREATE TABLE repair_notification_log (
        id INT PRIMARY KEY IDENTITY, repair_id INT NOT NULL,
        channel NVARCHAR(10) NOT NULL, recipient NVARCHAR(255),
        message NVARCHAR(MAX), status NVARCHAR(10) DEFAULT 'sent',
        error_msg NVARCHAR(500), sent_at DATETIME DEFAULT GETDATE(),
        CONSTRAINT FK_notif_job FOREIGN KEY (repair_id) REFERENCES repair_jobs(id) ON DELETE CASCADE
      )`);
    // Add columns that may be missing from existing tables
    for (const [tbl, col, def] of [
      ['repair_jobs',     'public_token', 'NVARCHAR(48) NULL'],
      ['repair_timeline', 'read_at',      'DATETIME NULL'],
      ['repair_timeline', 'replied_at',   'DATETIME NULL'],
    ]) {
      try {
        await req().query(`
          IF NOT EXISTS (SELECT 1 FROM sys.columns
                         WHERE object_id=OBJECT_ID('${tbl}') AND name='${col}')
            ALTER TABLE ${tbl} ADD ${col} ${def}`);
      } catch(e2) { console.warn(`⚠️  Could not add ${tbl}.${col}:`, e2.message); }
    }
    console.log('✅ Repair tables ready');
  } catch(e) { console.error('❌ Repair table error:', e.message); }
}

// ══════════════════════════════════════════════════════════
//  SPECIALIST LOG
// ══════════════════════════════════════════════════════════
async function ensureSpecialistTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='specialist_log' AND xtype='U')
      CREATE TABLE specialist_log (
        id               INT PRIMARY KEY IDENTITY,
        calllog_id       INT,
        company_name     NVARCHAR(255),
        subject          NVARCHAR(500),
        problem_type     NVARCHAR(200),
        -- Contact info
        contact_name     NVARCHAR(100),
        contact_phone    NVARCHAR(50),
        line_id          NVARCHAR(100),
        line_group       NVARCHAR(200),
        customer_location NVARCHAR(255),
        -- Assignment
        original_agent   INT,
        assigned_to_team NVARCHAR(50),
        assigned_to_user INT,
        priority         NVARCHAR(20) DEFAULT 'normal',
        note             NVARCHAR(MAX),
        assigned_at      DATETIME DEFAULT GETDATE(),
        -- Resolution
        status           NVARCHAR(50) DEFAULT 'pending',
        resolved_by      INT,
        resolved_at      DATETIME,
        resolution_note  NVARCHAR(MAX),
        updated_at       DATETIME DEFAULT GETDATE()
      )`);
    // Widen status column if still NVARCHAR(20)
    try {
      await req().query(`
        IF EXISTS (
          SELECT 1 FROM sys.columns
          WHERE object_id=OBJECT_ID('specialist_log') AND name='status' AND max_length < 100
        )
          ALTER TABLE specialist_log ALTER COLUMN status NVARCHAR(50) DEFAULT 'pending'`);
    } catch {}
    // Add columns if missing
    for (const [col, def] of [
      ['issue_id',     'NVARCHAR(100) NULL'],
      ['accepted_by',  'INT NULL'],
      ['accepted_at',  'DATETIME NULL'],
      ['description',  'NVARCHAR(MAX) NULL'],
      ['solution',     'NVARCHAR(MAX) NULL'],
    ]) {
      try {
        await req().query(`
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('specialist_log') AND name='${col}')
            ALTER TABLE specialist_log ADD ${col} ${def}`);
      } catch {}
    }
    console.log('✅ specialist_log table ready');
  } catch(e) { console.error('❌ specialist_log error:', e.message); }
}

// ══════════════════════════════════════════════════════════
//  ISSUE FOLLOW UP TABLE
// ══════════════════════════════════════════════════════════
async function ensureFollowupTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='issue_followup' AND xtype='U')
      CREATE TABLE issue_followup (
        id                 INT PRIMARY KEY IDENTITY,
        specialist_log_id  INT NULL,
        calllog_id         INT NULL,
        company_name       NVARCHAR(255),
        subject            NVARCHAR(500),
        description        NVARCHAR(MAX),
        contact_name       NVARCHAR(100),
        contact_phone      NVARCHAR(50),
        priority           NVARCHAR(20) DEFAULT 'normal',
        created_by         INT,
        assigned_to_team   NVARCHAR(50),
        assigned_to_user   INT NULL,
        status             NVARCHAR(50) DEFAULT 'pending',
        accepted_by        INT NULL,
        accepted_at        DATETIME NULL,
        case_opened_by     INT NULL,
        case_opened_at     DATETIME NULL,
        case_note          NVARCHAR(MAX) NULL,
        resolved_by        INT NULL,
        resolved_at        DATETIME NULL,
        resolution_note    NVARCHAR(MAX) NULL,
        created_at         DATETIME DEFAULT GETDATE(),
        updated_at         DATETIME DEFAULT GETDATE()
      )`);
    console.log('✅ issue_followup table ready');
  } catch(e) { console.error('❌ issue_followup error:', e.message); }
}

// ── GET /api/followup ──────────────────────────────────────
app.get('/api/followup', authRequired, async (request, res) => {
  try {
    const u    = request.user;
    const stat = request.query.status || '';
    const team = request.query.team   || '';
    let where  = '1=1';
    const binds = [];
    if (stat) { where += ` AND fu.status=@stat`; binds.push(['stat', sql.NVarChar, stat]); }
    if (team) { where += ` AND fu.assigned_to_team=@team`; binds.push(['team', sql.NVarChar, team]); }
    let r = req();
    binds.forEach(([k,t,v]) => r = r.input(k, t, v));
    const rows = (await r.query(`
      SELECT fu.*,
             ec.name  AS created_by_name,
             ea.name  AS accepted_by_name,
             eo.name  AS case_opened_by_name,
             er.name  AS resolved_by_name,
             eu.name  AS assigned_to_user_name
      FROM issue_followup fu
      LEFT JOIN app_users  uc ON uc.id = fu.created_by
      LEFT JOIN employees  ec ON ec.id = uc.employee_id
      LEFT JOIN app_users  ua ON ua.id = fu.accepted_by
      LEFT JOIN employees  ea ON ea.id = ua.employee_id
      LEFT JOIN app_users  uo ON uo.id = fu.case_opened_by
      LEFT JOIN employees  eo ON eo.id = uo.employee_id
      LEFT JOIN app_users  ur ON ur.id = fu.resolved_by
      LEFT JOIN employees  er ON er.id = ur.employee_id
      LEFT JOIN app_users  uu ON uu.id = fu.assigned_to_user
      LEFT JOIN employees  eu ON eu.id = uu.employee_id
      WHERE ${where}
      ORDER BY fu.created_at DESC`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/followup/badge ────────────────────────────────
app.get('/api/followup/badge', authRequired, async (request, res) => {
  try {
    const r = await req().query(
      `SELECT COUNT(*) AS cnt FROM issue_followup WHERE status IN ('pending','accepted')`);
    res.json({ pending: r.recordset[0]?.cnt || 0 });
  } catch(e) { res.json({ pending: 0 }); }
});

// ── POST /api/followup ─────────────────────────────────────
app.post('/api/followup', authRequired, async (request, res) => {
  try {
    const b = request.body;
    if (!b.subject?.trim())           return res.status(400).json({ error: 'กรุณาระบุหัวข้อ' });
    if (!b.assigned_to_team?.trim())  return res.status(400).json({ error: 'กรุณาเลือกทีมที่รับงาน' });
    const result = await req()
      .input('slid', sql.Int,      b.specialist_log_id || null)
      .input('cid',  sql.Int,      b.calllog_id        || null)
      .input('cn',   sql.NVarChar, b.company_name      || null)
      .input('sub',  sql.NVarChar, b.subject.trim())
      .input('desc', sql.NVarChar, b.description       || null)
      .input('ctn',  sql.NVarChar, b.contact_name      || null)
      .input('ctp',  sql.NVarChar, b.contact_phone     || null)
      .input('pri',  sql.NVarChar, b.priority          || 'normal')
      .input('cb',   sql.Int,      request.user.id)
      .input('att',  sql.NVarChar, b.assigned_to_team.trim())
      .input('atu',  sql.Int,      b.assigned_to_user  || null)
      .query(`INSERT INTO issue_followup
        (specialist_log_id,calllog_id,company_name,subject,description,contact_name,contact_phone,
         priority,created_by,assigned_to_team,assigned_to_user)
        OUTPUT INSERTED.id
        VALUES(@slid,@cid,@cn,@sub,@desc,@ctn,@ctp,@pri,@cb,@att,@atu)`);
    const newId = result.recordset[0].id;
    const uname = request.user.name || request.user.username;
    await sendLineNotify(`\n🔁 [Follow Up ใหม่] ${b.company_name||'—'}\n📋 ${b.subject}\nทีมที่รับ: ${b.assigned_to_team}\nสร้างโดย: ${uname}`);
    res.json({ id: newId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/followup/:id ──────────────────────────────────
app.put('/api/followup/:id', authRequired, async (request, res) => {
  try {
    const id  = parseInt(request.params.id);
    const b   = request.body;
    const uid = request.user.id;
    const cur = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM issue_followup WHERE id=@id')).recordset[0];
    if (!cur) return res.status(404).json({ error: 'not found' });

    const newStatus = b.status ?? cur.status;
    await req()
      .input('id',   sql.Int,      id)
      .input('st',   sql.NVarChar, newStatus)
      .input('pr',   sql.NVarChar, b.priority         ?? cur.priority)
      .input('nt',   sql.NVarChar, b.description      ?? cur.description)
      .input('cn',   sql.NVarChar, b.case_note        ?? cur.case_note)
      .input('rn',   sql.NVarChar, b.resolution_note  ?? cur.resolution_note)
      .input('aby',  sql.Int,      newStatus==='accepted'    && !cur.accepted_by    ? uid : cur.accepted_by)
      .input('coby', sql.Int,      newStatus==='case_opened' && !cur.case_opened_by ? uid : cur.case_opened_by)
      .input('rby',  sql.Int,      newStatus==='resolved'    && !cur.resolved_by    ? uid : cur.resolved_by)
      .query(`UPDATE issue_followup SET
        status=@st, priority=@pr, description=@nt, case_note=@cn, resolution_note=@rn,
        accepted_by=@aby,
        accepted_at=CASE WHEN @st='accepted'    AND accepted_at    IS NULL THEN GETDATE() ELSE accepted_at    END,
        case_opened_by=@coby,
        case_opened_at=CASE WHEN @st='case_opened' AND case_opened_at IS NULL THEN GETDATE() ELSE case_opened_at END,
        resolved_by=@rby,
        resolved_at=CASE WHEN @st='resolved'    AND resolved_at    IS NULL THEN GETDATE() ELSE resolved_at    END,
        updated_at=GETDATE()
        WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/followup/:id ───────────────────────────────
app.delete('/api/followup/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    await req().input('id', sql.Int, id).query('DELETE FROM issue_followup WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function ensureFollowupV2Tables() {
  try {
    await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='fu_folders' AND xtype='U')
      CREATE TABLE fu_folders (id INT PRIMARY KEY IDENTITY, name NVARCHAR(200) NOT NULL, color NVARCHAR(20) DEFAULT '#3b82f6', created_by INT, created_at DATETIME DEFAULT GETDATE())`);

    await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='fu_boards' AND xtype='U')
      CREATE TABLE fu_boards (id INT PRIMARY KEY IDENTITY, folder_id INT NOT NULL, name NVARCHAR(200) NOT NULL, created_by INT, created_at DATETIME DEFAULT GETDATE())`);

    await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='fu_issues' AND xtype='U')
      CREATE TABLE fu_issues (
        id INT PRIMARY KEY IDENTITY, board_id INT NOT NULL, position INT DEFAULT 0,
        branch NVARCHAR(200), detail NVARCHAR(MAX), category NVARCHAR(100),
        priority NVARCHAR(20) DEFAULT 'normal', assigned_to INT NULL,
        status NVARCHAR(50) DEFAULT 'pending', due_date DATE NULL, fix_date DATE NULL,
        note NVARCHAR(MAX), created_by INT,
        created_at DATETIME DEFAULT GETDATE(), updated_at DATETIME DEFAULT GETDATE())`);

    await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='fu_comments' AND xtype='U')
      CREATE TABLE fu_comments (id INT PRIMARY KEY IDENTITY, issue_id INT NOT NULL, user_id INT NOT NULL, body NVARCHAR(MAX) NOT NULL, created_at DATETIME DEFAULT GETDATE())`);

    await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='fu_activity' AND xtype='U')
      CREATE TABLE fu_activity (id INT PRIMARY KEY IDENTITY, issue_id INT NOT NULL, user_id INT NOT NULL, action NVARCHAR(200), old_val NVARCHAR(MAX), new_val NVARCHAR(MAX), created_at DATETIME DEFAULT GETDATE())`);

    await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='fu_mentions' AND xtype='U')
      CREATE TABLE fu_mentions (id INT PRIMARY KEY IDENTITY, issue_id INT NOT NULL, comment_id INT NOT NULL, target_user_id INT NOT NULL, seen BIT DEFAULT 0, created_at DATETIME DEFAULT GETDATE())`);

    await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='fu_categories' AND xtype='U')
      CREATE TABLE fu_categories (id INT PRIMARY KEY IDENTITY, name NVARCHAR(100) NOT NULL UNIQUE)`);

    await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='fu_attachments' AND xtype='U')
      CREATE TABLE fu_attachments (id INT PRIMARY KEY IDENTITY, issue_id INT NOT NULL, filename NVARCHAR(300) NOT NULL, original_name NVARCHAR(300) NOT NULL, file_size INT, mime_type NVARCHAR(100), created_by INT, created_at DATETIME DEFAULT GETDATE())`);

    try { await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('fu_folders') AND name='group_id') ALTER TABLE fu_folders ADD group_id INT NULL`); } catch(e2) {}
    try { await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('fu_folders') AND name='group_name') ALTER TABLE fu_folders ADD group_name NVARCHAR(255) NULL`); } catch(e2) {}
    console.log('✅ Follow Up v2 tables ready');
  } catch(e) { console.error('❌ Follow Up v2 tables error:', e.message); }
}

// ══ FOLLOW UP v2 — FOLDERS ══
app.get('/api/fu/folders', authRequired, async (request, res) => {
  try {
    const rows = (await req().query(`
      SELECT f.*, e.name AS created_by_name,
        (SELECT COUNT(*) FROM fu_boards b WHERE b.folder_id=f.id) AS board_count
      FROM fu_folders f
      LEFT JOIN app_users au ON au.id=f.created_by
      LEFT JOIN employees e ON e.id=au.employee_id
      ORDER BY f.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fu/folders', authRequired, async (request, res) => {
  try {
    const { name, color } = request.body;
    if (!name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อโฟลเดอร์' });
    const r = await req().input('n',sql.NVarChar,name.trim()).input('c',sql.NVarChar,color||'#3b82f6').input('cb',sql.Int,request.user.id)
      .query(`INSERT INTO fu_folders(name,color,created_by) OUTPUT INSERTED.id VALUES(@n,@c,@cb)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/fu/folders/:id', authRequired, async (request, res) => {
  try {
    const b = request.body;
    let r = req().input('id',sql.Int,parseInt(request.params.id));
    const updates = [];
    if (b.name  !== undefined) { r=r.input('n',sql.NVarChar,b.name);              updates.push('name=@n'); }
    if (b.color !== undefined) { r=r.input('c',sql.NVarChar,b.color||null);        updates.push('color=ISNULL(@c,color)'); }
    if (b.hasOwnProperty('group_id')) {
      r=r.input('gid',sql.Int,b.group_id||null).input('gn',sql.NVarChar,b.group_name||null);
      updates.push('group_id=@gid','group_name=@gn');
    }
    if (!updates.length) return res.json({ ok:true });
    await r.query(`UPDATE fu_folders SET ${updates.join(',')} WHERE id=@id`);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/fu/folders/:id', authRequired, async (request, res) => {
  try {
    await req().input('id',sql.Int,parseInt(request.params.id)).query(`DELETE FROM fu_folders WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ FOLLOW UP v2 — BOARDS ══
app.get('/api/fu/folders/:fid/boards', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('fid',sql.Int,parseInt(request.params.fid)).query(`
      SELECT b.*,e.name AS created_by_name,
        (SELECT COUNT(*) FROM fu_issues i WHERE i.board_id=b.id) AS issue_count
      FROM fu_boards b
      LEFT JOIN app_users au ON au.id=b.created_by
      LEFT JOIN employees e ON e.id=au.employee_id
      WHERE b.folder_id=@fid ORDER BY b.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fu/boards', authRequired, async (request, res) => {
  try {
    const { folder_id, name } = request.body;
    if (!folder_id || !name?.trim()) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const r = await req().input('fid',sql.Int,folder_id).input('n',sql.NVarChar,name.trim()).input('cb',sql.Int,request.user.id)
      .query(`INSERT INTO fu_boards(folder_id,name,created_by) OUTPUT INSERTED.id VALUES(@fid,@n,@cb)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/fu/boards/:id', authRequired, async (request, res) => {
  try {
    await req().input('id',sql.Int,parseInt(request.params.id)).input('n',sql.NVarChar,request.body.name)
      .query(`UPDATE fu_boards SET name=@n WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/fu/boards/:id', authRequired, async (request, res) => {
  try {
    await req().input('id',sql.Int,parseInt(request.params.id)).query(`DELETE FROM fu_boards WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ FOLLOW UP v2 — ISSUES ══
app.get('/api/fu/boards/:bid/issues', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('bid',sql.Int,parseInt(request.params.bid)).query(`
      SELECT i.*,
        ea.name AS assigned_to_name,
        ec.name AS created_by_name,
        (SELECT COUNT(*) FROM fu_comments c WHERE c.issue_id=i.id) AS comment_count,
        (SELECT TOP 1 c.created_at FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_at,
        (SELECT TOP 1 c.body     FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_body
      FROM fu_issues i
      LEFT JOIN app_users ua ON ua.id=i.assigned_to
      LEFT JOIN employees ea ON ea.id=ua.employee_id
      LEFT JOIN app_users uc ON uc.id=i.created_by
      LEFT JOIN employees ec ON ec.id=uc.employee_id
      WHERE i.board_id=@bid ORDER BY i.position,i.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fu/issues', authRequired, async (request, res) => {
  try {
    const b = request.body;
    if (!b.board_id) return res.status(400).json({ error: 'กรุณาระบุ board' });
    const r = await req()
      .input('bid',sql.Int,b.board_id).input('br',sql.NVarChar,b.branch||null)
      .input('det',sql.NVarChar,b.detail||null).input('cat',sql.NVarChar,b.category||null)
      .input('pri',sql.NVarChar,b.priority||'normal').input('at',sql.Int,b.assigned_to||null)
      .input('dd',sql.Date,b.due_date||null).input('nt',sql.NVarChar,b.note||null)
      .input('cb',sql.Int,request.user.id)
      .query(`INSERT INTO fu_issues(board_id,branch,detail,category,priority,assigned_to,due_date,note,created_by) OUTPUT INSERTED.id VALUES(@bid,@br,@det,@cat,@pri,@at,@dd,@nt,@cb)`);
    const newId = r.recordset[0].id;
    if (b.category?.trim()) {
      try { await req().input('c',sql.NVarChar,b.category.trim())
        .query(`IF NOT EXISTS(SELECT 1 FROM fu_categories WHERE name=@c) INSERT INTO fu_categories(name) VALUES(@c)`); } catch {}
    }
    // Log creation activity
    try { await req().input('iid',sql.Int,newId).input('uid',sql.Int,request.user.id)
      .input('act',sql.NVarChar,'สร้าง Issue').input('ov',sql.NVarChar,'').input('nv',sql.NVarChar,b.detail||'')
      .query(`INSERT INTO fu_activity(issue_id,user_id,action,old_val,new_val) VALUES(@iid,@uid,@act,@ov,@nv)`); } catch {}
    res.json({ id: newId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/fu/issues/:id', authRequired, async (request, res) => {
  try {
    const id  = parseInt(request.params.id);
    const b   = request.body;
    const uid = request.user.id;
    const cur = (await req().input('id',sql.Int,id).query('SELECT * FROM fu_issues WHERE id=@id')).recordset[0];
    if (!cur) return res.status(404).json({ error: 'not found' });

    let r = req().input('id',sql.Int,id);
    const updates = ['updated_at=GETDATE()'];
    if (b.hasOwnProperty('branch'))      { r=r.input('branch',sql.NVarChar,b.branch??null);      updates.push('branch=@branch'); }
    if (b.hasOwnProperty('detail'))      { r=r.input('detail',sql.NVarChar,b.detail??null);      updates.push('detail=@detail'); }
    if (b.hasOwnProperty('category'))    { r=r.input('cat',sql.NVarChar,b.category??null);       updates.push('category=@cat'); }
    if (b.hasOwnProperty('priority'))    { r=r.input('pri',sql.NVarChar,b.priority);             updates.push('priority=@pri'); }
    if (b.hasOwnProperty('assigned_to')) { r=r.input('at',sql.Int,b.assigned_to??null);          updates.push('assigned_to=@at'); }
    if (b.hasOwnProperty('status'))      { r=r.input('st',sql.NVarChar,b.status);                updates.push('status=@st'); }
    if (b.hasOwnProperty('due_date'))    { r=r.input('dd',sql.Date,b.due_date||null);            updates.push('due_date=@dd'); }
    if (b.hasOwnProperty('fix_date'))    { r=r.input('fd',sql.Date,b.fix_date||null);            updates.push('fix_date=@fd'); }
    if (b.hasOwnProperty('note'))        { r=r.input('nt',sql.NVarChar,b.note??null);            updates.push('note=@nt'); }
    await r.query(`UPDATE fu_issues SET ${updates.join(',')} WHERE id=@id`);

    // Activity log for status/assignee changes
    const logFields = {status:'สถานะ',priority:'ความสำคัญ',assigned_to:'ผู้รับผิดชอบ',category:'Category'};
    for (const [field,label] of Object.entries(logFields)) {
      if (b.hasOwnProperty(field) && String(b[field]??'')!==String(cur[field]??'')) {
        try { await req().input('iid',sql.Int,id).input('uid',sql.Int,uid)
          .input('act',sql.NVarChar,`เปลี่ยน${label}`).input('ov',sql.NVarChar,String(cur[field]??'')).input('nv',sql.NVarChar,String(b[field]??''))
          .query(`INSERT INTO fu_activity(issue_id,user_id,action,old_val,new_val) VALUES(@iid,@uid,@act,@ov,@nv)`); } catch {}
      }
    }
    if (b.category?.trim()) {
      try { await req().input('c',sql.NVarChar,b.category.trim())
        .query(`IF NOT EXISTS(SELECT 1 FROM fu_categories WHERE name=@c) INSERT INTO fu_categories(name) VALUES(@c)`); } catch {}
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/fu/issues/:id', authRequired, async (request, res) => {
  try {
    await req().input('id',sql.Int,parseInt(request.params.id)).query('DELETE FROM fu_issues WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ FOLLOW UP v2 — TIMELINE (comments + activity) ══
app.get('/api/fu/issues/:id/timeline', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const comments = (await req().input('id',sql.Int,id).query(`
      SELECT 'comment' AS type,c.id,c.body AS content,c.created_at,e.name AS user_name
      FROM fu_comments c LEFT JOIN app_users au ON au.id=c.user_id LEFT JOIN employees e ON e.id=au.employee_id
      WHERE c.issue_id=@id`)).recordset;
    const activity = (await req().input('id',sql.Int,id).query(`
      SELECT 'activity' AS type,a.id,a.action AS content,a.old_val,a.new_val,a.created_at,e.name AS user_name
      FROM fu_activity a LEFT JOIN app_users au ON au.id=a.user_id LEFT JOIN employees e ON e.id=au.employee_id
      WHERE a.issue_id=@id`)).recordset;
    res.json([...comments,...activity].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fu/issues/:id/comments', authRequired, async (request, res) => {
  try {
    const id   = parseInt(request.params.id);
    const body = request.body.body?.trim();
    if (!body) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });
    const r = await req().input('iid',sql.Int,id).input('uid',sql.Int,request.user.id).input('b',sql.NVarChar,body)
      .query(`INSERT INTO fu_comments(issue_id,user_id,body) OUTPUT INSERTED.id VALUES(@iid,@uid,@b)`);
    const cid = r.recordset[0].id;
    // @mention parsing
    const mentions = [...body.matchAll(/@([^\s@]+)/g)].map(m=>m[1]);
    if (mentions.length) {
      const users = (await req().query(`SELECT au.id,e.name FROM app_users au JOIN employees e ON e.id=au.employee_id WHERE au.active=1`)).recordset;
      for (const m of mentions) {
        const matched = users.find(u=>u.name.replace(/\s/g,'').toLowerCase().includes(m.toLowerCase()));
        if (matched) {
          try { await req().input('iid',sql.Int,id).input('cid',sql.Int,cid).input('tuid',sql.Int,matched.id)
            .query(`INSERT INTO fu_mentions(issue_id,comment_id,target_user_id) VALUES(@iid,@cid,@tuid)`); } catch {}
        }
      }
    }
    res.json({ id: cid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ FOLLOW UP v2 — CATEGORIES + BADGE ══
app.get('/api/fu/categories', authRequired, async (req_, res) => {
  try {
    const rows = (await req().query(`SELECT name FROM fu_categories ORDER BY name`)).recordset;
    res.json(rows.map(r=>r.name));
  } catch(e) { res.json([]); }
});

// ══ FOLLOW UP v2 — ATTACHMENTS ══
app.get('/api/fu/issues/:id/attachments', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('id',sql.Int,parseInt(request.params.id))
      .query(`SELECT a.*, e.name AS uploaded_by_name FROM fu_attachments a
              LEFT JOIN app_users au ON au.id=a.created_by
              LEFT JOIN employees e ON e.id=au.employee_id
              WHERE a.issue_id=@id ORDER BY a.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fu/issues/:id/attachments', authRequired, fuUpload.array('files', 10), async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const files = request.files || [];
    if (!files.length) return res.status(400).json({ error: 'ไม่พบไฟล์' });
    const inserted = [];
    for (const f of files) {
      const r = await req()
        .input('iid', sql.Int, id)
        .input('fn',  sql.NVarChar, f.filename)
        .input('on',  sql.NVarChar, f.originalname)
        .input('fs',  sql.Int, f.size)
        .input('mt',  sql.NVarChar, f.mimetype)
        .input('cb',  sql.Int, request.user.id)
        .query(`INSERT INTO fu_attachments(issue_id,filename,original_name,file_size,mime_type,created_by) OUTPUT INSERTED.id VALUES(@iid,@fn,@on,@fs,@mt,@cb)`);
      inserted.push({ id: r.recordset[0].id, filename: f.filename, original_name: f.originalname, file_size: f.size, mime_type: f.mimetype });
    }
    res.json({ ok: true, files: inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/fu/attachments/:id', authRequired, async (request, res) => {
  try {
    const row = (await req().input('id',sql.Int,parseInt(request.params.id))
      .query(`SELECT a.*, a.issue_id FROM fu_attachments a WHERE a.id=@id`)).recordset[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    // Delete file from disk
    const filePath = path.join(UPLOAD_DIR, 'fu', String(row.issue_id), row.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await req().input('id',sql.Int,parseInt(request.params.id)).query(`DELETE FROM fu_attachments WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fu/badge', authRequired, async (request, res) => {
  try {
    const r = await req().input('uid',sql.Int,request.user.id)
      .query(`SELECT COUNT(*) AS cnt FROM fu_mentions WHERE target_user_id=@uid AND seen=0`);
    res.json({ mentions: r.recordset[0]?.cnt||0 });
  } catch(e) { res.json({ mentions:0 }); }
});

app.post('/api/fu/mentions/seen', authRequired, async (request, res) => {
  try {
    await req().input('uid',sql.Int,request.user.id)
      .query(`UPDATE fu_mentions SET seen=1 WHERE target_user_id=@uid AND seen=0`);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lightweight badge count only
app.get('/api/specialist/badge', authRequired, async (request, res) => {
  try {
    const r = await req().query(
      `SELECT COUNT(*) AS cnt FROM specialist_log WHERE status='pending'`);
    res.json({ pending: r.recordset[0]?.cnt || 0 });
  } catch(e) { res.json({ pending: 0 }); }
});

// Get all specialist logs
app.get('/api/specialist', authRequired, async (request, res) => {
  try {
    const { status, team, my, dateFrom, dateTo } = request.query;
    const r = req();
    // Simplified query — store names at create/accept time, minimal JOINs
    let q = `SELECT TOP 500 sl.*,
               e1.name AS agent_name, e1.team AS agent_team,
               e4.name AS accepted_by_name
             FROM specialist_log sl
             LEFT JOIN app_users au1 ON au1.id = sl.original_agent
             LEFT JOIN employees  e1 ON e1.id  = au1.employee_id
             LEFT JOIN app_users au4 ON au4.id = sl.accepted_by
             LEFT JOIN employees  e4 ON e4.id  = au4.employee_id
             WHERE 1=1`;
    if (dateFrom) { q += ' AND sl.assigned_at >= @df'; r.input('df', sql.DateTime, new Date(dateFrom)); }
    else if (!dateTo) { q += ' AND sl.assigned_at >= DATEADD(day,-90,GETDATE())'; }
    if (dateTo)   { q += ' AND sl.assigned_at < DATEADD(day,1,@dt)'; r.input('dt', sql.DateTime, new Date(dateTo)); }
    if (status)  { q += ' AND sl.status=@st';    r.input('st', sql.NVarChar, status); }
    if (team)    { q += ' AND sl.assigned_to_team=@tm'; r.input('tm', sql.NVarChar, team); }
    if (my==='1'){ q += ' AND sl.assigned_to_user=@me'; r.input('me', sql.Int, request.user.id||0); }
    q += ' ORDER BY sl.assigned_at DESC';
    const rows = (await r.query(q)).recordset;

    // Cross-query LicenseDB for live calllog description / initial solution from helpdesk
    const calllogIds = rows.filter(s => s.calllog_id).map(s => s.calllog_id);
    if (calllogIds.length && getExtPool()) {
      try {
        const clRows = (await extReq().query(
          `SELECT CalllogId AS id, CalllogDesc AS calllog_description, Solution AS calllog_solution
           FROM Calllog WHERE CalllogId IN (${calllogIds.join(',')})`
        )).recordset;
        const clMap = {};
        clRows.forEach(c => { clMap[c.id] = c; });
        rows.forEach(s => {
          if (s.calllog_id && clMap[s.calllog_id]) {
            s.calllog_description = clMap[s.calllog_id].calllog_description;
            s.calllog_solution    = clMap[s.calllog_id].calllog_solution;
          }
        });
      } catch(e2) { console.error('SP calllog cross-query:', e2.message); }
    }

    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create specialist log (assign to specialist)
app.post('/api/specialist', authRequired, async (request, res) => {
  try {
    const b = request.body;
    // Duplicate guard: block if an active (non-resolved/cancelled) job exists for same calllog_id
    if (b.calllog_id) {
      const dup = await req()
        .input('cid', sql.Int, b.calllog_id)
        .query(`SELECT id FROM specialist_log WHERE calllog_id=@cid AND status NOT IN ('resolved','cancelled')`);
      if (dup.recordset.length > 0) {
        return res.status(409).json({ error: `มีงาน Specialist สำหรับเคสนี้อยู่แล้ว (#${dup.recordset[0].id})`, duplicate_id: dup.recordset[0].id });
      }
    }
    const result = await req()
      .input('cid',  sql.Int,      b.calllog_id       || null)
      .input('cn',   sql.NVarChar, b.company_name      || null)
      .input('subj', sql.NVarChar, b.subject           || null)
      .input('pt',   sql.NVarChar, b.problem_type      || null)
      .input('ctn',  sql.NVarChar, b.contact_name      || null)
      .input('ctp',  sql.NVarChar, b.contact_phone     || null)
      .input('li',   sql.NVarChar, b.line_id           || null)
      .input('lg',   sql.NVarChar, b.line_group        || null)
      .input('loc',  sql.NVarChar, b.customer_location || null)
      .input('oa',   sql.Int,      request.user.id     || null)
      .input('att',  sql.NVarChar, b.assigned_to_team  || null)
      .input('atu',  sql.Int,      b.assigned_to_user  || null)
      .input('nt',   sql.NVarChar, b.note              || null)
      .input('desc', sql.NVarChar, b.description       || null)
      .input('sol',  sql.NVarChar, b.solution          || null)
      .query(`INSERT INTO specialist_log
        (calllog_id,company_name,subject,problem_type,
         contact_name,contact_phone,line_id,line_group,customer_location,
         original_agent,assigned_to_team,assigned_to_user,note,description,solution)
        OUTPUT INSERTED.id VALUES
        (@cid,@cn,@subj,@pt,@ctn,@ctp,@li,@lg,@loc,@oa,@att,@atu,@nt,@desc,@sol)`);
    // Line notify
    const uname = request.user.name || request.user.username;
    await sendLineNotify(`\n🔧 [Specialist] ${b.company_name||'—'}\nมอบหมายโดย: ${uname}\nทีม: ${b.assigned_to_team||'—'}\n${b.note||''}`);
    res.json({ id: result.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update specialist log
app.put('/api/specialist/:id', authRequired, async (request, res) => {
  try {
    const b  = request.body;
    const id = parseInt(request.params.id);
    const cur = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM specialist_log WHERE id=@id')).recordset[0];
    if (!cur) return res.status(404).json({ error: 'not found' });
    await req()
      .input('id',  sql.Int,      id)
      .input('st',  sql.NVarChar, b.status              ?? cur.status)
      .input('att', sql.NVarChar, b.assigned_to_team    ?? cur.assigned_to_team)
      .input('atu', sql.Int,      b.assigned_to_user    ?? cur.assigned_to_user)
      .input('pr',  sql.NVarChar, b.priority            ?? cur.priority)
      .input('nt',  sql.NVarChar, b.note                ?? cur.note)
      .input('ctn', sql.NVarChar, b.contact_name        ?? cur.contact_name)
      .input('ctp', sql.NVarChar, b.contact_phone       ?? cur.contact_phone)
      .input('li',  sql.NVarChar, b.line_id             ?? cur.line_id)
      .input('lg',  sql.NVarChar, b.line_group          ?? cur.line_group)
      .input('loc', sql.NVarChar, b.customer_location   ?? cur.customer_location)
      .input('rnt', sql.NVarChar, b.resolution_note     ?? cur.resolution_note)
      .input('iid', sql.NVarChar, b.issue_id            ?? cur.issue_id)
      .input('rb',  sql.Int,      b.status==='resolved' ? (request.user.id||null) : cur.resolved_by)
      .input('aby', sql.Int,      b.status==='pending' ? null
                                  : b.hasOwnProperty('accepted_by') ? (b.accepted_by ?? null)
                                  : (b.status==='in_progress' && !cur.accepted_by ? (request.user.id||null) : cur.accepted_by))
      .input('isReassign', sql.Bit, (b.status==='pending') || (b.hasOwnProperty('accepted_by') && b.accepted_by === null) ? 1 : 0)
      .query(`UPDATE specialist_log SET
        status=@st, assigned_to_team=@att, assigned_to_user=@atu, priority=@pr, note=@nt,
        contact_name=@ctn, contact_phone=@ctp, line_id=@li, line_group=@lg,
        customer_location=@loc, resolution_note=@rnt, issue_id=@iid, resolved_by=@rb,
        accepted_by=@aby,
        accepted_at=CASE WHEN @isReassign=1 THEN NULL
                         WHEN @st='in_progress' AND accepted_at IS NULL THEN GETDATE()
                         ELSE accepted_at END,
        resolved_at=CASE WHEN @st='resolved' AND resolved_at IS NULL THEN GETDATE() ELSE resolved_at END,
        updated_at=GETDATE()
        WHERE id=@id`);
    // Notify on reassign
    if (b.hasOwnProperty('accepted_by') && b.accepted_by === null && b.assigned_to_team && b.assigned_to_team !== cur.assigned_to_team) {
      const uname = request.user.name || request.user.username;
      await sendLineNotify(`\n🔄 [Specialist Reassign] ${cur.company_name||'—'}\nจาก: ${cur.assigned_to_team||'—'} → ใหม่: ${b.assigned_to_team}\nโดย: ${uname}${b.note?'\n'+b.note:''}`);
    }
    // Notify on status change
    if (b.status && b.status !== cur.status) {
      const statusLabel = {pending:'รอดำเนินการ',in_progress:'กำลังดำเนินการ',assigned_to_programmer:'Assign to Programmer',resolved:'แก้ไขแล้ว',rejected:'ปฏิเสธ',cancelled:'ยกเลิก'};
      const uname = request.user.name || request.user.username;
      await sendLineNotify(`\n🔧 [Specialist] ${cur.company_name||'—'}\nสถานะ: ${statusLabel[b.status]||b.status}\nโดย: ${uname}${b.resolution_note?'\n'+b.resolution_note:''}`);

      // Auto-close calllog when specialist marks resolved OR assigned_to_programmer
      if (['resolved','assigned_to_programmer'].includes(b.status) && cur.calllog_id && getExtPool()) {
        try {
          const uname = request.user.name || request.user.username || 'Specialist';
          const closeStatus = (await extReq()
            .query(`SELECT TOP 1 StatusId FROM CallStatus
                    WHERE StatusName LIKE '%close%' OR StatusName LIKE '%complete%'
                    ORDER BY StatusName`)).recordset[0];
          if (closeStatus) {
            const solNote = b.status === 'assigned_to_programmer'
              ? `[ส่งต่อ Programmer: ${uname}]${b.resolution_note ? ' ' + b.resolution_note : ''}`
              : `[แก้ไขโดย Specialist: ${uname}]${b.resolution_note ? ' ' + b.resolution_note : ''}`;
            await extReq()
              .input('id',   sql.Int,      cur.calllog_id)
              .input('stid', sql.Int,      closeStatus.StatusId)
              .input('sol',  sql.NVarChar, solNote)
              .query(`UPDATE Calllog
                      SET StatusId=@stid,
                          CloseDate=GETDATE(), DueDate=GETDATE(),
                          Solution=ISNULL(NULLIF(Solution,''), @sol),
                          UpdateDate=GETDATE()
                      WHERE CalllogId=@id`);
          }
        } catch(e) { console.warn('auto-close calllog failed:', e.message); }
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete specialist log (with reason)
app.delete('/api/specialist/:id', authRequired, managerRequired, async (request, res) => {
  try {
    const id     = parseInt(request.params.id);
    const reason = (request.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'กรุณาระบุหมายเหตุการลบ' });

    const row = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM specialist_log WHERE id=@id')).recordset[0];
    if (!row) return res.status(404).json({ error: 'ไม่พบข้อมูล' });

    // Ensure audit log table exists
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='specialist_delete_log')
      CREATE TABLE specialist_delete_log (
        id           INT IDENTITY PRIMARY KEY,
        specialist_id INT,
        company_name NVARCHAR(255),
        subject      NVARCHAR(255),
        status       NVARCHAR(50),
        reason       NVARCHAR(MAX),
        deleted_by   INT,
        deleted_at   DATETIME DEFAULT GETDATE()
      )`);

    await req()
      .input('sid', sql.Int,      id)
      .input('cn',  sql.NVarChar, row.company_name)
      .input('sub', sql.NVarChar, row.subject)
      .input('st',  sql.NVarChar, row.status)
      .input('rsn', sql.NVarChar, reason)
      .input('by',  sql.Int,      request.user.id || null)
      .query(`INSERT INTO specialist_delete_log (specialist_id,company_name,subject,status,reason,deleted_by)
              VALUES (@sid,@cn,@sub,@st,@rsn,@by)`);

    await req().input('id', sql.Int, id)
      .query('DELETE FROM specialist_log WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get contact info from LicenseDB by company name
app.get('/api/specialist/contact-info', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.json({});
    const { company } = request.query;
    if (!company) return res.json({});
    const r = await extReq().input('cn', sql.NVarChar, `%${company}%`)
      .query(`SELECT TOP 1 ContactName, Phone, MobilePhone, Email, Address, City
              FROM CustomerRegistration WHERE CompanyName LIKE @cn AND (Hide=0 OR Hide IS NULL)`);
    res.json(r.recordset[0] || {});
  } catch(e) { res.json({}); }
});

// Convert Thai time input (UTC+7) → UTC datetime string for SQL Server (which stores UTC)
function thaiToUtc(s) {
  if (!s) return null;
  // Append +07:00 so new Date() correctly interprets as UTC+7, then convert to UTC
  const d = new Date(s + ':00+07:00');
  if (isNaN(d)) return null;
  return d.toISOString().replace('T',' ').substring(0, 19); // UTC 'YYYY-MM-DD HH:MM:SS'
}

// Store datetime "face value" — LicenseDB stores local Thai time as-is (no UTC conversion).
// Append Z so mssql sends the face value as UTC, matching how legacy records are stored.
// e.g. user enters "10:30" → DB stores 10:30 → parseDbDate strips Z → shows 10:30 ✓
function faceValueDate(s) {
  if (!s) return null;
  const withZ = s.length === 16 ? s + ':00Z' : (s.endsWith('Z') ? s : s + 'Z');
  const d = new Date(withZ);
  return isNaN(d) ? null : d;
}

init().then(async () => {
  // Drop hardcoded team CHECK constraint so dynamic teams work
  try {
    await getPool().request().query(`
      IF EXISTS (SELECT 1 FROM sys.check_constraints
                 WHERE name='CK_emp_team' AND parent_object_id=OBJECT_ID('employees'))
        ALTER TABLE employees DROP CONSTRAINT CK_emp_team`);
  } catch(e) { console.warn('CK_emp_team drop skipped:', e.message); }

  // Add calluserid column to app_users (LicenseDB Users.UserId)
  try {
    await getPool().request().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('app_users') AND name='calluserid')
        ALTER TABLE app_users ADD calluserid INT NULL`);
  } catch(e) { console.warn('calluserid migration:', e.message); }

  await ensureCustomerLinksTable();
  await ensureRepairTables();
  await ensureSpecialistTable();
  await ensureRequirementsTables();
  await ensureFollowupTable();
  await ensureFollowupV2Tables();

  // Drop CHECK constraint on shifts.shift_type so 'dayoff' can be inserted
  try {
    await getPool().request().query(`
      DECLARE @cn NVARCHAR(200);
      SELECT @cn = cc.CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
      JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE cu ON cc.CONSTRAINT_NAME = cu.CONSTRAINT_NAME
      WHERE cu.TABLE_NAME = 'shifts' AND cu.COLUMN_NAME = 'shift_type';
      IF @cn IS NOT NULL EXEC('ALTER TABLE shifts DROP CONSTRAINT [' + @cn + ']');
    `);
  } catch(e) { console.warn('drop shifts check constraint:', e.message); }

  // Widen shifts.shift_type column to fit longer keys like 'leave_personal'
  try {
    await getPool().request().query(`
      IF EXISTS (
        SELECT 1 FROM sys.columns
        WHERE object_id=OBJECT_ID('shifts') AND name='shift_type' AND max_length < 30
      )
        ALTER TABLE shifts ALTER COLUMN shift_type NVARCHAR(30) NOT NULL;
    `);
  } catch(e) { console.warn('widen shift_type column:', e.message); }

  app.listen(PORT, () => console.log(`🚀 CS Team App running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('❌ Startup failed:', err.message);
  process.exit(1);
});
