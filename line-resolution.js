// ══════════════════════════════════════════════════════════
//  เคสไลน์ "แก้จบเมื่อไหร่" — AI judge เฟส 1 (Requirement: ปรับหน้า ตอบเคสไลน์ไว)
//  1 เคส = ข้อความลูกค้าที่ AI คัดกรองว่าเป็นเคสและมีคนตอบแล้ว (line_case_response)
//  AI อ่านแชทของกลุ่มตั้งแต่เคสเริ่ม → ตัดสินว่าจบไหม จบตอนไหน จบแบบไหน หมวดอะไร
//  ผลเก็บถาวรใน line_case_resolution (+ line_case_resolution_msg = ข้อความไหนเป็นของเคสไหน)
//
//  ข้อจำกัดของข้อมูล: LineWaitingReply เก็บแค่ข้อความลูกค้า ข้อความของแอดมิน INF- ไม่ถูกเก็บ
//  มีแค่ "ใคร/เวลาไหน" ที่ตอบ (AnsweredBy/AnsweredTime) — ทีมงานที่ชื่อไม่ใช่ INF- (เช่น Inf-Christ)
//  ถูกเก็บเป็นแถวพร้อมข้อความ · AI จึงเห็นการตอบของ INF- เป็นบรรทัด "ทีมงานตอบ (ไม่มีข้อความ)"
//
//  เวลา: ข้อความทั้งหมดใช้นาฬิกาเครื่อง LineBotMonitor — วัดความเงียบด้วยนาฬิกาเครื่องเดียวกัน
// ══════════════════════════════════════════════════════════

const CATEGORIES = ['printer', 'menu', 'report', 'order', 'remote', 'other'];
const SIGNALS = ['customer_confirmed', 'agent_fixed', 'escalated', 'abandoned'];
const SILENCE_MIN = 120;      // ลูกค้าเงียบเกินนี้ถึงจะตัดสิน (และเว้นระยะก่อนตัดสินซ้ำ)
const FINAL_HOURS = 24;       // เคสอายุเกินนี้ = ตัดสินครั้งสุดท้าย ไม่มีสัญญาณจบ → abandoned
const MAX_LINES = 80;         // บรรทัดแชทสูงสุดที่ส่งให้ AI ต่อเคส

