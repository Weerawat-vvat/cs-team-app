require('dotenv').config();
const express                    = require('express');
const cors                       = require('cors');
const path                       = require('path');
const bcrypt                     = require('bcryptjs');
const jwt                        = require('jsonwebtoken');
const { init, getPool, getExtPool, sql } = require('./database');
const Anthropic                  = require('@anthropic-ai/sdk');

const app        = express();
const PORT       = process.env.PORT || 3010;
const AI_MODEL   = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const JWT_SECRET = process.env.JWT_SECRET || 'cs-team-jwt-secret-change-in-prod';
const claude     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    cl.Subject          AS category,
    u.UserName          AS assigned_name,
    cl.IssueURL,
    cl.Subject          AS title,
    pt.Note             AS problem_type
  FROM Calllog cl
  INNER JOIN CustomerRegistration cr ON cr.RegistrationId  = cl.RegistrationId
  INNER JOIN CallStatus           cs ON cs.StatusId        = cl.StatusId
  INNER JOIN Users                u  ON u.UserId           = cl.SupportId
  LEFT  JOIN Project              p  ON p.ProjectId        = cl.ProjectId
  LEFT  JOIN ProblemType          pt ON pt.ProblemTypeId   = cl.ProblemTypeId
`;

// ══════════════════════════════════════════════════════════
//  EMPLOYEES (cs_team)
// ══════════════════════════════════════════════════════════
app.get('/api/employees', async (request, res) => {
  try {
    const { team, include_inactive } = request.query;
    const r = req();
    let q = `SELECT id, name, nickname, team, role, phone, start_date, active, created_at
             FROM employees`;
    const conds = [];
    if (!include_inactive) conds.push('active=1');
    if (team) { conds.push('team=@team'); r.input('team', sql.NVarChar, team); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY team, role DESC, id';
    res.json((await r.query(q)).recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/employees', async (request, res) => {
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

app.put('/api/employees/:id', async (request, res) => {
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

app.delete('/api/employees/:id', async (request, res) => {
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

app.get('/api/shifts', async (request, res) => {
  try {
    const { week_start, team } = request.query;
    const startDate = getMonday(week_start);
    const endD = new Date(startDate); endD.setDate(endD.getDate() + 6);
    const endDate = endD.toISOString().split('T')[0];
    const r = req().input('s', sql.Date, startDate).input('e', sql.Date, endDate);
    let q = `SELECT s.*, e.name, e.team, e.role
             FROM shifts s JOIN employees e ON e.id=s.employee_id
             WHERE e.active=1 AND s.shift_date BETWEEN @s AND @e`;
    if (team) { q += ' AND e.team=@team'; r.input('team', sql.NVarChar, team); }
    q += ' ORDER BY s.shift_date, e.team, s.shift_type, e.id';
    res.json((await r.query(q)).recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shifts', async (request, res) => {
  try {
    const { employee_id, shift_type, shift_date } = request.body;
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

app.get('/api/shifts/coverage', async (request, res) => {
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
app.get('/api/leave-requests', async (_, res) => {
  try {
    const result = await req().query(`
      SELECT lr.*, e.name AS emp_name, e.team, a.name AS approver_name
      FROM leave_requests lr
      JOIN employees e ON e.id=lr.employee_id
      LEFT JOIN employees a ON a.id=lr.approved_by
      ORDER BY lr.created_at DESC`);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leave-requests', async (request, res) => {
  try {
    const { employee_id, leave_date, reason } = request.body;
    const result = await req()
      .input('eid', sql.Int, employee_id).input('date', sql.Date, leave_date)
      .input('reason', sql.NVarChar, reason)
      .query('INSERT INTO leave_requests (employee_id,leave_date,reason) OUTPUT INSERTED.id VALUES (@eid,@date,@reason)');
    res.json({ id: result.recordset[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leave-requests/:id/approve', async (request, res) => {
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

app.put('/api/leave-requests/:id/reject', async (request, res) => {
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
    const { status, search, dateFrom, dateTo, team } = request.query;
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
    let q = CALLLOG_SELECT + ' WHERE cl.ReceiveDate >= @df';
    r.input('df', sql.DateTime, new Date(defaultFrom));
    if (status) { q += ' AND cs.StatusName=@status';  r.input('status', sql.NVarChar, status); }
    if (search) { q += ' AND (cl.Subject LIKE @s OR cr.CompanyName LIKE @s OR u.UserName LIKE @s)';
                                                       r.input('s',      sql.NVarChar, `%${search}%`); }
    if (dateTo) { q += ' AND cl.ReceiveDate <= @dt';  r.input('dt',     sql.DateTime, new Date(dateTo + 'T23:59:59')); }
    q += appendScopeClause(r, scope);
    q += ' ORDER BY cl.ReceiveDate DESC';
    res.json((await r.query(q)).recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets/:id', async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const result = await extReq().input('id', sql.Int, request.params.id)
      .query(CALLLOG_SELECT + ' WHERE cl.CalllogId=@id');
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
    const { month, team } = request.query;
    const ym = (month || new Date().toISOString().substring(0, 7));
    const monthStart = ym + '-01';
    const monthEnd   = new Date(new Date(monthStart).setMonth(new Date(monthStart).getMonth() + 1));

    // Resolve RBAC scope + optional team filter
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

    const r = extReq().input('s', sql.DateTime, new Date(monthStart)).input('e', sql.DateTime, monthEnd);
    const sc = appendScopeClause(r, scope);
    const kpiRows = await r.query(`
        SELECT
          u.UserName,
          COUNT(cl.CalllogId) AS total_cases,
          MIN(cl.ReceiveDate) AS first_case,
          MAX(cl.ReceiveDate) AS last_case
        FROM Calllog cl
        INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @s AND cl.ReceiveDate < @e${sc}
        GROUP BY u.UserName, u.UserId
        ORDER BY total_cases DESC
      `);
    const comments = await req()
      .input('month', sql.Date, monthStart)
      .query(`SELECT ext_username, comment, recorded_by,
                     e.name AS recorder_name
              FROM kpi_comments kc
              LEFT JOIN employees e ON e.id = kc.recorded_by
              WHERE month = @month`);
    const commentMap = {};
    comments.recordset.forEach(c => { commentMap[c.ext_username] = c; });
    const result = kpiRows.recordset.map(r => ({
      ...r,
      month: monthStart,
      comment:       commentMap[r.UserName]?.comment       || null,
      recorded_by:   commentMap[r.UserName]?.recorded_by   || null,
      recorder_name: commentMap[r.UserName]?.recorder_name || null,
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KPI Agent Detail drill-down ──────────────────────────
app.get('/api/kpi/agent-detail', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { username, month } = request.query;
    if (!username) return res.status(400).json({ error: 'username required' });
    const ym = month || new Date().toISOString().substring(0, 7);
    const monthStart = ym + '-01';
    const monthEnd   = new Date(new Date(monthStart).setMonth(new Date(monthStart).getMonth() + 1));

    const r = extReq()
      .input('s',  sql.DateTime, new Date(monthStart))
      .input('e',  sql.DateTime, monthEnd)
      .input('un', sql.NVarChar, username);

    const [cats, daily, timing] = await Promise.all([
      // Top categories
      r.query(`SELECT cl.Subject AS category,
                      COUNT(*) AS cnt,
                      AVG(CAST(cl.Stars AS FLOAT)) AS avg_stars
               FROM Calllog cl
               INNER JOIN Users u ON u.UserId = cl.SupportId
               WHERE cl.ReceiveDate >= @s AND cl.ReceiveDate < @e
                 AND u.UserName = @un
               GROUP BY cl.Subject
               ORDER BY cnt DESC`),
      // Daily trend
      extReq().input('s', sql.DateTime, new Date(monthStart)).input('e', sql.DateTime, monthEnd)
        .input('un', sql.NVarChar, username)
        .query(`SELECT CAST(cl.ReceiveDate AS DATE) AS day, COUNT(*) AS cnt
                FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
                WHERE cl.ReceiveDate >= @s AND cl.ReceiveDate < @e AND u.UserName = @un
                GROUP BY CAST(cl.ReceiveDate AS DATE) ORDER BY day`),
      // Avg resolution time + stars
      extReq().input('s', sql.DateTime, new Date(monthStart)).input('e', sql.DateTime, monthEnd)
        .input('un', sql.NVarChar, username)
        .query(`SELECT
                  COUNT(*) AS total,
                  AVG(CASE WHEN cl.CloseDate IS NOT NULL
                       THEN DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate) END) AS avg_minutes,
                  AVG(CAST(cl.Stars AS FLOAT)) AS avg_stars,
                  COUNT(CASE WHEN cl.Stars IS NOT NULL THEN 1 END) AS rated_count
                FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
                WHERE cl.ReceiveDate >= @s AND cl.ReceiveDate < @e AND u.UserName = @un`)
    ]);

    res.json({
      categories:  cats.recordset,
      dailyTrend:  daily.recordset,
      summary:     timing.recordset[0] || {}
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/kpi/comment', async (request, res) => {
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

app.get('/api/kpi/history', async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { months = 6 } = request.query;
    const result = await extReq()
      .input('months', sql.Int, parseInt(months))
      .query(`
        SELECT
          FORMAT(cl.ReceiveDate,'yyyy-MM') AS month,
          u.UserName,
          COUNT(cl.CalllogId) AS total_cases
        FROM Calllog cl
        INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= '2026-01-01'
        GROUP BY FORMAT(cl.ReceiveDate,'yyyy-MM'), u.UserName
        ORDER BY month, total_cases DESC
      `);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  DASHBOARD — Calllog (LicenseDB) + shifts/leaves (cs_team)
// ══════════════════════════════════════════════════════════
app.get('/api/dashboard', async (_, res) => {
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
app.post('/api/ai/chat', async (request, res) => {
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
app.get('/api/ai/dashboard-summary', async (_, res) => {
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
app.post('/api/ai/suggest-shifts', async (request, res) => {
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
app.get('/api/ai/forecast-kpi', async (request, res) => {
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
//  TEAMS (cs_team)
// ══════════════════════════════════════════════════════════
app.get('/api/teams', async (request, res) => {
  try {
    const result = await req().query(
      'SELECT * FROM teams WHERE active=1 ORDER BY sort_order, display_name'
    );
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/teams', async (request, res) => {
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

app.put('/api/teams/:id', async (request, res) => {
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

app.delete('/api/teams/:id', async (request, res) => {
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
    const meDate = dateTo ? new Date(dateTo + 'T23:59:59') : new Date(new Date(msStr).setMonth(msDate.getMonth() + 1));

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

    const [d1, d2, d3, d4, d5, d6, d7, d8, d9] = await Promise.all([
      // Daily trend
      r1.query(`SELECT CAST(cl.ReceiveDate AS DATE) AS day, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc1}
        GROUP BY CAST(cl.ReceiveDate AS DATE) ORDER BY day`),
      // Category stats
      r2.query(`SELECT cl.Subject AS category, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc2}
        GROUP BY cl.Subject ORDER BY cnt DESC`),
      // Agent cases — this period
      r3.query(`SELECT u.UserName, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc3}
        GROUP BY u.UserName ORDER BY cnt DESC`),
      // Agent cases — previous period
      r4.query(`SELECT u.UserName, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc4}
        GROUP BY u.UserName`),
      // Agent × category
      r5.query(`SELECT TOP 300 u.UserName, cl.Subject AS category, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc5}
        GROUP BY u.UserName, cl.Subject ORDER BY u.UserName, cnt DESC`),
      // Hourly distribution
      r6.query(`SELECT DATEPART(hour, cl.ReceiveDate) AS hr, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc6}
        GROUP BY DATEPART(hour, cl.ReceiveDate) ORDER BY hr`),
      // Day-of-week distribution
      r7.query(`SELECT DATEPART(weekday, cl.ReceiveDate) AS dow, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc7}
        GROUP BY DATEPART(weekday, cl.ReceiveDate) ORDER BY dow`),
      // Category daily trend (top cats over time)
      r8.query(`SELECT TOP 500 CAST(cl.ReceiveDate AS DATE) AS day, cl.Subject AS cat, COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc8}
        GROUP BY CAST(cl.ReceiveDate AS DATE), cl.Subject ORDER BY day, cnt DESC`),
      // Closed count this period
      r9.query(`SELECT COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        INNER JOIN CallStatus cs ON cs.StatusId = cl.StatusId
        WHERE cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me
          AND (cs.StatusName LIKE '%close%' OR cs.StatusName LIKE '%ปิด%' OR cs.StatusName LIKE '%complete%')${sc9}`),
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
      closedThis:    d9.recordset[0]?.cnt || 0,
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
app.get('/api/ai-analysis', async (_, res) => {
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
init().then(() => {
  app.listen(PORT, () => console.log(`🚀 CS Team App running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('❌ Startup failed:', err.message);
  process.exit(1);
});
