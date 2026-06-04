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
const { GoogleGenerativeAI }     = require('@google/generative-ai');

const app        = express();
const PORT       = process.env.PORT || 3010;
const AI_MODEL   = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const JWT_SECRET = process.env.JWT_SECRET || 'cs-team-jwt-secret-change-in-prod';
const genAI      = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '', { apiVersion: 'v1' });

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

// ── Knowledge image upload config ────────────────────────
const skStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, 'knowledge', String(req.params.id || 'tmp'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.png';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9ก-๙._-]/g,'_').substring(0,60);
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});
const skUpload = multer({
  storage: skStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase() || '.png'));
  }
});

// ── Smart filename decoder for Thai/Unicode ───────────────
// busboy 1.x may already return correct UTF-8, OR may return latin1-encoded bytes.
// Check first: if name already contains Thai/Unicode → use as-is.
// Otherwise try latin1→utf8 conversion (legacy browsers / older busboy).
function fixUploadName(raw) {
  if (!raw) return raw;
  if (/[฀-๿-ÿ]/.test(raw)) return raw; // already has real Unicode
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (/[฀-๿]/.test(decoded)) return decoded; // successfully recovered Thai
  } catch (e) {}
  return raw;
}

// ── Service public-portal upload config ──────────────────
const svcPubUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, 'svc', 'tmp');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const name = fixUploadName(file.originalname);
      const ext  = path.extname(name).toLowerCase();
      // Keep Thai chars in disk filename but strip unsafe chars
      const base = path.basename(name, ext)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .slice(0, 60);
      cb(null, `${Date.now()}_${base}${ext}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = fixUploadName(file.originalname);
    cb(null, /\.(jpg|jpeg|png|gif|pdf|xlsx|xls|csv)$/i.test(name));
  }
});

// ── News attachment upload config ────────────────────────
const newsStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, 'news', String(req.params.id || 'tmp'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9ก-๙_-]/g, '_').slice(0,80);
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});
const newsUpload = multer({
  storage: newsStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.(jpg|jpeg|png|gif|webp|pdf|html|htm|doc|docx|xlsx|xls)$/i.test(file.originalname));
  }
});

// ── Error Log table ──────────────────────────────────────
async function ensureErrorLogTable() {
  await getPool().request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='error_log')
    CREATE TABLE error_log (
      id         INT PRIMARY KEY IDENTITY,
      source     NVARCHAR(100) NULL,
      error_msg  NVARCHAR(MAX) NULL,
      context    NVARCHAR(MAX) NULL,
      ip         NVARCHAR(60)  NULL,
      created_at DATETIME DEFAULT GETDATE()
    )`);
}

async function logError(source, error_msg, context, ip) {
  try {
    await getPool().request()
      .input('src', sql.NVarChar, source||null)
      .input('msg', sql.NVarChar, String(error_msg||'').slice(0,2000))
      .input('ctx', sql.NVarChar, context ? JSON.stringify(context).slice(0,2000) : null)
      .input('ip',  sql.NVarChar, ip||null)
      .query(`INSERT INTO error_log (source,error_msg,context,ip) VALUES(@src,@msg,@ctx,@ip)`);
  } catch(e) { console.warn('logError failed:', e.message); }
}