function createLineResolution({ req, getLineBotPool, sql, aiGenerate, SchemaType, startDate, log = console }) {
  let _tables = false, _running = false;

  async function tablesExist() {
    const r = await req().query(`SELECT OBJECT_ID('line_case_resolution') AS a, OBJECT_ID('line_case_resolution_msg') AS b`);
    return !!(r.recordset[0].a && r.recordset[0].b);
  }

  async function ensure() {
    if (_tables) return;
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='line_case_resolution' AND xtype='U')
      CREATE TABLE line_case_resolution (
        case_msg_id       INT PRIMARY KEY,            -- LineWaitingReply.Id ของข้อความแรกของเคส
        group_id          NVARCHAR(100) NULL,
        group_name        NVARCHAR(300) NULL,
        pod_id            INT NULL,
        customer_user_id  NVARCHAR(100) NULL,
        first_msg_time    DATETIME NOT NULL,          -- เวลา LineBotMonitor
        first_answer_time DATETIME NULL,
        answered_by       NVARCHAR(100) NULL,         -- คนตอบคนแรก
        issue_category    NVARCHAR(20) NULL,          -- printer|menu|report|order|remote|other
        resolved          BIT NOT NULL DEFAULT 0,
        resolution_signal NVARCHAR(30) NULL,          -- customer_confirmed|agent_fixed|escalated|abandoned
        resolved_msg_ref  NVARCHAR(20) NULL,          -- Id ข้อความ หรือ S<n> = บรรทัดทีมงานตอบ
        resolved_at       DATETIME NULL,              -- เวลา LineBotMonitor
        resolved_by       NVARCHAR(100) NULL,         -- ทีมงานที่ตอบล่าสุดก่อน/ตอน resolved_at
        agent_turns       INT NULL,                   -- ช่วงที่ทีมงานตอบ (ตอบติดกันนับ 1) จนถึง resolved_at
        customer_msgs     INT NULL,                   -- ข้อความลูกค้าในเคสจนถึง resolved_at
        calllog_id        INT NULL,
        ai_reason         NVARCHAR(500) NULL,
        ai_model          NVARCHAR(100) NULL,
        checks            INT NOT NULL DEFAULT 0,     -- ตัดสินมาแล้วกี่รอบ
        final             BIT NOT NULL DEFAULT 0,     -- 1 = ไม่ตัดสินซ้ำแล้ว
        next_check_at     DATETIME NULL,              -- เวลา LineBotMonitor
        created_at        DATETIME DEFAULT GETDATE(),
        updated_at        DATETIME DEFAULT GETDATE());
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='line_case_resolution_msg' AND xtype='U')
      CREATE TABLE line_case_resolution_msg (
        msg_id      INT PRIMARY KEY,                  -- LineWaitingReply.Id ของลูกค้าที่เป็นของเคสนี้
        case_msg_id INT NOT NULL);
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='ix_lcres_time')
        CREATE INDEX ix_lcres_time ON line_case_resolution(first_msg_time);
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='ix_lcres_msg_case')
        CREATE INDEX ix_lcres_msg_case ON line_case_resolution_msg(case_msg_id);`);
    _tables = true;
  }

  // เคสที่ถึงเวลาตัดสิน: ยังไม่เคยตัดสิน หรือยังไม่จบและถึงรอบตรวจซ้ำ · ข้อความที่เป็นของเคสอื่นแล้วข้าม
  async function pickCases(lbNow, limit, haveTables) {
    const r = req().input('st', sql.NVarChar, startDate).input('now', sql.DateTime, lbNow).input('sil', sql.Int, SILENCE_MIN);
    const join = haveTables ? `
      LEFT JOIN line_case_resolution c ON c.case_msg_id = r.source_msg_id
      LEFT JOIN line_case_resolution_msg m ON m.msg_id = r.source_msg_id AND m.case_msg_id <> r.source_msg_id` : '';
    const cond = haveTables
      ? `AND m.msg_id IS NULL AND (c.case_msg_id IS NULL OR (c.final = 0 AND c.next_check_at <= @now))`
      : '';
    return (await r.query(`
      SELECT TOP (${limit}) r.source_msg_id, r.group_id, r.group_name, r.pod_id, r.message_time, r.summary,
             r.answered_by, r.answered_time, r.calllog_id ${haveTables ? ', c.checks' : ', 0 AS checks'}
      FROM line_case_response r ${join}
      WHERE r.answered_time IS NOT NULL AND r.message_time >= CAST(@st AS DATE)
        AND r.message_time <= DATEADD(minute, -@sil, @now) ${cond}
      ORDER BY r.message_time`)).recordset;
  }

  // แชทของกลุ่มตั้งแต่ก่อนเคส 10 นาที ถึง 24 ชม. หลังเคส (หรือถึงตอนนี้)
  async function loadThread(lb, c, lbNow) {
    const start = new Date(new Date(c.message_time).getTime() - 10 * 60000);
    const end = new Date(Math.min(new Date(c.message_time).getTime() + FINAL_HOURS * 3600000, lbNow.getTime()));
    const rows = (await lb.request().input('g', sql.NVarChar, c.group_id).input('s', sql.DateTime, start).input('e', sql.DateTime, end)
      .query(`SELECT TOP 400 Id, CustomerUserId, CustomerName, CustomerMessage, MessageTime, Answered, AnsweredTime, AnsweredBy
              FROM dbo.LineWaitingReply WHERE GroupId=@g AND MessageTime >= @s AND MessageTime <= @e ORDER BY MessageTime, Id`)).recordset;
    return rows;
  }

  const isStaffName = n => /^inf[\s_.\-]/i.test(String(n || '').trim()) || /[\s_.\-]info$/i.test(String(n || '').trim());
  const hhmm = d => new Date(d).toISOString().slice(5, 16).replace('T', ' ');   // face value ของ DATETIME

  // ไทม์ไลน์ของเคส: กลุ่มใหญ่มีหลายสาขาคุยปนกัน → เอาเฉพาะ
  //   • ข้อความของเจ้าของเคส (CustomerUserId เดียวกัน)
  //   • "ทีมงานตอบ" เฉพาะครั้งที่ตอบข้อความของเจ้าของเคส (bot ผูก AnsweredTime ให้ข้อความที่รออยู่)
  //   • ข้อความคนอื่น/ทีมงานที่ชื่อไม่ใช่ INF- เฉพาะที่อยู่ใกล้ข้อความของเจ้าของเคส (±NEAR_MIN) — ไว้เห็นบริบท เช่น HQ อนุมัติ
  // และไม่เกิน 6 ชม. หลังเจ้าของเคสพิมพ์ครั้งสุดท้าย
  const NEAR_MIN = 20, TAIL_HOURS = 6;
  function buildTimeline(rows, c) {
    const caseRow = rows.find(r => r.Id === c.source_msg_id);
    const caseUser = caseRow?.CustomerUserId || null;
    const caseTime = new Date(c.message_time);
    const all = rows.map(r => {
      const staff = isStaffName(r.CustomerName);
      const text = (r.CustomerMessage && r.CustomerMessage !== 'undefined')
        ? String(r.CustomerMessage).replace(/\s+/g, ' ').slice(0, 200) : '[รูป/สติกเกอร์/ไฟล์]';
      return { ref: String(r.Id), time: new Date(r.MessageTime), kind: staff ? 'staff_text' : 'customer',
        who: staff ? String(r.CustomerName).trim() : (r.CustomerName || 'ลูกค้า'), text,
        mine: !staff && (r.Id === c.source_msg_id || (!!caseUser && r.CustomerUserId === caseUser)),
        isCase: r.Id === c.source_msg_id,
        answeredTime: r.Answered && r.AnsweredTime ? new Date(r.AnsweredTime) : null, answeredBy: r.AnsweredBy };
    });
    const mine = all.filter(l => l.mine && l.time >= new Date(caseTime.getTime() - 10 * 60000));
    // ปลายหน้าต่าง = ข้อความล่าสุดของเจ้าของเคส หรือเวลาที่ทีมงานตอบเจ้าของเคสครั้งล่าสุด (ตอบช้าหลายชม. ก็ต้องเห็น)
    const lastMine = mine.reduce((m, l) => {
      const t = l.answeredTime && l.answeredTime > l.time ? l.answeredTime : l.time;
      return t > m ? t : m;
    }, caseTime);
    const tailEnd = new Date(lastMine.getTime() + TAIL_HOURS * 3600000);
    const near = t => mine.some(m => Math.abs(t - m.time) <= NEAR_MIN * 60000);

    const staffSeen = new Map();
    for (const l of mine) if (l.answeredTime && l.answeredTime >= caseTime && l.answeredTime <= tailEnd) {
      const k = +l.answeredTime;
      if (!staffSeen.has(k)) staffSeen.set(k, { time: l.answeredTime, who: l.answeredBy || 'ทีมงาน' });
    }
    let lines = [
      ...mine,
      ...all.filter(l => !l.mine && l.time >= caseTime && l.time <= tailEnd && near(l.time)),
      ...[...staffSeen.values()].sort((a, b) => a.time - b.time)
        .map((s, i) => ({ ref: 'S' + (i + 1), time: s.time, kind: 'staff_reply', who: s.who, text: '' })),
    ].sort((a, b) => a.time - b.time || (a.kind === 'staff_reply') - (b.kind === 'staff_reply'));
    // ยาวเกิน: ตัดข้อความคนอื่นก่อน แล้วค่อยตัดท้าย
    if (lines.length > MAX_LINES) {
      const others = lines.filter(l => l.kind !== 'staff_reply' && !l.mine);
      const drop = new Set(others.slice(Math.max(0, others.length - (lines.length - MAX_LINES))));
      lines = lines.filter(l => !drop.has(l)).slice(0, MAX_LINES);
    }
    return { lines, caseUser };
  }

  function buildPrompt(c, lines, final) {
    const body = lines.map(l => {
      const tag = l.kind === 'staff_reply' ? `ทีมงาน ${l.who} ตอบเจ้าของเคส (ไม่มีข้อความ)`
        : l.kind === 'staff_text' ? `ทีมงาน ${l.who}: ${l.text}`
        : `${l.mine ? 'ลูกค้าเจ้าของเคส' : 'ลูกค้าคนอื่น'} (${String(l.who).slice(0, 20)}): ${l.text}`;
      return `[${l.ref}] ${hhmm(l.time)} ${l.isCase ? '>>> ' : ''}${tag}`;
    }).join('\n');
    return `คุณคือผู้ตรวจเคสซัพพอร์ตระบบร้านอาหาร (POS) ที่คุยผ่าน LINE กลุ่ม
