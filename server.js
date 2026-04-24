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
    received: 'รับเรื่องแล้ว', assessing: 'กำลังประเมิน',
    quoted: 'เสนอราคาแล้ว', waiting_approval: 'รอลูกค้าอนุมัติ',
    device_received: 'รับเครื่องแล้ว', sent_supplier: 'ส่ง Supplier แล้ว',
    returned_from_supplier: 'ได้เครื่องคืนจาก Supplier',
    returned_to_customer: 'ส่งคืนลูกค้าแล้ว',
    closed: 'ปิดงาน', cancelled: 'ยกเลิก'
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
    pt.ProblemTypeDetail        AS problem_type_detail
  FROM Calllog cl
  INNER JOIN CustomerRegistration cr ON cr.RegistrationId  = cl.RegistrationId
  LEFT  JOIN CallStatus           cs ON cs.StatusId        = cl.StatusId
  INNER JOIN Users                u  ON u.UserId           = cl.SupportId
  LEFT  JOIN Project              p  ON p.ProjectId        = cl.ProjectId
  LEFT  JOIN ProblemType          pt ON pt.ProblemTypeId   = cl.ProblemTypeId
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

app.post('/api/shifts', async (request, res) => {
  try {
    const { employee_id, shift_type, shift_date } = request.body;

    // Check if this date already has a shift (upsert: delete first, then insert = no extra day)
    const existing = await req().input('eid', sql.Int, employee_id).input('date', sql.Date, shift_date)
      .query('SELECT id FROM shifts WHERE employee_id=@eid AND shift_date=@date AND status NOT IN (\'leave\',\'approved_leave\')');
    const isReplace = existing.recordset.length > 0;

    if (!isReplace) {
      // Count non-leave shifts this week (Mon–Sun of shift_date)
      const d = new Date(shift_date);
      const day = d.getDay(); // 0=Sun
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
                  AND status NOT IN ('leave','approved_leave')`);
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
    const { status, search, dateFrom, dateTo, team, problemType } = request.query;
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
      q += appendScopeClause(r, scope);
    }
    q += ' ORDER BY cl.ReceiveDate DESC';
    res.json((await r.query(q)).recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Overdue tickets — must be BEFORE /:id route
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
    const result = await extReq().query('SELECT DISTINCT Subject AS category FROM Calllog WHERE Subject IS NOT NULL ORDER BY Subject');
    res.json(result.recordset.map(r => r.category));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/meta/problem-types', async (_, res) => {
  try {
    if (!getExtPool()) return res.json([]);
    const result = await extReq().query(
      `SELECT DISTINCT pt.ProblemTypeDetail
       FROM ProblemType pt
       WHERE pt.ProblemTypeDetail IS NOT NULL
       ORDER BY pt.ProblemTypeDetail`
    );
    res.json(result.recordset.map(r => r.ProblemTypeDetail));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
        ticket_id    INT NOT NULL,
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
  } catch(e) { console.error('customer tables error:', e.message); }
}

// Get or create public link for a company (auto-detect group)
app.post('/api/customer-links', authRequired, async (request, res) => {
  try {
    const { company_name } = request.body;
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

// PUBLIC — get tickets by token (no auth)
app.get('/api/public/track/:token', async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'DB not available' });
    const { token } = request.params;

    // Validate token
    const link = await req().input('tok', sql.NVarChar, token)
      .query('SELECT * FROM customer_links WHERE token=@tok');
    if (!link.recordset.length) return res.status(404).json({ error: 'Link ไม่พบหรือถูกลบแล้ว' });

    const linkRow   = link.recordset[0];
    const isGroup   = linkRow.link_type === 'group' && linkRow.group_id;
    const displayName = isGroup ? linkRow.group_name : linkRow.company_name;

    const ticketQuery = `
      SELECT
        cl.CalllogId        AS id,
        cr.CompanyName,
        cl.ReceiveDate      AS opened_at,
        cl.CloseDate,
        cs.StatusName       AS status,
        cl.Subject          AS title,
        pt.ProblemTypeDetail AS problem_type,
        cl.CalllogDesc      AS description,
        cl.Solution,
        u.UserName          AS agent,
        cl.Stars,
        CASE WHEN cl.CloseDate IS NOT NULL AND cl.ReceiveDate IS NOT NULL
             THEN DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate) END AS resolve_minutes
      FROM Calllog cl
      INNER JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
      INNER JOIN CallStatus           cs ON cs.StatusId       = cl.StatusId
      INNER JOIN Users                u  ON u.UserId          = cl.SupportId
      LEFT  JOIN ProblemType          pt ON pt.ProblemTypeId  = cl.ProblemTypeId`;

    let result;
    if (isGroup) {
      // Group link: fetch all branches in the group (GroupId != 1 guaranteed by creation)
      result = await extReq().input('gid', sql.Int, linkRow.group_id)
        .query(ticketQuery + `
          WHERE cl.Active=1 AND cr.GroupId = @gid
          ORDER BY cl.ReceiveDate DESC`);
    } else {
      result = await extReq().input('cn', sql.NVarChar, `%${linkRow.company_name}%`)
        .query(ticketQuery + `
          WHERE cl.Active=1 AND cr.CompanyName LIKE @cn
          ORDER BY cl.ReceiveDate DESC`);
    }

    // Branches list (for group link — show customer which branches are included)
    let branches = [];
    if (isGroup) {
      const br = await extReq().input('gid2', sql.Int, linkRow.group_id)
        .query(`SELECT DISTINCT cr.CompanyName
                FROM CustomerRegistration cr WHERE cr.GroupId=@gid2 ORDER BY cr.CompanyName`);
      branches = br.recordset.map(r => r.CompanyName);
    }

    // Complaints
    const complaints = isGroup
      ? await req().input('gid3', sql.Int, linkRow.group_id)
          .query(`SELECT id, ticket_id, message, status, created_at
                  FROM ticket_complaints tc
                  WHERE EXISTS (
                    SELECT 1 FROM CustomerRegistration cr
                    WHERE cr.CompanyName = tc.company_name AND cr.GroupId = @gid3
                  ) ORDER BY created_at DESC`)
      : await req().input('cn2', sql.NVarChar, linkRow.company_name)
          .query(`SELECT id, ticket_id, message, status, created_at
                  FROM ticket_complaints WHERE company_name=@cn2 ORDER BY created_at DESC`);

    res.json({
      company:    displayName,
      isGroup,
      groupId:    linkRow.group_id || null,
      branches,
      tickets:    result.recordset,
      complaints: complaints.recordset
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
    // Unread = customer_message entries where read_at IS NULL
    // We track read by adding read_at column lazily
    const result = await req().query(`
      SELECT rt.repair_id, rj.job_no, rj.company_name,
             COUNT(*) AS msg_count,
             MAX(rt.changed_at) AS last_msg
      FROM repair_timeline rt
      JOIN repair_jobs rj ON rj.id = rt.repair_id
      WHERE rt.field_changed = 'customer_message'
        AND rt.read_at IS NULL
      GROUP BY rt.repair_id, rj.job_no, rj.company_name
      ORDER BY last_msg DESC`);
    res.json(result.recordset);
  } catch(e) {
    // If read_at column doesn't exist yet, add it
    if (e.message.includes('read_at')) {
      try {
        await req().query(`ALTER TABLE repair_timeline ADD read_at DATETIME NULL`);
        return res.json([]);
      } catch {}
    }
    res.json([]);
  }
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

// Customer message from tracking page (no auth)
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
    const { status, dateFrom, dateTo, search } = request.query;
    let q = `SELECT rj.*, e.name AS reporter_name, e2.name AS updater_name
             FROM repair_jobs rj
             LEFT JOIN app_users au  ON au.id = rj.reported_by
             LEFT JOIN employees e   ON e.id  = au.employee_id
             LEFT JOIN app_users au2 ON au2.id = rj.updated_by
             LEFT JOIN employees e2  ON e2.id  = au2.employee_id
             WHERE 1=1`;
    const r = req();
    if (status)   { q += ' AND rj.status=@st';          r.input('st', sql.NVarChar, status); }
    if (dateFrom) { q += ' AND rj.reported_at>=@df';    r.input('df', sql.DateTime, new Date(dateFrom)); }
    if (dateTo)   { q += ' AND rj.reported_at<@dt';     r.input('dt', sql.DateTime, new Date(new Date(dateTo).getTime()+86400000)); }
    if (search)   { q += ' AND (rj.job_no LIKE @s OR rj.company_name LIKE @s OR rj.serial_no LIKE @s OR rj.contact_name LIKE @s)';
                                                         r.input('s', sql.NVarChar, `%${search}%`); }
    q += ' ORDER BY rj.reported_at DESC';
    res.json((await r.query(q)).recordset);
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
                     au.employee_id, e.name, e.team, e.nickname
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
      SELECT au.id, au.username, au.role, au.ext_username, au.active, au.created_at,
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
      .query(`INSERT INTO app_users (employee_id, username, password_hash, role, ext_username)
              OUTPUT INSERTED.id VALUES (@eid,@uname,@hash,@role,@extuname)`);
    res.json({ id: result.recordset[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', authRequired, async (request, res) => {
  const { username, password, role, ext_username, active } = request.body;
  try {
    const r = req()
      .input('uname',    sql.NVarChar, username)
      .input('role',     sql.NVarChar, role)
      .input('extuname', sql.NVarChar, ext_username || null)
      .input('active',   sql.Bit,      active ?? 1)
      .input('id',       sql.Int,      request.params.id);
    let q = 'UPDATE app_users SET username=@uname,role=@role,ext_username=@extuname,active=@active';
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
      r8.query(`SELECT TOP 500 CAST(cl.ReceiveDate AS DATE) AS day, cl.Subject AS cat, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc8}
        GROUP BY CAST(cl.ReceiveDate AS DATE), cl.Subject ORDER BY day, cnt DESC`),
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
    console.log('✅ Repair tables ready');
  } catch(e) { console.error('❌ Repair table error:', e.message); }
}

init().then(async () => {
  await ensureCustomerLinksTable();
  await ensureRepairTables();
  app.listen(PORT, () => console.log(`🚀 CS Team App running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('❌ Startup failed:', err.message);
  process.exit(1);
});