// ── Error Log API ─────────────────────────────────────────
app.get('/api/error-log', authRequired, async (request, res) => {
  try {
    const limit  = Math.min(parseInt(request.query.limit)||100, 500);
    const source = request.query.source || null;
    let where = source ? `WHERE source=@src` : '';
    const rows = (await getPool().request()
      .input('src', sql.NVarChar, source||'')
      .query(`SELECT TOP(${limit}) id,source,error_msg,context,ip,created_at
              FROM error_log ${where} ORDER BY created_at DESC`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/error-log', authRequired, async (request, res) => {
  try {
    const days = parseInt(request.query.days) || 30;
    await getPool().request().input('d', sql.Int, days)
      .query(`DELETE FROM error_log WHERE created_at < DATEADD(day,-@d,GETDATE())`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LINE Settings table ───────────────────────────────────
async function ensureLineNotifyTable() {
  await getPool().request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='line_settings')
      CREATE TABLE line_settings (
        id INT PRIMARY KEY,
        channel_token NVARCHAR(500) NULL,
        updated_at DATETIME DEFAULT GETDATE()
      );
    IF NOT EXISTS (SELECT 1 FROM line_settings WHERE id=1)
      INSERT INTO line_settings (id) VALUES (1);
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='line_notify_targets')
      CREATE TABLE line_notify_targets (
        id INT PRIMARY KEY IDENTITY,
        name NVARCHAR(100) NOT NULL,
        group_id NVARCHAR(100) NOT NULL,
        events NVARCHAR(500) NULL,
        serve_types NVARCHAR(500) NULL,
        active BIT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE()
      );
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('line_notify_targets') AND name='serve_types')
      ALTER TABLE line_notify_targets ADD serve_types NVARCHAR(500) NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('line_notify_targets') AND name='project_ids')
      ALTER TABLE line_notify_targets ADD project_ids NVARCHAR(500) NULL;
  `);
}

// ── Notification helpers ──────────────────────────────────
// opts: { serveType?: string }  — used to filter targets by serve_types when event=service_request
async function sendLineNotify(message, eventType = null, opts = {}) {
  try {
    // Read channel token: DB first, fallback to env
    let token;
    try {
      const tokenRow = (await getPool().request()
        .query(`SELECT channel_token FROM line_settings WHERE id=1`)).recordset[0];
      token = tokenRow?.channel_token || process.env.LINE_CHANNEL_TOKEN;
    } catch { token = process.env.LINE_CHANNEL_TOKEN; }
    if (!token) return;

    // Read active targets
    let targets = [];
    try {
      targets = (await getPool().request()
        .query(`SELECT id, name, group_id, events, serve_types, project_ids FROM line_notify_targets WHERE active=1`)).recordset;
    } catch {
      // Fallback to legacy single group if table not ready
      const groupId = process.env.LINE_GROUP_ID;
      if (groupId) targets = [{ name: 'default', group_id: groupId, events: null, serve_types: null, project_ids: null }];
    }

    for (const target of targets) {
      // Filter by eventType
      if (eventType && target.events) {
        const allowed = target.events.split(',').map(e => e.trim());
        if (!allowed.includes(eventType)) continue;
      }
      // Filter by serve_types (only applies to service_request events)
      if (eventType === 'service_request' && opts.serveType && target.serve_types) {
        const allowedTypes = target.serve_types.split(',').map(s => s.trim()).filter(Boolean);
        if (allowedTypes.length && !allowedTypes.includes(opts.serveType)) continue;
      }
      // Filter by project_ids (only applies to service_request events)
      if (eventType === 'service_request' && opts.projectId && target.project_ids) {
        const allowedProjs = target.project_ids.split(',').map(s => s.trim()).filter(Boolean);
        if (allowedProjs.length && !allowedProjs.includes(String(opts.projectId))) continue;
      }
      try {
        await axios.post('https://api.line.me/v2/bot/message/push',
          { to: target.group_id, messages: [{ type: 'text', text: message.trim() }] },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
      } catch(e) { console.error(`LINE Messaging API error (target: ${target.name}):`, e.response?.data || e.message); }
    }
  } catch(e) { console.error('sendLineNotify error:', e.message); }
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

async function notifyRepairStatus(repairId, jobNo, companyName, newStatus, changedByName, details={}) {
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
  let msg;
  if (newStatus === 'received') {
    msg = `\n🔧 [งานซ่อมใหม่] ${jobNo} — ${companyName}`;
    if (details.device_type)  msg += `\nอุปกรณ์: ${details.device_type}${details.device_model ? ' ' + details.device_model : ''}`;
    if (details.serial_no)    msg += `\nS/N: ${details.serial_no}`;
    if (details.symptom)      msg += `\nอาการ: ${details.symptom}`;
    if (details.contact_name) msg += `\nผู้ติดต่อ: ${details.contact_name}${details.contact_phone ? ' ' + details.contact_phone : ''}`;
    msg += `\nโดย: ${changedByName}\n${new Date().toLocaleString('th-TH')}`;
  } else {
    msg = `\n🔧 [${jobNo}] ${companyName}\nสถานะ: ${label}\nอัพเดทโดย: ${changedByName}\n${new Date().toLocaleString('th-TH')}`;
  }
  await sendLineNotify(msg, newStatus === 'received' ? 'repair_received' : 'repair_status');
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
// - PDF/HTML: inline (browser opens them natively)
// - Office files: force download (avoid redirect to Office Online)
app.use('/uploads', (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (['.xlsx', '.xls', '.csv', '.doc', '.docx'].includes(ext)) {
    const filename = path.basename(req.path);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/octet-stream');
  } else if (ext === '.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
  } else if (['.html', '.htm'].includes(ext)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline');
  }
  next();
}, express.static(UPLOAD_DIR));

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
    let q = `SELECT e.id, e.name, e.nickname, e.team, e.role, e.phone, e.start_date, e.active, e.created_at,
                    au.id AS user_id
             FROM employees e
             LEFT JOIN app_users au ON au.employee_id = e.id AND au.active = 1`;
    const conds = [];
    if (!include_inactive) conds.push('e.active=1');
    // staff: only see themselves
    if (role === 'staff') {
      conds.push('e.id=@myEmpId');
      r.input('myEmpId', sql.Int, request.user.employee_id || 0);
    } else if (role === 'team_lead') {
      // team_lead: only their team
      conds.push('e.team=@myTeam');
      r.input('myTeam', sql.NVarChar, request.user.team || '');
    } else if (team) {
      conds.push('e.team=@team'); r.input('team', sql.NVarChar, team);
    }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY e.team, e.role DESC, e.id';
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
      IF NOT EXISTS (SELECT 1 FROM shift_types WHERE shift_key='leave_office')
        INSERT INTO shift_types (shift_key,name,start_time,end_time,color_bg,color_text,sort_order)
        VALUES ('leave_office',N'หยุดออฟฟิศ (Office)',NULL,NULL,'#e0f2fe','#0369a1',9);
      IF NOT EXISTS (SELECT 1 FROM shift_types WHERE shift_key='leave_annual')
        INSERT INTO shift_types (shift_key,name,start_time,end_time,color_bg,color_text,sort_order)
        VALUES ('leave_annual',N'ลาพักร้อน',NULL,NULL,'#f3e8ff','#6b21a8',7);
    `);
    const rows = (await req().query('SELECT * FROM shift_types ORDER BY sort_order')).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shift-types', authRequired, managerRequired, async (request, res) => {
  try {
    const { shift_key, name, start_time, end_time, color_bg, color_text, sort_order } = request.body;
    if (!shift_key || !name) return res.status(400).json({ error: 'shift_key and name required' });
    const result = await req()
      .input('key',  sql.NVarChar, shift_key.toLowerCase().replace(/\s+/g,'_'))
      .input('name', sql.NVarChar, name)
      .input('st',   sql.NVarChar, start_time || null)
      .input('et',   sql.NVarChar, end_time   || null)
      .input('cbg',  sql.NVarChar, color_bg   || '#f1f5f9')
      .input('ctxt', sql.NVarChar, color_text || '#475569')
      .input('ord',  sql.Int,      sort_order || 99)
      .query(`INSERT INTO shift_types (shift_key,name,start_time,end_time,color_bg,color_text,sort_order)
              OUTPUT INSERTED.id VALUES (@key,@name,@st,@et,@cbg,@ctxt,@ord)`);
    res.json({ id: result.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/shift-types/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, parseInt(request.params.id))
      .query('DELETE FROM shift_types WHERE id=@id');
    res.json({ ok: true });
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

// Bulk generate shifts from weekly pattern for a whole month
app.post('/api/shifts/bulk-generate', authRequired, managerRequired, async (request, res) => {
  try {
    const { month, patterns, overwrite } = request.body;
    // month = 'YYYY-MM', patterns = [{employee_id, days: {0:'morning',1:'morning',...}}]
    // days keys: 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat (JS getDay())
    if (!month || !Array.isArray(patterns) || !patterns.length)
      return res.status(400).json({ error: 'month and patterns required' });

    const [year, mon] = month.split('-').map(Number);
    const daysInMonth = new Date(year, mon, 0).getDate();

    let generated = 0, skipped = 0;
    for (const { employee_id, days } of patterns) {
      if (!employee_id || !days) continue;
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, mon - 1, d);
        const dow  = date.getDay(); // 0=Sun…6=Sat
        const stype = days[dow];
        if (!stype) continue; // no pattern for this weekday → skip
        const dateStr = date.toISOString().split('T')[0];

        if (!overwrite) {
          const ex = await req().input('eid', sql.Int, employee_id).input('dt', sql.Date, dateStr)
            .query('SELECT id FROM shifts WHERE employee_id=@eid AND shift_date=@dt');
          if (ex.recordset.length) { skipped++; continue; }
        }
        await req().input('eid', sql.Int, employee_id).input('dt', sql.Date, dateStr)
          .query('DELETE FROM shifts WHERE employee_id=@eid AND shift_date=@dt');
        await req()
          .input('eid',   sql.Int,      employee_id)
          .input('stype', sql.NVarChar, stype)
          .input('dt',    sql.Date,     dateStr)
          .query('INSERT INTO shifts (employee_id,shift_type,shift_date) VALUES (@eid,@stype,@dt)');
        generated++;
      }
    }
    res.json({ ok: true, generated, skipped });
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
      .input('sol',   sql.NVarChar, resolverNote)
      .query(`UPDATE Calllog
              SET StatusId=@stid, CloseDate=GETDATE(), DueDate=GETDATE(),
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

// ── Batch Import Cases ────────────────────────────────────
app.post('/api/cases/import', authRequired, async (request, res) => {
  if (!getExtPool()) return res.status(503).json({ error: 'LicenseDB not connected' });
  const rows = request.body?.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'ไม่มีข้อมูล' });

  // Pre-load lookup tables once
  const [statusRows, userRows, ptRows] = await Promise.all([
    extReq().query(`SELECT StatusId, StatusName FROM CallStatus`),
    extReq().query(`SELECT UserId, UserName FROM Users WHERE Active=1`),
    extReq().query(`SELECT ProblemTypeId, ProblemTypeDetail FROM ProblemType`),
  ]);
  const statusMap = {}; statusRows.recordset.forEach(r => { statusMap[r.StatusName.toLowerCase()] = r.StatusId; });
  const userMap   = {}; userRows.recordset.forEach(r => { userMap[r.UserName.toLowerCase()] = r.UserId; });
  const ptMap     = {}; ptRows.recordset.forEach(r => { ptMap[(r.ProblemTypeDetail||'').toLowerCase()] = r.ProblemTypeId; });

  // Default status: first "close/complete" status, fallback to first available
  const defaultStatusId = Object.entries(statusMap).find(([k]) => k.includes('close') || k.includes('complete'))?.[1]
    || statusRows.recordset[0]?.StatusId || null;

  const results = [];
  for (const row of rows) {
    try {
      // Lookup RegistrationId by company name
      const regRow = (await extReq().input('cn', sql.NVarChar, row.company_name)
        .query(`SELECT TOP 1 RegistrationId FROM CustomerRegistration WHERE CompanyName=@cn AND Active=1`)).recordset[0];
      if (!regRow) { results.push({ ok: false, error: `ไม่พบร้านค้า: ${row.company_name}` }); continue; }

      // Lookup SupportId / UserId by agent name
      const agentKey = (row.agent_name||'').toLowerCase();
      const supportId = userMap[agentKey] || null;
      if (!supportId) { results.push({ ok: false, error: `ไม่พบ Agent: ${row.agent_name}` }); continue; }

      const ptKey  = (row.problem_type||'').toLowerCase();
      const statusId = row.close_date ? defaultStatusId : (Object.entries(statusMap).find(([k]) => !k.includes('close') && !k.includes('complete'))?.[1] || null);
      const solveType = ['Walk-in','Onsite'].includes(row.inform_type) ? 'Walk-in' : 'Remote';

      const r = await extReq()
        .input('rid',  sql.Int,      regRow.RegistrationId)
        .input('rd',   sql.DateTime, row.receive_date ? new Date(row.receive_date) : new Date())
        .input('cd',   sql.DateTime, row.close_date   ? new Date(row.close_date)   : null)
        .input('desc', sql.NVarChar, row.description  || null)
        .input('iname',sql.NVarChar, row.inform_name  || null)
        .input('itel', sql.NVarChar, row.inform_tel   || null)
        .input('itype',sql.NVarChar, row.inform_type  || 'Phone')
        .input('sid',  sql.Int,      supportId)
        .input('stid', sql.Int,      statusId)
        .input('pid',  sql.Int,      12)
        .input('ptid', sql.Int,      ptMap[ptKey]     || null)
        .input('subj', sql.NVarChar, row.subject      || null)
        .input('sol',  sql.NVarChar, row.solution     || null)
        .input('uid',  sql.Int,      supportId)
        .input('cbid', sql.Int,      row.close_date ? supportId : null)
        .input('solvt',sql.NVarChar, solveType)
        .query(`INSERT INTO Calllog
          (RegistrationId,ReceiveDate,CloseDate,DueDate,CalllogDesc,InformName,InformTel,
           InformType,SupportId,StatusId,ProjectId,ProblemTypeId,Subject,Solution,
           SolveType,UserId,CloseById,Active,InsertDate,UpdateDate)
          OUTPUT INSERTED.CalllogId AS id
          VALUES(@rid,@rd,@cd,@cd,@desc,@iname,@itel,@itype,@sid,@stid,@pid,@ptid,
                 @subj,@sol,@solvt,@uid,@cbid,1,GETDATE(),GETDATE())`);
      results.push({ ok: true, id: r.recordset[0]?.id });
    } catch(e) {
      results.push({ ok: false, error: e.message });
    }
  }
  res.json({ results });
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
      SELECT au.ext_username, ISNULL(e.nickname, e.name) AS display_name, e.team
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const map = {};
    rows.forEach(r => { map[r.ext_username] = r.display_name; });
    // Also expose as detailed map for team lookup: { names: {}, teams: {} }
    res.json(map);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Extended name+team map for KPI
app.get('/api/name-map/full', authRequired, async (_, res) => {
  try {
    const rows = (await req().query(`
      SELECT au.ext_username, ISNULL(e.nickname, e.name) AS display_name, e.team
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const names = {}, teams = {};
    rows.forEach(r => { names[r.ext_username] = r.display_name; teams[r.ext_username] = r.team || ''; });
    res.json({ names, teams });
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

    const r7 = mk();  const sc7 = appendScopeClause(r7, scope);
    const [d1, d2, d3, d4, d5, d6, d7] = await Promise.all([
      // Main KPI per agent
      r1.query(`
        SELECT u.UserName,
          COUNT(cl.CalllogId)  AS total_cases,
          SUM(CASE WHEN cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%complete%' THEN 1 ELSE 0 END) AS closed_cases,
          AVG(CASE WHEN cl.CloseDate IS NOT NULL AND cl.ReceiveDate IS NOT NULL AND cl.CloseDate >= cl.ReceiveDate
                   THEN DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate) END) AS avg_resolve_min,
          AVG(CASE WHEN cl.Stars IS NOT NULL AND cl.Stars > 0 THEN CAST(cl.Stars AS FLOAT) END) AS avg_stars,
          COUNT(CASE WHEN cl.Stars IS NOT NULL AND cl.Stars > 0 THEN 1 END) AS rated_count,
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
      // Grade score per agent: A=4, B=3, C=2, D=1, E/F=0
      r7.query(`
        SELECT u.UserName,
          SUM(CASE s.Grade WHEN 'A' THEN 4 WHEN 'B' THEN 3 WHEN 'C' THEN 2 WHEN 'D' THEN 1 ELSE 0 END) AS total_score,
          AVG(CAST(CASE s.Grade WHEN 'A' THEN 4 WHEN 'B' THEN 3 WHEN 'C' THEN 2 WHEN 'D' THEN 1 ELSE 0 END AS FLOAT)) AS avg_score,
          COUNT(*) AS graded_cases
        FROM Calllog cl
        INNER JOIN Users u ON u.UserId = cl.SupportId
        JOIN Subject s ON s.SubjectName = cl.Subject
        WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e${sc7}
        GROUP BY u.UserName`),
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

    // Build grade score map
    const gradeMap = {};
    d7.recordset.forEach(r => { gradeMap[r.UserName] = r; });

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
        // Grade score (A=4,B=3,C=2,D=1,E/F=0)
        grade_total_score: gradeMap[r.UserName]?.total_score ?? null,
        grade_avg_score:   gradeMap[r.UserName]?.avg_score   ?? null,
        grade_cases:       gradeMap[r.UserName]?.graded_cases ?? 0,
      };
    });

    // Sort: primary = grade_total_score desc (must have ≥10 cases), fallback total_cases
    result.sort((a, b) => {
      const aScore = (a.grade_cases >= 10 ? a.grade_total_score : null) ?? -1;
      const bScore = (b.grade_cases >= 10 ? b.grade_total_score : null) ?? -1;
      return bScore !== aScore ? bScore - aScore : (b.total_cases - a.total_cases);
    });

    res.json({ agents: result, starsDist: d4.recordset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Estimate Stars: preview count ────────────────────────
app.get('/api/kpi/estimate-stars/preview', authRequired, managerRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { dateFrom, dateTo } = request.query;
    const s = dateFrom ? new Date(dateFrom) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const e = dateTo   ? new Date(new Date(dateTo).getTime() + 86400000) : new Date();
    const r = (await extReq()
      .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
      .query(`SELECT COUNT(*) AS cnt FROM Calllog WHERE Active=1 AND Stars IS NULL AND ReceiveDate >= @s AND ReceiveDate < @e`)).recordset[0];
    res.json({ count: r.cnt, dateFrom: s.toISOString().slice(0,10), dateTo: e.toISOString().slice(0,10) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Estimate Stars: save to Calllog ──────────────────────
// Formula: Stars = f(resolve time, close status) — only updates Stars IS NULL
app.post('/api/kpi/estimate-stars', authRequired, managerRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { dateFrom, dateTo } = request.body;
    const s = dateFrom ? new Date(dateFrom) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const e = dateTo   ? new Date(new Date(dateTo).getTime() + 86400000) : new Date();
    const r = await extReq()
      .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
      .query(`
        UPDATE cl
        SET cl.Stars = CASE
          -- ยังไม่ปิดงาน
          WHEN cs.StatusName NOT LIKE '%close%' AND cs.StatusName NOT LIKE '%complete%' THEN 2
          -- มี Subject.TimeToResolve → เทียบกับ SLA ของหัวข้อนั้นโดยตรง
          WHEN cl.CloseDate IS NOT NULL AND s.TimeToResolve IS NOT NULL AND s.TimeToResolve > 0 THEN
            CASE
              WHEN DATEDIFF(minute,cl.ReceiveDate,cl.CloseDate) <= s.TimeToResolve          THEN 5
              WHEN DATEDIFF(minute,cl.ReceiveDate,cl.CloseDate) <= s.TimeToResolve * 1.5    THEN 3
              WHEN DATEDIFF(minute,cl.ReceiveDate,cl.CloseDate) <= s.TimeToResolve * 2      THEN 2
              ELSE 1
            END
          -- ไม่มี Subject match → ใช้ DueDate
          WHEN cl.CloseDate IS NOT NULL AND cl.DueDate IS NOT NULL THEN
            CASE
              WHEN cl.CloseDate <= cl.DueDate                                                THEN 5
              WHEN DATEDIFF(minute,cl.DueDate,cl.CloseDate) <= 30                           THEN 3
              WHEN DATEDIFF(minute,cl.DueDate,cl.CloseDate) <= 120                          THEN 2
              ELSE 1
            END
          -- Fallback: เวลาแก้ไขล้วนๆ
          WHEN cl.CloseDate IS NOT NULL THEN
            CASE
              WHEN DATEDIFF(minute,cl.ReceiveDate,cl.CloseDate) <=  30 THEN 5
              WHEN DATEDIFF(minute,cl.ReceiveDate,cl.CloseDate) <= 120 THEN 4
              WHEN DATEDIFF(minute,cl.ReceiveDate,cl.CloseDate) <= 480 THEN 3
              ELSE 2
            END
          ELSE 2
        END,
        cl.UpdateDate = GETDATE()
        FROM Calllog cl
        INNER JOIN CallStatus cs ON cs.StatusId = cl.StatusId
        LEFT JOIN Subject s ON s.SubjectName = cl.Subject   -- join หัวข้อเพื่อได้ TimeToResolve
        WHERE cl.Active=1 AND cl.Stars IS NULL
          AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e
      `);
    res.json({ ok: true, updated: r.rowsAffected?.[0] ?? 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Specialist KPI ───────────────────────────────────────
app.get('/api/kpi/specialist', authRequired, async (request, res) => {
  try {
    const { dateFrom, dateTo } = request.query;
    let startDate = dateFrom ? new Date(dateFrom) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    let endDate   = dateTo   ? new Date(new Date(dateTo).getTime() + 86400000) : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1);

    // Per-agent stats — no CTE, plain subquery
    const agents = (await req()
      .input('s', sql.DateTime, startDate)
      .input('e', sql.DateTime, endDate)
      .query(`
        SELECT
          ISNULL(e.nickname, e.name)                  AS name,
          e.team,
          COUNT(sl.id)                                AS total_jobs,
          SUM(CASE WHEN sl.status IN ('resolved','assigned_to_programmer') THEN 1 ELSE 0 END) AS resolved_jobs,
          SUM(CASE WHEN sl.status IN ('pending','in_progress','need_more_info') THEN 1 ELSE 0 END) AS pending_jobs,
          SUM(CASE WHEN sl.status = 'rejected' THEN 1 ELSE 0 END) AS rejected_jobs,
          AVG(CASE WHEN sl.resolved_at IS NOT NULL AND sl.assigned_at IS NOT NULL
                        AND sl.resolved_at >= sl.assigned_at
                   THEN DATEDIFF(minute, sl.assigned_at, sl.resolved_at) END) AS avg_resolve_min,
          COALESCE(sl.assigned_to_user, au.employee_id) AS emp_id
        FROM specialist_log sl
        LEFT JOIN app_users au ON au.id = sl.accepted_by
        LEFT JOIN employees e  ON e.id  = COALESCE(sl.assigned_to_user, au.employee_id)
        WHERE sl.assigned_at >= @s AND sl.assigned_at < @e
          AND COALESCE(sl.assigned_to_user, au.employee_id) IS NOT NULL
        GROUP BY COALESCE(sl.assigned_to_user, au.employee_id), e.nickname, e.name, e.team
        ORDER BY total_jobs DESC
      `)).recordset;

    // top problem type per agent
    const topProbRows = (await req()
      .input('s', sql.DateTime, startDate)
      .input('e', sql.DateTime, endDate)
      .query(`
        SELECT emp_id, problem_type FROM (
          SELECT
            COALESCE(sl.assigned_to_user, au.employee_id) AS emp_id,
            sl.problem_type,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(sl.assigned_to_user, au.employee_id)
              ORDER BY COUNT(*) DESC
            ) AS rn
          FROM specialist_log sl
          LEFT JOIN app_users au ON au.id = sl.accepted_by
          WHERE sl.assigned_at >= @s AND sl.assigned_at < @e
            AND sl.problem_type IS NOT NULL
            AND COALESCE(sl.assigned_to_user, au.employee_id) IS NOT NULL
          GROUP BY COALESCE(sl.assigned_to_user, au.employee_id), sl.problem_type
        ) t WHERE rn = 1
      `)).recordset;
    const topProbMap = {};
    topProbRows.forEach(r => { topProbMap[r.emp_id] = r.problem_type; });
    agents.forEach(a => { a.top_problem_type = topProbMap[a.emp_id] || null; });

    // Problem type distribution (all jobs in range)
    const problemTypes = (await req()
      .input('s', sql.DateTime, startDate)
      .input('e', sql.DateTime, endDate)
      .query(`
        SELECT TOP 10 problem_type, COUNT(*) AS cnt
        FROM specialist_log
        WHERE assigned_at >= @s AND assigned_at < @e AND problem_type IS NOT NULL
        GROUP BY problem_type ORDER BY cnt DESC
      `)).recordset;

    res.json({ agents, problemTypes });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    if (timeVal >= 8*60+30 && timeVal <= 17*60+30)  currentShifts.push('morning');
    if (timeVal >= 8*60+30 && timeVal <= 17*60+30)  currentShifts.push('morning2');
    if (timeVal >= 10*60   && timeVal <= 19*60)      currentShifts.push('mid');
    if (timeVal >= 10*60   && timeVal <= 19*60)      currentShifts.push('midday');
    if (timeVal >= 12*60   && timeVal <= 21*60+30)   currentShifts.push('afternoon');
    if (timeVal >= 15*60   || timeVal <= 1*60)       currentShifts.push('night');
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
                WHERE cl.Active=1 AND CAST(cl.ReceiveDate AS DATE)=@today
                GROUP BY cs.StatusName`)).recordset;
      todayTotal = ticketsToday.reduce((s,r) => s + r.cnt, 0);

      // This week (Mon–today)
      weekStart = getMonday(today);
      weekTotal = (await extReq()
        .input('ws', sql.Date, weekStart).input('we', sql.Date, today)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl
                WHERE cl.Active=1 AND CAST(cl.ReceiveDate AS DATE) BETWEEN @ws AND @we`)).recordset[0]?.cnt || 0;

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
                WHERE cl.Active=1
                  AND cl.ReceiveDate >= '2026-01-01'
                  AND cl.ReceiveDate <= DATEADD(hour,-24,GETDATE())
                  AND cs.StatusName NOT LIKE '%close%'
                  AND cs.StatusName NOT LIKE '%ปิด%'
                  AND cs.StatusName NOT LIKE '%complete%'
                ORDER BY cl.ReceiveDate ASC`)).recordset;
      ticketStats = (await extReq()
        .query(`SELECT cs.StatusName AS status, COUNT(*) AS cnt
                FROM Calllog cl
                INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
                WHERE cl.Active=1 AND cl.ReceiveDate >= '2026-01-01'
                GROUP BY cs.StatusName`)).recordset;
      const ms = today.substring(0,7) + '-01';
      const me = new Date(new Date(ms).setMonth(new Date(ms).getMonth()+1));
      kpiSummary = (await extReq()
        .input('s', sql.DateTime, new Date(ms)).input('e', sql.DateTime, me)
        .query(`SELECT TOP 10 u.UserName, COUNT(cl.CalllogId) AS total_cases
                FROM Calllog cl INNER JOIN Users u ON u.UserId=cl.SupportId
                WHERE cl.Active=1 AND cl.ReceiveDate >= @s AND cl.ReceiveDate < @e
                GROUP BY u.UserName ORDER BY total_cases DESC`)).recordset;
      dailyTrend = (await extReq()
        .query(`SELECT CAST(cl.ReceiveDate AS DATE) AS day, COUNT(*) AS cnt
                FROM Calllog cl
                WHERE cl.Active=1 AND cl.ReceiveDate >= DATEADD(day,-30,GETDATE())
                GROUP BY CAST(cl.ReceiveDate AS DATE)
                ORDER BY day`)).recordset;
      const lastMonthStart = new Date(new Date(ms).setMonth(new Date(ms).getMonth()-1)).toISOString().split('T')[0].substring(0,7)+'-01';
      const lastMonthEnd   = new Date(ms);
      monthTotal = (await extReq()
        .input('ms', sql.DateTime, new Date(ms)).input('me', sql.DateTime, me)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me`)).recordset[0]?.cnt || 0;
      lastMonthTotal = (await extReq()
        .input('lms', sql.DateTime, new Date(lastMonthStart)).input('lme', sql.DateTime, lastMonthEnd)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl WHERE cl.Active=1 AND cl.ReceiveDate >= @lms AND cl.ReceiveDate < @lme`)).recordset[0]?.cnt || 0;
      totalYear = (await extReq()
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl WHERE cl.Active=1 AND cl.ReceiveDate >= '2026-01-01'`)).recordset[0]?.cnt || 0;
      closedThisMonth = (await extReq()
        .input('ms', sql.DateTime, new Date(ms)).input('me', sql.DateTime, me)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl
                INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
                WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me
                  AND (cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%ปิด%' OR cs.StatusName LIKE '%complete%')`)).recordset[0]?.cnt || 0;
    }
    const shiftIn  = currentShifts.map((_,i) => `@st${i}`).join(',');
    const shiftReq = req().input('today', sql.Date, today);
    currentShifts.forEach((s,i) => shiftReq.input(`st${i}`, sql.NVarChar, s));
    const onShift = (await shiftReq.query(`
      SELECT s.shift_type, e.id AS employee_id, e.name, e.nickname, e.team, e.role
      FROM shifts s JOIN employees e ON e.id=s.employee_id
      WHERE s.shift_date=@today AND s.shift_type IN (${shiftIn})
        AND s.status='scheduled' AND e.active=1
      ORDER BY e.team, s.shift_type`)).recordset;

    // ── Count Calllog per employee since their shift start ────
    let shiftTaskCounts = {}; // employee_id → count
    if (ext && onShift.length > 0) {
      try {
        const onShiftIds = [...new Set(onShift.map(e => e.employee_id).filter(id => id > 0))];
        if (onShiftIds.length > 0) {
          const cuRows = (await req().query(
            `SELECT employee_id, calluserid FROM app_users WHERE employee_id IN (${onShiftIds.join(',')}) AND calluserid IS NOT NULL AND active=1`
          )).recordset;
          if (cuRows.length > 0) {
            const empToCalluser = {}, calluserToEmp = {};
            cuRows.forEach(r => { empToCalluser[r.employee_id] = r.calluserid; calluserToEmp[r.calluserid] = r.employee_id; });
            const SHIFT_START = { morning:'08:00', morning2:'08:30', midday:'10:00', mid:'10:00', afternoon:'12:00', night:'15:00' };
            // Group by shift_type
            const byShiftType = {};
            onShift.forEach(e => {
              if (!e.employee_id || !empToCalluser[e.employee_id]) return;
              if (!byShiftType[e.shift_type]) byShiftType[e.shift_type] = [];
              byShiftType[e.shift_type].push({ empId: e.employee_id, callId: empToCalluser[e.employee_id] });
            });
            for (const [sType, emps] of Object.entries(byShiftType)) {
              const startTime = SHIFT_START[sType] || '08:00';
              const startDT   = new Date(`${today}T${startTime}:00`);
              const callIds   = emps.map(e => e.callId);
              const r         = extReq().input('st', sql.DateTime, startDT);
              callIds.forEach((cu, i) => r.input(`c${i}`, sql.Int, cu));
              const rows = (await r.query(
                `SELECT SupportId, COUNT(*) AS cnt FROM Calllog WHERE Active=1 AND ReceiveDate>=@st AND SupportId IN (${callIds.map((_,i)=>`@c${i}`).join(',')}) GROUP BY SupportId`
              )).recordset;
              rows.forEach(row => {
                const emp = emps.find(e => e.callId === row.SupportId);
                if (emp) shiftTaskCounts[emp.empId] = row.cnt;
              });
            }
          }
        }
      } catch(err) { console.warn('shiftTaskCounts error:', err.message); }
    }

    const pendingLeaves = (await req()
      .query(`SELECT lr.*, e.name AS emp_name, e.team
              FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id
              WHERE lr.status='pending' ORDER BY lr.leave_date`)).recordset;
    // Build ext_username → employee name map
    const nameMapRows = (await req().query(`
      SELECT au.ext_username, ISNULL(e.nickname, e.name) AS display_name
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const nameMap = {};
    nameMapRows.forEach(r => { nameMap[r.ext_username] = r.display_name; });

    res.json({
      ticketsToday, overdueTickets, ticketStats,
      kpiSummary, onShift, pendingLeaves,
      currentShifts, serverTime: now.toISOString(),
      extConnected: !!ext,
      dailyTrend, monthTotal, lastMonthTotal, totalYear, closedThisMonth,
      todayTotal, weekTotal, weekStart, nameMap, shiftTaskCounts
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
  if (timeVal >= 8*60+30 && timeVal <= 17*60+30)  currentShifts.push('morning');
  if (timeVal >= 8*60+30 && timeVal <= 17*60+30)  currentShifts.push('morning2');
  if (timeVal >= 10*60   && timeVal <= 19*60)      currentShifts.push('mid');
  if (timeVal >= 10*60   && timeVal <= 19*60)      currentShifts.push('midday');
  if (timeVal >= 12*60   && timeVal <= 21*60+30)   currentShifts.push('afternoon');
  if (timeVal >= 15*60   || timeVal <= 1*60)       currentShifts.push('night');
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
    SELECT s.shift_type, e.name, e.nickname, e.team, e.role
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

    const model = genAI.getGenerativeModel({ model: AI_MODEL, systemInstruction: systemPrompt });
    // Convert history to Gemini format (role: user|model)
    const geminiHistory = history.slice(-8).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    const chat   = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessage(message);
    res.json({ reply: result.response.text() });
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

    const model  = genAI.getGenerativeModel({ model: AI_MODEL });
    const result = await model.generateContent(prompt);
    res.json({ summary: result.response.text() });
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

    const model  = genAI.getGenerativeModel({ model: AI_MODEL });
    const result = await model.generateContent(prompt);
    let text = result.response.text().trim()
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

    const model  = genAI.getGenerativeModel({ model: AI_MODEL });
    const result = await model.generateContent(prompt);
    res.json({ analysis: result.response.text() });
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
    const { token, ticket_id, contact_name, contact_phone, email, message } = request.body;
    if (!token || !message) return res.status(400).json({ error: 'token และ message จำเป็น' });
    if (!contact_name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อผู้ติดต่อ' });
    const link = await req().input('tok', sql.NVarChar, token)
      .query('SELECT company_name FROM customer_links WHERE token=@tok');
    if (!link.recordset.length) return res.status(404).json({ error: 'link ไม่พบ' });
    const company_name = link.recordset[0].company_name;
    // Ensure columns exist (idempotent)
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ticket_complaints' AND COLUMN_NAME='contact_name')
        ALTER TABLE ticket_complaints ADD contact_name NVARCHAR(200) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ticket_complaints' AND COLUMN_NAME='contact_phone')
        ALTER TABLE ticket_complaints ADD contact_phone NVARCHAR(50) NULL;
    `);
    await req()
      .input('tid',  sql.Int,      ticket_id || null)
      .input('cn',   sql.NVarChar, company_name)
      .input('cname',sql.NVarChar, contact_name.trim())
      .input('ctel', sql.NVarChar, contact_phone || null)
      .input('em',   sql.NVarChar, email || null)
      .input('msg',  sql.NVarChar, message)
      .query(`INSERT INTO ticket_complaints (ticket_id, company_name, contact_name, contact_phone, email, message)
              VALUES (@tid, @cn, @cname, @ctel, @em, @msg)`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUBLIC — submit complaint direct (no token, no auth)
app.post('/api/public/complaint/direct', async (request, res) => {
  try {
    const { company_name, contact_name, contact_phone, email, message } = request.body;
    if (!company_name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อร้าน / บริษัท' });
    if (!message?.trim())      return res.status(400).json({ error: 'กรุณาระบุข้อความร้องเรียน' });
    await req()
      .input('cn',   sql.NVarChar, company_name.trim())
      .input('cname',sql.NVarChar, contact_name?.trim() || null)
      .input('ctel', sql.NVarChar, contact_phone || null)
      .input('em',   sql.NVarChar, email || null)
      .input('msg',  sql.NVarChar, message.trim())
      .query(`INSERT INTO ticket_complaints (company_name, contact_name, contact_phone, email, message)
              VALUES (@cn, @cname, @ctel, @em, @msg)`);
    await sendLineNotify(`\n📣 [ร้องเรียนใหม่] ${company_name.trim()}${contact_name?` | ${contact_name.trim()}`:''}${contact_phone?` | ${contact_phone}`:''}\n"${message.trim().substring(0,100)}${message.trim().length>100?'…':''}"`, 'complaint');
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

// INTERNAL — update complaint status (general)
app.put('/api/complaints/:id/status', authRequired, async (request, res) => {
  try {
    const VALID = ['pending','in_progress','resolved','rejected','cancelled'];
    const status = request.body?.status;
    if (!VALID.includes(status)) return res.status(400).json({ error: 'status ไม่ถูกต้อง' });
    const isClosed = ['resolved','rejected','cancelled'].includes(status);
    await req()
      .input('id',  sql.Int,      parseInt(request.params.id))
      .input('st',  sql.NVarChar, status)
      .input('by',  sql.Int,      request.user.employee_id || null)
      .query(`UPDATE ticket_complaints
              SET status=@st,
                  resolved_at = CASE WHEN @st IN ('resolved','rejected','cancelled') THEN GETDATE() ELSE NULL END,
                  resolved_by = CASE WHEN @st IN ('resolved','rejected','cancelled') THEN @by  ELSE NULL END
              WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// INTERNAL — resolve complaint (legacy, kept for compat)
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

// Generate job number RJ-YYYYMM-XXXX (uses MAX to handle gaps from deleted records)
async function genJobNo() {
  const ym = new Date().toISOString().substring(0,7).replace('-','');
  const prefix = `RJ-${ym}-`;
  const row = await req()
    .query(`SELECT ISNULL(MAX(CAST(SUBSTRING(job_no, ${prefix.length + 1}, 4) AS INT)), 0) + 1 AS n
            FROM repair_jobs
            WHERE job_no LIKE '${prefix}%'`);
  const seq = String(row.recordset[0].n).padStart(4, '0');
  return `${prefix}${seq}`;
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
      `SELECT COUNT(*) AS cnt FROM ticket_complaints WHERE status IN ('pending','in_progress')`);

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
    await sendLineNotify(`\n↩️ [${job.job_no}] ${job.company_name}\nAdmin ตอบ: ${sender}\n"${message.trim()}"`, 'repair_message');

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
      .query(`SELECT rj.*, ISNULL(e.nickname, e.name) AS reporter_name
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
      job_no:           job.job_no,
      company_name:     job.company_name,
      device_type:      job.device_type,
      device_model:     job.device_model,
      serial_no:        job.serial_no,
      status:           job.status,
      finance_status:   job.finance_status,
      reported_at:      job.reported_at,
      updated_at:       job.updated_at,
      // dates (for legacy status mapping)
      received_date:               job.received_date,
      sent_supplier_date:          job.sent_supplier_date,
      returned_from_supplier_date: job.returned_from_supplier_date,
      returned_to_customer_date:   job.returned_to_customer_date,
      // problem detail
      symptom:          job.symptom,
      initial_fix:      job.initial_fix,
      remark:           job.remark,
      taken_back_items: job.taken_back_items,
      // warranty
      warranty:         job.warranty,
      warranty_expire:  job.warranty_expire,
      // quotation
      quote_no:         job.quote_no,
      quote_date:       job.quote_date,
      // spare device
      spare_serial_no:  job.spare_serial_no,
      device_location:  job.device_location,
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
      .input('tnote', sql.NVarChar, 'ลูกค้าแจ้งซ่อมผ่านระบบออนไลน์')
      .query(`INSERT INTO repair_timeline (repair_id,field_changed,new_value,note)
              VALUES (@rid,N'status',N'received',@tnote)`);

    const fileNote = request.files?.length ? ` (แนบรูป ${request.files.length} ไฟล์)` : '';
    // LINE notify is best-effort — don't fail the request if it errors
    sendLineNotify(`\n🔧 [แจ้งซ่อมใหม่] ${b.company_name}\nJob: ${newJob}\nอุปกรณ์: ${b.device_type||'—'} ${b.device_model||''}\nS/N: ${b.serial_no||'—'}\nอาการ: ${b.symptom}\nผู้แจ้ง: ${b.contact_name} ${b.contact_phone}${fileNote}`, 'repair_received').catch(()=>{});

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
    await sendLineNotify(`\n💬 [${job.job_no}] ${job.company_name}\nข้อความจาก: ${displayName}\n"${message.trim()}"`, 'repair_message');
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
    let q = `SELECT rj.*, ISNULL(e.nickname, e.name) AS reporter_name, ISNULL(e2.nickname, e2.name) AS updater_name
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

// Lightweight badge: count all open (non-closed) repair jobs — no date filter
app.get('/api/repair/badge', authRequired, async (request, res) => {
  try {
    const r = await req().query(
      `SELECT COUNT(*) AS cnt FROM repair_jobs
       WHERE status NOT IN ('returned','cancelled')`);
    res.json({ open: r.recordset[0]?.cnt || 0 });
  } catch(e) { res.json({ open: 0 }); }
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
        .query(`SELECT rj.*, ISNULL(e.nickname, e.name) AS reporter_name, ISNULL(e2.nickname, e2.name) AS updater_name
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

// Toggle acknowledge
app.patch('/api/repair/:id/acknowledge', authRequired, async (request, res) => {
  try {
    const id  = parseInt(request.params.id);
    const val = request.body.acknowledged ? 1 : 0;
    await req().input('id', sql.Int, id).input('v', sql.Bit, val)
      .input('by', sql.Int, request.user.id || null)
      .query(`UPDATE repair_jobs SET
                acknowledged=@v,
                acknowledged_at=${val ? 'GETDATE()' : 'NULL'},
                acknowledged_by=${val ? '@by' : 'NULL'}
              WHERE id=@id`);
    res.json({ acknowledged: val });
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
      .input('nv', sql.NVarChar, 'received').input('nt', sql.NVarChar, 'สร้างงานใหม่')
      .query(`INSERT INTO repair_timeline (repair_id,field_changed,new_value,changed_by,note)
              VALUES (@rid,N'status',@nv,@by,@nt)`);
    // Line notify
    const uname = request.user.name || request.user.username;
    await notifyRepairStatus(newId, newJob, b.company_name||'—', 'received', uname, {
      device_type: b.device_type, device_model: b.device_model,
      serial_no: b.serial_no, symptom: b.symptom,
      contact_name: b.contact_name, contact_phone: b.contact_phone
    });
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
//  SW UPDATE JOBS
// ══════════════════════════════════════════════════════════

// GET /api/sw-update/badge — MUST be before /api/sw-update/:id
app.get('/api/sw-update/badge', authRequired, async (request, res) => {
  try {
    const r = (await req()
      .query(`SELECT COUNT(*) AS cnt FROM sw_update_jobs WHERE status NOT IN ('done','cancelled')`))
      .recordset[0];
    res.json({ count: r?.cnt || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sw-update
app.get('/api/sw-update', authRequired, async (request, res) => {
  try {
    const { status, priority, q } = request.query;
    let where = 'WHERE 1=1';
    const r = req();
    if (status)   { where += ' AND j.status=@st';   r.input('st', sql.NVarChar, status); }
    if (priority) { where += ' AND j.priority=@pr'; r.input('pr', sql.NVarChar, priority); }
    if (q) {
      where += ' AND (j.company_name LIKE @q OR j.description LIKE @q OR j.azure_id LIKE @q)';
      r.input('q', sql.NVarChar, `%${q}%`);
    }
    const rows = (await r.query(`
      SELECT j.*, ISNULL(e.nickname, e.name) AS reporter_name
      FROM sw_update_jobs j
      LEFT JOIN app_users au ON au.id = j.reported_by
      LEFT JOIN employees e  ON e.id  = au.employee_id
      ${where}
      ORDER BY j.created_at DESC
    `)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sw-update
app.post('/api/sw-update', authRequired, async (request, res) => {
  try {
    const b = request.body;
    // Guard: prevent duplicate SW Update for the same FU issue
    if (b.fu_issue_id) {
      const dup = (await req()
        .input('fuid', sql.Int, b.fu_issue_id)
        .query('SELECT id FROM sw_update_jobs WHERE fu_issue_id=@fuid')).recordset[0];
      if (dup) return res.status(409).json({ error: `มีงานอัพเดท SW #${dup.id} สำหรับ Follow Up นี้อยู่แล้ว`, existing_id: dup.id });
    }
    const result = await req()
      .input('rid',  sql.Int,      b.registration_id   || null)
      .input('cn',   sql.NVarChar, b.company_name       || null)
      .input('rd',   sql.Date,     b.received_date    ? new Date(b.received_date) : null)
      .input('ad',   sql.Date,     b.appointment_date ? new Date(b.appointment_date) : null)
      .input('pr',   sql.NVarChar, b.priority          || 'normal')
      .input('st',   sql.NVarChar, b.status            || 'pending')
      .input('desc', sql.NVarChar, b.description        || null)
      .input('azid', sql.NVarChar, b.azure_id           || null)
      .input('ver',  sql.NVarChar, b.version_recommend  || null)
      .input('rb',   sql.Int,      b.reported_by        || null)
      .input('fuid', sql.Int,      b.fu_issue_id        || null)
      .input('cb',   sql.Int,      request.user.id)
      .query(`INSERT INTO sw_update_jobs
        (registration_id,company_name,received_date,appointment_date,
         priority,status,description,azure_id,version_recommend,
         reported_by,fu_issue_id,created_by)
        OUTPUT INSERTED.id
        VALUES(@rid,@cn,@rd,@ad,@pr,@st,@desc,@azid,@ver,@rb,@fuid,@cb)`);
    res.json({ id: result.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/sw-update/:id
app.put('/api/sw-update/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b  = request.body;
    // Fetch fu_issue_id before update (stored at creation)
    const cur = (await req().input('id', sql.Int, id)
      .query('SELECT fu_issue_id FROM sw_update_jobs WHERE id=@id')).recordset[0];
    await req()
      .input('id',   sql.Int,      id)
      .input('rid',  sql.Int,      b.registration_id   || null)
      .input('cn',   sql.NVarChar, b.company_name       || null)
      .input('rd',   sql.Date,     b.received_date    ? new Date(b.received_date) : null)
      .input('ad',   sql.Date,     b.appointment_date ? new Date(b.appointment_date) : null)
      .input('pr',   sql.NVarChar, b.priority          || 'normal')
      .input('st',   sql.NVarChar, b.status            || 'pending')
      .input('desc', sql.NVarChar, b.description        || null)
      .input('azid', sql.NVarChar, b.azure_id           || null)
      .input('ver',  sql.NVarChar, b.version_recommend  || null)
      .input('rb',   sql.Int,      b.reported_by        || null)
      .input('ub',   sql.Int,      request.user.id)
      .query(`UPDATE sw_update_jobs SET
        registration_id=@rid, company_name=@cn,
        received_date=@rd, appointment_date=@ad,
        priority=@pr, status=@st,
        description=@desc, azure_id=@azid,
        version_recommend=@ver, reported_by=@rb,
        updated_at=GETDATE(), updated_by=@ub
        WHERE id=@id`);
    // Auto-resolve linked Follow Up when SW Update is done
    if (b.status === 'done' && cur?.fu_issue_id) {
      try {
        await req().input('fuid', sql.Int, cur.fu_issue_id)
          .query(`UPDATE fu_issues SET status='resolved', updated_at=GETDATE()
                  WHERE id=@fuid AND status NOT IN ('resolved','cancelled')`);
      } catch(e) { console.warn('fu auto-resolve failed:', e.message); }
    }
    res.json({ ok: true, fu_issue_id: cur?.fu_issue_id || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/sw-update/:id
app.delete('/api/sw-update/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, parseInt(request.params.id))
      .query('DELETE FROM sw_update_jobs WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
  const { name, display_name, color, sort_order, active, show_in_schedule } = request.body;
  try {
    await req()
      .input('name',             sql.NVarChar, name)
      .input('display_name',     sql.NVarChar, display_name)
      .input('color',            sql.NVarChar, color      || '#2563eb')
      .input('sort_order',       sql.Int,      sort_order || 0)
      .input('active',           sql.Bit,      active     ?? 1)
      .input('show_in_schedule', sql.Bit,      show_in_schedule ?? 1)
      .input('id',               sql.Int,      request.params.id)
      .query(`UPDATE teams SET name=@name, display_name=@display_name,
              color=@color, sort_order=@sort_order, active=@active,
              show_in_schedule=@show_in_schedule WHERE id=@id`);
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
      name: user.name, nickname: user.nickname || null, team: user.team
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
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
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me
          AND (cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%ปิด%' OR cs.StatusName LIKE '%complete%')${sc9}`),
      // Hour × Agent heatmap
      r10.query(`SELECT DATEPART(hour, cl.ReceiveDate) AS hr, u.UserName, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc10}
        GROUP BY DATEPART(hour, cl.ReceiveDate), u.UserName
        ORDER BY hr, u.UserName`),
      // Closed count previous period
      r11.query(`SELECT COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        INNER JOIN CallStatus cs ON cs.StatusId = cl.StatusId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me
          AND (cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%ปิด%' OR cs.StatusName LIKE '%complete%')${sc11}`),
    ]);

    // Build ext_username → employee name map
    const nameMapRows = (await req().query(`
      SELECT au.ext_username, ISNULL(e.nickname, e.name) AS display_name
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const nameMap = {};
    nameMapRows.forEach(r => { nameMap[r.ext_username] = r.display_name; });

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
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY ยังไม่ได้ตั้งค่าใน .env' });
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
    if (timeVal >= 8*60+30  && timeVal <= 17*60+30) curShifts.push('morning');
    if (timeVal >= 8*60+30  && timeVal <= 17*60+30) curShifts.push('morning2');
    if (timeVal >= 10*60    && timeVal <= 19*60)     curShifts.push('mid');
    if (timeVal >= 10*60    && timeVal <= 19*60)     curShifts.push('midday');
    if (timeVal >= 12*60    && timeVal <= 21*60+30)  curShifts.push('afternoon');
    if (timeVal >= 15*60   || timeVal <= 1*60)       curShifts.push('night');
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

    const model  = genAI.getGenerativeModel({ model: AI_MODEL });
    const stream = await model.generateContentStream(prompt);

    for await (const chunk of stream.stream) {
      const text = chunk.text();
      if (text) send('delta', { text });
    }

    send('done', { inputTokens: 0, outputTokens: 0 });

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
             ISNULL(ea.nickname, ea.name) AS assigned_to_name,
             b.id AS board_id, b.name AS board_name,
             f.id AS folder_id, f.name AS folder_name
      FROM fu_issues i
      JOIN fu_boards b ON b.id = i.board_id
      JOIN fu_folders f ON f.id = b.folder_id
      LEFT JOIN employees ea ON ea.id = i.assigned_to
      WHERE f.group_id = @gid
      ORDER BY
        CASE i.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        i.created_at DESC
    `)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/public/track/:token/fu-boards ───────────────
// Returns folders + boards for this customer group (for issue/board creation UI)
app.get('/api/public/track/:token/fu-boards', async (request, res) => {
  try {
    const tok  = request.params.token;
    const link = (await req().input('tok',sql.NVarChar,tok)
      .query('SELECT * FROM customer_links WHERE token=@tok')).recordset[0];
    if (!link) return res.status(404).json({ error: 'Link ไม่พบ' });
    if (!link.group_id) return res.json([]);

    const rows = (await req().input('gid',sql.Int,link.group_id).query(`
      SELECT f.id AS folder_id, f.name AS folder_name, f.color AS folder_color,
             b.id AS board_id, b.name AS board_name,
             (SELECT COUNT(*) FROM fu_issues i WHERE i.board_id=b.id) AS issue_count
      FROM fu_folders f
      JOIN fu_boards b ON b.folder_id=f.id
      WHERE f.group_id = @gid
      ORDER BY f.name, b.name
    `)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/public/track/:token/fu-board ───────────────
// Create a new board in a folder belonging to this group
app.post('/api/public/track/:token/fu-board', async (request, res) => {
  try {
    const tok  = request.params.token;
    const { folder_id, name } = request.body;
    if (!name?.trim())   return res.status(400).json({ error: 'กรุณาระบุชื่อ Board' });
    if (!folder_id)      return res.status(400).json({ error: 'กรุณาระบุ Folder' });

    const link = (await req().input('tok',sql.NVarChar,tok)
      .query('SELECT * FROM customer_links WHERE token=@tok')).recordset[0];
    if (!link) return res.status(404).json({ error: 'Link ไม่พบ' });
    if (!link.group_id) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });

    // Verify folder belongs to this group
    const folder = (await req().input('fid',sql.Int,parseInt(folder_id)).input('gid',sql.Int,link.group_id)
      .query('SELECT id FROM fu_folders WHERE id=@fid AND group_id=@gid')).recordset[0];
    if (!folder) return res.status(403).json({ error: 'Folder ไม่พบหรือไม่มีสิทธิ์' });

    const r = await req().input('fid',sql.Int,parseInt(folder_id)).input('n',sql.NVarChar,name.trim())
      .query(`INSERT INTO fu_boards(folder_id,name) OUTPUT INSERTED.id VALUES(@fid,@n)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/public/track/:token/fu-issue ───────────────
// Create a new issue in a board belonging to this group
app.post('/api/public/track/:token/fu-issue', async (request, res) => {
  try {
    const tok  = request.params.token;
    const { board_id, detail, category, priority, note, due_date } = request.body;
    if (!board_id)       return res.status(400).json({ error: 'กรุณาระบุ Board' });
    if (!detail?.trim()) return res.status(400).json({ error: 'กรุณาระบุหัวข้อปัญหา' });

    const link = (await req().input('tok',sql.NVarChar,tok)
      .query('SELECT * FROM customer_links WHERE token=@tok')).recordset[0];
    if (!link) return res.status(404).json({ error: 'Link ไม่พบ' });
    if (!link.group_id) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });

    // Verify board belongs to a folder in this group
    const board = (await req().input('bid',sql.Int,parseInt(board_id)).input('gid',sql.Int,link.group_id)
      .query(`SELECT b.id FROM fu_boards b
              JOIN fu_folders f ON f.id=b.folder_id
              WHERE b.id=@bid AND f.group_id=@gid`)).recordset[0];
    if (!board) return res.status(403).json({ error: 'Board ไม่พบหรือไม่มีสิทธิ์' });

    const r = await req()
      .input('bid',sql.Int,parseInt(board_id))
      .input('det',sql.NVarChar,detail.trim())
      .input('cat',sql.NVarChar,category||null)
      .input('pri',sql.NVarChar,priority||'normal')
      .input('dd', sql.Date,    due_date||null)
      .input('nt', sql.NVarChar,note||null)
      .query(`INSERT INTO fu_issues(board_id,detail,category,priority,due_date,note)
              OUTPUT INSERTED.id VALUES(@bid,@det,@cat,@pri,@dd,@nt)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/public/track/:token/fu-issue/:id ────────────
// Customer edits their own issue (detail, category, priority, due_date, note)
app.put('/api/public/track/:token/fu-issue/:id', async (request, res) => {
  try {
    const tok = request.params.token;
    const id  = parseInt(request.params.id);
    const { detail, category, priority, note, due_date } = request.body;
    if (!detail?.trim()) return res.status(400).json({ error: 'กรุณาระบุหัวข้อปัญหา' });

    const link = (await req().input('tok',sql.NVarChar,tok)
      .query('SELECT * FROM customer_links WHERE token=@tok')).recordset[0];
    if (!link) return res.status(404).json({ error: 'Link ไม่พบ' });
    if (!link.group_id) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });

    // Verify issue belongs to a board in this group
    const issue = (await req().input('id',sql.Int,id).input('gid',sql.Int,link.group_id)
      .query(`SELECT i.id FROM fu_issues i
              JOIN fu_boards b ON b.id=i.board_id
              JOIN fu_folders f ON f.id=b.folder_id
              WHERE i.id=@id AND f.group_id=@gid`)).recordset[0];
    if (!issue) return res.status(403).json({ error: 'Issue ไม่พบหรือไม่มีสิทธิ์' });

    await req()
      .input('id',  sql.Int,     id)
      .input('det', sql.NVarChar, detail.trim())
      .input('cat', sql.NVarChar, category||null)
      .input('pri', sql.NVarChar, priority||'normal')
      .input('dd',  sql.Date,    due_date||null)
      .input('nt',  sql.NVarChar, note||null)
      .query(`UPDATE fu_issues SET detail=@det,category=@cat,priority=@pri,due_date=@dd,note=@nt,updated_at=GETDATE() WHERE id=@id`);
    res.json({ ok: true });
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
      ['repair_jobs',     'public_token',    'NVARCHAR(48) NULL'],
      ['repair_jobs',     'acknowledged',    'BIT DEFAULT 0'],
      ['repair_jobs',     'acknowledged_at', 'DATETIME NULL'],
      ['repair_jobs',     'acknowledged_by', 'INT NULL'],
      ['repair_timeline', 'read_at',         'DATETIME NULL'],
      ['repair_timeline', 'replied_at',      'DATETIME NULL'],
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
      ['issue_id',        'NVARCHAR(100) NULL'],
      ['accepted_by',     'INT NULL'],
      ['accepted_at',     'DATETIME NULL'],
      ['description',     'NVARCHAR(MAX) NULL'],
      ['solution',        'NVARCHAR(MAX) NULL'],
      ['registration_id',  'INT NULL'],
      ['inform_type',      'NVARCHAR(50) NULL'],
      ['problem_type_id',  'INT NULL'],
      ['subject_id',       'INT NULL'],
    ]) {
      try {
        await req().query(`
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('specialist_log') AND name='${col}')
            ALTER TABLE specialist_log ADD ${col} ${def}`);
      } catch {}
    }
    // ── specialist_comments ────────────────────────────
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='specialist_comments' AND xtype='U')
      CREATE TABLE specialist_comments (
        id         INT PRIMARY KEY IDENTITY,
        sp_id      INT NOT NULL,
        user_id    INT NOT NULL,
        body       NVARCHAR(MAX) NOT NULL,
        created_at DATETIME DEFAULT GETDATE()
      )`);
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
    await sendLineNotify(`\n🔁 [Follow Up ใหม่] ${b.company_name||'—'}\n📋 ${b.subject}\nทีมที่รับ: ${b.assigned_to_team}\nสร้างโดย: ${uname}`, 'followup');
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
    try { await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('fu_issues') AND name='sp_ref') ALTER TABLE fu_issues ADD sp_ref INT NULL`); } catch(e2) {}
    try { await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('fu_issues') AND name='issue_url') ALTER TABLE fu_issues ADD issue_url NVARCHAR(500) NULL`); } catch(e2) {}
    console.log('✅ Follow Up v2 tables ready');
  } catch(e) { console.error('❌ Follow Up v2 tables error:', e.message); }
}

// ══ FOLLOW UP v2 — SUMMARY (sidebar stats) ══
app.get('/api/fu/summary', authRequired, async (request, res) => {
  try {
    const [statusRows, staleRows] = await Promise.all([
      req().query(`
        SELECT status, COUNT(*) AS cnt
        FROM fu_issues
        GROUP BY status`),
      req().query(`
        SELECT
          SUM(CASE WHEN DATEDIFF(day,updated_at,GETDATE()) BETWEEN 7  AND 13 THEN 1 ELSE 0 END) AS d7,
          SUM(CASE WHEN DATEDIFF(day,updated_at,GETDATE()) BETWEEN 14 AND 29 THEN 1 ELSE 0 END) AS d14,
          SUM(CASE WHEN DATEDIFF(day,updated_at,GETDATE()) >= 30              THEN 1 ELSE 0 END) AS d30
        FROM fu_issues
        WHERE status NOT IN ('resolved','cancelled')`)
    ]);
    const statusMap = {};
    statusRows.recordset.forEach(r => { statusMap[r.status] = r.cnt; });
    res.json({ status: statusMap, stale: staleRows.recordset[0] || { d7:0, d14:0, d30:0 } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ FOLLOW UP v2 — OVERVIEW (manager tab) ══
app.get('/api/fu/overview', authRequired, async (request, res) => {
  try {
    const [boardRows, staleRows, assigneeRows] = await Promise.all([
      req().query(`
        SELECT
          f.id AS folder_id, f.name AS folder_name,
          b.id AS board_id,  b.name AS board_name,
          ISNULL(i.status,'none') AS status,
          COUNT(i.id) AS cnt
        FROM fu_folders f
        JOIN fu_boards b ON b.folder_id = f.id
        LEFT JOIN fu_issues i ON i.board_id = b.id
        GROUP BY f.id, f.name, b.id, b.name, i.status
        ORDER BY f.name, b.name, i.status`),
      req().query(`
        SELECT TOP 20
          i.id, i.detail, i.status, i.priority,
          DATEDIFF(day, i.updated_at, GETDATE()) AS days_stale,
          ISNULL(e.nickname, e.name) AS assigned_name,
          b.id AS board_id, b.name AS board_name, f.name AS folder_name
        FROM fu_issues i
        LEFT JOIN employees e ON e.id = i.assigned_to
        LEFT JOIN fu_boards b ON b.id = i.board_id
        LEFT JOIN fu_folders f ON f.id = b.folder_id
        WHERE i.status NOT IN ('resolved','cancelled')
          AND DATEDIFF(day, i.updated_at, GETDATE()) >= 7
        ORDER BY days_stale DESC`),
      req().query(`
        SELECT
          i.assigned_to,
          ISNULL(e.nickname, e.name) AS assignee_name,
          i.status,
          COUNT(i.id) AS cnt
        FROM fu_issues i
        LEFT JOIN employees e ON e.id = i.assigned_to
        WHERE i.status NOT IN ('resolved','cancelled')
        GROUP BY i.assigned_to, ISNULL(e.nickname, e.name), i.status
        ORDER BY assignee_name, i.status`)
    ]);
    res.json({ boards: boardRows.recordset, stale: staleRows.recordset, assignee: assigneeRows.recordset });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ FOLLOW UP v2 — ISSUES BY ASSIGNEE (Tab 3) ══
app.get('/api/fu/by-assignee', authRequired, async (request, res) => {
  try {
    const result = await req().query(`
      SELECT
        i.id, i.detail, i.note, i.branch, i.status, i.priority, i.category,
        i.due_date, i.issue_url, i.assigned_to, i.created_by,
        ISNULL(e.nickname, e.name)   AS assignee_name,
        ISNULL(e.nickname, e.name)   AS assigned_to_name,
        ISNULL(ec.nickname, ec.name) AS created_by_name,
        DATEDIFF(day, i.updated_at, GETDATE()) AS days_stale,
        (SELECT COUNT(*) FROM fu_comments c WHERE c.issue_id=i.id) AS comment_count,
        (SELECT TOP 1 c.created_at FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_at,
        (SELECT TOP 1 c.body       FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_body,
        b.id AS board_id,  b.name AS board_name,
        f.id AS folder_id, f.name AS folder_name
      FROM fu_issues i
      LEFT JOIN employees  e  ON e.id  = i.assigned_to
      LEFT JOIN app_users  uc ON uc.id = i.created_by
      LEFT JOIN employees  ec ON ec.id = uc.employee_id
      LEFT JOIN fu_boards  b  ON b.id  = i.board_id
      LEFT JOIN fu_folders f  ON f.id  = b.folder_id
      WHERE i.status NOT IN ('resolved','cancelled')
      ORDER BY assignee_name, i.status, i.priority`);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ FOLLOW UP v2 — STALE ISSUES ══
app.get('/api/fu/stale', authRequired, async (request, res) => {
  try {
    const minDays = parseInt(request.query.days || '7', 10);
    const result = await req().input('minDays', sql.Int, minDays).query(`
      SELECT TOP 50
        i.id, i.detail, i.branch, i.status, i.priority,
        i.updated_at, i.created_at,
        DATEDIFF(day, i.updated_at, GETDATE()) AS days_stale,
        ISNULL(e.nickname, e.name) AS assigned_name,
        b.id AS board_id, b.name AS board_name,
        f.id AS folder_id, f.name AS folder_name
      FROM fu_issues i
      LEFT JOIN employees e ON e.id = i.assigned_to
      LEFT JOIN fu_boards b ON b.id = i.board_id
      LEFT JOIN fu_folders f ON f.id = b.folder_id
      WHERE i.status NOT IN ('resolved', 'cancelled')
        AND DATEDIFF(day, i.updated_at, GETDATE()) >= @minDays
      ORDER BY days_stale DESC
    `);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
    if (b.name  != null) { r=r.input('n',sql.NVarChar,b.name);        updates.push('name=@n'); }
    if (b.color != null) { r=r.input('c',sql.NVarChar,b.color||null); updates.push('color=ISNULL(@c,color)'); }
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
// Return all folders with their boards (for move-issue picker)
app.get('/api/fu/all-boards', authRequired, async (request, res) => {
  try {
    const rows = (await req().query(`
      SELECT f.id AS folder_id, f.name AS folder_name, f.color AS folder_color,
             b.id AS board_id, b.name AS board_name
      FROM fu_folders f
      JOIN fu_boards b ON b.folder_id=f.id
      ORDER BY f.created_at, b.created_at`)).recordset;
    // Group by folder
    const map = {};
    for (const r of rows) {
      if (!map[r.folder_id]) map[r.folder_id] = { id:r.folder_id, name:r.folder_name, color:r.folder_color, boards:[] };
      map[r.folder_id].boards.push({ id:r.board_id, name:r.board_name });
    }
    res.json(Object.values(map));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Move issue to another board
app.patch('/api/fu/issues/:id/move', authRequired, async (request, res) => {
  try {
    const id      = parseInt(request.params.id);
    const boardId = parseInt(request.body.board_id);
    if (!boardId) return res.status(400).json({ error: 'board_id required' });
    // Get destination board name for activity log
    const bRow = (await req().input('bid',sql.Int,boardId)
      .query(`SELECT b.name AS bname, f.name AS fname FROM fu_boards b JOIN fu_folders f ON f.id=b.folder_id WHERE b.id=@bid`)).recordset[0];
    if (!bRow) return res.status(404).json({ error: 'board not found' });
    await req().input('id',sql.Int,id).input('bid',sql.Int,boardId)
      .query(`UPDATE fu_issues SET board_id=@bid, updated_at=GETDATE() WHERE id=@id`);
    // Activity log
    await req().input('iid',sql.Int,id).input('uid',sql.Int,request.user.id)
      .input('ct',sql.NVarChar,'ย้าย Board')
      .input('nv',sql.NVarChar,`${bRow.fname} / ${bRow.bname}`)
      .query(`INSERT INTO fu_activity(issue_id,user_id,content,new_val,created_at) VALUES(@iid,@uid,@ct,@nv,GETDATE())`);
    res.json({ ok:true, board_name: bRow.bname, folder_name: bRow.fname });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fu/boards/:bid/issues', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('bid',sql.Int,parseInt(request.params.bid)).query(`
      SELECT i.*,
        ISNULL(ea.nickname, ea.name) AS assigned_to_name,
        ISNULL(ec.nickname, ec.name) AS created_by_name,
        (SELECT COUNT(*) FROM fu_comments c WHERE c.issue_id=i.id) AS comment_count,
        (SELECT TOP 1 c.created_at FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_at,
        (SELECT TOP 1 c.body     FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_body
      FROM fu_issues i
      LEFT JOIN employees ea ON ea.id=i.assigned_to
      LEFT JOIN app_users uc ON uc.id=i.created_by
      LEFT JOIN employees ec ON ec.id=uc.employee_id
      WHERE i.board_id=@bid ORDER BY i.position,i.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET single fu_issue by id ─────────────────────────────
app.get('/api/fu/issues/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const rows = (await req().input('id',sql.Int,id).query(`
      SELECT i.*,
        ISNULL(ea.nickname, ea.name) AS assigned_to_name,
        ISNULL(ec.nickname, ec.name) AS created_by_name,
        (SELECT COUNT(*) FROM fu_comments c WHERE c.issue_id=i.id) AS comment_count,
        (SELECT TOP 1 c.created_at FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_at,
        (SELECT TOP 1 c.body     FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_body
      FROM fu_issues i
      LEFT JOIN employees ea ON ea.id=i.assigned_to
      LEFT JOIN app_users uc ON uc.id=i.created_by
      LEFT JOIN employees ec ON ec.id=uc.employee_id
      WHERE i.id=@id`)).recordset;
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
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
      .input('cb',sql.Int,request.user.id).input('spref',sql.Int,b.sp_ref||null)
      .input('iu',sql.NVarChar,b.issue_url||null)
      .query(`INSERT INTO fu_issues(board_id,branch,detail,category,priority,assigned_to,due_date,note,created_by,sp_ref,issue_url) OUTPUT INSERTED.id VALUES(@bid,@br,@det,@cat,@pri,@at,@dd,@nt,@cb,@spref,@iu)`);
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
    if (b.hasOwnProperty('issue_url'))   { r=r.input('iu',sql.NVarChar,b.issue_url??null);       updates.push('issue_url=@iu'); }
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
      SELECT 'comment' AS type,c.id,c.body AS content,c.created_at,ISNULL(e.nickname,e.name) AS user_name
      FROM fu_comments c LEFT JOIN app_users au ON au.id=c.user_id LEFT JOIN employees e ON e.id=au.employee_id
      WHERE c.issue_id=@id`)).recordset;
    const activity = (await req().input('id',sql.Int,id).query(`
      SELECT 'activity' AS type,a.id,a.action AS content,a.old_val,a.new_val,a.created_at,ISNULL(e.nickname,e.name) AS user_name
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
    const [mentionR, openR] = await Promise.all([
      req().input('uid',sql.Int,request.user.id)
        .query(`SELECT COUNT(*) AS cnt FROM fu_mentions WHERE target_user_id=@uid AND seen=0`),
      // Count ALL open issues team-wide (no date filter, no user filter) — stays until done/cancelled
      req().query(`SELECT COUNT(*) AS cnt FROM fu_issues WHERE status NOT IN ('done','cancelled')`)
    ]);
    res.json({
      mentions: mentionR.recordset[0]?.cnt || 0,
      open:     openR.recordset[0]?.cnt    || 0
    });
  } catch(e) { res.json({ mentions:0, open:0 }); }
});

app.post('/api/fu/mentions/seen', authRequired, async (request, res) => {
  try {
    await req().input('uid',sql.Int,request.user.id)
      .query(`UPDATE fu_mentions SET seen=1 WHERE target_user_id=@uid AND seen=0`);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ FOLLOW UP v2 — AZURE ISSUES (Tab 4) ══
app.get('/api/fu/azure-items', authRequired, async (request, res) => {
  try {
    // 1. ดึง fu_issues ที่มี issue_url จาก DB
    const localRows = (await req().query(`
      SELECT i.id, i.issue_url, i.priority AS fu_priority,
             b.id AS board_id, b.name AS board_name,
             f.id AS folder_id, f.name AS folder_name
      FROM fu_issues i
      LEFT JOIN fu_boards b ON b.id = i.board_id
      LEFT JOIN fu_folders f ON f.id = b.folder_id
      WHERE i.issue_url IS NOT NULL AND i.issue_url != ''
      ORDER BY f.name, b.name
    `)).recordset;

    if (!localRows.length) return res.json([]);

    // 2. Parse workItemId + project จาก URL
    const urlRegex = /infogrammer\/([^\/]+)\/_workitems\/edit\/(\d+)/;
    const parsed = localRows.map(row => {
      const m = urlRegex.exec(row.issue_url || '');
      return { ...row, project: m ? m[1] : null, workItemId: m ? parseInt(m[2], 10) : null };
    });

    const pat = process.env.AZURE_DEVOPS_PAT || '';
    const azureMap = {};

    if (!pat) {
      console.warn('[Azure] AZURE_DEVOPS_PAT not set — work item details unavailable');
    } else {
      // 3. เรียก Azure Work Items REST API (ง่ายและเชื่อถือได้กว่า Analytics)
      const authHeader = 'Basic ' + Buffer.from(':' + pat).toString('base64');
      const httpsModule = require('https');

      const fetchAz = (url) => new Promise((resolve, reject) => {
        const u = new URL(url);
        const opts = {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: { Authorization: authHeader, Accept: 'application/json' },
          timeout: 15000,
        };
        const r = httpsModule.get(opts, resp => {
          let body = '';
          resp.on('data', c => { body += c; });
          resp.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch(e) { console.error('[Azure] JSON parse error:', body.slice(0,200)); reject(e); }
          });
        });
        r.on('timeout', () => { r.destroy(); reject(new Error('Azure timeout')); });
        r.on('error', reject);
      });

      // ฟิลด์ที่ต้องการ (REST API ใช้ reference name)
      const AZ_FIELDS = [
        'System.Title',
        'System.State',
        'System.WorkItemType',
        'System.AssignedTo',
        'Custom.LevelofUrgency',
        'Custom.ReleaseDate',
        'Custom.ReleaseVersion',
      ].join(',');

      // เก็บ IDs ที่ unique และ valid ทั้งหมด
      const allIds = [...new Set(parsed.filter(r => r.workItemId).map(r => r.workItemId))];

      // Azure รองรับ max 200 IDs ต่อ request
      const BATCH = 200;
      for (let i = 0; i < allIds.length; i += BATCH) {
        const batch = allIds.slice(i, i + BATCH);
        try {
          const url = `https://dev.azure.com/infogrammer/_apis/wit/workitems?ids=${batch.join(',')}&fields=${encodeURIComponent(AZ_FIELDS)}&api-version=7.0`;
          const data = await fetchAz(url);
          if (data.message) {
            console.error('[Azure] API error:', data.message);
            break;
          }
          (data.value || []).forEach(item => {
            const f = item.fields || {};
            const assigned = f['System.AssignedTo'];
            azureMap[item.id] = {
              title:          f['System.Title']        || null,
              state:          f['System.State']        || null,
              workItemType:   f['System.WorkItemType'] || null,
              assignedTo:     typeof assigned === 'object'
                                ? (assigned?.displayName || null)
                                : (assigned || null),
              levelOfUrgency: f['Custom.LevelofUrgency']  || null,
              releaseDate:    f['Custom.ReleaseDate']      || null,
              releaseVersion: f['Custom.ReleaseVersion']   || null,
            };
          });
          console.log(`[Azure] Fetched batch ${i}–${i+batch.length}: ${Object.keys(azureMap).length} total mapped`);
        } catch(e) {
          console.error(`[Azure] Work Items API error (batch ${i}):`, e.message);
        }
      }
    }

    // 4. รวมข้อมูล DB + Azure แล้วส่งกลับ
    const result = parsed.map(r => ({
      fu_id:       r.id,
      board_id:    r.board_id,
      board_name:  r.board_name,
      folder_id:   r.folder_id,
      folder_name: r.folder_name,
      workItemId:  r.workItemId,
      project:     r.project,
      issue_url:   r.issue_url,
      ...(r.workItemId && azureMap[r.workItemId]
        ? azureMap[r.workItemId]
        : { title: null, state: null, levelOfUrgency: null, workItemType: null,
            assignedTo: null, releaseDate: null, releaseVersion: null }),
    }));

    res.json(result);
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
               ISNULL(e1.nickname, e1.name) AS agent_name, e1.team AS agent_team,
               ISNULL(e4.nickname, e4.name) AS accepted_by_name
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
      .input('cid',  sql.Int,      b.calllog_id        || null)
      .input('rid',  sql.Int,      b.registration_id   || null)
      .input('cn',   sql.NVarChar, b.company_name      || null)
      .input('subj', sql.NVarChar, b.subject           || null)
      .input('pt',   sql.NVarChar, b.problem_type      || null)
      .input('ctn',  sql.NVarChar, b.contact_name      || null)
      .input('ctp',  sql.NVarChar, b.contact_phone     || null)
      .input('li',   sql.NVarChar, b.line_id           || null)
      .input('lg',   sql.NVarChar, b.line_group        || null)
      .input('it',   sql.NVarChar, b.inform_type       || null)
      .input('ptid', sql.Int,      b.problem_type_id   || null)
      .input('siid', sql.Int,      b.subject_id        || null)
      .input('loc',  sql.NVarChar, b.customer_location || null)
      .input('oa',   sql.Int,      request.user.id     || null)
      .input('att',  sql.NVarChar, b.assigned_to_team  || null)
      .input('atu',  sql.Int,      b.assigned_to_user  || null)
      .input('nt',   sql.NVarChar, b.note              || null)
      .input('desc', sql.NVarChar, b.description       || null)
      .input('sol',  sql.NVarChar, b.solution          || null)
      .query(`INSERT INTO specialist_log
        (calllog_id,registration_id,company_name,subject,problem_type,problem_type_id,subject_id,
         contact_name,contact_phone,line_id,line_group,inform_type,customer_location,
         original_agent,assigned_to_team,assigned_to_user,note,description,solution)
        OUTPUT INSERTED.id VALUES
        (@cid,@rid,@cn,@subj,@pt,@ptid,@siid,@ctn,@ctp,@li,@lg,@it,@loc,@oa,@att,@atu,@nt,@desc,@sol)`);
    // Line notify
    const uname = request.user.name || request.user.username;
    await sendLineNotify(`\n🔧 [Specialist] ${b.company_name||'—'}\nมอบหมายโดย: ${uname}\nทีม: ${b.assigned_to_team||'—'}\n${b.note||''}`, 'specialist');
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
                                  : (b.status && b.status !== cur.status) ? (request.user.id || null)
                                  : cur.accepted_by)
      .input('isReassign', sql.Bit, (b.status==='pending') || (b.hasOwnProperty('accepted_by') && b.accepted_by === null) ? 1 : 0)
      .input('cn',  sql.NVarChar, b.hasOwnProperty('company_name')  ? b.company_name  : cur.company_name)
      .input('desc',sql.NVarChar, b.hasOwnProperty('description')   ? b.description   : cur.description)
      .input('subj',sql.NVarChar, b.hasOwnProperty('subject')       ? b.subject       : cur.subject)
      .input('sjid',sql.Int,      b.hasOwnProperty('subject_id')    ? (b.subject_id ?? null) : cur.subject_id)
      .input('pt',  sql.NVarChar, b.hasOwnProperty('problem_type')  ? b.problem_type  : cur.problem_type)
      .input('ptid',sql.Int,      b.hasOwnProperty('problem_type_id')? (b.problem_type_id ?? null) : cur.problem_type_id)
      .input('itype',sql.NVarChar,b.hasOwnProperty('inform_type')   ? b.inform_type   : cur.inform_type)
      .query(`UPDATE specialist_log SET
        status=@st, assigned_to_team=@att, assigned_to_user=@atu, priority=@pr, note=@nt,
        contact_name=@ctn, contact_phone=@ctp, line_id=@li, line_group=@lg,
        customer_location=@loc, resolution_note=@rnt, issue_id=@iid, resolved_by=@rb,
        accepted_by=@aby,
        company_name=@cn, description=@desc, subject=@subj, subject_id=@sjid,
        problem_type=@pt, problem_type_id=@ptid, inform_type=@itype,
        accepted_at=CASE WHEN @isReassign=1 THEN NULL
                         WHEN @st='in_progress' AND accepted_at IS NULL THEN GETDATE()
                         ELSE accepted_at END,
        resolved_at=CASE WHEN @st='resolved' AND resolved_at IS NULL THEN GETDATE() ELSE resolved_at END,
        updated_at=GETDATE()
        WHERE id=@id`);
    // Notify on reassign
    if (b.hasOwnProperty('accepted_by') && b.accepted_by === null && b.assigned_to_team && b.assigned_to_team !== cur.assigned_to_team) {
      const uname = request.user.name || request.user.username;
      await sendLineNotify(`\n🔄 [Specialist Reassign] ${cur.company_name||'—'}\nจาก: ${cur.assigned_to_team||'—'} → ใหม่: ${b.assigned_to_team}\nโดย: ${uname}${b.note?'\n'+b.note:''}`, 'specialist');
    }
    // Notify on status change
    if (b.status && b.status !== cur.status) {
      const statusLabel = {pending:'รอดำเนินการ',in_progress:'กำลังดำเนินการ',need_more_info:'Need more information',assigned_to_programmer:'Assign to Programmer',resolved:'แก้ไขแล้ว',rejected:'ปฏิเสธ',cancelled:'ยกเลิก'};
      const uname = request.user.name || request.user.username;
      // Auto-close calllog when specialist marks resolved OR assigned_to_programmer
      if (['resolved','assigned_to_programmer'].includes(b.status) && getExtPool()) {
        try {
          const uname = request.user.name || request.user.username || 'Specialist';
          const resNote = b.resolution_note ?? cur.resolution_note;
          const closeStatus = (await extReq()
            .query(`SELECT TOP 1 StatusId FROM CallStatus
                    WHERE StatusName LIKE '%close%' OR StatusName LIKE '%complete%'
                    ORDER BY StatusName`)).recordset[0];
          if (closeStatus) {
            const solNote = b.status === 'assigned_to_programmer'
              ? `[ส่งต่อ Programmer: ${uname}]${resNote ? ' ' + resNote : ''}`
              : `[แก้ไขโดย Specialist: ${uname}]${resNote ? ' ' + resNote : ''}`;

            if (cur.calllog_id) {
              // ── มี calllog อยู่แล้ว → update ──────────────────────────
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

            // ── ทุกกรณีที่ resolved → สร้าง Calllog ใหม่เสมอ ──────────
            if (b.status === 'resolved') {
              const supportId = request.user.calluserid || null;

              // 1) RegistrationId — priority: specialist_log → linked calllog → company name lookup
              let regId = cur.registration_id || null;
              if (!regId && cur.calllog_id) {
                try {
                  const clRow = (await extReq().input('cid', sql.Int, cur.calllog_id)
                    .query(`SELECT RegistrationId FROM Calllog WHERE CalllogId=@cid`)).recordset[0];
                  if (clRow?.RegistrationId) regId = clRow.RegistrationId;
                } catch {}
              }
              if (!regId && cur.company_name) {
                try {
                  const regRow = (await extReq().input('cn', sql.NVarChar, cur.company_name)
                    .query(`SELECT TOP 1 RegistrationId FROM CustomerRegistration
                            WHERE CompanyName=@cn AND Active=1`)).recordset[0];
                  if (regRow) regId = regRow.RegistrationId;
                } catch {}
              }

              // 2) Sanitize "-" → null สำหรับ contact fields
              const sanitize = v => (!v || v.trim() === '-' || v.trim() === '') ? null : v.trim();
              const informName  = sanitize(cur.contact_name);
              const informTel   = sanitize(cur.contact_phone);
              const informLine  = sanitize(cur.line_id);

              // 3) InformType / SolveType — ใช้จาก specialist_log ถ้ามี ไม่งั้น Remote
              const rawInformType = cur.inform_type || 'Remote';
              const solveType = ['Walk-in','Onsite'].includes(rawInformType) ? 'Walk-in' : 'Remote';

              // 4) ProblemTypeId + IssueCategoryId (SubjectId) — ใช้จาก stored ID ก่อน fallback text lookup
              let problemTypeId = cur.problem_type_id || null;
              if (!problemTypeId && cur.problem_type) {
                try {
                  const ptRow = (await extReq().input('pt', sql.NVarChar, cur.problem_type)
                    .query(`SELECT TOP 1 ProblemTypeId FROM ProblemType
                            WHERE ProblemTypeDetail=@pt`)).recordset[0];
                  if (ptRow) problemTypeId = ptRow.ProblemTypeId;
                } catch {}
              }
              let issueCategoryId = cur.subject_id || null;
              if (!issueCategoryId && cur.subject) {
                try {
                  const subjRow = (await extReq().input('sn', sql.NVarChar, cur.subject)
                    .query(`SELECT TOP 1 SubjectId FROM Subject
                            WHERE SubjectName=@sn AND Active=1`)).recordset[0];
                  if (subjRow) issueCategoryId = subjRow.SubjectId;
                } catch {}
              }

              // 5) Solution — รวม resolution_note + description ถ้ามี
              const descDetail  = sanitize(cur.description);
              const fullSolNote = solNote + (descDetail ? `\n${descDetail}` : '');

              const newLog = await extReq()
                .input('rid',   sql.Int,      regId)
                .input('rd',    sql.DateTime, cur.assigned_at || new Date())
                .input('desc',  sql.NVarChar, cur.description || cur.subject || null)
                .input('iname', sql.NVarChar, informName)
                .input('itel',  sql.NVarChar, informTel)
                .input('itype', sql.NVarChar, rawInformType)
                .input('line',  sql.NVarChar, informLine)
                .input('ptid',  sql.Int,      problemTypeId)
                .input('icid',  sql.Int,      issueCategoryId)
                .input('pid',   sql.Int,      12)
                .input('sid',   sql.Int,      supportId)
                .input('stid',  sql.Int,      closeStatus.StatusId)
                .input('subj',  sql.NVarChar, cur.subject || null)
                .input('sol',   sql.NVarChar, fullSolNote)
                .input('solvt', sql.NVarChar, solveType)
                .input('uid',   sql.Int,      supportId)
                .input('cbid',  sql.Int,      supportId)
                .query(`INSERT INTO Calllog
                  (RegistrationId, ReceiveDate, CloseDate, DueDate, CalllogDesc,
                   InformName, InformTel, InformType, OnsiteRemark,
                   IssueCategoryId, ProblemTypeId, ProjectId, SupportId, StatusId,
                   Subject, Solution, SolveType,
                   UserId, CloseById, Active, InsertDate, UpdateDate)
                  OUTPUT INSERTED.CalllogId AS id
                  VALUES (@rid, @rd, GETDATE(), GETDATE(), @desc,
                          @iname, @itel, @itype, @line,
                          @icid, @ptid, @pid, @sid, @stid,
                          @subj, @sol, @solvt,
                          @uid, @cbid, 1, GETDATE(), GETDATE())`);
              const newCalllogId = newLog.recordset[0]?.id;
              // ถ้าไม่มี calllog_id เดิม → link specialist_log กับ calllog ใหม่
              if (newCalllogId && !cur.calllog_id) {
                await req().input('id', sql.Int, id).input('cid', sql.Int, newCalllogId)
                  .query('UPDATE specialist_log SET calllog_id=@cid WHERE id=@id');
              }
            }
          }
        } catch(e) { console.warn('auto-close/create calllog failed:', e.message); }
      }

      // ── ถ้าเคย resolved แล้วเปลี่ยนกลับ → reopen Calllog ─────────────
      if (cur.status === 'resolved' && !['resolved','assigned_to_programmer'].includes(b.status) && cur.calllog_id && getExtPool()) {
        try {
          const openStatus = (await extReq()
            .query(`SELECT TOP 1 StatusId FROM CallStatus
                    WHERE StatusName NOT LIKE '%close%' AND StatusName NOT LIKE '%complete%'
                    ORDER BY StatusId ASC`)).recordset[0];
          if (openStatus) {
            await extReq()
              .input('id',   sql.Int, cur.calllog_id)
              .input('stid', sql.Int, openStatus.StatusId)
              .query(`UPDATE Calllog
                      SET StatusId=@stid, CloseDate=NULL, DueDate=NULL, UpdateDate=GETDATE()
                      WHERE CalllogId=@id`);
          }
        } catch(e) { console.warn('reopen calllog failed:', e.message); }
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Specialist Comments ───────────────────────────────────
app.get('/api/specialist/:id/comments', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const rows = (await req().input('id', sql.Int, id).query(`
      SELECT c.id, c.body, c.created_at,
             ISNULL(e.nickname, e.name) AS author_name
      FROM specialist_comments c
      LEFT JOIN app_users u ON u.id = c.user_id
      LEFT JOIN employees e ON e.id  = u.employee_id
      WHERE c.sp_id = @id
      ORDER BY c.created_at ASC`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/specialist/:id/comments', authRequired, async (request, res) => {
  try {
    const spId = parseInt(request.params.id);
    const body = (request.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'กรุณาใส่ข้อความ' });
    const r = await req()
      .input('spid', sql.Int,      spId)
      .input('uid',  sql.Int,      request.user.id)
      .input('body', sql.NVarChar, body)
      .query(`INSERT INTO specialist_comments(sp_id,user_id,body) OUTPUT INSERTED.id VALUES(@spid,@uid,@body)`);
    // bump updated_at on parent
    await req().input('id', sql.Int, spId).query('UPDATE specialist_log SET updated_at=GETDATE() WHERE id=@id');
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/specialist/:id/comments/:cid', authRequired, leadRequired, async (request, res) => {
  try {
    const cid = parseInt(request.params.cid);
    await req().input('cid', sql.Int, cid).query('DELETE FROM specialist_comments WHERE id=@cid');
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

// ══════════════════════════════════════════════════════════
//  SHOP INFO — Migration (new flat table)
// ══════════════════════════════════════════════════════════
async function ensureShopKnowledgeTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shop_knowledge' AND xtype='U')
      CREATE TABLE shop_knowledge (
        id          INT IDENTITY PRIMARY KEY,
        brand_name  NVARCHAR(255) NOT NULL,
        branch_name NVARCHAR(255) NULL,
        category    NVARCHAR(100) NOT NULL DEFAULT N'ทั่วไป',
        title       NVARCHAR(500) NOT NULL,
        content     NVARCHAR(MAX) NULL,
        sort_order  INT DEFAULT 0,
        created_by  INT NULL,
        updated_by  INT NULL,
        created_at  DATETIME DEFAULT GETDATE(),
        updated_at  DATETIME DEFAULT GETDATE()
      )`);
    // Images table for knowledge articles
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shop_knowledge_images' AND xtype='U')
      CREATE TABLE shop_knowledge_images (
        id           INT IDENTITY PRIMARY KEY,
        knowledge_id INT NOT NULL,
        filename     NVARCHAR(255) NOT NULL,
        original_name NVARCHAR(255) NULL,
        caption      NVARCHAR(500) NULL,
        sort_order   INT DEFAULT 0,
        created_at   DATETIME DEFAULT GETDATE()
      )`);
    console.log('✅ shop_knowledge table ready');
  } catch(e) { console.error('❌ shop_knowledge table error:', e.message); }
}

async function ensureShopEntriesTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shop_entries' AND xtype='U')
      CREATE TABLE shop_entries (
        id              INT IDENTITY PRIMARY KEY,
        brand_name      NVARCHAR(255)  NULL,
        branch_name     NVARCHAR(255)  NULL,
        branch_code     NVARCHAR(100)  NULL,
        contact_name    NVARCHAR(255)  NULL,
        telephone       NVARCHAR(100)  NULL,
        terminal_type   NVARCHAR(100)  NULL,
        terminal_name   NVARCHAR(255)  NULL,
        anydesk_id      NVARCHAR(255)  NULL,
        teamviewer_id   NVARCHAR(255)  NULL,
        remote_password NVARCHAR(255)  NULL,
        ip_address      NVARCHAR(100)  NULL,
        services        NVARCHAR(500)  NULL,
        note            NVARCHAR(MAX)  NULL,
        created_at      DATETIME DEFAULT GETDATE(),
        updated_at      DATETIME DEFAULT GETDATE()
      )`);
    // Add branch_code column if not exists (migration for existing tables)
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id=OBJECT_ID('shop_entries') AND name='branch_code')
      ALTER TABLE shop_entries ADD branch_code NVARCHAR(100) NULL`);
    console.log('✅ shop_entries table ready');
  } catch(e) { console.error('❌ shop_entries table error:', e.message); }
}

// ══════════════════════════════════════════════════════════
//  SERVICE REQUESTS (Support Package / Promotion Setup)
// ══════════════════════════════════════════════════════════
async function ensureServiceRequestsTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='service_requests' AND xtype='U')
      CREATE TABLE service_requests (
        id              INT PRIMARY KEY IDENTITY,
        brands          NVARCHAR(MAX) NULL,
        branch_scope    NVARCHAR(20)  DEFAULT 'all',
        branches        NVARCHAR(MAX) NULL,
        promo_name      NVARCHAR(500) NULL,
        sale_types      NVARCHAR(MAX) NULL,
        coupon_code     NVARCHAR(100) NULL,
        erp_code        NVARCHAR(100) NULL,
        coupon_type     NVARCHAR(50)  NULL,
        coupon_details  NVARCHAR(MAX) NULL,
        start_date      NVARCHAR(20)  NULL,
        start_time      NVARCHAR(10)  NULL,
        expiry_type     NVARCHAR(20)  DEFAULT 'none',
        expiry_date     NVARCHAR(20)  NULL,
        expiry_days     INT           NULL,
        per_bill        BIT           DEFAULT 1,
        max_per_receipt INT           NULL,
        min_purchase_type NVARCHAR(20) DEFAULT 'none',
        min_purchase_value NVARCHAR(50) NULL,
        can_combine     NVARCHAR(MAX) NULL,
        customer_groups NVARCHAR(MAX) NULL,
        pilot_store     NVARCHAR(200) NULL,
        contact_name    NVARCHAR(200) NULL,
        test_date       NVARCHAR(20)  NULL,
        test_time       NVARCHAR(50)  NULL,
        attachment_name NVARCHAR(500) NULL,
        status          NVARCHAR(30)  DEFAULT 'received',
        assigned_to     INT           NULL,
        note            NVARCHAR(MAX) NULL,
        created_by      INT           NULL,
        created_at      DATETIME      DEFAULT GETDATE(),
        updated_at      DATETIME      DEFAULT GETDATE()
      )`);
    // Add new columns if not exist
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='promo_detail') ALTER TABLE service_requests ADD promo_detail NVARCHAR(MAX) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='condition') ALTER TABLE service_requests ADD condition NVARCHAR(MAX) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='request_type') ALTER TABLE service_requests ADD request_type NVARCHAR(30) DEFAULT 'coupon' NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='serve_type') ALTER TABLE service_requests ADD serve_type NVARCHAR(50) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='title') ALTER TABLE service_requests ADD title NVARCHAR(500) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='request_no') ALTER TABLE service_requests ADD request_no NVARCHAR(100) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='job_no') ALTER TABLE service_requests ADD job_no NVARCHAR(50) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='request_date') ALTER TABLE service_requests ADD request_date DATE NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='requester_position') ALTER TABLE service_requests ADD requester_position NVARCHAR(200) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='requester_name') ALTER TABLE service_requests ADD requester_name NVARCHAR(200) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='period_start') ALTER TABLE service_requests ADD period_start DATE NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='period_end') ALTER TABLE service_requests ADD period_end DATE NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='objective') ALTER TABLE service_requests ADD objective NVARCHAR(MAX) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='project_id') ALTER TABLE service_requests ADD project_id INT NULL`);
    console.log('✅ service_requests table ready');
  } catch(e) { console.error('❌ service_requests error:', e.message); }
}

async function ensureServiceProjectsTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='service_projects' AND xtype='U')
      CREATE TABLE service_projects (
        id           INT PRIMARY KEY IDENTITY,
        name         NVARCHAR(300) NOT NULL,
        description  NVARCHAR(MAX) NULL,
        public_token NVARCHAR(64)  NOT NULL,
        is_active    BIT           DEFAULT 1,
        created_by   INT           NULL,
        created_at   DATETIME      DEFAULT GETDATE(),
        updated_at   DATETIME      DEFAULT GETDATE()
      )`);
    console.log('✅ service_projects table ready');
  } catch(e) { console.error('❌ service_projects error:', e.message); }
}

async function ensureServiceAttachmentsTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='service_attachments' AND xtype='U')
      CREATE TABLE service_attachments (
        id                 INT PRIMARY KEY IDENTITY,
        service_request_id INT NOT NULL,
        file_name          NVARCHAR(300) NOT NULL,
        file_path          NVARCHAR(500) NOT NULL,
        file_size          INT,
        mime_type          NVARCHAR(100),
        uploaded_at        DATETIME DEFAULT GETDATE()
      )`);
    // Add new columns if not exist
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_attachments') AND name='stage')
      ALTER TABLE service_attachments ADD stage NVARCHAR(30) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_attachments') AND name='uploaded_by')
      ALTER TABLE service_attachments ADD uploaded_by INT NULL`);
    console.log('✅ service_attachments table ready');
  } catch(e) { console.error('❌ service_attachments error:', e.message); }
}

async function ensureSwUpdateTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sw_update_jobs' AND xtype='U')
      CREATE TABLE sw_update_jobs (
        id            INT PRIMARY KEY IDENTITY,
        registration_id INT NULL,
        company_name  NVARCHAR(255) NULL,
        received_date DATE NULL,
        appointment_date DATE NULL,
        priority      NVARCHAR(20) DEFAULT 'normal',
        status        NVARCHAR(30) DEFAULT 'pending',
        description   NVARCHAR(MAX) NULL,
        azure_id      NVARCHAR(100) NULL,
        version_recommend NVARCHAR(200) NULL,
        reported_by   INT NULL,
        created_by    INT NULL,
        created_at    DATETIME DEFAULT GETDATE(),
        updated_at    DATETIME DEFAULT GETDATE(),
        updated_by    INT NULL
      )
    `);
    // Add fu_issue_id link column
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('sw_update_jobs') AND name='fu_issue_id')
      ALTER TABLE sw_update_jobs ADD fu_issue_id INT NULL`);
    console.log('✅ sw_update_jobs table ready');
  } catch(e) { console.error('❌ sw_update_jobs error:', e.message); }
}

// ── One-time migration: fix garbled Thai filenames in service_attachments ──
async function fixGarbledServiceAttachmentNames() {
  try {
    const rows = (await req().query(
      `SELECT id, file_name FROM service_attachments WHERE file_name IS NOT NULL`
    )).recordset;
    let fixed = 0;
    for (const row of rows) {
      const original = row.file_name;
      // Skip if already contains valid Thai Unicode
      if (/[฀-๿]/.test(original)) continue;
      // Try latin1 → utf8 recovery
      try {
        const decoded = Buffer.from(original, 'latin1').toString('utf8');
        if (/[฀-๿]/.test(decoded)) {
          await req()
            .input('id',  sql.Int,      row.id)
            .input('fn',  sql.NVarChar, decoded)
            .query(`UPDATE service_attachments SET file_name=@fn WHERE id=@id`);
          fixed++;
        }
      } catch (e) {}
    }
    if (fixed > 0) console.log(`✅ Fixed ${fixed} garbled Thai filename(s) in service_attachments`);
  } catch (e) { console.warn('fixGarbledServiceAttachmentNames:', e.message); }
}

// ── GET /api/service-requests/badge — open jobs count (no date filter) ──
app.get('/api/service-requests/badge', authRequired, async (request, res) => {
  try {
    const r = await req().query(
      `SELECT COUNT(*) AS cnt FROM service_requests
       WHERE status NOT IN ('delivered','cancelled')`);
    res.json({ open: r.recordset[0]?.cnt || 0 });
  } catch(e) { res.json({ open: 0 }); }
});

// ── GET /api/service-requests/next-job-no ─────────────────
app.get('/api/service-requests/next-job-no', authRequired, async (request, res) => {
  try {
    const year = new Date().getFullYear();
    const result = await req().query(
      `SELECT COUNT(*) AS cnt FROM service_requests WHERE YEAR(created_at) = ${year}`
    );
    const cnt  = (result.recordset[0].cnt || 0) + 1;
    const jobNo = `JOB-${year}-${String(cnt).padStart(4, '0')}`;
    res.json({ job_no: jobNo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/service-requests ──────────────────────────────
app.get('/api/service-requests', authRequired, async (request, res) => {
  try {
    const { status, q, dateFrom, dateTo, projectId } = request.query;
    let where = 'WHERE 1=1';
    if (status)    where += ` AND sr.status=N'${status.replace(/'/g,"''")}'`;
    if (q)         where += ` AND (sr.job_no LIKE N'%${q.replace(/'/g,"''")}%' OR sr.title LIKE N'%${q.replace(/'/g,"''")}%' OR sr.brands LIKE N'%${q.replace(/'/g,"''")}%' OR sr.request_no LIKE N'%${q.replace(/'/g,"''")}%' OR sr.requester_name LIKE N'%${q.replace(/'/g,"''")}%')`;
    if (dateFrom)  where += ` AND CAST(sr.created_at AS DATE) >= '${dateFrom}'`;
    if (dateTo)    where += ` AND CAST(sr.created_at AS DATE) <= '${dateTo}'`;
    if (projectId) where += ` AND sr.project_id = ${parseInt(projectId)}`;
    const rows = (await req().query(`
      SELECT sr.*,
             ISNULL(ec.nickname, ec.name) AS created_by_name,
             ISNULL(ea.nickname, ea.name) AS assigned_to_name
      FROM service_requests sr
      LEFT JOIN app_users  uc ON uc.id = sr.created_by
      LEFT JOIN employees  ec ON ec.id = uc.employee_id
      LEFT JOIN app_users  ua ON ua.id = sr.assigned_to
      LEFT JOIN employees  ea ON ea.id = ua.employee_id
      ${where}
      ORDER BY sr.created_at DESC`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/service-requests ─────────────────────────────
app.post('/api/service-requests', authRequired, async (request, res) => {
  try {
    const b = request.body;
    const result = await req()
      .input('project_id',         sql.Int,      b.project_id ? parseInt(b.project_id) : null)
      .input('job_no',             sql.NVarChar, b.job_no||null)
      .input('serve_type',         sql.NVarChar, b.serve_type||null)
      .input('brands',             sql.NVarChar, JSON.stringify(b.brands||[]))
      .input('branches',           sql.NVarChar, JSON.stringify(b.branches||[]))
      .input('title',              sql.NVarChar, b.title||null)
      .input('request_no',         sql.NVarChar, b.request_no||null)
      .input('request_date',       sql.Date,     b.request_date?new Date(b.request_date):null)
      .input('requester_position', sql.NVarChar, b.requester_position||null)
      .input('requester_name',     sql.NVarChar, b.requester_name||null)
      .input('period_start',       sql.Date,     b.period_start?new Date(b.period_start):null)
      .input('period_end',         sql.Date,     b.period_end?new Date(b.period_end):null)
      .input('objective',          sql.NVarChar, b.objective||null)
      .input('condition',          sql.NVarChar, b.condition||null)
      .input('attachment_name',    sql.NVarChar, b.attachment_name||null)
      .input('status',             sql.NVarChar, 'received')
      .input('created_by',         sql.Int,      request.user.id)
      .query(`INSERT INTO service_requests
        (project_id,job_no,serve_type,brands,branches,title,request_no,request_date,
         requester_position,requester_name,period_start,period_end,
         objective,condition,attachment_name,status,created_by)
        OUTPUT INSERTED.id
        VALUES(@project_id,@job_no,@serve_type,@brands,@branches,@title,@request_no,@request_date,
               @requester_position,@requester_name,@period_start,@period_end,
               @objective,@condition,@attachment_name,@status,@created_by)`);
    const newId = result.recordset[0].id;

    // LINE notify
    try {
      const SERVE_LABEL = {
        promo_coupon:'สร้างโปรฯ / คูปอง', quick_sale:'สร้างปุ่มขายด่วน',
        edit_promo_coupon:'แก้ไขโปรฯ / คูปอง', edit_quick_sale:'แก้ไขปุ่มขายด่วน',
        cancel_promo_coupon:'แจ้งยกเลิกโปรฯ / คูปอง', cancel_quick_sale:'แจ้งยกเลิกปุ่มขายด่วน',
      };
      const brands = (() => { try { return (JSON.parse(b.brands||'[]')||[]).join(', '); } catch { return ''; } })();
      const ps = b.period_start ? new Date(b.period_start).toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'2-digit'}) : '';
      const pe = b.period_end   ? new Date(b.period_end).toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'2-digit'}) : '';
      const stypeLabel = SERVE_LABEL[b.serve_type] || b.serve_type || '—';
      const period = (ps || pe) ? `\nช่วงเวลา: ${ps}${ps&&pe?' – ':''}${pe}` : '';
      const msg = `\n🔔[งานบริการ] ${b.job_no||`#${newId}`}` +
        `\nประเภท: ${stypeLabel}` +
        (b.title          ? `\nหัวข้อ: ${b.title}` : '') +
        (brands           ? `\nแบรนด์: ${brands}` : '') +
        (b.requester_name ? `\nผู้แจ้ง: ${b.requester_name}${b.requester_position ? ` (${b.requester_position})` : ''}` : '') +
        period;
      await sendLineNotify(msg, 'service_request', { serveType: b.serve_type, projectId: b.project_id });
    } catch(e) { console.warn('service_request line notify failed:', e.message); }

    res.json({ id: newId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/service-requests/:id ─────────────────────────
app.put('/api/service-requests/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b  = request.body;

    // Fetch current job for notify context
    const cur = (await req().input('id', sql.Int, id)
      .query(`SELECT job_no, title, serve_type, project_id, requester_name, requester_position, status
              FROM service_requests WHERE id=@id`)).recordset[0];

    await req()
      .input('id',          sql.Int,      id)
      .input('status',      sql.NVarChar, b.status||null)
      .input('note',        sql.NVarChar, b.note!=null ? b.note : null)
      .input('assigned_to', sql.Int,      b.assigned_to||null)
      .query(`UPDATE service_requests SET
        status=COALESCE(@status,status),
        note=COALESCE(@note,note),
        assigned_to=COALESCE(@assigned_to,assigned_to),
        updated_at=GETDATE()
        WHERE id=@id`);

    // LINE notify on status change
    if (cur && b.status && b.status !== cur.status) {
      try {
        const STATUS_LABEL = {
          received:'📥 รับเรื่องแล้ว', in_progress:'⚙️ กำลังดำเนินการ',
          testing:'🧪 ทดสอบ', delivered:'✅ ส่งมอบแล้ว', cancelled:'❌ ยกเลิก',
        };
        const SERVE_LABEL = {
          promo_coupon:'สร้างโปรฯ / คูปอง', quick_sale:'สร้างปุ่มขายด่วน',
          edit_promo_coupon:'แก้ไขโปรฯ / คูปอง', edit_quick_sale:'แก้ไขปุ่มขายด่วน',
          cancel_promo_coupon:'แจ้งยกเลิกโปรฯ / คูปอง', cancel_quick_sale:'แจ้งยกเลิกปุ่มขายด่วน',
        };
        const uname      = request.user.nickname || request.user.name || request.user.username || '—';
        const statusLabel = STATUS_LABEL[b.status] || b.status;
        const stypeLabel  = SERVE_LABEL[cur.serve_type] || cur.serve_type || '—';
        const msg = `\n🔔[งานบริการ] ${cur.job_no||`#${id}`}` +
          `\nสถานะ: ${statusLabel}` +
          (cur.title          ? `\nหัวข้อ: ${cur.title}` : '') +
          (stypeLabel         ? `\nประเภท: ${stypeLabel}` : '') +
          (cur.requester_name ? `\nผู้แจ้ง: ${cur.requester_name}${cur.requester_position ? ` (${cur.requester_position})` : ''}` : '') +
          `\nอัพเดทโดย: ${uname}`;
        await sendLineNotify(msg, 'service_request', { serveType: cur.serve_type, projectId: cur.project_id });
      } catch(e) { console.warn('service_request status notify failed:', e.message); }
    }

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/service-requests/:id ──────────────────────
app.delete('/api/service-requests/:id', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, parseInt(request.params.id))
      .query('DELETE FROM service_requests WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/service-requests/:id/attachments ─────────────
app.get('/api/service-requests/:id/attachments', authRequired, async (request, res) => {
  try {
    const rows = (await req()
      .input('sid', sql.Int, parseInt(request.params.id))
      .query(`SELECT id, file_name, file_path, file_size, mime_type, stage, uploaded_at
              FROM service_attachments WHERE service_request_id=@sid ORDER BY uploaded_at`))
      .recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/service-requests/:id/stage-files ─────────────
// Admin: upload proof files tagged to a workflow stage
app.post('/api/service-requests/:id/stage-files', authRequired, svcPubUpload.array('files', 10), async (request, res) => {
  try {
    const id    = parseInt(request.params.id);
    const stage = request.body.stage || null;
    const job   = (await req().input('id', sql.Int, id)
      .query('SELECT id FROM service_requests WHERE id=@id')).recordset[0];
    if (!job) return res.status(404).json({ error: 'not found' });
    const files = request.files || [];
    const inserted = [];
    if (files.length) {
      const jobDir = path.join(UPLOAD_DIR, 'svc', String(id));
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
      for (const file of files) {
        const newPath = path.join(jobDir, file.filename);
        fs.renameSync(file.path, newPath);
        const relPath = `/uploads/svc/${id}/${file.filename}`;
        const origName = fixUploadName(file.originalname);
        const r = await req()
          .input('sid', sql.Int,      id)
          .input('fn',  sql.NVarChar, origName)
          .input('fp',  sql.NVarChar, relPath)
          .input('fs',  sql.Int,      file.size)
          .input('mt',  sql.NVarChar, file.mimetype||null)
          .input('st',  sql.NVarChar, stage)
          .input('by',  sql.Int,      request.user.id||null)
          .query(`INSERT INTO service_attachments
                    (service_request_id,file_name,file_path,file_size,mime_type,stage,uploaded_by)
                  OUTPUT INSERTED.id,INSERTED.file_name,INSERTED.file_path,INSERTED.stage
                  VALUES(@sid,@fn,@fp,@fs,@mt,@st,@by)`);
        inserted.push(r.recordset[0]);
      }
    }
    res.json({ ok: true, files: inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/service-projects ──────────────────────────────
app.get('/api/service-projects', authRequired, async (request, res) => {
  try {
    const rows = (await req().query(`
      SELECT p.*,
             ISNULL(e.nickname, e.name) AS created_by_name,
             (SELECT COUNT(*) FROM service_requests sr WHERE sr.project_id = p.id) AS job_count
      FROM service_projects p
      LEFT JOIN app_users u ON u.id = p.created_by
      LEFT JOIN employees e ON e.id = u.employee_id
      ORDER BY p.created_at DESC`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/service-projects ─────────────────────────────
app.post('/api/service-projects', authRequired, async (request, res) => {
  try {
    const b = request.body;
    const token = crypto.randomBytes(24).toString('hex');
    const result = await req()
      .input('name',         sql.NVarChar, b.name||'Untitled Project')
      .input('description',  sql.NVarChar, b.description||null)
      .input('public_token', sql.NVarChar, token)
      .input('created_by',   sql.Int,      request.user.id)
      .query(`INSERT INTO service_projects (name,description,public_token,created_by)
              OUTPUT INSERTED.id, INSERTED.public_token
              VALUES(@name,@description,@public_token,@created_by)`);
    res.json({ id: result.recordset[0].id, public_token: result.recordset[0].public_token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/service-projects/:id ─────────────────────────
app.put('/api/service-projects/:id', authRequired, async (request, res) => {
  try {
    const b = request.body;
    await req()
      .input('id',          sql.Int,      parseInt(request.params.id))
      .input('name',        sql.NVarChar, b.name||null)
      .input('description', sql.NVarChar, b.description||null)
      .query(`UPDATE service_projects SET
        name=COALESCE(@name,name),
        description=COALESCE(@description,description),
        updated_at=GETDATE()
        WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/service-projects/:id ──────────────────────
app.delete('/api/service-projects/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    // Unlink jobs from this project (don't delete the jobs)
    await req().input('id', sql.Int, id)
      .query(`UPDATE service_requests SET project_id=NULL WHERE project_id=@id`);
    await req().input('id', sql.Int, id)
      .query(`DELETE FROM service_projects WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/service-projects/:id/regen-token ─────────────
app.post('/api/service-projects/:id/regen-token', authRequired, async (request, res) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    await req()
      .input('id',    sql.Int,      parseInt(request.params.id))
      .input('token', sql.NVarChar, token)
      .query(`UPDATE service_projects SET public_token=@token WHERE id=@id`);
    res.json({ public_token: token });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/public/project/:token ─────────────────────────
// Public: get project info + all jobs (no auth)
app.get('/api/public/project/:token', async (request, res) => {
  try {
    const token = request.params.token;
    const proj = (await req()
      .input('token', sql.NVarChar, token)
      .query(`SELECT id, name, description FROM service_projects WHERE public_token=@token AND is_active=1`))
      .recordset[0];
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    const jobs = (await req()
      .input('pid', sql.Int, proj.id)
      .query(`SELECT id, job_no, request_no, title, serve_type, status, request_date,
                     requester_name, requester_position, brands, branches,
                     period_start, period_end, objective, condition, created_at
              FROM service_requests
              WHERE project_id=@pid
              ORDER BY created_at DESC`)).recordset;
    res.json({ project: proj, jobs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/public/project/:token/submit ──────────────────
// Public: submit a new job into a project (no auth required)
app.post('/api/public/project/:token/submit', (req, res, next) => {
  svcPubUpload.array('files', 10)(req, res, err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'ไฟล์ขนาดใหญ่เกินกำหนด (สูงสุด 15 MB ต่อไฟล์)'
        : (err.message || 'อัปโหลดไฟล์ไม่สำเร็จ');
      console.warn('[public submit upload error]', err.code, err.message);
      logError('public_submit_upload', msg, { code: err.code }, req.ip);
      sendLineNotify(`\n⚠️ [Upload Error] ${msg}`, 'service_request').catch(()=>{});
      return res.status(400).json({ ok: false, error: msg });
    }
    next();
  });
}, async (request, res) => {
  try {
    const token = request.params.token;
    const proj = (await req()
      .input('token', sql.NVarChar, token)
      .query(`SELECT id FROM service_projects WHERE public_token=@token AND is_active=1`))
      .recordset[0];
    if (!proj) return res.status(404).json({ error: 'Project not found or inactive' });

    const b = request.body;
    // Generate job_no
    const year = new Date().getFullYear();
    const cntRes = await req().query(
      `SELECT COUNT(*) AS cnt FROM service_requests WHERE YEAR(created_at) = ${year}`
    );
    const cnt   = (cntRes.recordset[0].cnt || 0) + 1;
    const jobNo = `JOB-${year}-${String(cnt).padStart(4, '0')}`;

    const result = await req()
      .input('project_id',        sql.Int,      proj.id)
      .input('job_no',            sql.NVarChar, jobNo)
      .input('serve_type',        sql.NVarChar, b.serve_type||null)
      .input('brands',            sql.NVarChar, b.brands||'[]')
      .input('branches',          sql.NVarChar, b.branches||'[]')
      .input('title',             sql.NVarChar, b.title||null)
      .input('request_no',        sql.NVarChar, b.request_no||null)
      .input('request_date',      sql.Date,     b.request_date?new Date(b.request_date):new Date())
      .input('requester_position',sql.NVarChar, b.requester_position||null)
      .input('requester_name',    sql.NVarChar, b.requester_name||null)
      .input('period_start',      sql.Date,     b.period_start?new Date(b.period_start):null)
      .input('period_end',        sql.Date,     b.period_end?new Date(b.period_end):null)
      .input('objective',         sql.NVarChar, b.objective||null)
      .input('condition',         sql.NVarChar, b.condition||null)
      .input('status',            sql.NVarChar, 'received')
      .query(`INSERT INTO service_requests
        (project_id,job_no,serve_type,brands,branches,title,request_no,request_date,
         requester_position,requester_name,period_start,period_end,objective,condition,status)
        OUTPUT INSERTED.id, INSERTED.job_no
        VALUES(@project_id,@job_no,@serve_type,@brands,@branches,@title,@request_no,@request_date,
               @requester_position,@requester_name,@period_start,@period_end,@objective,@condition,@status)`);
    const inserted = result.recordset[0];

    // Handle file uploads
    if (request.files && request.files.length) {
      const jobDir = path.join(UPLOAD_DIR, 'svc', String(inserted.id));
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
      for (const file of request.files) {
        const newPath = path.join(jobDir, file.filename);
        fs.renameSync(file.path, newPath);
        const relPath = `/uploads/svc/${inserted.id}/${file.filename}`;
        const origName = fixUploadName(file.originalname);
        await req()
          .input('sid', sql.Int,      inserted.id)
          .input('fn',  sql.NVarChar, origName)
          .input('fp',  sql.NVarChar, relPath)
          .input('fs',  sql.Int,      file.size)
          .input('mt',  sql.NVarChar, file.mimetype||null)
          .query(`INSERT INTO service_attachments(service_request_id,file_name,file_path,file_size,mime_type)
                  VALUES(@sid,@fn,@fp,@fs,@mt)`);
      }
    }
    // LINE notify
    try {
      const SERVE_LABEL = {
        promo_coupon:'สร้างโปรฯ / คูปอง', quick_sale:'สร้างปุ่มขายด่วน',
        edit_promo_coupon:'แก้ไขโปรฯ / คูปอง', edit_quick_sale:'แก้ไขปุ่มขายด่วน',
        cancel_promo_coupon:'แจ้งยกเลิกโปรฯ / คูปอง', cancel_quick_sale:'แจ้งยกเลิกปุ่มขายด่วน',
      };
      const brands = (() => { try { return (JSON.parse(b.brands||'[]')||[]).join(', '); } catch { return b.brands||''; } })();
      const ps = b.period_start ? new Date(b.period_start).toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'2-digit'}) : '';
      const pe = b.period_end   ? new Date(b.period_end).toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'2-digit'}) : '';
      const stypeLabel = SERVE_LABEL[b.serve_type] || b.serve_type || '—';
      const period = (ps || pe) ? `\nช่วงเวลา: ${ps}${ps&&pe?' – ':''}${pe}` : '';
      const msg = `\n[งานบริการ] ${inserted.job_no}` +
        `\nประเภท: ${stypeLabel}` +
        (b.title          ? `\nหัวข้อ: ${b.title}` : '') +
        (brands           ? `\nแบรนด์: ${brands}` : '') +
        (b.requester_name ? `\nผู้แจ้ง: ${b.requester_name}${b.requester_position ? ` (${b.requester_position})` : ''}` : '') +
        period;
      await sendLineNotify(msg, 'service_request', { serveType: b.serve_type, projectId: proj.id });
    } catch(e) { console.warn('service_request (public) line notify failed:', e.message); }

    res.json({ ok: true, id: inserted.id, job_no: inserted.job_no });
  } catch(e) {
    console.error('[public submit error]', e.message, request.body);
    const b = request.body || {};
    logError('public_submit', e.message, {
      serve_type: b.serve_type, title: b.title,
      requester_name: b.requester_name, brands: b.brands
    }, request.ip);
    // LINE notify admin on server error
    sendLineNotify(
      `\n⚠️ [Submit Error] ${b.requester_name||'unknown'}\nError: ${e.message}\nServe type: ${b.serve_type||'—'}\nTitle: ${b.title||'—'}`,
      'service_request'
    ).catch(()=>{});
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/public/project/:token/jobs/:id ─────────────────
// Public: get single job + attachments (for edit pre-fill)
app.get('/api/public/project/:token/jobs/:id', async (request, res) => {
  try {
    const token = request.params.token;
    const id    = parseInt(request.params.id);
    const proj  = (await req()
      .input('token', sql.NVarChar, token)
      .query(`SELECT id FROM service_projects WHERE public_token=@token AND is_active=1`))
      .recordset[0];
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    const job = (await req()
      .input('id',  sql.Int, id)
      .input('pid', sql.Int, proj.id)
      .query(`SELECT id, job_no, request_no, title, serve_type, status,
                     request_date, requester_name, requester_position, brands, branches,
                     period_start, period_end, objective, condition
              FROM service_requests WHERE id=@id AND project_id=@pid`))
      .recordset[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const attachments = (await req()
      .input('sid', sql.Int, id)
      .query(`SELECT id, file_name, file_path, file_size, mime_type, stage FROM service_attachments WHERE service_request_id=@sid ORDER BY uploaded_at`))
      .recordset;
    res.json({ ...job, attachments });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/public/project/:token/jobs/:id ──────────────────
// Public: edit a job only if status is still 'received'
app.put('/api/public/project/:token/jobs/:id', svcPubUpload.array('files', 10), async (request, res) => {
  try {
    const token = request.params.token;
    const id    = parseInt(request.params.id);
    const proj  = (await req()
      .input('token', sql.NVarChar, token)
      .query(`SELECT id FROM service_projects WHERE public_token=@token AND is_active=1`))
      .recordset[0];
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    const job = (await req()
      .input('id',  sql.Int, id)
      .input('pid', sql.Int, proj.id)
      .query(`SELECT id, status FROM service_requests WHERE id=@id AND project_id=@pid`))
      .recordset[0];
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'received') return res.status(403).json({ error: 'ไม่สามารถแก้ไขได้ เนื่องจากมีเจ้าหน้าที่รับงานแล้ว' });

    const b = request.body;
    await req()
      .input('id',                 sql.Int,      id)
      .input('serve_type',         sql.NVarChar, b.serve_type||null)
      .input('brands',             sql.NVarChar, b.brands||'[]')
      .input('branches',           sql.NVarChar, b.branches||'[]')
      .input('title',              sql.NVarChar, b.title||null)
      .input('request_no',         sql.NVarChar, b.request_no||null)
      .input('request_date',       sql.Date,     b.request_date?new Date(b.request_date):null)
      .input('requester_position', sql.NVarChar, b.requester_position||null)
      .input('requester_name',     sql.NVarChar, b.requester_name||null)
      .input('period_start',       sql.Date,     b.period_start?new Date(b.period_start):null)
      .input('period_end',         sql.Date,     b.period_end?new Date(b.period_end):null)
      .input('objective',          sql.NVarChar, b.objective||null)
      .input('condition',          sql.NVarChar, b.condition||null)
      .query(`UPDATE service_requests SET
        serve_type=@serve_type, brands=@brands, branches=@branches, title=@title,
        request_no=@request_no, request_date=@request_date, requester_position=@requester_position,
        requester_name=@requester_name, period_start=@period_start, period_end=@period_end,
        objective=@objective, condition=@condition
        WHERE id=@id`);

    // Handle deleted attachments
    if (b.delete_attachment_ids) {
      const delIds = String(b.delete_attachment_ids).split(',').map(x=>parseInt(x)).filter(n=>!isNaN(n));
      for (const aid of delIds) {
        const row = (await req().input('id',sql.Int,aid).input('sid',sql.Int,id)
          .query(`SELECT file_path FROM service_attachments WHERE id=@id AND service_request_id=@sid`)).recordset[0];
        if (row) {
          try { const fp=path.join(UPLOAD_DIR,row.file_path.replace('/uploads/','')); if(fs.existsSync(fp))fs.unlinkSync(fp); } catch{}
          await req().input('id',sql.Int,aid).query(`DELETE FROM service_attachments WHERE id=@id`);
        }
      }
    }

    // Handle new file uploads
    if (request.files && request.files.length) {
      const jobDir = path.join(UPLOAD_DIR, 'svc', String(id));
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
      for (const file of request.files) {
        const newPath = path.join(jobDir, file.filename);
        fs.renameSync(file.path, newPath);
        const relPath = `/uploads/svc/${id}/${file.filename}`;
        const origName = fixUploadName(file.originalname);
        await req()
          .input('sid', sql.Int,      id)
          .input('fn',  sql.NVarChar, origName)
          .input('fp',  sql.NVarChar, relPath)
          .input('fs',  sql.Int,      file.size)
          .input('mt',  sql.NVarChar, file.mimetype||null)
          .query(`INSERT INTO service_attachments(service_request_id,file_name,file_path,file_size,mime_type)
                  VALUES(@sid,@fn,@fp,@fs,@mt)`);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  SHOP INFO — Migration (legacy 4-table schema)
// ══════════════════════════════════════════════════════════
async function ensureShopInfoTables() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shop_brands' AND xtype='U')
      CREATE TABLE shop_brands (
        id         INT PRIMARY KEY IDENTITY,
        name       NVARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT GETDATE()
      )`);

    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shop_branches' AND xtype='U')
      CREATE TABLE shop_branches (
        id          INT PRIMARY KEY IDENTITY,
        brand_id    INT NULL REFERENCES shop_brands(id),
        brand_name  NVARCHAR(255) NULL,
        branch_name NVARCHAR(255) NOT NULL,
        note        NVARCHAR(MAX) NULL,
        created_at  DATETIME DEFAULT GETDATE(),
        updated_at  DATETIME DEFAULT GETDATE()
      )`);

    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shop_contacts' AND xtype='U')
      CREATE TABLE shop_contacts (
        id           INT PRIMARY KEY IDENTITY,
        branch_id    INT NOT NULL REFERENCES shop_branches(id),
        contact_name NVARCHAR(255) NULL,
        telephone    NVARCHAR(100) NULL,
        created_at   DATETIME DEFAULT GETDATE()
      )`);

    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='shop_terminals' AND xtype='U')
      CREATE TABLE shop_terminals (
        id              INT PRIMARY KEY IDENTITY,
        branch_id       INT NOT NULL REFERENCES shop_branches(id),
        terminal_type   NVARCHAR(100) NULL,
        terminal_name   NVARCHAR(255) NULL,
        remote_type     NVARCHAR(50)  NULL,
        remote_id       NVARCHAR(255) NULL,
        remote_password NVARCHAR(255) NULL,
        ip_address      NVARCHAR(100) NULL,
        services        NVARCHAR(500) NULL,
        note            NVARCHAR(MAX) NULL,
        created_at      DATETIME DEFAULT GETDATE(),
        updated_at      DATETIME DEFAULT GETDATE()
      )`);

    console.log('✅ shop_info tables ready');
  } catch(e) { console.error('❌ shop_info tables error:', e.message); }
}

// ══════════════════════════════════════════════════════════
//  SHOP INFO — APIs
// ══════════════════════════════════════════════════════════

// GET /api/shopinfo?q=  — search + list all branches with contacts & terminals
app.get('/api/shopinfo', authRequired, async (request, res) => {
  try {
    const q = (request.query.q || '').trim();
    const like = `%${q}%`;

    // 1. Fetch matching branches
    const branchQ = q
      ? `SELECT b.* FROM shop_branches b
         LEFT JOIN shop_terminals t ON t.branch_id = b.id
         WHERE b.branch_name LIKE @like OR b.brand_name LIKE @like
            OR t.terminal_name LIKE @like OR t.ip_address LIKE @like OR t.remote_id LIKE @like
         GROUP BY b.id, b.brand_id, b.brand_name, b.branch_name, b.note, b.created_at, b.updated_at
         ORDER BY b.brand_name, b.branch_name`
      : `SELECT * FROM shop_branches ORDER BY brand_name, branch_name`;

    const r = q ? req().input('like', sql.NVarChar, like) : req();
    const branches = (await r.query(branchQ)).recordset;

    if (!branches.length) return res.json([]);

    const ids = branches.map(b => b.id);
    const idList = ids.join(',');

    const contacts  = (await req().query(`SELECT * FROM shop_contacts  WHERE branch_id IN (${idList})`)).recordset;
    const terminals = (await req().query(`SELECT * FROM shop_terminals WHERE branch_id IN (${idList}) ORDER BY terminal_type, terminal_name`)).recordset;

    const contactMap  = {};
    const terminalMap = {};
    for (const c of contacts)  { (contactMap[c.branch_id]  ||= []).push(c); }
    for (const t of terminals) { (terminalMap[t.branch_id] ||= []).push(t); }

    const result = branches.map(b => ({
      ...b,
      contacts:  contactMap[b.id]  || [],
      terminals: terminalMap[b.id] || [],
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shopinfo/brands — list all brand names
app.get('/api/shopinfo/brands', authRequired, async (request, res) => {
  try {
    const rows = (await req().query(`
      SELECT DISTINCT brand_name AS name
      FROM shop_branches
      WHERE brand_name IS NOT NULL AND brand_name <> ''
      ORDER BY brand_name`)).recordset;
    res.json(rows.map(r => r.name));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shopinfo/branch/:id
app.get('/api/shopinfo/branch/:id', authRequired, async (request, res) => {
  try {
    const id = +request.params.id;
    const branch = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM shop_branches WHERE id=@id')).recordset[0];
    if (!branch) return res.status(404).json({ error: 'Not found' });
    const contacts  = (await req().input('id', sql.Int, id).query('SELECT * FROM shop_contacts  WHERE branch_id=@id')).recordset;
    const terminals = (await req().input('id', sql.Int, id).query('SELECT * FROM shop_terminals WHERE branch_id=@id ORDER BY terminal_type, terminal_name')).recordset;
    res.json({ ...branch, contacts, terminals });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shopinfo/branch
app.post('/api/shopinfo/branch', authRequired, async (request, res) => {
  try {
    const { brand_name, branch_name, note } = request.body;
    if (!branch_name) return res.status(400).json({ error: 'branch_name required' });
    const result = await req()
      .input('brand_name',  sql.NVarChar, brand_name  || null)
      .input('branch_name', sql.NVarChar, branch_name)
      .input('note',        sql.NVarChar, note        || null)
      .query(`INSERT INTO shop_branches (brand_name, branch_name, note)
              OUTPUT INSERTED.id VALUES (@brand_name, @branch_name, @note)`);
    res.json({ id: result.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/shopinfo/branch/:id
app.put('/api/shopinfo/branch/:id', authRequired, async (request, res) => {
  try {
    const { brand_name, branch_name, note } = request.body;
    if (!branch_name) return res.status(400).json({ error: 'branch_name required' });
    await req()
      .input('id',          sql.Int,      +request.params.id)
      .input('brand_name',  sql.NVarChar, brand_name  || null)
      .input('branch_name', sql.NVarChar, branch_name)
      .input('note',        sql.NVarChar, note        || null)
      .query(`UPDATE shop_branches
              SET brand_name=@brand_name, branch_name=@branch_name, note=@note, updated_at=GETDATE()
              WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shopinfo/branch/:id — cascade delete contacts + terminals
app.delete('/api/shopinfo/branch/:id', authRequired, async (request, res) => {
  try {
    const id = +request.params.id;
    await req().input('id', sql.Int, id).query('DELETE FROM shop_contacts  WHERE branch_id=@id');
    await req().input('id', sql.Int, id).query('DELETE FROM shop_terminals WHERE branch_id=@id');
    await req().input('id', sql.Int, id).query('DELETE FROM shop_branches  WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shopinfo/contact
app.post('/api/shopinfo/contact', authRequired, async (request, res) => {
  try {
    const { branch_id, contact_name, telephone } = request.body;
    if (!branch_id) return res.status(400).json({ error: 'branch_id required' });
    const result = await req()
      .input('branch_id',    sql.Int,      +branch_id)
      .input('contact_name', sql.NVarChar, contact_name || null)
      .input('telephone',    sql.NVarChar, telephone    || null)
      .query(`INSERT INTO shop_contacts (branch_id, contact_name, telephone)
              OUTPUT INSERTED.id VALUES (@branch_id, @contact_name, @telephone)`);
    res.json({ id: result.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/shopinfo/contact/:id
app.put('/api/shopinfo/contact/:id', authRequired, async (request, res) => {
  try {
    const { contact_name, telephone } = request.body;
    await req()
      .input('id',           sql.Int,      +request.params.id)
      .input('contact_name', sql.NVarChar, contact_name || null)
      .input('telephone',    sql.NVarChar, telephone    || null)
      .query('UPDATE shop_contacts SET contact_name=@contact_name, telephone=@telephone WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shopinfo/contact/:id
app.delete('/api/shopinfo/contact/:id', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, +request.params.id).query('DELETE FROM shop_contacts WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shopinfo/terminal
app.post('/api/shopinfo/terminal', authRequired, async (request, res) => {
  try {
    const { branch_id, terminal_type, terminal_name, remote_type, remote_id, remote_password, ip_address, services, note } = request.body;
    if (!branch_id) return res.status(400).json({ error: 'branch_id required' });
    const result = await req()
      .input('branch_id',       sql.Int,      +branch_id)
      .input('terminal_type',   sql.NVarChar, terminal_type   || null)
      .input('terminal_name',   sql.NVarChar, terminal_name   || null)
      .input('remote_type',     sql.NVarChar, remote_type     || null)
      .input('remote_id',       sql.NVarChar, remote_id       || null)
      .input('remote_password', sql.NVarChar, remote_password || null)
      .input('ip_address',      sql.NVarChar, ip_address      || null)
      .input('services',        sql.NVarChar, services        || null)
      .input('note',            sql.NVarChar, note            || null)
      .query(`INSERT INTO shop_terminals
                (branch_id,terminal_type,terminal_name,remote_type,remote_id,remote_password,ip_address,services,note)
              OUTPUT INSERTED.id
              VALUES (@branch_id,@terminal_type,@terminal_name,@remote_type,@remote_id,@remote_password,@ip_address,@services,@note)`);
    res.json({ id: result.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/shopinfo/terminal/:id
app.put('/api/shopinfo/terminal/:id', authRequired, async (request, res) => {
  try {
    const { terminal_type, terminal_name, remote_type, remote_id, remote_password, ip_address, services, note } = request.body;
    await req()
      .input('id',              sql.Int,      +request.params.id)
      .input('terminal_type',   sql.NVarChar, terminal_type   || null)
      .input('terminal_name',   sql.NVarChar, terminal_name   || null)
      .input('remote_type',     sql.NVarChar, remote_type     || null)
      .input('remote_id',       sql.NVarChar, remote_id       || null)
      .input('remote_password', sql.NVarChar, remote_password || null)
      .input('ip_address',      sql.NVarChar, ip_address      || null)
      .input('services',        sql.NVarChar, services        || null)
      .input('note',            sql.NVarChar, note            || null)
      .query(`UPDATE shop_terminals
              SET terminal_type=@terminal_type, terminal_name=@terminal_name,
                  remote_type=@remote_type, remote_id=@remote_id, remote_password=@remote_password,
                  ip_address=@ip_address, services=@services, note=@note, updated_at=GETDATE()
              WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shopinfo/terminal/:id
app.delete('/api/shopinfo/terminal/:id', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, +request.params.id).query('DELETE FROM shop_terminals WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  SHOP INFO — New flat entries API
// ══════════════════════════════════════════════════════════

// GET /api/shopinfo/entries?q=  — search & return grouped by brand
app.get('/api/shopinfo/entries', authRequired, async (request, res) => {
  try {
    const q = (request.query.q || '').trim();
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = (await req()
        .input('like', sql.NVarChar, like)
        .query(`SELECT * FROM shop_entries
                WHERE brand_name LIKE @like OR branch_name LIKE @like
                   OR contact_name LIKE @like OR terminal_name LIKE @like
                   OR anydesk_id LIKE @like OR teamviewer_id LIKE @like
                   OR ip_address LIKE @like
                ORDER BY brand_name, branch_name, terminal_type, terminal_name`)).recordset;
    } else {
      rows = (await req().query(
        `SELECT * FROM shop_entries ORDER BY brand_name, branch_name, terminal_type, terminal_name`
      )).recordset;
    }

    // Group by brand_name
    const map = new Map();
    for (const row of rows) {
      const brand = row.brand_name || '';
      if (!map.has(brand)) map.set(brand, []);
      map.get(brand).push(row);
    }
    const result = [];
    for (const [brand_name, entries] of map) {
      result.push({ brand_name, entries });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shopinfo/entry-brands — distinct brand names
app.get('/api/shopinfo/entry-brands', authRequired, async (request, res) => {
  try {
    const rows = (await req().query(`
      SELECT DISTINCT brand_name FROM shop_entries
      WHERE brand_name IS NOT NULL AND brand_name <> ''
      ORDER BY brand_name`)).recordset;
    res.json(rows.map(r => r.brand_name));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shopinfo/entry
app.post('/api/shopinfo/entry', authRequired, async (request, res) => {
  try {
    const { brand_name, branch_name, branch_code, contact_name, telephone, terminal_type, terminal_name,
            anydesk_id, teamviewer_id, remote_password, ip_address, services, note } = request.body;
    const result = await req()
      .input('brand_name',      sql.NVarChar, brand_name      || null)
      .input('branch_name',     sql.NVarChar, branch_name     || null)
      .input('branch_code',     sql.NVarChar, branch_code     || null)
      .input('contact_name',    sql.NVarChar, contact_name    || null)
      .input('telephone',       sql.NVarChar, telephone       || null)
      .input('terminal_type',   sql.NVarChar, terminal_type   || null)
      .input('terminal_name',   sql.NVarChar, terminal_name   || null)
      .input('anydesk_id',      sql.NVarChar, anydesk_id      || null)
      .input('teamviewer_id',   sql.NVarChar, teamviewer_id   || null)
      .input('remote_password', sql.NVarChar, remote_password || null)
      .input('ip_address',      sql.NVarChar, ip_address      || null)
      .input('services',        sql.NVarChar, services        || null)
      .input('note',            sql.NVarChar, note            || null)
      .query(`INSERT INTO shop_entries
                (brand_name,branch_name,branch_code,contact_name,telephone,terminal_type,terminal_name,
                 anydesk_id,teamviewer_id,remote_password,ip_address,services,note)
              OUTPUT INSERTED.id
              VALUES (@brand_name,@branch_name,@branch_code,@contact_name,@telephone,@terminal_type,@terminal_name,
                      @anydesk_id,@teamviewer_id,@remote_password,@ip_address,@services,@note)`);
    res.json({ id: result.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/shopinfo/entry/:id
app.put('/api/shopinfo/entry/:id', authRequired, async (request, res) => {
  try {
    const { brand_name, branch_name, branch_code, contact_name, telephone, terminal_type, terminal_name,
            anydesk_id, teamviewer_id, remote_password, ip_address, services, note } = request.body;
    await req()
      .input('id',              sql.Int,      +request.params.id)
      .input('brand_name',      sql.NVarChar, brand_name      || null)
      .input('branch_name',     sql.NVarChar, branch_name     || null)
      .input('branch_code',     sql.NVarChar, branch_code     || null)
      .input('contact_name',    sql.NVarChar, contact_name    || null)
      .input('telephone',       sql.NVarChar, telephone       || null)
      .input('terminal_type',   sql.NVarChar, terminal_type   || null)
      .input('terminal_name',   sql.NVarChar, terminal_name   || null)
      .input('anydesk_id',      sql.NVarChar, anydesk_id      || null)
      .input('teamviewer_id',   sql.NVarChar, teamviewer_id   || null)
      .input('remote_password', sql.NVarChar, remote_password || null)
      .input('ip_address',      sql.NVarChar, ip_address      || null)
      .input('services',        sql.NVarChar, services        || null)
      .input('note',            sql.NVarChar, note            || null)
      .query(`UPDATE shop_entries
              SET brand_name=@brand_name, branch_name=@branch_name, branch_code=@branch_code,
                  contact_name=@contact_name, telephone=@telephone,
                  terminal_type=@terminal_type, terminal_name=@terminal_name,
                  anydesk_id=@anydesk_id, teamviewer_id=@teamviewer_id, remote_password=@remote_password,
                  ip_address=@ip_address, services=@services, note=@note, updated_at=GETDATE()
              WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shopinfo/entry/:id
app.delete('/api/shopinfo/entry/:id', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, +request.params.id).query('DELETE FROM shop_entries WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/dashboard/issues — Issue Analytics: subject breakdown + heatmap
app.get('/api/dashboard/issues', authRequired, async (request, res) => {
  try {
    const { dateFrom, dateTo } = request.query;
    const s = dateFrom ? new Date(dateFrom) : new Date(new Date().setHours(0,0,0,0));
    const e = dateTo   ? new Date(new Date(dateTo).setHours(23,59,59,999)) : new Date(new Date().setHours(23,59,59,999));

    const [subjectR, categoryR, heatmapR, totalR, customerR, custDetailR, custSubjectR] = await Promise.all([
      extReq()
        .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
        .query(`SELECT cl.Subject AS subject,
                       ISNULL(pt.ProblemTypeDetail,'(ไม่ระบุ)') AS category,
                       COUNT(*) AS cnt
                FROM Calllog cl
                LEFT JOIN ProblemType pt ON pt.ProblemTypeId=cl.ProblemTypeId
                WHERE cl.Active=1 AND cl.ReceiveDate>=@s AND cl.ReceiveDate<=@e
                  AND cl.Subject IS NOT NULL AND LEN(LTRIM(cl.Subject))>0
                GROUP BY cl.Subject, pt.ProblemTypeDetail ORDER BY cnt DESC`),
      extReq()
        .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
        .query(`SELECT ISNULL(pt.ProblemTypeDetail,'(ไม่ระบุ)') AS category, COUNT(*) AS cnt
                FROM Calllog cl
                LEFT JOIN ProblemType pt ON pt.ProblemTypeId=cl.ProblemTypeId
                WHERE cl.Active=1 AND cl.ReceiveDate>=@s AND cl.ReceiveDate<=@e
                GROUP BY pt.ProblemTypeDetail ORDER BY cnt DESC`),
      extReq()
        .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
        .query(`SELECT DATEPART(weekday,cl.ReceiveDate) AS dow,
                       DATEPART(hour,cl.ReceiveDate) AS hr,
                       COUNT(*) AS cnt
                FROM Calllog cl
                WHERE cl.Active=1 AND cl.ReceiveDate>=@s AND cl.ReceiveDate<=@e
                GROUP BY DATEPART(weekday,cl.ReceiveDate), DATEPART(hour,cl.ReceiveDate)`),
      extReq()
        .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
        .query(`SELECT COUNT(*) AS cnt FROM Calllog cl
                WHERE cl.Active=1 AND cl.ReceiveDate>=@s AND cl.ReceiveDate<=@e`),
      extReq()
        .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
        .query(`SELECT TOP 5 cr.CompanyName AS customer_name, COUNT(*) AS cnt
                FROM Calllog cl
                INNER JOIN CustomerRegistration cr ON cr.RegistrationId=cl.RegistrationId
                WHERE cl.Active=1 AND cl.ReceiveDate>=@s AND cl.ReceiveDate<=@e
                  AND cr.CompanyName IS NOT NULL AND LEN(LTRIM(cr.CompanyName))>0
                GROUP BY cr.CompanyName ORDER BY cnt DESC`),
      extReq()
        .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
        .query(`SELECT cr.CompanyName AS customer_name,
                       ISNULL(pt.ProblemTypeDetail,'(ไม่ระบุ)') AS category,
                       COUNT(*) AS cnt
                FROM Calllog cl
                INNER JOIN CustomerRegistration cr ON cr.RegistrationId=cl.RegistrationId
                LEFT JOIN ProblemType pt ON pt.ProblemTypeId=cl.ProblemTypeId
                WHERE cl.Active=1 AND cl.ReceiveDate>=@s AND cl.ReceiveDate<=@e
                  AND cr.CompanyName IS NOT NULL AND LEN(LTRIM(cr.CompanyName))>0
                GROUP BY cr.CompanyName, pt.ProblemTypeDetail`),
      extReq()
        .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
        .query(`SELECT cr.CompanyName AS customer_name,
                       cl.Subject AS subject,
                       COUNT(*) AS cnt
                FROM Calllog cl
                INNER JOIN CustomerRegistration cr ON cr.RegistrationId=cl.RegistrationId
                WHERE cl.Active=1 AND cl.ReceiveDate>=@s AND cl.ReceiveDate<=@e
                  AND cr.CompanyName IS NOT NULL AND LEN(LTRIM(cr.CompanyName))>0
                  AND cl.Subject IS NOT NULL AND LEN(LTRIM(cl.Subject))>0
                GROUP BY cr.CompanyName, cl.Subject`)
    ]);

    res.json({
      subjects:            subjectR.recordset,
      categories:          categoryR.recordset,
      heatmap:             heatmapR.recordset,
      total:               totalR.recordset[0]?.cnt || 0,
      customers:           customerR.recordset,
      customers_detail:    custDetailR.recordset,
      customers_by_subject: custSubjectR.recordset
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shopinfo/entry-brand — delete all entries of a brand
app.delete('/api/shopinfo/entry-brand', authRequired, async (request, res) => {
  const { brand_name } = request.body || {};
  if (!brand_name) return res.status(400).json({ error: 'brand_name required' });
  try {
    await req()
      .input('bn', sql.NVarChar, brand_name)
      .query('DELETE FROM shop_entries WHERE brand_name=@bn');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/shopinfo/entry-brand — rename a brand across all entries
app.put('/api/shopinfo/entry-brand', authRequired, async (request, res) => {
  const { old_name, new_name } = request.body || {};
  if (!old_name || !new_name) return res.status(400).json({ error: 'old_name and new_name required' });
  try {
    await req()
      .input('old', sql.NVarChar, old_name)
      .input('new', sql.NVarChar, new_name)
      .query('UPDATE shop_entries SET brand_name=@new WHERE brand_name=@old');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shopinfo/entries/import — batch insert entries from CSV import
app.post('/api/shopinfo/entries/import', authRequired, async (request, res) => {
  try {
    const rows = request.body?.entries;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'no entries' });
    let inserted = 0;
    for (const r of rows) {
      try {
        await req()
          .input('bn',  sql.NVarChar, r.brand_name      || null)
          .input('brn', sql.NVarChar, r.branch_name     || null)
          .input('brc', sql.NVarChar, r.branch_code     || null)
          .input('cn',  sql.NVarChar, r.contact_name    || null)
          .input('tel', sql.NVarChar, r.telephone       || null)
          .input('tt',  sql.NVarChar, r.terminal_type   || null)
          .input('tn',  sql.NVarChar, r.terminal_name   || null)
          .input('ad',  sql.NVarChar, r.anydesk_id      || null)
          .input('tv',  sql.NVarChar, r.teamviewer_id   || null)
          .input('pw',  sql.NVarChar, r.remote_password || null)
          .input('ip',  sql.NVarChar, r.ip_address      || null)
          .input('sv',  sql.NVarChar, r.services        || null)
          .input('nt',  sql.NVarChar, r.note            || null)
          .query(`INSERT INTO shop_entries
            (brand_name,branch_name,branch_code,contact_name,telephone,terminal_type,terminal_name,
             anydesk_id,teamviewer_id,remote_password,ip_address,services,note)
            VALUES(@bn,@brn,@brc,@cn,@tel,@tt,@tn,@ad,@tv,@pw,@ip,@sv,@nt)`);
        inserted++;
      } catch {}
    }
    res.json({ ok: true, inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  SHOP KNOWLEDGE — APIs
// ══════════════════════════════════════════════════════════

// GET /api/shopinfo/knowledge?brand=&q=
app.get('/api/shopinfo/knowledge', authRequired, async (request, res) => {
  try {
    const { brand, q } = request.query;
    let sql_where = '1=1';
    const qr = req();
    if (brand) { qr.input('brand', sql.NVarChar, brand); sql_where += ' AND brand_name=@brand'; }
    if (q)     { qr.input('q', sql.NVarChar, '%'+q+'%'); sql_where += ' AND (title LIKE @q OR content LIKE @q OR category LIKE @q)'; }
    const rows = (await qr.query(`
      SELECT k.*, e.name AS created_by_name, e2.name AS updated_by_name
      FROM shop_knowledge k
      LEFT JOIN app_users au  ON au.id = k.created_by
      LEFT JOIN employees e   ON e.id  = au.employee_id
      LEFT JOIN app_users au2 ON au2.id = k.updated_by
      LEFT JOIN employees e2  ON e2.id  = au2.employee_id
      WHERE ${sql_where}
      ORDER BY k.brand_name, k.sort_order, k.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shopinfo/knowledge
app.post('/api/shopinfo/knowledge', authRequired, async (request, res) => {
  try {
    const b = request.body;
    if (!b.brand_name?.trim()) return res.status(400).json({ error: 'กรุณาระบุแบรนด์' });
    if (!b.title?.trim())      return res.status(400).json({ error: 'กรุณาระบุหัวข้อ' });
    const r = await req()
      .input('bn', sql.NVarChar, b.brand_name.trim())
      .input('br', sql.NVarChar, b.branch_name?.trim() || null)
      .input('cat', sql.NVarChar, b.category?.trim() || 'ทั่วไป')
      .input('ti', sql.NVarChar, b.title.trim())
      .input('co', sql.NVarChar, b.content || null)
      .input('so', sql.Int, b.sort_order || 0)
      .input('cb', sql.Int, request.user.id)
      .query(`INSERT INTO shop_knowledge(brand_name,branch_name,category,title,content,sort_order,created_by,updated_by)
              OUTPUT INSERTED.id VALUES(@bn,@br,@cat,@ti,@co,@so,@cb,@cb)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/shopinfo/knowledge/:id
app.put('/api/shopinfo/knowledge/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b  = request.body;
    let r = req().input('id', sql.Int, id).input('ub', sql.Int, request.user.id);
    const updates = ['updated_at=GETDATE()', 'updated_by=@ub'];
    if (b.hasOwnProperty('brand_name'))  { r=r.input('bn',sql.NVarChar,b.brand_name?.trim()||null);   updates.push('brand_name=@bn'); }
    if (b.hasOwnProperty('branch_name')) { r=r.input('br',sql.NVarChar,b.branch_name?.trim()||null);  updates.push('branch_name=@br'); }
    if (b.hasOwnProperty('category'))    { r=r.input('cat',sql.NVarChar,b.category?.trim()||'ทั่วไป'); updates.push('category=@cat'); }
    if (b.hasOwnProperty('title'))       { r=r.input('ti',sql.NVarChar,b.title?.trim()||null);        updates.push('title=@ti'); }
    if (b.hasOwnProperty('content'))     { r=r.input('co',sql.NVarChar,b.content??null);              updates.push('content=@co'); }
    if (b.hasOwnProperty('sort_order'))  { r=r.input('so',sql.Int,b.sort_order||0);                   updates.push('sort_order=@so'); }
    await r.query(`UPDATE shop_knowledge SET ${updates.join(',')} WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shopinfo/knowledge/:id
app.delete('/api/shopinfo/knowledge/:id', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, parseInt(request.params.id))
      .query('DELETE FROM shop_knowledge WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shopinfo/knowledge/:id/images
app.get('/api/shopinfo/knowledge/:id/images', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const result = await req().input('id', sql.Int, id)
      .query('SELECT * FROM shop_knowledge_images WHERE knowledge_id=@id ORDER BY sort_order, created_at');
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/shopinfo/knowledge/:id/images  (multipart upload)
app.post('/api/shopinfo/knowledge/:id/images', authRequired, skUpload.array('images', 20), async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const caption = request.body.caption || null;
    const inserted = [];
    for (const file of (request.files || [])) {
      const r = await req()
        .input('kid', sql.Int, id)
        .input('fn',  sql.NVarChar, file.filename)
        .input('on',  sql.NVarChar, file.originalname)
        .input('cap', sql.NVarChar, caption)
        .query(`INSERT INTO shop_knowledge_images(knowledge_id,filename,original_name,caption)
                OUTPUT INSERTED.id, INSERTED.filename, INSERTED.original_name, INSERTED.knowledge_id
                VALUES(@kid,@fn,@on,@cap)`);
      if (r.recordset[0]) inserted.push(r.recordset[0]);
    }
    res.json({ ok: true, count: inserted.length, images: inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/shopinfo/knowledge/images/:imgId
app.delete('/api/shopinfo/knowledge/images/:imgId', authRequired, async (request, res) => {
  try {
    const imgId = parseInt(request.params.imgId);
    const row = await req().input('id', sql.Int, imgId)
      .query('SELECT * FROM shop_knowledge_images WHERE id=@id');
    if (row.recordset[0]) {
      const r = row.recordset[0];
      const filePath = path.join(UPLOAD_DIR, 'knowledge', String(r.knowledge_id), r.filename);
      try { fs.unlinkSync(filePath); } catch {}
      await req().input('id', sql.Int, imgId).query('DELETE FROM shop_knowledge_images WHERE id=@id');
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  LINE NOTIFICATION SETTINGS — APIs
// ══════════════════════════════════════════════════════════

// GET /api/settings/line
app.get('/api/settings/line', authRequired, async (request, res) => {
  try {
    const tokenRow = (await req().query(`SELECT channel_token FROM line_settings WHERE id=1`)).recordset[0];
    const rawToken = tokenRow?.channel_token || null;
    let maskedToken = null;
    if (rawToken && rawToken.length >= 8) {
      maskedToken = rawToken.slice(0, 4) + '****' + rawToken.slice(-4);
    } else if (rawToken) {
      maskedToken = '****';
    }
    const targets = (await req().query(`SELECT * FROM line_notify_targets ORDER BY created_at`)).recordset;
    res.json({ token: maskedToken, has_token: !!rawToken, targets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/line/token
app.post('/api/settings/line/token', authRequired, async (request, res) => {
  try {
    const { token } = request.body;
    await req()
      .input('tok', sql.NVarChar, token?.trim() || null)
      .query(`UPDATE line_settings SET channel_token=@tok, updated_at=GETDATE() WHERE id=1`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/settings/line/targets
app.get('/api/settings/line/targets', authRequired, async (request, res) => {
  try {
    const targets = (await req().query(`SELECT * FROM line_notify_targets ORDER BY created_at`)).recordset;
    res.json(targets);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/line/targets
app.post('/api/settings/line/targets', authRequired, async (request, res) => {
  try {
    const { name, group_id, events, serve_types, project_ids } = request.body;
    if (!name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อกลุ่ม' });
    if (!group_id?.trim()) return res.status(400).json({ error: 'กรุณาระบุ Group ID' });
    const eventsStr    = Array.isArray(events)      ? events.join(',')      : (events      || null);
    const serveTypeStr = Array.isArray(serve_types) ? serve_types.join(',') : (serve_types || null);
    const projIdsStr   = Array.isArray(project_ids) ? project_ids.join(',') : (project_ids || null);
    const r = await req()
      .input('nm',  sql.NVarChar, name.trim())
      .input('gid', sql.NVarChar, group_id.trim())
      .input('ev',  sql.NVarChar, eventsStr || null)
      .input('st',  sql.NVarChar, serveTypeStr || null)
      .input('pi',  sql.NVarChar, projIdsStr || null)
      .query(`INSERT INTO line_notify_targets (name, group_id, events, serve_types, project_ids) OUTPUT INSERTED.id VALUES (@nm, @gid, @ev, @st, @pi)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/settings/line/targets/:id
app.put('/api/settings/line/targets/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const { name, group_id, events, serve_types, project_ids, active } = request.body;
    const eventsStr    = Array.isArray(events)      ? events.join(',')      : (events      ?? null);
    const serveTypeStr = Array.isArray(serve_types) ? serve_types.join(',') : (serve_types ?? null);
    const projIdsStr   = Array.isArray(project_ids) ? project_ids.join(',') : (project_ids ?? null);
    await req()
      .input('id',  sql.Int,      id)
      .input('nm',  sql.NVarChar, name?.trim() || null)
      .input('gid', sql.NVarChar, group_id?.trim() || null)
      .input('ev',  sql.NVarChar, eventsStr)
      .input('st',  sql.NVarChar, serveTypeStr)
      .input('pi',  sql.NVarChar, projIdsStr)
      .input('act', sql.Bit,      active !== undefined ? (active ? 1 : 0) : 1)
      .query(`UPDATE line_notify_targets SET name=COALESCE(@nm,name), group_id=COALESCE(@gid,group_id),
              events=@ev, serve_types=@st, project_ids=@pi, active=@act WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/settings/line/targets/:id
app.delete('/api/settings/line/targets/:id', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, parseInt(request.params.id))
      .query(`DELETE FROM line_notify_targets WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/line/targets/:id/test
app.post('/api/settings/line/targets/:id/test', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const target = (await req().input('id', sql.Int, id)
      .query(`SELECT * FROM line_notify_targets WHERE id=@id`)).recordset[0];
    if (!target) return res.status(404).json({ error: 'ไม่พบกลุ่มนี้' });
    // Read token
    let token;
    try {
      const tokenRow = (await req().query(`SELECT channel_token FROM line_settings WHERE id=1`)).recordset[0];
      token = tokenRow?.channel_token || process.env.LINE_CHANNEL_TOKEN;
    } catch { token = process.env.LINE_CHANNEL_TOKEN; }
    if (!token) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Channel Access Token' });
    const msg = `🔔 ทดสอบการแจ้งเตือน\nCS Team App — ส่งถึง: ${target.name}\n${new Date().toLocaleString('th-TH')}`;
    await axios.post('https://api.line.me/v2/bot/message/push',
      { to: target.group_id, messages: [{ type: 'text', text: msg }] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.response?.data?.message || e.message }); }
});

// ══════════════════════════════════════════════════════════
//  FOLLOW UP — DAILY DIGEST NOTIFICATION
// ══════════════════════════════════════════════════════════
const PRI_EMOJI = { urgent:'🔴', high:'🟠', normal:'🟡', low:'🟢' };
const STALE_DAYS = 3; // days without update = stale

async function sendFollowUpDigest() {
  try {
    const today    = `CAST(GETDATE() AS DATE)`;
    const tomorrow = `CAST(DATEADD(DAY,1,GETDATE()) AS DATE)`;
    const staleTS  = `DATEADD(DAY,-${STALE_DAYS},GETDATE())`;
    const notDone  = `i.status NOT IN ('resolved','cancelled')`;
    const cols     = `i.id, i.detail, i.priority, i.due_date, i.updated_at,
                      ISNULL(e.nickname,e.name) AS assigned_to_name,
                      b.name AS board_name, f.name AS folder_name`;
    const joins    = `FROM fu_issues i
                      LEFT JOIN fu_boards b  ON b.id = i.board_id
                      LEFT JOIN fu_folders f ON f.id = b.folder_id
                      LEFT JOIN app_users au ON au.id = i.assigned_to
                      LEFT JOIN employees e  ON e.id  = au.employee_id`;

    const [overdue, dueToday, dueTmr, stale] = await Promise.all([
      req().query(`SELECT ${cols} ${joins} WHERE ${notDone} AND i.due_date < ${today} ORDER BY i.due_date ASC`),
      req().query(`SELECT ${cols} ${joins} WHERE ${notDone} AND i.due_date = ${today}  ORDER BY i.priority`),
      req().query(`SELECT ${cols} ${joins} WHERE ${notDone} AND i.due_date = ${tomorrow} ORDER BY i.priority`),
      req().query(`SELECT ${cols} ${joins} WHERE ${notDone} AND i.due_date IS NOT NULL AND i.updated_at < ${staleTS} ORDER BY i.updated_at ASC`),
    ]);

    const od = overdue.recordset, td = dueToday.recordset, tm = dueTmr.recordset, st = stale.recordset;
    if (!od.length && !td.length && !tm.length && !st.length) return; // ไม่มีอะไร ไม่ส่ง

    const fmtIssue = (r) => {
      const emoji = PRI_EMOJI[r.priority] || '⚪';
      const who   = r.assigned_to_name ? ` → ${r.assigned_to_name}` : '';
      const brd   = r.folder_name ? `[${r.folder_name}/${r.board_name}]` : `[${r.board_name||'—'}]`;
      const txt   = (r.detail||'').substring(0, 60) + ((r.detail||'').length > 60 ? '…' : '');
      return `${emoji}  ${brd} เรื่อง ${txt}${who}`;
    };
    const fmtDaysAgo = (d) => {
      if (!d) return '';
      const days = Math.floor((Date.now() - new Date(String(d).replace('Z',''))) / 86400000);
      return days > 0 ? ` (${days} วันที่แล้ว)` : '';
    };

    const dateStr = new Date().toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric'});
    let msg = `📋 Follow Up สรุปรายวัน — ${dateStr}\n`;

    if (od.length) {
      msg += `\n🔴 เลยกำหนด ${od.length} รายการ:\n`;
      msg += od.map(r => fmtIssue(r) + fmtDaysAgo(r.due_date)).join('\n');
    }
    if (td.length) {
      msg += `\n\n⚠️ ครบกำหนดวันนี้ ${td.length} รายการ:\n`;
      msg += td.map(fmtIssue).join('\n');
    }
    if (tm.length) {
      msg += `\n\n🔔 พรุ่งนี้ครบกำหนด ${tm.length} รายการ:\n`;
      msg += tm.map(fmtIssue).join('\n');
    }
    if (st.length) {
      msg += `\n\n💤 ไม่มี update ${STALE_DAYS}+ วัน ${st.length} รายการ:\n`;
      msg += st.map(r => fmtIssue(r) + fmtDaysAgo(r.updated_at)).join('\n');
    }

    await sendLineNotify(msg, 'followup_due');
    console.log('📋 Follow Up digest sent');
  } catch(e) { console.error('Follow Up digest error:', e.message); }
}

// Manual trigger endpoint
app.post('/api/followup/digest', authRequired, async (req2, res) => {
  await sendFollowUpDigest();
  res.json({ ok: true });
});

// Schedule: check every minute, fire at 08:00 Bangkok (UTC+7)
let _lastDigestDate = '';
setInterval(() => {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 3600000); // UTC+7
  const hh  = bkk.getUTCHours(), mm = bkk.getUTCMinutes();
  const today = bkk.toISOString().split('T')[0];
  if (hh === 8 && mm === 0 && today !== _lastDigestDate) {
    _lastDigestDate = today;
    sendFollowUpDigest();
  }
}, 60000);

// ── News / Announcements ─────────────────────────────────────────────────────
async function ensureNewsTable() {
  await getPool().request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='news_posts')
    CREATE TABLE news_posts (
      id          INT PRIMARY KEY IDENTITY,
      title       NVARCHAR(200) NOT NULL,
      body        NVARCHAR(MAX) NOT NULL,
      category    NVARCHAR(50)  DEFAULT N'ทั่วไป',
      author_id   INT           NOT NULL,
      author_name NVARCHAR(100) NOT NULL,
      pinned      BIT           DEFAULT 0,
      links       NVARCHAR(MAX) NULL,
      created_at  DATETIME      DEFAULT GETDATE(),
      updated_at  DATETIME      DEFAULT GETDATE()
    )`);
  // Add links column to existing tables that pre-date this migration
  await getPool().request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('news_posts') AND name='links')
      ALTER TABLE news_posts ADD links NVARCHAR(MAX) NULL`);
  await getPool().request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='news_attachments')
    CREATE TABLE news_attachments (
      id            INT PRIMARY KEY IDENTITY,
      post_id       INT           NOT NULL,
      filename      NVARCHAR(300) NOT NULL,
      original_name NVARCHAR(300) NOT NULL,
      file_size     INT,
      mime_type     NVARCHAR(100),
      created_by    INT,
      created_at    DATETIME DEFAULT GETDATE()
    )`);
}

app.get('/api/news', authRequired, async (req2, res) => {
  try {
    const rows = (await req().query(`
      SELECT id, title, body, category, author_id, author_name, pinned, links,
             created_at, updated_at,
             CASE WHEN DATEDIFF(second, created_at, updated_at) > 60 THEN 1 ELSE 0 END AS is_edited
      FROM news_posts
      ORDER BY pinned DESC, created_at DESC`)).recordset;
    if (rows.length) {
      const ids = rows.map(r => parseInt(r.id)).join(',');
      const atts = (await req().query(
        `SELECT id,post_id,filename,original_name,file_size,mime_type FROM news_attachments WHERE post_id IN (${ids}) ORDER BY created_at`
      )).recordset;
      const byPost = {};
      atts.forEach(a => { (byPost[a.post_id] = byPost[a.post_id]||[]).push(a); });
      rows.forEach(r => {
        r.attachments = byPost[r.id] || [];
        try { r.links = r.links ? JSON.parse(r.links) : []; } catch { r.links = []; }
      });
    }
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/news', authRequired, leadRequired, async (request, res) => {
  try {
    const { title, body, category, links } = request.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body required' });
    const u = request.user;
    const linksJson = Array.isArray(links) ? JSON.stringify(links) : null;
    const row = (await req()
      .input('ti',  sql.NVarChar, String(title).slice(0,200))
      .input('bo',  sql.NVarChar, String(body))
      .input('ca',  sql.NVarChar, String(category||'ทั่วไป').slice(0,50))
      .input('uid', sql.Int,      u.id)
      .input('un',  sql.NVarChar, String(u.name||u.username||'').slice(0,100))
      .input('lk',  sql.NVarChar, linksJson)
      .query(`INSERT INTO news_posts (title,body,category,author_id,author_name,links)
              OUTPUT INSERTED.id,INSERTED.title,INSERTED.body,INSERTED.category,
                     INSERTED.author_id,INSERTED.author_name,INSERTED.pinned,
                     INSERTED.links,INSERTED.created_at,INSERTED.updated_at
              VALUES (@ti,@bo,@ca,@uid,@un,@lk)`)).recordset[0];
    try { row.links = row.links ? JSON.parse(row.links) : []; } catch { row.links = []; }
    row.attachments = [];
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/news/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const u  = request.user;
    const isLead = ['team_lead','manager','admin'].includes(u.role);
    const ex = (await req().input('id', sql.Int, id)
      .query('SELECT author_id FROM news_posts WHERE id=@id')).recordset[0];
    if (!ex) return res.status(404).json({ error: 'Not found' });
    if (!isLead && ex.author_id !== u.id)
      return res.status(403).json({ error: 'Access denied' });
    const { title, body, category, links } = request.body;
    const linksJson = Array.isArray(links) ? JSON.stringify(links) : null;
    await req()
      .input('id', sql.Int,      id)
      .input('ti', sql.NVarChar, String(title).slice(0,200))
      .input('bo', sql.NVarChar, String(body))
      .input('ca', sql.NVarChar, String(category||'ทั่วไป').slice(0,50))
      .input('lk', sql.NVarChar, linksJson)
      .query(`UPDATE news_posts SET title=@ti,body=@bo,category=@ca,links=@lk,updated_at=GETDATE() WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/news/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const u  = request.user;
    const isLead = ['team_lead','manager','admin'].includes(u.role);
    const ex = (await req().input('id', sql.Int, id)
      .query('SELECT author_id FROM news_posts WHERE id=@id')).recordset[0];
    if (!ex) return res.status(404).json({ error: 'Not found' });
    if (!isLead && ex.author_id !== u.id)
      return res.status(403).json({ error: 'Access denied' });
    // Delete attachment files from disk
    const atts = (await req().input('id', sql.Int, id)
      .query('SELECT filename FROM news_attachments WHERE post_id=@id')).recordset;
    for (const a of atts) {
      const fp = path.join(UPLOAD_DIR, 'news', String(id), a.filename);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
    }
    await req().input('id', sql.Int, id).query('DELETE FROM news_attachments WHERE post_id=@id');
    await req().input('id', sql.Int, id).query('DELETE FROM news_posts WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/news/:id/pin', authRequired, leadRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    await req().input('id', sql.Int, id)
      .query('UPDATE news_posts SET pinned=CASE WHEN pinned=1 THEN 0 ELSE 1 END WHERE id=@id');
    const row = (await req().input('id', sql.Int, id)
      .query('SELECT pinned FROM news_posts WHERE id=@id')).recordset[0];
    res.json({ pinned: row?.pinned || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/news/:id/attachments', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('id', sql.Int, parseInt(request.params.id))
      .query(`SELECT id,post_id,filename,original_name,file_size,mime_type,created_at
              FROM news_attachments WHERE post_id=@id ORDER BY created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/news/:id/attachments', authRequired, newsUpload.array('files', 10), async (request, res) => {
  try {
    const postId = parseInt(request.params.id);
    const files  = request.files || [];
    const inserted = [];
    for (const f of files) {
      const r = (await req()
        .input('pid', sql.Int,      postId)
        .input('fn',  sql.NVarChar, f.filename)
        .input('on',  sql.NVarChar, f.originalname)
        .input('fs',  sql.Int,      f.size)
        .input('mt',  sql.NVarChar, f.mimetype)
        .input('cb',  sql.Int,      request.user.id)
        .query(`INSERT INTO news_attachments(post_id,filename,original_name,file_size,mime_type,created_by)
                OUTPUT INSERTED.id,INSERTED.post_id,INSERTED.filename,INSERTED.original_name,INSERTED.file_size,INSERTED.mime_type
                VALUES(@pid,@fn,@on,@fs,@mt,@cb)`)).recordset[0];
      inserted.push(r);
    }
    res.json({ ok: true, files: inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/news/attachments/:id', authRequired, async (request, res) => {
  try {
    const id  = parseInt(request.params.id);
    const u   = request.user;
    const row = (await req().input('id', sql.Int, id)
      .query('SELECT na.*, np.author_id AS post_author FROM news_attachments na JOIN news_posts np ON np.id=na.post_id WHERE na.id=@id')).recordset[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    const isLead = ['team_lead','manager','admin'].includes(u.role);
    if (!isLead && row.post_author !== u.id)
      return res.status(403).json({ error: 'Access denied' });
    const fp = path.join(UPLOAD_DIR, 'news', String(row.post_id), row.filename);
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
    await req().input('id', sql.Int, id).query('DELETE FROM news_attachments WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

  await ensureErrorLogTable();
  await ensureCustomerLinksTable();
  await ensureRepairTables();
  await ensureSpecialistTable();
  await ensureRequirementsTables();
  await ensureFollowupTable();
  await ensureFollowupV2Tables();
  await ensureShopInfoTables();
  await ensureShopEntriesTable();
  await ensureShopKnowledgeTable();
  await ensureLineNotifyTable();
  await ensureServiceRequestsTable();
  await ensureServiceProjectsTable();
  await ensureServiceAttachmentsTable();
  await ensureSwUpdateTable();
  await ensureNewsTable();
  await fixGarbledServiceAttachmentNames();

  // Add show_in_schedule column to teams
  try {
    await getPool().request().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('teams') AND name='show_in_schedule')
        ALTER TABLE teams ADD show_in_schedule BIT NOT NULL DEFAULT 1`);
  } catch(e) { console.warn('show_in_schedule migration:', e.message); }

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