เคสที่ต้องตัดสินคือข้อความที่มี >>> (สรุปจากระบบคัดกรอง: "${c.summary || '-'}")${c.calllog_id ? ` · เคสนี้ถูกเปิดในระบบ Calllog แล้ว (#${c.calllog_id})` : ''}
แชทด้านล่างคัดมาเฉพาะข้อความของเจ้าของเคส + ข้อความคนอื่นที่อยู่ใกล้ๆ (กลุ่มนี้อาจมีหลายเรื่องปนกัน ให้ดูเฉพาะเรื่องของเคสนี้)
หมายเหตุ: ข้อความของแอดมิน INF- ไม่ถูกบันทึก เห็นเป็น "ทีมงาน ... ตอบเจ้าของเคส (ไม่มีข้อความ)" ณ เวลาที่ตอบเท่านั้น
ทีมงานส่วนใหญ่แก้ปัญหาแล้วแจ้งในไลน์ ลูกค้ามักไม่ตอบกลับเมื่อใช้ได้แล้ว

แชท ([Id] เดือน-วัน เวลา):
${body}

ตอบเป็น JSON object เท่านั้น:
- case_msg_ids: Id ข้อความลูกค้า (ตัวเลข) ทุกข้อความที่เป็นเรื่องเดียวกับเคสนี้ รวมข้อความ >>> ด้วย
- issue_category: ${CATEGORIES.join('|')} (printer=เครื่องพิมพ์/ลิ้นชัก, menu=เมนู/ราคา/โปรโมชัน, report=รายงาน/ยอด, order=บิล/ออเดอร์/ยกเลิก/PR/PO, remote=ขอรีโมท/เข้าเครื่อง/ติดตั้ง)
- resolved: true/false
- resolution_signal: ${SIGNALS.join('|')}
    customer_confirmed = ลูกค้าบอกว่าได้แล้ว/ใช้ได้แล้ว/เรียบร้อย/ขอบคุณ หลังทีมงานแก้
    agent_fixed = มีบรรทัดทีมงานตอบหลังข้อความล่าสุดของเจ้าของเคสเกี่ยวกับเรื่องนี้ แล้วเจ้าของเคสไม่ได้แจ้งว่ายังไม่ได้/ไม่ได้ถามต่อเรื่องเดิม (เงียบไปเกิน 2 ชม. หรือไปคุยเรื่องอื่น)
    escalated = ส่งต่อทีมอื่น (dev/ซ่อม) หรือเปิดเคสในระบบ แล้ว CS หยุดดำเนินการ
    abandoned = ไม่มีทีมงานตอบเลยหลังเคส หรือข้อความสุดท้ายของเจ้าของเคสยังบอกว่าไม่ได้/ยังรออยู่ และไม่มีทีมงานตอบต่อ
