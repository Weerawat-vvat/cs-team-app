require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const { init }   = require('./database');
const Anthropic  = require('@anthropic-ai/sdk');

const app     = express();
const PORT    = process.env.PORT || 3010;
const AI_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const claude  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db; // filled after async init

// ══════════════════════════════════════════════════════════
//  EMPLOYEES
// ══════════════════════════════════════════════════════════
app.get('/api/employees', (req, res) => {
  const { team } = req.query;
  let sql = 'SELECT * FROM employees WHERE active=1';
  const params = [];
  if (team) { sql += ' AND team=?'; params.push(team); }
  sql += ' ORDER BY team, role DESC, id';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/employees', (req, res) => {
  const { name, team, role } = req.body;
  const result = db.prepare(
    'INSERT INTO employees (name, team, role) VALUES (?, ?, ?)'
  ).run(name, team, role || 'staff');
  res.json({ id: result.lastInsertRowid, name, team, role });
});

app.put('/api/employees/:id', (req, res) => {
  const { name, team, role, active } = req.body;
  db.prepare(
    'UPDATE employees SET name=?, team=?, role=?, active=? WHERE id=?'
  ).run(name, team, role, active, req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
//  SHIFTS
// ══════════════════════════════════════════════════════════
app.get('/api/shifts', (req, res) => {
  const { week_start, team } = req.query;
  // default: this week Mon
  let startDate = week_start;
  if (!startDate) {
    const today = new Date();
    const d = today.getDay();
    const diff = d === 0 ? -6 : 1 - d;
    const mon = new Date(today);
    mon.setDate(today.getDate() + diff);
    startDate = mon.toISOString().split('T')[0];
  }
  const endD = new Date(startDate);
  endD.setDate(endD.getDate() + 6);
  const endDate = endD.toISOString().split('T')[0];

  let sql = `
    SELECT s.*, e.name, e.team, e.role
    FROM shifts s
    JOIN employees e ON e.id = s.employee_id
    WHERE e.active=1 AND s.shift_date BETWEEN ? AND ?
  `;
  const params = [startDate, endDate];
  if (team) { sql += ' AND e.team=?'; params.push(team); }
  sql += ' ORDER BY s.shift_date, e.team, s.shift_type, e.id';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/shifts', (req, res) => {
  const { employee_id, shift_type, shift_date } = req.body;
  // upsert: delete old then insert
  db.prepare('DELETE FROM shifts WHERE employee_id=? AND shift_date=?').run(employee_id, shift_date);
  const r = db.prepare(
    'INSERT INTO shifts (employee_id, shift_type, shift_date) VALUES (?, ?, ?)'
  ).run(employee_id, shift_type, shift_date);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/shifts/:id', (req, res) => {
  const { shift_type, status } = req.body;
  db.prepare('UPDATE shifts SET shift_type=?, status=? WHERE id=?')
    .run(shift_type, status, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/shifts/:id', (req, res) => {
  db.prepare('DELETE FROM shifts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Coverage warning: days with <1 person per team-shift
app.get('/api/shifts/coverage', (req, res) => {
  const { week_start } = req.query;
  let startDate = week_start;
  if (!startDate) {
    const today = new Date();
    const d = today.getDay();
    const diff = d === 0 ? -6 : 1 - d;
    const mon = new Date(today);
    mon.setDate(today.getDate() + diff);
    startDate = mon.toISOString().split('T')[0];
  }
  const endD = new Date(startDate);
  endD.setDate(endD.getDate() + 6);
  const endDate = endD.toISOString().split('T')[0];

  const rows = db.prepare(`
    SELECT s.shift_date, e.team, s.shift_type, COUNT(*) as cnt
    FROM shifts s
    JOIN employees e ON e.id = s.employee_id
    WHERE e.active=1 AND s.shift_date BETWEEN ? AND ?
      AND s.status != 'leave' AND s.status != 'approved_leave'
    GROUP BY s.shift_date, e.team, s.shift_type
  `).all(startDate, endDate);
  res.json(rows);
});

// ══════════════════════════════════════════════════════════
//  LEAVE REQUESTS
// ══════════════════════════════════════════════════════════
app.get('/api/leave-requests', (req, res) => {
  const rows = db.prepare(`
    SELECT lr.*, e.name as emp_name, e.team,
           a.name as approver_name
    FROM leave_requests lr
    JOIN employees e ON e.id = lr.employee_id
    LEFT JOIN employees a ON a.id = lr.approved_by
    ORDER BY lr.created_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/leave-requests', (req, res) => {
  const { employee_id, leave_date, reason } = req.body;
  const r = db.prepare(
    'INSERT INTO leave_requests (employee_id, leave_date, reason) VALUES (?, ?, ?)'
  ).run(employee_id, leave_date, reason);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/leave-requests/:id/approve', (req, res) => {
  const { approved_by } = req.body;
  const lr = db.prepare('SELECT * FROM leave_requests WHERE id=?').get(req.params.id);
  if (!lr) return res.status(404).json({ error: 'not found' });

  db.prepare(
    "UPDATE leave_requests SET status='approved', approved_by=? WHERE id=?"
  ).run(approved_by, req.params.id);

  // update shift status too
  db.prepare(
    "UPDATE shifts SET status='approved_leave' WHERE employee_id=? AND shift_date=?"
  ).run(lr.employee_id, lr.leave_date);

  res.json({ ok: true });
});

app.put('/api/leave-requests/:id/reject', (req, res) => {
  const { approved_by } = req.body;
  db.prepare(
    "UPDATE leave_requests SET status='rejected', approved_by=? WHERE id=?"
  ).run(approved_by, req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
//  TICKETS
// ══════════════════════════════════════════════════════════
app.get('/api/tickets', (req, res) => {
  const { team, status } = req.query;
  let sql = `
    SELECT t.*, e.name as assigned_name,
           p.title as parent_title
    FROM tickets t
    LEFT JOIN employees e ON e.id = t.assigned_to
    LEFT JOIN tickets p ON p.id = t.escalated_from
    WHERE 1=1
  `;
  const params = [];
  if (team)   { sql += ' AND t.team=?';   params.push(team); }
  if (status) { sql += ' AND t.status=?'; params.push(status); }
  sql += ' ORDER BY t.opened_at DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/tickets/:id', (req, res) => {
  const t = db.prepare(`
    SELECT t.*, e.name as assigned_name, p.title as parent_title
    FROM tickets t
    LEFT JOIN employees e ON e.id = t.assigned_to
    LEFT JOIN tickets p ON p.id = t.escalated_from
    WHERE t.id=?
  `).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

app.post('/api/tickets', (req, res) => {
  const { title, description, team, priority, assigned_to, vendor_name, escalated_from } = req.body;
  const r = db.prepare(
    `INSERT INTO tickets (title, description, team, priority, assigned_to, vendor_name, escalated_from)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(title, description, team, priority || 'normal', assigned_to || null, vendor_name || null, escalated_from || null);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/tickets/:id', (req, res) => {
  const { title, description, status, priority, assigned_to, vendor_name } = req.body;
  const closedAt = status === 'closed' ? new Date().toISOString() : null;
  db.prepare(
    `UPDATE tickets SET title=?, description=?, status=?, priority=?,
     assigned_to=?, vendor_name=?, closed_at=? WHERE id=?`
  ).run(title, description, status, priority, assigned_to || null, vendor_name || null, closedAt, req.params.id);
  res.json({ ok: true });
});

// Escalate: create new helpdesk ticket linked to original
app.post('/api/tickets/:id/escalate', (req, res) => {
  const orig = db.prepare('SELECT * FROM tickets WHERE id=?').get(req.params.id);
  if (!orig) return res.status(404).json({ error: 'not found' });

  // mark original as in_progress
  db.prepare("UPDATE tickets SET status='in_progress' WHERE id=?").run(orig.id);

  const r = db.prepare(
    `INSERT INTO tickets (title, description, team, priority, escalated_from)
     VALUES (?, ?, 'helpdesk', ?, ?)`
  ).run('[Escalated] ' + orig.title, orig.description, orig.priority, orig.id);

  res.json({ id: r.lastInsertRowid });
});

// ══════════════════════════════════════════════════════════
//  KPI
// ══════════════════════════════════════════════════════════
app.get('/api/kpi', (req, res) => {
  const { month, team } = req.query;
  let sql = `
    SELECT k.*, e.name, e.team, e.role,
           r.name as recorder_name
    FROM kpi_records k
    JOIN employees e ON e.id = k.employee_id
    LEFT JOIN employees r ON r.id = k.recorded_by
    WHERE 1=1
  `;
  const params = [];
  if (month) { sql += ' AND k.month LIKE ?'; params.push(month.substring(0,7) + '%'); }
  if (team)  { sql += ' AND e.team=?'; params.push(team); }
  sql += ' ORDER BY k.month DESC, e.team, e.id';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/kpi', (req, res) => {
  const { employee_id, month, total_cases, avg_resolve_minutes, satisfaction_score, comment, recorded_by } = req.body;
  // upsert
  const existing = db.prepare(
    'SELECT id FROM kpi_records WHERE employee_id=? AND month LIKE ?'
  ).get(employee_id, month.substring(0,7) + '%');

  if (existing) {
    db.prepare(
      `UPDATE kpi_records SET total_cases=?, avg_resolve_minutes=?, satisfaction_score=?,
       comment=?, recorded_by=? WHERE id=?`
    ).run(total_cases, avg_resolve_minutes, satisfaction_score, comment, recorded_by, existing.id);
    res.json({ id: existing.id, updated: true });
  } else {
    const r = db.prepare(
      `INSERT INTO kpi_records (employee_id, month, total_cases, avg_resolve_minutes, satisfaction_score, comment, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(employee_id, month, total_cases, avg_resolve_minutes, satisfaction_score, comment, recorded_by);
    res.json({ id: r.lastInsertRowid });
  }
});

// ══════════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════════
app.get('/api/dashboard', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const now   = new Date();
  const hour  = now.getHours();
  const minute = now.getMinutes();
  const timeVal = hour * 60 + minute;

  // current shift: morning=08:30-16:30, afternoon=15:30-23:30, night=16:00-24:00
  const currentShifts = [];
  if (timeVal >= 8*60+30 && timeVal <= 16*60+30)  currentShifts.push('morning');
  if (timeVal >= 15*60+30 && timeVal <= 23*60+30) currentShifts.push('afternoon');
  if (timeVal >= 16*60 || timeVal <= 0)            currentShifts.push('night');
  if (currentShifts.length === 0) currentShifts.push('morning'); // fallback

  // tickets today by team & status
  const ticketsToday = db.prepare(`
    SELECT team, status, COUNT(*) as cnt
    FROM tickets
    WHERE DATE(opened_at) = ?
    GROUP BY team, status
  `).all(today);

  // overdue tickets > 24h
  const overdueTickets = db.prepare(`
    SELECT t.*, e.name as assigned_name
    FROM tickets t
    LEFT JOIN employees e ON e.id = t.assigned_to
    WHERE t.status != 'closed'
      AND datetime(t.opened_at) <= datetime('now','-24 hours')
    ORDER BY t.opened_at ASC
  `).all();

  // on-shift now
  const onShift = db.prepare(`
    SELECT s.shift_type, e.name, e.team, e.role
    FROM shifts s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.shift_date = ? AND s.shift_type IN (${currentShifts.map(()=>'?').join(',')})
      AND s.status = 'scheduled' AND e.active=1
    ORDER BY e.team, s.shift_type
  `).all(today, ...currentShifts);

  // weekly KPI summary (avg per team this month)
  const thisMonth = today.substring(0,7);
  const kpiSummary = db.prepare(`
    SELECT e.team,
           AVG(k.total_cases) as avg_cases,
           AVG(k.satisfaction_score) as avg_score
    FROM kpi_records k
    JOIN employees e ON e.id = k.employee_id
    WHERE k.month LIKE ?
    GROUP BY e.team
  `).all(thisMonth + '%');

  // ticket stats total
  const ticketStats = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM tickets GROUP BY status
  `).all();

  // pending leaves
  const pendingLeaves = db.prepare(`
    SELECT lr.*, e.name as emp_name, e.team
    FROM leave_requests lr
    JOIN employees e ON e.id = lr.employee_id
    WHERE lr.status='pending'
    ORDER BY lr.leave_date
  `).all();

  res.json({
    ticketsToday,
    overdueTickets,
    onShift,
    kpiSummary,
    ticketStats,
    pendingLeaves,
    currentShifts,
    serverTime: now.toISOString()
  });
});

// ══════════════════════════════════════════════════════════
//  AI ENDPOINTS
// ══════════════════════════════════════════════════════════

// ── Helper: build dashboard context string ──
function getDashboardContext() {
  const today = new Date().toISOString().split('T')[0];
  const thisMonth = today.substring(0, 7);
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeVal = hour * 60 + minute;
  const currentShifts = [];
  if (timeVal >= 8*60+30 && timeVal <= 16*60+30)  currentShifts.push('morning');
  if (timeVal >= 15*60+30 && timeVal <= 23*60+30) currentShifts.push('afternoon');
  if (timeVal >= 16*60 || timeVal <= 0)            currentShifts.push('night');
  if (currentShifts.length === 0) currentShifts.push('morning');

  const ticketsToday = db.prepare(`SELECT team, status, COUNT(*) as cnt FROM tickets WHERE DATE(opened_at)=? GROUP BY team, status`).all(today);
  const overdueTickets = db.prepare(`SELECT title, team, priority, opened_at FROM tickets WHERE status!='closed' AND datetime(opened_at) <= datetime('now','-24 hours') ORDER BY opened_at ASC`).all();
  const onShift = db.prepare(`SELECT s.shift_type, e.name, e.team, e.role FROM shifts s JOIN employees e ON e.id=s.employee_id WHERE s.shift_date=? AND s.shift_type IN (${currentShifts.map(()=>'?').join(',')}) AND s.status='scheduled' AND e.active=1`).all(today, ...currentShifts);
  const kpiSummary = db.prepare(`SELECT e.team, AVG(k.total_cases) as avg_cases, AVG(k.satisfaction_score) as avg_score, AVG(k.avg_resolve_minutes) as avg_minutes FROM kpi_records k JOIN employees e ON e.id=k.employee_id WHERE k.month LIKE ? GROUP BY e.team`).all(thisMonth + '%');
  const ticketStats = db.prepare(`SELECT status, COUNT(*) as cnt FROM tickets GROUP BY status`).all();
  const pendingLeaves = db.prepare(`SELECT lr.leave_date, e.name, e.team FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id WHERE lr.status='pending'`).all();

  return `
ข้อมูลระบบ CS Team Manager ณ วันที่ ${today} เวลา ${now.toLocaleTimeString('th-TH')}

[กะที่กำลังทำงานอยู่]: ${currentShifts.join(', ')}
[พนักงานออนกะตอนนี้]: ${JSON.stringify(onShift)}
[Ticket วันนี้แยกตามทีม/สถานะ]: ${JSON.stringify(ticketsToday)}
[Ticket ที่ค้างเกิน 24h]: ${JSON.stringify(overdueTickets)}
[สถิติ Ticket ทั้งหมด]: ${JSON.stringify(ticketStats)}
[KPI เดือนนี้แยกทีม]: ${JSON.stringify(kpiSummary)}
[คำขอลาที่รอ approve]: ${JSON.stringify(pendingLeaves)}
`.trim();
}

// ── 1. AI Chat ─────────────────────────────────────────────
app.post('/api/ai/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const context = getDashboardContext();
    const systemPrompt = `คุณคือผู้ช่วย AI สำหรับระบบบริหารทีม Customer Service ชื่อว่า "CS Assistant"
ตอบเป็นภาษาไทย กระชับ ชัดเจน เป็นมิตร
ใช้ข้อมูลต่อไปนี้เพื่อตอบคำถาม:\n\n${context}`;

    const messages = [
      ...history.slice(-8), // keep last 8 turns for context
      { role: 'user', content: message }
    ];

    const response = await claude.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('AI chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. Dashboard AI Summary ────────────────────────────────
app.get('/api/ai/dashboard-summary', async (req, res) => {
  try {
    const context = getDashboardContext();
    const prompt = `วิเคราะห์สถานการณ์ปัจจุบันของทีม Customer Service จากข้อมูลนี้:

${context}

กรุณาสรุปใน 3 ส่วน:
1. 🚨 ปัญหาเร่งด่วน (ถ้ามี)
2. 📊 ภาพรวมสถานการณ์
3. 💡 คำแนะนำ

ตอบเป็นภาษาไทย กระชับ อ่านง่าย ไม่เกิน 200 คำ`;

    const response = await claude.messages.create({
      model: AI_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ summary: response.content[0].text });
  } catch (err) {
    console.error('AI summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 3. AI Suggest Shifts ───────────────────────────────────
app.post('/api/ai/suggest-shifts', async (req, res) => {
  const { week_start, team } = req.body;
  try {
    // Get employees & leave requests for that week
    let empSql = 'SELECT id, name, team, role FROM employees WHERE active=1';
    const empParams = [];
    if (team) { empSql += ' AND team=?'; empParams.push(team); }
    const employees = db.prepare(empSql).all(...empParams);

    const endD = new Date(week_start);
    endD.setDate(endD.getDate() + 6);
    const endDate = endD.toISOString().split('T')[0];

    const approvedLeaves = db.prepare(`
      SELECT lr.employee_id, lr.leave_date, e.name, e.team
      FROM leave_requests lr
      JOIN employees e ON e.id=lr.employee_id
      WHERE lr.status='approved' AND lr.leave_date BETWEEN ? AND ?
    `).all(week_start, endDate);

    const prompt = `คุณคือผู้จัดการทีม CS กรุณาวางแผนตารางกะสัปดาห์ ${week_start} ถึง ${endDate}

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

ตอบเป็น JSON array ในรูปแบบ:
[{"employee_id": 1, "shift_date": "YYYY-MM-DD", "shift_type": "morning|afternoon|night"}]
ตอบเฉพาะ JSON เท่านั้น ไม่ต้องมีคำอธิบาย`;

    const response = await claude.messages.create({
      model: AI_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    let text = response.content[0].text.trim();
    // strip markdown code fences if present
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const suggestions = JSON.parse(text);
    res.json({ suggestions, week_start, end_date: endDate });
  } catch (err) {
    console.error('AI shift error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 4. AI KPI Forecast ─────────────────────────────────────
app.get('/api/ai/forecast-kpi', async (req, res) => {
  const { team } = req.query;
  try {
    let sql = `
      SELECT e.name, e.team, e.role, k.month,
             k.total_cases, k.avg_resolve_minutes, k.satisfaction_score
      FROM kpi_records k
      JOIN employees e ON e.id=k.employee_id
      WHERE 1=1
    `;
    const params = [];
    if (team) { sql += ' AND e.team=?'; params.push(team); }
    sql += ' ORDER BY k.month, e.team, e.id';
    const kpiData = db.prepare(sql).all(...params);

    const prompt = `คุณคือนักวิเคราะห์ประสิทธิภาพทีม Customer Service
วิเคราะห์ข้อมูล KPI 3 เดือนที่ผ่านมา:

${JSON.stringify(kpiData, null, 2)}

กรุณาวิเคราะห์และสรุปใน 4 หัวข้อ:
1. 📈 Trend โดยรวม (แต่ละทีมดีขึ้นหรือแย่ลง?)
2. ⭐ พนักงานที่ผลงานโดดเด่น (ระบุชื่อ+เหตุผล)
3. ⚠️ จุดที่ต้องปรับปรุง (ทีม/บุคคล)
4. 🔮 พยากรณ์เดือนหน้า (คาดการณ์แนวโน้ม)

ตอบเป็นภาษาไทย ชัดเจน มีข้อมูลเชิงตัวเลขสนับสนุน`;

    const response = await claude.messages.create({
      model: AI_MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }]
    });

    res.json({ analysis: response.content[0].text });
  } catch (err) {
    console.error('AI forecast error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start Server ──────────────────────────────────────────
init().then(database => {
  db = database;
  app.listen(PORT, () => {
    console.log(`🚀 CS Team App running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('❌ Database init failed:', err);
  process.exit(1);
});