- resolved_msg_id: Id ของบรรทัดที่ถือว่าจบ (customer_confirmed = ข้อความลูกค้าที่ยืนยัน, agent_fixed/escalated = บรรทัด S<n> หรือ Id ทีมงานที่ตอบล่าสุด) · abandoned = null
- reason: เหตุผลสั้นๆ ภาษาไทย ไม่เกิน 120 ตัวอักษร
${final ? 'นี่คือการตัดสินครั้งสุดท้าย (เคสเกิน 24 ชม.) ถ้าไม่มีสัญญาณจบให้ตอบ abandoned' : 'ถ้าลูกค้ายังคุยอยู่หรือยังไม่ชัดว่าจบ ให้ resolved=false และ abandoned'}`;
  }

  const parseObj = txt => {
    const m = String(txt).match(/\{[\s\S]*\}/);
    const o = JSON.parse(m ? m[0] : txt);
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('AI ไม่ได้ตอบเป็น JSON object');
    return o;
  };

  // ตรวจคำตอบ AI ให้ตรงกับแชทจริง แล้วคิดตัวเลข (เวลา/รอบ) เองจากไทม์ไลน์ — ไม่เชื่อตัวเลขจาก AI
  function judgeToResult(c, lines, ai, final) {
    const byRef = new Map(lines.map(l => [l.ref, l]));
    const custIds = new Set(lines.filter(l => l.kind === 'customer').map(l => l.ref));
    const ids = new Set([String(c.source_msg_id)]);
    for (const x of Array.isArray(ai.case_msg_ids) ? ai.case_msg_ids : []) if (custIds.has(String(x))) ids.add(String(x));
    // ข้อความลูกค้าที่ถูกตอบพร้อมกับข้อความเคส (พิมพ์ติดกันแล้วตอบรอบเดียว) = เรื่องเดียวกันแน่นอน
    const caseLine = byRef.get(String(c.source_msg_id));
    if (caseLine?.answeredTime) lines.forEach(l => { if (l.kind === 'customer' && l.mine && l.answeredTime && +l.answeredTime === +caseLine.answeredTime) ids.add(l.ref); });

    let signal = SIGNALS.includes(ai.resolution_signal) ? ai.resolution_signal : 'abandoned';
    let resolved = ai.resolved === true && signal !== 'abandoned';
    const endLine = resolved ? byRef.get(String(ai.resolved_msg_id ?? '')) : null;
    if (resolved && (!endLine || endLine.time < new Date(c.message_time))) { resolved = false; signal = 'abandoned'; }
    const resolvedAt = resolved ? endLine.time : null;

    const upTo = resolvedAt || (lines.length ? lines[lines.length - 1].time : new Date(c.message_time));
    const caseCust = lines.filter(l => l.kind === 'customer' && ids.has(l.ref) && l.time <= upTo);
    // รอบทีมงาน = ครั้งที่ทีมงานตอบข้อความลูกค้าของเคสนี้ (bot ผูก AnsweredTime ให้ข้อความที่รออยู่ทั้งหมด
    // → เวลาตอบไม่ซ้ำกัน = 1 รอบ) + ทีมงานชื่อไม่ใช่ INF- ที่พิมพ์ต่อจากข้อความของเคสทันที
    // ไม่นับการตอบลูกค้าคนอื่นในกลุ่มเดียวกัน
    const answerTimes = new Map();   // ms → ชื่อคนตอบ
    const staffByTime = new Map(lines.filter(l => l.kind === 'staff_reply').map(l => [+l.time, l.who]));
    const caseStart = new Date(c.message_time);
    for (const l of caseCust) if (l.answeredTime && l.answeredTime >= caseStart && l.answeredTime <= upTo) answerTimes.set(+l.answeredTime, staffByTime.get(+l.answeredTime) || l.answeredBy || null);
    let prevIsCase = false;
    for (const l of lines) {
      if (l.time > upTo) break;
      if (l.kind === 'customer') prevIsCase = ids.has(l.ref);
      else if (l.kind === 'staff_text') { if (prevIsCase && !answerTimes.has(+l.time)) answerTimes.set(+l.time, l.who); prevIsCase = false; }
    }
    const turns = answerTimes.size;
    const lastAns = [...answerTimes].sort((a, b) => a[0] - b[0]).pop();
    const resolvedBy = lastAns ? lastAns[1] : null;
    const cat = CATEGORIES.includes(ai.issue_category) ? ai.issue_category : 'other';
    return {
      case_msg_ids: [...ids].map(Number), issue_category: cat, resolved, resolution_signal: signal,
      resolved_msg_ref: resolved ? String(ai.resolved_msg_id) : null, resolved_at: resolvedAt,
      resolved_by: resolved ? resolvedBy : null, agent_turns: turns, customer_msgs: caseCust.length,
      ai_reason: String(ai.reason || '').slice(0, 500), final,
    };
  }

  async function evaluateCase(lb, c, lbNow) {
    const rows = await loadThread(lb, c, lbNow);
    if (!rows.some(r => r.Id === c.source_msg_id)) return null;   // ข้อความต้นทางหาย (ไม่น่าเกิด)
    const { lines, caseUser } = buildTimeline(rows, c);
    const ageH = (lbNow - new Date(c.message_time)) / 3600000;
    const final = ageH >= FINAL_HOURS || (c.checks || 0) >= 6;
    const { value, usedModel } = await aiGenerate(buildPrompt(c, lines, final), {
      parse: parseObj, feature: 'line_resolution',
      geminiConfig: SchemaType ? { generationConfig: { responseMimeType: 'application/json' } } : null,
    });
    const out = judgeToResult(c, lines, value, final);
    // ยังไม่จบ + ยังไม่ครบ 24 ชม. → ตรวจใหม่อีก 2 ชม. · จบแล้วก็ final (ลูกค้ากลับมาใหม่ = เคสใหม่)
    out.final = out.resolved || final;
    out.next_check_at = out.final ? null : new Date(lbNow.getTime() + SILENCE_MIN * 60000);
    out.customer_user_id = caseUser;
    out.ai_model = usedModel;
    return out;
  }

  async function save(c, r) {
    await req().input('id', sql.Int, c.source_msg_id).input('g', sql.NVarChar, c.group_id).input('gn', sql.NVarChar, c.group_name)
      .input('pod', sql.Int, c.pod_id).input('cu', sql.NVarChar, r.customer_user_id).input('mt', sql.DateTime, c.message_time)
      .input('fat', sql.DateTime, c.answered_time).input('ab', sql.NVarChar, c.answered_by)
      .input('cat', sql.NVarChar, r.issue_category).input('res', sql.Bit, r.resolved ? 1 : 0).input('sig', sql.NVarChar, r.resolution_signal)
      .input('ref', sql.NVarChar, r.resolved_msg_ref).input('rat', sql.DateTime, r.resolved_at).input('rby', sql.NVarChar, r.resolved_by)
      .input('turns', sql.Int, r.agent_turns).input('cm', sql.Int, r.customer_msgs).input('cid', sql.Int, c.calllog_id || null)
      .input('why', sql.NVarChar, r.ai_reason).input('model', sql.NVarChar, r.ai_model).input('fin', sql.Bit, r.final ? 1 : 0)
      .input('next', sql.DateTime, r.next_check_at).query(`
      IF EXISTS (SELECT 1 FROM line_case_resolution WHERE case_msg_id=@id)
        UPDATE line_case_resolution SET customer_user_id=@cu, issue_category=@cat, resolved=@res, resolution_signal=@sig,
          resolved_msg_ref=@ref, resolved_at=@rat, resolved_by=@rby, agent_turns=@turns, customer_msgs=@cm,
          calllog_id=ISNULL(@cid, calllog_id), ai_reason=@why, ai_model=@model, checks=checks+1, final=@fin,
          next_check_at=@next, updated_at=GETDATE()
        WHERE case_msg_id=@id
      ELSE
        INSERT INTO line_case_resolution (case_msg_id, group_id, group_name, pod_id, customer_user_id, first_msg_time,
          first_answer_time, answered_by, issue_category, resolved, resolution_signal, resolved_msg_ref, resolved_at, resolved_by,
          agent_turns, customer_msgs, calllog_id, ai_reason, ai_model, checks, final, next_check_at)
        VALUES (@id, @g, @gn, @pod, @cu, @mt, @fat, @ab, @cat, @res, @sig, @ref, @rat, @rby, @turns, @cm, @cid, @why, @model, 1, @fin, @next)`);
    // ข้อความของเคส: ทำใหม่ทุกรอบ · ข้อความที่เป็นของเคสอื่นอยู่แล้วไม่แย่ง (เคสแรกได้ก่อน)
    const t = req().input('id', sql.Int, c.source_msg_id);
    r.case_msg_ids.forEach((m, k) => t.input('m' + k, sql.Int, m));
    await t.query(`
      DELETE FROM line_case_resolution_msg WHERE case_msg_id=@id;
      INSERT INTO line_case_resolution_msg (msg_id, case_msg_id)
      SELECT v.id, @id FROM (VALUES ${r.case_msg_ids.map((_, k) => `(@m${k})`).join(',')}) v(id)
      WHERE NOT EXISTS (SELECT 1 FROM line_case_resolution_msg x WHERE x.msg_id = v.id);`);
  }

  // รอบหนึ่ง: ตัดสินเคสที่ถึงเวลา limit เคส · dryRun = อ่านอย่างเดียว ไม่สร้างตาราง ไม่เขียน
  async function runBatch({ limit = 15, dryRun = false, onlyIds = null } = {}) {
    if (_running && !dryRun) return { skipped: 'running' };
    const lb = getLineBotPool();
    if (!lb) return { error: 'LineBotMonitor DB ไม่ได้เชื่อมต่อ' };
    if (!dryRun) _running = true;
    const results = [];
    try {
      const haveTables = dryRun ? await tablesExist() : (await ensure(), true);
      const lbNow = (await lb.request().query('SELECT GETDATE() AS now')).recordset[0].now;
      let cases = await pickCases(lbNow, onlyIds ? 2000 : limit, haveTables);
      if (onlyIds) cases = cases.filter(c => onlyIds.includes(c.source_msg_id));
      // ใน dry run ไม่มีตารางกันซ้ำ — ข้ามข้อความที่เคสก่อนหน้าในรอบเดียวกันกินไปแล้ว
      const taken = new Set();
      for (const c of cases) {
        if (taken.has(c.source_msg_id)) continue;
        try {
          const r = await evaluateCase(lb, c, lbNow);
          if (!r) continue;
          r.case_msg_ids.forEach(id => id !== c.source_msg_id && taken.add(id));
          if (!dryRun) await save(c, r);
          results.push({ case_msg_id: c.source_msg_id, group_name: c.group_name, summary: c.summary, message_time: c.message_time, ...r });
        } catch (e) {
          log.error(`line resolution case ${c.source_msg_id}:`, e.message);
          results.push({ case_msg_id: c.source_msg_id, error: e.message });
          if (/AI ไม่สำเร็จ/.test(e.message)) break;   // AI ล่มทั้งสองเจ้า — รอบหน้าค่อยลองใหม่
        }
      }
      if (!dryRun && results.length) log.log(`🧩 line resolution: ตัดสิน ${results.filter(r => !r.error).length}/${cases.length} เคส`);
      return { lbNow, picked: cases.length, results };
    } finally { if (!dryRun) _running = false; }
  }

  return { ensure, runBatch, evaluateCase, buildTimeline, buildPrompt, judgeToResult, CATEGORIES, SIGNALS };
}

module.exports = { createLineResolution };
