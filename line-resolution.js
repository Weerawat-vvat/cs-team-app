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
// ── ประหยัด token: เรียก AI เฉพาะตอนที่น่าจะจบแล้ว และมีข้อความใหม่ตั้งแต่ AI ดูครั้งก่อน ──
const SILENCE_MIN = 120;      // ทีมงานตอบล่าสุดแล้วเงียบเกินนี้ = น่าจะแก้จบ (agent_fixed) → ให้ AI ตัดสิน
const CLOSE_SILENCE_MIN = 10; // ข้อความล่าสุดเป็นคำปิดงาน/ลูกค้าตอบรับ แล้วกลุ่มเงียบเกินนี้ → ให้ AI ตัดสิน
const RECHECK_MIN = 15;       // ยังไม่เข้าเงื่อนไข / ไม่มีข้อความใหม่ → ดูแชทใหม่อีกครั้ง (อ่าน DB อย่างเดียว ไม่เรียก AI)
const MAX_AI_PER_DAY = 6;     // เรียก AI ได้ไม่เกินกี่ครั้ง/เคส/วัน
const FINAL_HOURS = 24;       // เคสอายุเกินนี้ = ตัดสินครั้งสุดท้าย ไม่มีสัญญาณจบ → abandoned
const MAX_LINES = 15;         // บรรทัดแชทสูงสุดที่ส่งให้ AI ต่อเคส (ข้อความ >>> ของเคส + ล่าสุด)
const MAX_OUT_TOKENS = 200;   // JSON ย่อ ~60–120 token · เผื่อไว้กันคำตอบถูกตัดกลางคัน
// ลูกค้าตอบรับ / ทีมงาน (ชื่อไม่ใช่ INF- ที่มีข้อความ) แจ้งปิดงาน — ข้อความของแอดมิน INF- ไม่ถูกเก็บ ใช้ไม่ได้
const CUSTOMER_OK = /ได้แล้ว|ใช้ได้|เรียบร้อย|ขอบคุณ|ขอบใจ|โอเค|โอเช|\bok\b|okay|รับทราบ|ได้ค่ะ|ได้ครับ|ได้คับ|ได้ค่า|👍|🙏|🙇/i;
const CUSTOMER_NOT_OK = /ไม่ได้|ยังไม่|ยังค้าง|ไม่ขึ้น|ไม่ออก|error|ผิดพลาด|ช่วย(?:ดู|เช็ค|แก้)|\?|ไหม|มั้ย/i;
const STAFF_CLOSE = /เรียบร้อย|แก้ไขแล้ว|แก้แล้ว|ได้แล้ว|ใช้งานได้|ลองใหม่|ลองอีกครั้ง|ปิดเคส|ส่งต่อ|แจ้ง ?dev|เปิดเคส/i;
const WORK_FROM_H = 8;        // เวลาทำงาน 08:00–24:00

// วินาทีทำงานระหว่าง a→b (นับเฉพาะ 08:00–24:00) · DATETIME เก็บเวลาไทยแบบ face value → อ่านด้วย getUTC*
function workSec(a, b) {
  a = new Date(a); b = new Date(b);
  if (!(b > a)) return 0;
  let sec = 0;
  const d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
  for (; d < b; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = new Date(d.getTime() + WORK_FROM_H * 3600000), e = new Date(d.getTime() + 86400000);
    const lo = Math.max(+s, +a), hi = Math.min(+e, +b);
    if (hi > lo) sec += (hi - lo) / 1000;
  }
  return Math.round(sec);
}

// ── สัญญาณการคุยงาน (หน้า Leaderboard "คุยงานดี") — ดูจากที่ลูกค้าพิมพ์กลับหลังทีมงานตอบ ไม่ใช้ AI ──
// ระบบไม่มีข้อความของแอดมิน INF- จึงวัดจากปฏิกิริยาลูกค้าแทน
const TALK_CONFUSED = /ยังไม่ได้|ไม่ได้เลย|ยังไม่หาย|เหมือนเดิม|ไม่เข้าใจ|ทำยังไง|ยังไงต่อ|ยังงัย|หมายถึง|หมายความว่า|ยังไม่ขึ้น|ยังไม่ออก|ยังใช้ไม่ได้|ยังค้าง|งง|\?\?/;
const TALK_CHASE = /เป็นยังไงบ้าง|ได้หรือยัง|ได้ยัง|รอนาน|ยังรอ|รออยู่|ตามเรื่อง|ติดตามเรื่อง|ขออัพเดท|ขออัปเดต|อัพเดทให้|ความคืบหน้า|มีคนดูไหม|มีใครอยู่ไหม/;
const TALK_THANKS = /ขอบคุณ|ขอบใจ|ได้แล้ว|ใช้ได้แล้ว|เรียบร้อย|โอเค|ok\b|okay|รับทราบ|👍|🙏/i;
// ข้อความเจ้าของเคสหลังทีมงานตอบครั้งแรก จนถึงจบเคส (ไม่จบ = 6 ชม.)
function talkSignals(c, lines, resolvedAt) {
  const caseLine = lines.find(l => l.ref === String(c.source_msg_id ?? c.case_msg_id));
  const A = caseLine?.answeredTime;
  if (!A) return { talk_confused: false, talk_chased: false, talk_thanks: false };
  const end = resolvedAt ? new Date(resolvedAt) : new Date(new Date(c.message_time).getTime() + 6 * 3600000);
  const after = lines.filter(l => l.kind === 'customer' && l.mine && l.time > A && l.time <= end);
  return {
    talk_confused: after.some(l => TALK_CONFUSED.test(l.text)),
    talk_chased: after.some(l => TALK_CHASE.test(l.text)),
    talk_thanks: after.some(l => TALK_THANKS.test(l.text) && !TALK_CONFUSED.test(l.text)),
  };
}

function createLineResolution({ req, getLineBotPool, sql, aiGenerate, SchemaType, startDate, aiModel = null, log = console }) {
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
      IF COL_LENGTH('line_case_resolution','ttr_work_sec') IS NULL
        ALTER TABLE line_case_resolution ADD ttr_work_sec INT NULL, customer_wait_sec INT NULL;
      -- last_checked_* = แชทที่ AI เห็นครั้งล่าสุด (Id ข้อความล่าสุด + เวลาทีมงานตอบล่าสุด) ไม่เปลี่ยน = ไม่เรียก AI ซ้ำ
      IF COL_LENGTH('line_case_resolution','last_checked_msg_id') IS NULL
        ALTER TABLE line_case_resolution ADD last_checked_msg_id INT NULL, last_checked_answer_at DATETIME NULL,
          ai_day DATE NULL, ai_calls_day INT NOT NULL CONSTRAINT df_lcres_ai_calls_day DEFAULT 0;
      IF COL_LENGTH('line_case_resolution','talk_confused') IS NULL
        ALTER TABLE line_case_resolution ADD talk_confused BIT NULL, talk_chased BIT NULL, talk_thanks BIT NULL;
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='ix_lcres_time')
        CREATE INDEX ix_lcres_time ON line_case_resolution(first_msg_time);
      IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='ix_lcres_msg_case')
        CREATE INDEX ix_lcres_msg_case ON line_case_resolution_msg(case_msg_id);`);
    _tables = true;
  }

  // เคสที่ถึงเวลาดู: ยังไม่เคยดู หรือยังไม่จบและถึงรอบตรวจซ้ำ · ข้อความที่เป็นของเคสอื่นแล้วข้าม
  // (ดู ≠ เรียก AI — evaluateCase ตัดสินว่าต้องเรียก AI ไหม)
  async function pickCases(lbNow, limit, haveTables) {
    const r = req().input('st', sql.NVarChar, startDate).input('now', sql.DateTime, lbNow).input('sil', sql.Int, CLOSE_SILENCE_MIN);
    const join = haveTables ? `
      LEFT JOIN line_case_resolution c ON c.case_msg_id = r.source_msg_id
      LEFT JOIN line_case_resolution_msg m ON m.msg_id = r.source_msg_id AND m.case_msg_id <> r.source_msg_id` : '';
    const cond = haveTables
      ? `AND m.msg_id IS NULL AND (c.case_msg_id IS NULL OR (c.final = 0 AND c.next_check_at <= @now))`
      : '';
    return (await r.query(`
      SELECT TOP (${limit}) r.source_msg_id, r.group_id, r.group_name, r.pod_id, r.message_time, r.summary,
             r.answered_by, r.answered_time, r.calllog_id
             ${haveTables ? `, c.case_msg_id AS has_row, c.checks, c.ai_model, c.last_checked_msg_id, c.last_checked_answer_at,
                 CONVERT(char(10), c.ai_day, 23) AS ai_day, c.ai_calls_day` : ', NULL AS has_row, 0 AS checks'}
      FROM line_case_response r ${join}
      WHERE r.answered_time IS NOT NULL AND r.message_time >= CAST(@st AS DATE)
        AND r.message_time <= DATEADD(minute, -@sil, @now) ${cond}
      ORDER BY CASE WHEN r.message_time >= DATEADD(day, -2, @now) THEN 0 ELSE 1 END,   -- เคสสดก่อน แล้วค่อยไล่ย้อนหลัง
        ${haveTables ? 'ISNULL(c.next_check_at, r.message_time)' : 'r.message_time'}`)).recordset;
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
    // ไทม์ไลน์เต็มใช้คิดตัวเลข (รอบคุย/เวลารอ) · ที่ส่งให้ AI ตัดเหลือ MAX_LINES ด้วย promptLines()
    return { lines, caseUser };
  }

  // บรรทัดที่ส่งให้ AI: ข้อความ >>> ของเคส + บรรทัดล่าสุด รวมไม่เกิน MAX_LINES · ตัดข้อความลูกค้าคนอื่นก่อน
  function promptLines(lines, c) {
    if (lines.length <= MAX_LINES) return lines;
    const others = lines.filter(l => l.kind === 'customer' && !l.mine);
    const drop = new Set(others.slice(0, Math.max(0, lines.length - MAX_LINES)));
    let keep = lines.filter(l => !drop.has(l));
    if (keep.length > MAX_LINES) {
      const caseLine = keep.find(l => l.isCase);
      const tail = keep.filter(l => l !== caseLine).slice(-(MAX_LINES - (caseLine ? 1 : 0)));
      keep = caseLine ? [caseLine, ...tail] : tail;
    }
    return keep;
  }

  // ข้อความล่าสุดเป็นสัญญาณจบไหม (กฎล้วน ไม่ใช้ AI)
  function closingSignal(last) {
    if (!last) return false;
    if (last.kind === 'customer' && last.mine) return CUSTOMER_OK.test(last.text) && !CUSTOMER_NOT_OK.test(last.text);
    if (last.kind === 'staff_text') return STAFF_CLOSE.test(last.text);
    return false;
  }

  // จุดสังเกตว่าแชทเปลี่ยนไหม: Id ข้อความล่าสุดในไทม์ไลน์ + เวลาที่ทีมงานตอบเจ้าของเคสล่าสุด
  // (ทีมงาน INF- ตอบไม่สร้างแถวใหม่ — bot แค่ใส่ AnsweredTime ให้ข้อความที่รออยู่)
  function threadMark(lines) {
    let msgId = 0, ansAt = null;
    for (const l of lines) {
      if (/^\d+$/.test(l.ref)) msgId = Math.max(msgId, +l.ref);
      if (l.mine && l.answeredTime && (!ansAt || l.answeredTime > ansAt)) ansAt = l.answeredTime;
    }
    return { msgId, ansAt };
  }

  function buildPrompt(c, allLines, final) {
    const lines = promptLines(allLines, c);
    const body = lines.map(l => {
      const tag = l.kind === 'staff_reply' ? `ทีมงาน ${l.who} ตอบเจ้าของเคส (ไม่มีข้อความ)`
        : l.kind === 'staff_text' ? `ทีมงาน ${l.who}: ${l.text}`
        : `${l.mine ? 'ลูกค้าเจ้าของเคส' : 'ลูกค้าคนอื่น'} (${String(l.who).slice(0, 20)}): ${String(l.text).slice(0, 150)}`;
      return `[${l.ref}] ${hhmm(l.time)} ${l.isCase ? '>>> ' : ''}${tag}`;
    }).join('\n');
    return `ตรวจเคสซัพพอร์ต POS ใน LINE กลุ่ม เคสคือข้อความ >>> (สรุป: "${c.summary || '-'}")${c.calllog_id ? ` เปิด Calllog แล้ว #${c.calllog_id}` : ''}
ดูเฉพาะเรื่องของเคสนี้ · ข้อความแอดมิน INF- ไม่ถูกบันทึก เห็นเป็น "ทีมงาน X ตอบเจ้าของเคส" · ลูกค้ามักไม่ตอบกลับเมื่อใช้ได้แล้ว
${allLines.length > lines.length ? `(แสดง ${lines.length}/${allLines.length} บรรทัด: ข้อความเคส + ล่าสุด)\n` : ''}
${body}

ตอบ JSON บรรทัดเดียวเท่านั้น ห้ามอธิบาย:
{"ids":[Id ลูกค้าที่เป็นเรื่องเดียวกับเคส รวม >>>],"cat":"${CATEGORIES.join('|')}","res":true/false,"sig":"${SIGNALS.join('|')}","end":"Id หรือ S<n> ของบรรทัดที่จบ หรือ null","conf":0-1,"why":"ไทย ≤60 ตัวอักษร"}
cat: printer=เครื่องพิมพ์/ลิ้นชัก menu=เมนู/ราคา/โปร report=รายงาน/ยอด order=บิล/ออเดอร์/PR/PO remote=รีโมท/ติดตั้ง
sig: customer_confirmed=ลูกค้าบอกได้แล้ว/ขอบคุณหลังแก้ · agent_fixed=ทีมงานตอบหลังข้อความล่าสุดของเจ้าของเคสแล้วลูกค้าไม่ได้บอกว่ายังไม่ได้ · escalated=ส่งต่อทีมอื่น/เปิดเคสแล้ว CS หยุด · abandoned=ไม่มีสัญญาณจบ (res=false, end=null)
${final ? 'ตัดสินครั้งสุดท้าย (เกิน 24 ชม.) ไม่มีสัญญาณจบ = abandoned' : 'ลูกค้ายังคุยอยู่/ไม่ชัด = res:false, abandoned'}`;
  }

  const parseObj = txt => {
    const m = String(txt).match(/\{[\s\S]*\}/);
    const o = JSON.parse(m ? m[0] : txt);
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('AI ไม่ได้ตอบเป็น JSON object');
    return o;
  };

  // ตรวจคำตอบ AI ให้ตรงกับแชทจริง แล้วคิดตัวเลข (เวลา/รอบ) เองจากไทม์ไลน์ — ไม่เชื่อตัวเลขจาก AI
  function judgeToResult(c, lines, raw, final) {
    // คีย์ย่อ (ids/cat/res/sig/end/why) ประหยัด output token · รับคีย์ยาวแบบเดิมด้วย
    const ai = {
      case_msg_ids: raw.ids ?? raw.case_msg_ids, issue_category: raw.cat ?? raw.issue_category,
      resolved: raw.res ?? raw.resolved, resolution_signal: raw.sig ?? raw.resolution_signal,
      resolved_msg_id: raw.end ?? raw.resolved_msg_id, reason: raw.why ?? raw.reason,
    };
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
    // เวลารอลูกค้า = ทีมงานตอบแล้ว → จนเจ้าของเคสพิมพ์กลับเรื่องนี้ (ลูกบอลอยู่ฝั่งลูกค้า) · นับเฉพาะเวลาทำงาน
    // เวลาฝั่งเรา (Agent-side TTR) = แก้จบ − เวลารอลูกค้า
    let custWait = 0, waitFrom = null;
    const events = [
      ...[...answerTimes.keys()].map(t => ({ t: new Date(t), staff: true })),
      ...caseCust.map(l => ({ t: l.time, staff: false })),
    ].sort((a, b) => a.t - b.t || a.staff - b.staff);
    for (const e of events) {
      if (e.staff) { if (!waitFrom) waitFrom = e.t; }
      else if (waitFrom) { custWait += workSec(waitFrom, e.t); waitFrom = null; }
    }
    return {
      case_msg_ids: [...ids].map(Number), issue_category: cat, resolved, resolution_signal: signal,
      resolved_msg_ref: resolved ? String(ai.resolved_msg_id) : null, resolved_at: resolvedAt,
      resolved_by: resolved ? resolvedBy : null, agent_turns: turns, customer_msgs: caseCust.length,
      ttr_work_sec: resolved ? workSec(caseStart, resolvedAt) : null,
      customer_wait_sec: resolved ? custWait : null,
      ai_reason: String(ai.reason || '').slice(0, 500), final,
    };
  }

  // ── ทางลัดไม่ใช้ AI ─────────────────────────────────────
  // เคสส่วนใหญ่ (~2 ใน 3) คือ ลูกค้าถาม → ทีมงานตอบรอบเดียว → ลูกค้าเงียบ หรือแค่ขอบคุณ
  // ตัดสินด้วยกฎได้เลย ผลตรงกับที่ AI ตัดสิน ไม่ต้องเสีย token · เคสที่ลูกค้าพิมพ์ต่อเรื่องอื่น/ยังไม่ได้ → ส่ง AI
  const THANKS_RE = /^(ขอบคุณ|ขอบใจ|ขอบพระคุณ|thank|thx|ได้แล้ว|ใช้ได้แล้ว|เรียบร้อย|โอเค|โอเค้|ok|okay|รับทราบ|ทราบ|ครับ|ค่ะ|คะ|คับ|จ้า|จ้ะ|ค่า|👍|🙏|🙏🏻|❤️|😊|\s|[.!~ๆ]|ผม|ครับผม|นะ|นะคะ|นะครับ|มากๆ|มาก|เลย)+$/i;
  const CAT_RULES = [
    ['printer', /ปริ้น|ปริ๊น|พิมพ์|printer|ลิ้นชัก|สลิป|กระดาษ|ใบเสร็จไม่ออก|เครื่องครัว|ออกครัว|reprint/i],
    ['remote', /รีโมท|remote|anydesk|teamviewer|ultraviewer|เข้าเครื่อง|ติดตั้ง|ลงโปรแกรม|ลงเครื่อง|เซ็ต|setup|EDC/i],
    ['menu', /เมนู|ราคา|โปรโมชั่น|โปรโมชัน|โปร\b|ท็อปปิ้ง|topping|menu|คูปอง|coupon|ส่วนลด/i],
    ['report', /รายงาน|report|ยอดขาย|สรุปยอด|ยอด|สต็อก|stock|ปิดรอบ|text ?file|shift/i],
    ['order', /บิล|บีล|ออเดอร์|order|ยกเลิก|void|\bPR\b|\bPO\b|โต๊ะ|ชำระ|ใบกำกับ|ใบเสร็จ|เงินสด|โอน|approve|อนุมัติ|ชื่อบริษัท|ประเภทลูกค้า|lineman|grab|รับผลิต/i],
  ];
  const guessCategory = text => (CAT_RULES.find(([, re]) => re.test(text)) || ['other'])[0];

  // คืนผลแบบเดียวกับ judgeToResult หรือ null = ไม่ชัด ให้ AI ตัดสิน
  function ruleJudge(c, lines, lbNow) {
    const caseLine = lines.find(l => l.ref === String(c.source_msg_id));
    const A = caseLine?.answeredTime;
    if (!A || A < new Date(c.message_time)) return null;
    if (lbNow - A < SILENCE_MIN * 60000) return null;                 // ตอบแล้วแต่ยังไม่เงียบพอ
    const mine = lines.filter(l => l.kind === 'customer' && l.mine);
    const sameAns = mine.filter(l => l.time <= A && l.answeredTime && +l.answeredTime === +A);
    const after = mine.filter(l => l.time > A);
    // ลูกค้าพิมพ์ระหว่างรอ แล้วไม่ได้ถูกตอบพร้อมกัน → มีหลายเรื่อง/หลายรอบ ให้ AI ดู
    if (mine.some(l => l.time >= new Date(c.message_time) && l.time <= A && !sameAns.includes(l))) return null;
    if (after.some(l => l.text === '[รูป/สติกเกอร์/ไฟล์]' || !THANKS_RE.test(l.text.trim()))) return null;
    const thanks = after[0] || null;
    const sLine = lines.find(l => l.kind === 'staff_reply' && +l.time === +A);
    const resolvedAt = thanks ? thanks.time : A;
    const caseStart = new Date(c.message_time);
    const ids = [...new Set([String(c.source_msg_id), ...sameAns.map(l => l.ref), ...(thanks ? [thanks.ref] : [])])];
    return {
      case_msg_ids: ids.map(Number),
      issue_category: guessCategory([c.summary, ...sameAns.map(l => l.text)].join(' ')),
      resolved: true, resolution_signal: thanks ? 'customer_confirmed' : 'agent_fixed',
      resolved_msg_ref: thanks ? thanks.ref : (sLine?.ref || null), resolved_at: resolvedAt,
      resolved_by: sLine?.who || caseLine.answeredBy || null, agent_turns: 1,
      customer_msgs: sameAns.length + (thanks ? 1 : 0) || 1,
      ttr_work_sec: workSec(caseStart, resolvedAt),
      customer_wait_sec: thanks ? workSec(A, thanks.time) : 0,
      ai_reason: thanks ? 'กฎ: ทีมงานตอบรอบเดียว ลูกค้าขอบคุณ/ยืนยัน' : 'กฎ: ทีมงานตอบรอบเดียว ลูกค้าไม่ถามต่อ',
      final: true,
    };
  }

  // ตัดสินใจว่าเคสนี้รอบนี้ต้องทำอะไร — เรียก AI เฉพาะเมื่อจำเป็น
  //   wait     = ยังไม่ถึงเวลา / ไม่มีข้อความใหม่ → ตั้งเวลาดูใหม่ (ไม่เสีย token)
  //   finalize = ครบ 24 ชม. และไม่มีอะไรใหม่ตั้งแต่ AI ดูครั้งก่อน → ใช้ผลเดิมเป็นผลสุดท้าย (ไม่เสีย token)
  //   ai       = เรียก AI ตัดสิน
  //   deferred = ต้องเรียก AI แต่รอบนี้ครบโควตาแล้ว → รอบหน้า
  async function evaluateCase(lb, c, lbNow, { allowAi = true } = {}) {
    const rows = await loadThread(lb, c, lbNow);
    if (!rows.some(r => r.Id === c.source_msg_id)) return null;   // ข้อความต้นทางหาย (ไม่น่าเกิด)
    const { lines, caseUser } = buildTimeline(rows, c);
    // เคสง่าย → ตัดสินด้วยกฎ ไม่เรียก AI
    const rule = ruleJudge(c, lines, lbNow);
    if (rule) return { action: 'rule', ...rule, ...talkSignals(c, lines, rule.resolved_at), next_check_at: null, customer_user_id: caseUser, ai_model: 'rule' };
    const now = +lbNow;
    const finalAt = new Date(c.message_time).getTime() + FINAL_HOURS * 3600000;
    const final = now >= finalAt;
    const mark = threadMark(lines);
    const judgedBefore = !!c.ai_model;
    const isNew = !judgedBefore || mark.msgId !== (c.last_checked_msg_id || 0)
      || +(mark.ansAt || 0) !== +(c.last_checked_answer_at ? new Date(c.last_checked_answer_at) : 0);
    const day = new Date(now).toISOString().slice(0, 10);
    const callsToday = c.ai_day === day ? (c.ai_calls_day || 0) : 0;
    const capped = callsToday >= MAX_AI_PER_DAY;
    const wait = (at, why) => ({ action: 'wait', why, customer_user_id: caseUser,
      next_check_at: new Date(Math.max(now + 60000, Math.min(at, finalAt))) });

    const last = lines[lines.length - 1];
    const lastAt = Math.max(...lines.map(l => +l.time), new Date(c.message_time).getTime());
    const silentMin = (now - lastAt) / 60000;
    const closing = closingSignal(last);
    const staffLast = last && (last.kind === 'staff_reply' || last.kind === 'staff_text');

    let needAi;
    if (final) needAi = isNew && !capped;
    else if (!isNew) return wait(now + RECHECK_MIN * 60000, 'ไม่มีข้อความใหม่');
    else if (closing && silentMin >= CLOSE_SILENCE_MIN) needAi = true;
    else if (staffLast && silentMin >= SILENCE_MIN) needAi = true;
    else if (closing) return wait(lastAt + CLOSE_SILENCE_MIN * 60000, 'รอกลุ่มเงียบ 10 นาที');
    else if (staffLast) return wait(lastAt + SILENCE_MIN * 60000, 'รอลูกค้าเงียบหลังทีมงานตอบ');
    else return wait(now + RECHECK_MIN * 60000, 'ลูกค้ายังรอทีมงาน');
    if (needAi && capped) {
      const tomorrow = Date.UTC(...day.split('-').map((v, i) => i === 1 ? v - 1 : +v)) + 86400000;
      return wait(tomorrow, `เรียก AI ครบ ${MAX_AI_PER_DAY} ครั้งวันนี้แล้ว`);
    }

    if (!needAi) {
      // final ที่ไม่ต้องเรียก AI: มีผลเดิม → ใช้ผลเดิม · ไม่เคยตัดสิน (ครบโควตา) → abandoned ด้วยกฎ
      if (judgedBefore) return { action: 'finalize', keepPrevious: true };
      const out = judgeToResult(c, lines, { why: 'ไม่มีสัญญาณจบ (ตัดสินด้วยกฎ ไม่ใช้ AI)' }, true);
      return { action: 'finalize', ...out, ...talkSignals(c, lines, out.resolved_at), final: true, next_check_at: null, customer_user_id: caseUser, ai_model: 'rule' };
    }
    if (!allowAi) return { action: 'deferred' };

    const { value, usedModel } = await aiGenerate(buildPrompt(c, lines, final), {
      parse: parseObj, feature: 'line_resolution', model: aiModel || undefined,
      geminiConfig: SchemaType ? { generationConfig: {
        responseMimeType: 'application/json', maxOutputTokens: MAX_OUT_TOKENS, temperature: 0,
        // รุ่น lite ไม่คิดอยู่แล้ว และไม่รับ thinkingBudget (400) — ส่งเฉพาะรุ่นที่คิด
        ...(/lite/i.test(aiModel || "") ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
      } } : null,
    });
    const out = judgeToResult(c, lines, value, final);
    // จบแล้ว = final ไม่ตรวจซ้ำ (ลูกค้ากลับมาใหม่ = เคสใหม่) · ยังไม่จบ → ดูใหม่เมื่อมีข้อความใหม่
    out.final = out.resolved || final;
    out.next_check_at = out.final ? null : new Date(Math.min(now + RECHECK_MIN * 60000, finalAt));
    out.customer_user_id = caseUser;
    out.ai_model = usedModel;
    out.mark = mark;
    out.day = day;
    Object.assign(out, talkSignals(c, lines, out.resolved_at));
    return { action: 'ai', ...out };
  }

  async function save(c, r) {
    const ai = r.action === 'ai';
    await req().input('id', sql.Int, c.source_msg_id).input('g', sql.NVarChar, c.group_id).input('gn', sql.NVarChar, c.group_name)
      .input('pod', sql.Int, c.pod_id).input('cu', sql.NVarChar, r.customer_user_id).input('mt', sql.DateTime, c.message_time)
      .input('fat', sql.DateTime, c.answered_time).input('ab', sql.NVarChar, c.answered_by)
      .input('cat', sql.NVarChar, r.issue_category).input('res', sql.Bit, r.resolved ? 1 : 0).input('sig', sql.NVarChar, r.resolution_signal)
      .input('ref', sql.NVarChar, r.resolved_msg_ref).input('rat', sql.DateTime, r.resolved_at).input('rby', sql.NVarChar, r.resolved_by)
      .input('turns', sql.Int, r.agent_turns).input('cm', sql.Int, r.customer_msgs).input('cid', sql.Int, c.calllog_id || null)
      .input('why', sql.NVarChar, r.ai_reason).input('model', sql.NVarChar, r.ai_model).input('fin', sql.Bit, r.final ? 1 : 0)
      .input('next', sql.DateTime, r.next_check_at)
      .input('ttr', sql.Int, r.ttr_work_sec).input('cw', sql.Int, r.customer_wait_sec)
      .input('ai', sql.Bit, ai ? 1 : 0).input('lm', sql.Int, ai ? r.mark.msgId : null)
      .input('la', sql.DateTime, ai ? r.mark.ansAt : null).input('day', sql.NVarChar, ai ? r.day : null)
      .input('tcf', sql.Bit, r.talk_confused ?? null).input('tch', sql.Bit, r.talk_chased ?? null).input('tth', sql.Bit, r.talk_thanks ?? null).query(`
      IF EXISTS (SELECT 1 FROM line_case_resolution WHERE case_msg_id=@id)
        UPDATE line_case_resolution SET customer_user_id=@cu, issue_category=@cat, resolved=@res, resolution_signal=@sig,
          ttr_work_sec=@ttr, customer_wait_sec=@cw,
          resolved_msg_ref=@ref, resolved_at=@rat, resolved_by=@rby, agent_turns=@turns, customer_msgs=@cm,
          calllog_id=ISNULL(@cid, calllog_id), ai_reason=@why, ai_model=@model, checks=checks+@ai, final=@fin,
          next_check_at=@next, updated_at=GETDATE(), talk_confused=@tcf, talk_chased=@tch, talk_thanks=@tth,
          last_checked_msg_id=CASE WHEN @ai=1 THEN @lm ELSE last_checked_msg_id END,
          last_checked_answer_at=CASE WHEN @ai=1 THEN @la ELSE last_checked_answer_at END,
          ai_calls_day=CASE WHEN @ai=0 THEN ai_calls_day WHEN ai_day=CAST(@day AS DATE) THEN ai_calls_day+1 ELSE 1 END,
          ai_day=CASE WHEN @ai=1 THEN CAST(@day AS DATE) ELSE ai_day END
        WHERE case_msg_id=@id
      ELSE
        INSERT INTO line_case_resolution (case_msg_id, group_id, group_name, pod_id, customer_user_id, first_msg_time,
          first_answer_time, answered_by, issue_category, resolved, resolution_signal, resolved_msg_ref, resolved_at, resolved_by,
          agent_turns, customer_msgs, calllog_id, ai_reason, ai_model, checks, final, next_check_at, ttr_work_sec, customer_wait_sec,
          last_checked_msg_id, last_checked_answer_at, ai_day, ai_calls_day, talk_confused, talk_chased, talk_thanks)
        VALUES (@id, @g, @gn, @pod, @cu, @mt, @fat, @ab, @cat, @res, @sig, @ref, @rat, @rby, @turns, @cm, @cid, @why, @model, @ai, @fin, @next, @ttr, @cw,
          @lm, @la, CAST(@day AS DATE), @ai, @tcf, @tch, @tth)`);
    // ข้อความของเคส: ทำใหม่ทุกรอบ · ข้อความที่เป็นของเคสอื่นอยู่แล้วไม่แย่ง (เคสแรกได้ก่อน)
    const t = req().input('id', sql.Int, c.source_msg_id);
    r.case_msg_ids.forEach((m, k) => t.input('m' + k, sql.Int, m));
    await t.query(`
      DELETE FROM line_case_resolution_msg WHERE case_msg_id=@id;
      INSERT INTO line_case_resolution_msg (msg_id, case_msg_id)
      SELECT v.id, @id FROM (VALUES ${r.case_msg_ids.map((_, k) => `(@m${k})`).join(',')}) v(id)
      WHERE NOT EXISTS (SELECT 1 FROM line_case_resolution_msg x WHERE x.msg_id = v.id);`);
  }

  // ยังไม่ถึงเวลาเรียก AI: จดเวลาดูใหม่ไว้ (สร้างแถวรอไว้ถ้ายังไม่มี — final=0 หน้า KPI ไม่นับ)
  async function saveWait(c, r) {
    await req().input('id', sql.Int, c.source_msg_id).input('g', sql.NVarChar, c.group_id).input('gn', sql.NVarChar, c.group_name)
      .input('pod', sql.Int, c.pod_id).input('cu', sql.NVarChar, r.customer_user_id).input('mt', sql.DateTime, c.message_time)
      .input('fat', sql.DateTime, c.answered_time).input('ab', sql.NVarChar, c.answered_by)
      .input('cid', sql.Int, c.calllog_id || null).input('next', sql.DateTime, r.next_check_at).query(`
      IF EXISTS (SELECT 1 FROM line_case_resolution WHERE case_msg_id=@id)
        UPDATE line_case_resolution SET next_check_at=@next, calllog_id=ISNULL(@cid, calllog_id), updated_at=GETDATE() WHERE case_msg_id=@id
      ELSE
        INSERT INTO line_case_resolution (case_msg_id, group_id, group_name, pod_id, customer_user_id, first_msg_time,
          first_answer_time, answered_by, calllog_id, checks, final, next_check_at)
        VALUES (@id, @g, @gn, @pod, @cu, @mt, @fat, @ab, @cid, 0, 0, @next)`);
  }

  // ครบ 24 ชม. ไม่มีข้อความใหม่ตั้งแต่ AI ดูครั้งก่อน → ใช้ผลเดิมเป็นผลสุดท้าย
  async function saveFinalPrevious(c) {
    await req().input('id', sql.Int, c.source_msg_id)
      .query(`UPDATE line_case_resolution SET final=1, next_check_at=NULL, updated_at=GETDATE() WHERE case_msg_id=@id`);
  }

  // เติมสัญญาณการคุยงานให้เคสที่ตัดสินไปก่อนมีคอลัมน์นี้ (อ่าน LineBotMonitor อย่างเดียว ไม่ใช้ AI)
  async function backfillTalk(limit = 300) {
    const lb = getLineBotPool();
    if (!lb) return 0;
    await ensure();
    const lbNow = (await lb.request().query('SELECT GETDATE() AS now')).recordset[0].now;
    const rows = (await req().query(`SELECT TOP (${limit}) case_msg_id, case_msg_id AS source_msg_id, group_id, first_msg_time AS message_time, resolved_at
      FROM line_case_resolution WHERE final = 1 AND talk_confused IS NULL ORDER BY first_msg_time DESC`)).recordset;
    let n = 0;
    for (const c of rows) {
      let sig = { talk_confused: false, talk_chased: false, talk_thanks: false };
      try {
        const t = await loadThread(lb, c, lbNow);
        if (t.some(x => x.Id === c.case_msg_id)) sig = talkSignals(c, buildTimeline(t, c).lines, c.resolved_at);
      } catch (e) { log.error(`talk backfill ${c.case_msg_id}:`, e.message); continue; }
      await req().input('id', sql.Int, c.case_msg_id).input('a', sql.Bit, sig.talk_confused).input('b', sql.Bit, sig.talk_chased).input('c', sql.Bit, sig.talk_thanks)
        .query('UPDATE line_case_resolution SET talk_confused=@a, talk_chased=@b, talk_thanks=@c WHERE case_msg_id=@id');
      n++;
    }
    if (n) log.log(`💬 line talk backfill: ${n} เคส`);
    return n;
  }

  // รอบหนึ่ง: ดูเคสที่ถึงเวลา เรียก AI ไม่เกิน limit ครั้ง · dryRun = อ่านอย่างเดียว ไม่สร้างตาราง ไม่เขียน
  // aiAllowed = false/ฟังก์ชันที่คืน false (เกินงบ token รายวัน) → ตัดสินด้วยกฎอย่างเดียว เคสที่ต้องใช้ AI เลื่อนไป
  async function runBatch({ limit = 15, dryRun = false, onlyIds = null, aiAllowed = true } = {}) {
    if (_running && !dryRun) return { skipped: 'running' };
    const lb = getLineBotPool();
    if (!lb) return { error: 'LineBotMonitor DB ไม่ได้เชื่อมต่อ' };
    if (!dryRun) _running = true;
    const results = [];
    const count = { ai: 0, rule: 0, finalize: 0, wait: 0, deferred: 0 };
    try {
      const haveTables = dryRun ? await tablesExist() : (await ensure(), true);
      const lbNow = (await lb.request().query('SELECT GETDATE() AS now')).recordset[0].now;
      // ดูได้หลายเคส (อ่าน DB อย่างเดียว) แต่เรียก AI ไม่เกิน limit ครั้ง/รอบ
      let cases = await pickCases(lbNow, onlyIds ? 2000 : Math.min(300, limit * 10), haveTables);
      if (onlyIds) cases = cases.filter(c => onlyIds.includes(c.source_msg_id));
      // ใน dry run ไม่มีตารางกันซ้ำ — ข้ามข้อความที่เคสก่อนหน้าในรอบเดียวกันกินไปแล้ว
      const taken = new Set();
      let aiDown = false;   // AI ล่ม/เครดิตหมด → เคสที่เหลือในรอบนี้ใช้กฎอย่างเดียว
      for (const c of cases) {
        if (taken.has(c.source_msg_id)) continue;
        try {
          const r = await evaluateCase(lb, c, lbNow, { allowAi: count.ai < limit && !aiDown && (typeof aiAllowed === 'function' ? aiAllowed() : aiAllowed) });
          if (!r) continue;
          count[r.action]++;
          if (r.action === 'deferred') continue;
          if (r.action === 'wait') { if (!dryRun) await saveWait(c, r); continue; }
          if (r.keepPrevious) { if (!dryRun) await saveFinalPrevious(c); continue; }
          r.case_msg_ids.forEach(id => id !== c.source_msg_id && taken.add(id));
          if (!dryRun) await save(c, r);
          const { mark, day, ...shown } = r;
          results.push({ case_msg_id: c.source_msg_id, group_name: c.group_name, summary: c.summary, message_time: c.message_time, ...shown });
        } catch (e) {
          log.error(`line resolution case ${c.source_msg_id}:`, e.message);
          results.push({ case_msg_id: c.source_msg_id, error: e.message });
          if (/AI ไม่สำเร็จ/.test(e.message)) aiDown = true;   // AI ล่มทั้งสองเจ้า — รอบหน้าค่อยลองใหม่
        }
      }
      if (!dryRun && (count.ai || count.finalize || count.rule))
        log.log(`🧩 line resolution: AI ${count.ai} · กฎ ${count.rule} · ปิดโดยไม่ใช้ AI ${count.finalize} · รอ ${count.wait}${count.deferred ? ` · เลื่อนรอบหน้า ${count.deferred}` : ''} (ดู ${cases.length} เคส)`);
      return { lbNow, picked: cases.length, count, results };
    } finally { if (!dryRun) _running = false; }
  }

  return { ensure, runBatch, evaluateCase, buildTimeline, buildPrompt, promptLines, closingSignal, threadMark, judgeToResult, ruleJudge, loadThread, pickCases, backfillTalk, CATEGORIES, SIGNALS };
}

// คิดตัวเลขหน้า "ตอบเคสไลน์ไว" (เฟส 2) จากแถว line_case_resolution — แยกเป็นฟังก์ชันล้วนไว้ทดสอบกับข้อมูลจริงได้
// S (ไม่บังคับ) = { employees, calllog, prevCalllog, lineMap } → เพิ่ม staff: Leaderboard รายพนักงาน (LINE + Calllog)
function buildBoard(curRaw, prevRaw, B, S = null) {
  const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const prep = rows => rows.filter(x => x.final).map(x => {
    const frt = x.first_answer_time ? workSec(x.first_msg_time, x.first_answer_time) : null;
    const ttr = x.resolved ? (x.ttr_work_sec ?? workSec(x.first_msg_time, x.resolved_at)) : null;
    return { ...x, frt, ttr, agent_ttr: ttr == null ? null : Math.max(0, ttr - (x.customer_wait_sec || 0)), turns: x.agent_turns || 0 };
  });
  const stats = cs => {
    const res = cs.filter(c => c.resolved), frts = cs.map(c => c.frt).filter(v => v != null);
    // รอบคุยคิดเฉพาะเคสที่เห็นทีมงานตอบอย่างน้อย 1 รอบ (0 รอบ = ไม่มีบันทึกการตอบ ไม่ใช่ "คุยน้อย")
    const tr = res.filter(c => c.turns >= 1);
    return {
      cases: cs.length, resolved: res.length, abandoned: cs.length - res.length,
      frt_median: median(frts), frt_within_pct: frts.length ? Math.round(frts.filter(v => v <= B.frtTargetSec).length / frts.length * 100) : null,
      ttr_median: median(res.map(c => c.ttr)), agent_ttr_median: median(res.map(c => c.agent_ttr)),
      turns_avg: tr.length ? +avg(tr.map(c => c.turns)).toFixed(1) : null,
      one_touch_pct: tr.length ? Math.round(tr.filter(c => c.turns <= B.oneTouchTurns).length / tr.length * 100) : null,
    };
  };
  const cur = prep(curRaw), prevRows = prep(prevRaw);

  // Resolution เทียบ median ของหมวดเดียวกัน (เคส "เมนู" ยากกว่า "ขอรีโมท")
  const catMed = new Map();
  for (const cat of new Set(cur.map(c => c.issue_category))) catMed.set(cat, median(cur.filter(c => c.issue_category === cat && c.resolved).map(c => c.agent_ttr)));
  const resScore = c => {
    if (!c.resolved) return 0;   // ไม่มีสัญญาณจบ = ไม่ได้คะแนนด้านนี้
    const m = catMed.get(c.issue_category);
    return m == null || c.agent_ttr <= m ? 100 : Math.round(100 * Math.max(m, 60) / Math.max(c.agent_ttr, 60));
  };
  const W = B.weights, wSum = W.speed + W.resolution + W.efficiency;
  const byPerson = new Map();
  cur.forEach(c => { const k = c.answered_by || '(ไม่ทราบ)'; (byPerson.get(k) || byPerson.set(k, []).get(k)).push(c); });
  const prevBy = new Map();
  prevRows.forEach(c => { const k = c.answered_by || '(ไม่ทราบ)'; (prevBy.get(k) || prevBy.set(k, []).get(k)).push(c); });
  const scoreOf = cs => {
    const s = stats(cs);
    const speed = s.frt_within_pct ?? 0;
    const resolution = Math.round(avg(cs.map(resScore)) ?? 0);
    // Efficiency = ครึ่งหนึ่ง One-touch %, อีกครึ่งรอบคุยเฉลี่ย (≤2 รอบ = 100, ≥8 รอบ = 0)
    const turnScore = s.turns_avg == null ? 0 : Math.round(Math.max(0, Math.min(100, (8 - s.turns_avg) / 6 * 100)));
    const efficiency = Math.round(((s.one_touch_pct ?? 0) + turnScore) / 2);
    return { ...s, speed, resolution_score: resolution, efficiency, total: Math.round((speed * W.speed + resolution * W.resolution + efficiency * W.efficiency) / wSum) };
  };
  // ── Leaderboard สองบอร์ด: "คุยงานดี" และ "ตอบไว" (ไม่ใช้ AI) ──
  const clamp = v => Math.max(0, Math.min(100, Math.round(v)));
  const pct = (a, n) => n ? Math.round(a / n * 100) : null;
  const boardRaw = cs => {
    const s = stats(cs), tk = cs.filter(c => c.talk_confused != null);
    const confused = pct(tk.filter(c => c.talk_confused).length, tk.length);
    const chased = pct(tk.filter(c => c.talk_chased).length, tk.length);
    const confirmed = pct(tk.filter(c => c.resolution_signal === 'customer_confirmed' || c.talk_thanks).length, tk.length);
    // คุยงานดี: รู้เรื่อง 40 (ลูกค้างง 0% = 100, 20% = 0) · กระชับ 30 · ไม่ต้องทวง 15 (10% = 0) · ลูกค้ายืนยัน 15 (50% = 100)
    const concise = clamp(((s.one_touch_pct ?? 0) + clamp((4 - (s.turns_avg ?? 4)) / 3 * 100)) / 2);
    const talk = confused == null ? null : Math.round(clamp(100 - confused * 5) * .4 + concise * .3 + clamp(100 - chased * 10) * .15 + clamp(confirmed / 50 * 100) * .15);
    // ตอบไว: ทันเป้าตอบแรก 70 · แก้จบฝั่งเรา 30 (≤ 30 นาที = 100, ≥ 4 ชม. = 0)
    const fix = s.agent_ttr_median;
    const speed = Math.round((s.frt_within_pct ?? 0) * .7 + (fix == null ? 0 : clamp((14400 - Math.max(1800, fix)) / (14400 - 1800) * 100)) * .3);
    return { talk, speed, confused_pct: confused, chased_pct: chased, confirmed_pct: confirmed, talk_known: tk.length };
  };
  // จำนวนเคสมีผล: คะแนนถูกดึงเข้าหาค่าเฉลี่ยทีมตามจำนวนเคส (เคสน้อย = ยังไม่น่าเชื่อ) — ต้องมีเคสมากถึงจะได้คะแนนสุดขั้ว
  const K = B.shrinkCases ?? 20;
  const teamRaw = boardRaw(cur), prevTeamRaw = boardRaw(prevRows);
  const shrink = (v, n, t) => v == null ? null : t == null ? v : Math.round((v * n + t * K) / (n + K));
  const boardOf = (cs, team) => {
    const r = boardRaw(cs);
    return { ...r, talk_raw: r.talk, speed_raw: r.speed,
      talk: shrink(r.talk, r.talk_known, team.talk), speed: shrink(r.speed, cs.length, team.speed) };
  };
  const people = [...byPerson].map(([name, cs]) => {
    const p = { name, ...scoreOf(cs), ...boardOf(cs, teamRaw) };
    const pv = prevBy.get(name);
    p.prev_total = pv && pv.length >= 5 ? scoreOf(pv).total : null;
    if (pv && pv.length >= B.minCases) { const q = boardOf(pv, prevTeamRaw); p.prev_talk = q.talk; p.prev_speed = q.speed; }
    p.ranked = p.cases >= B.minCases;
    return p;
  }).sort((a, b) => b.ranked - a.ranked || b.total - a.total || b.cases - a.cases);
  // อันดับช่วงก่อน (ไว้ทำลูกศร ▲▼)
  const prevRank = key => [...prevBy].filter(([, cs]) => cs.length >= B.minCases)
    .map(([name, cs]) => ({ name, v: boardOf(cs, prevTeamRaw)[key] })).filter(x => x.v != null).sort((a, b) => b.v - a.v).map(x => x.name);
  const pr = { talk: prevRank('talk'), speed: prevRank('speed') };
  people.forEach(p => { p.prev_rank_talk = pr.talk.includes(p.name) ? pr.talk.indexOf(p.name) + 1 : null;
    p.prev_rank_speed = pr.speed.includes(p.name) ? pr.speed.indexOf(p.name) + 1 : null; });

  // ป้าย — คิดจากคนที่ติดอันดับ
  const R = people.filter(p => p.ranked);
  const best = (fn, dir = 1) => R.filter(p => fn(p) != null).sort((a, b) => dir * (fn(a) - fn(b)))[0]?.name || null;
  const badges = {
    fastest: best(p => p.frt_median),
    fixer: best(p => p.agent_ttr_median),
    clearest: best(p => p.turns_avg),
    improved: (() => { const x = R.filter(p => p.prev_total != null).sort((a, b) => (b.total - b.prev_total) - (a.total - a.prev_total))[0]; return x && x.total > x.prev_total ? x.name : null; })(),
  };

  // เคสที่ควรดู (แทนตาราง "ตอบช้าสุด")
  const brief = c => ({ case_msg_id: c.case_msg_id, group_name: c.group_name, pod_id: c.pod_id, answered_by: c.answered_by,
    first_msg_time: c.first_msg_time, issue_category: c.issue_category, resolution_signal: c.resolution_signal,
    turns: c.turns, ttr: c.ttr, agent_ttr: c.agent_ttr, reason: c.ai_reason });
  const review = {
    many_turns: cur.filter(c => c.turns > B.reviewTurns).sort((a, b) => b.turns - a.turns).slice(0, 30).map(brief),
    slow_fix: cur.filter(c => c.agent_ttr != null && c.agent_ttr > B.reviewTtrSec).sort((a, b) => b.agent_ttr - a.agent_ttr).slice(0, 30).map(brief),
    abandoned: cur.filter(c => !c.resolved).sort((a, b) => new Date(b.first_msg_time) - new Date(a.first_msg_time)).slice(0, 30).map(brief),
  };

  // รายงานผู้บริหาร: แนวโน้มรายวัน + หมวดปัญหา (ตัวเลขล้วน ไม่ใช้ AI)
  const dayKey = c => new Date(c.first_msg_time).toISOString().slice(0, 10);
  const byDay = new Map();
  cur.forEach(c => { const k = dayKey(c); (byDay.get(k) || byDay.set(k, []).get(k)).push(c); });
  const by_day = [...byDay].sort((a, b) => a[0].localeCompare(b[0])).map(([day, cs]) => {
    const s = stats(cs);
    return { day, cases: s.cases, frt_median: s.frt_median, frt_within_pct: s.frt_within_pct,
      resolved_pct: s.cases ? Math.round(s.resolved / s.cases * 100) : null, agent_ttr_median: s.agent_ttr_median };
  });
  const prevCat = new Map();
  prevRows.forEach(c => prevCat.set(c.issue_category, (prevCat.get(c.issue_category) || 0) + 1));
  const by_category = [...new Set(cur.map(c => c.issue_category || 'other'))].map(cat => {
    const cs = cur.filter(c => (c.issue_category || 'other') === cat), s = stats(cs);
    return { category: cat, cases: s.cases, pct: Math.round(s.cases / (cur.length || 1) * 100), prev_cases: prevCat.get(cat) || 0,
      frt_median: s.frt_median, agent_ttr_median: s.agent_ttr_median, turns_avg: s.turns_avg,
      resolved_pct: s.cases ? Math.round(s.resolved / s.cases * 100) : null };
  }).sort((a, b) => b.cases - a.cases);


  // ── Leaderboard รายพนักงาน: รวม LINE (คุยงานดี/ตอบไว) + Calllog (ทุกช่องทาง · ดาวลูกค้า) ──
  // งานโทรศัพท์ / ตอบผ่าน LINE ส่วนตัว ไม่อยู่ในข้อมูล LINE แต่อยู่ใน Calllog → คนที่รับเคสเยอะไม่เสียเปรียบ
  let staff = null, staffTeam = null;
  if (S) {
    const median = xs => { xs = xs.filter(v => v != null).sort((a, b) => a - b); if (!xs.length) return null; const h = xs.length >> 1; return xs.length % 2 ? xs[h] : (xs[h - 1] + xs[h]) / 2; };
    const norm = v => String(v || '').toLowerCase().replace(/^inf[\s_.\-]*/, '').replace(/[^a-z0-9ก-๙]/g, '');
    const emps = S.employees.map(e => ({ ...e, keys: [norm(e.nickname), norm(e.ext_username)].filter(Boolean),
      lines: String(e.line_names || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean) }));
    const byExt = new Map(emps.filter(e => e.ext_username).map(e => [String(e.ext_username).toLowerCase(), e]));
    const over = new Map(Object.entries(S.lineMap || {}).map(([k, v]) => [norm(k), norm(v)]));
    const lineEmp = new Map();
    const empOfLine = name => {
      if (lineEmp.has(name)) return lineEmp.get(name);
      const k = norm(name), o = over.get(k), exact = String(name || '').trim().toLowerCase();
      // 1) ผูกไว้ในหน้าจัดการ User (แม่นสุด) → 2) LINE_STAFF_MAP → 3) เดาจากชื่อเล่น/username
      const hit = emps.find(e => e.lines.includes(exact))
        || (o && emps.find(e => e.keys.includes(o)))
        || emps.find(e => e.keys.includes(k))
        || (k.length >= 3 && emps.find(e => e.keys.some(x => x.length >= 3 && (x.startsWith(k) || k.startsWith(x) || x.includes(k)))))
        || null;
      lineEmp.set(name, hit);
      return hit;
    };
    const CH = { line: 'LINE', phone: 'โทร', remote: 'Remote', email: 'Email' };
    const chOf = v => CH[String(v || '').trim().toLowerCase()] || 'อื่นๆ';
    const p75 = xs => { xs = xs.filter(v => v > 0).sort((a, b) => a - b); return xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * .75))] : 0; };
    const tierOf = v => v == null ? null : v >= 90 ? 'diamond' : v >= 80 ? 'gold' : v >= 70 ? 'silver' : v >= 60 ? 'bronze' : 'rookie';
    const W2 = B.staffWeights || { talk: 30, speed: 20, sat: 30, volume: 20 };

    const buildStaff = (cases, calllog, teamLine) => {
      const m = new Map();
      const get = e => m.get(e.id) || m.set(e.id, { id: e.id, name: e.nickname || e.name, full_name: e.name, team: e.team,
        pod_id: e.pod_id ?? null, pod_name: e.pod_name || null, pod_color: e.pod_color || null,
        line_names: new Set(), cases: [], cl: [] }).get(e.id);
      for (const c of cases) { const e = empOfLine(c.answered_by); if (e) { const s = get(e); s.cases.push(c); s.line_names.add(c.answered_by); } }
      for (const r of calllog) { const e = byExt.get(String(r.user || '').toLowerCase()); if (e) get(e).cl.push(r); }
      const list = [...m.values()].map(s => {
        const st = stats(s.cases), br = boardRaw(s.cases);
        const channels = {};
        s.cl.forEach(r => { const k = chOf(r.channel); channels[k] = (channels[k] || 0) + 1; });
        const closed = s.cl.filter(r => r.closed_at);
        const rated = s.cl.filter(r => r.stars > 0);
        const unlogged = s.cases.filter(c => !c.calllog_id).length;   // แชท LINE ที่ไม่ได้เปิดเคสใน Calllog
        return {
          id: s.id, name: s.name, full_name: s.full_name, team: s.team, line_names: [...s.line_names],
          pod_id: s.pod_id, pod_name: s.pod_name, pod_color: s.pod_color,
          line_cases: s.cases.length, line_unlogged: unlogged, calllog_total: s.cl.length, channels,
          // งานทั้งหมด = เคสใน Calllog (ทุกช่องทาง) หรือแชท LINE ที่ตอบ แล้วแต่อันไหนมากกว่า — ไม่บวกกันเพราะแชทส่วนใหญ่เปิดเคสใน Calllog ด้วย
          workload: Math.max(s.cl.length, s.cases.length),
          closed_pct: s.cl.length ? Math.round(closed.length / s.cl.length * 100) : null,
          close_median_min: median(closed.map(r => (new Date(r.closed_at) - new Date(r.opened_at)) / 60000).filter(v => v >= 0)),
          stars_avg: rated.length ? +(rated.reduce((a, r) => a + r.stars, 0) / rated.length).toFixed(2) : null, rated: rated.length,
          frt_median: st.frt_median, frt_within_pct: st.frt_within_pct, agent_ttr_median: st.agent_ttr_median,
          turns_avg: st.turns_avg, one_touch_pct: st.one_touch_pct, abandoned: st.abandoned,
          confused_pct: br.confused_pct, chased_pct: br.chased_pct, confirmed_pct: br.confirmed_pct,
          talk_raw: br.talk, speed_raw: br.speed, talk_known: br.talk_known,
        };
      });
      // ค่าเฉลี่ยทีม (ไว้ดึงคะแนนของคนที่ข้อมูลน้อย)
      const rated = list.filter(x => x.rated);
      const teamStars = rated.length ? rated.reduce((a, x) => a + x.stars_avg * x.rated, 0) / rated.reduce((a, x) => a + x.rated, 0) : null;
      const satOf = v => v == null ? null : clamp((v - 3) / 2 * 100);   // ดาว 3 = 0 · ดาว 5 = 100
      const vTop = p75(list.filter(x => x.workload >= B.minCases).map(x => x.workload));
      list.forEach(x => {
        const lineOk = x.line_cases >= 10;
        x.talk = lineOk ? shrink(x.talk_raw, x.talk_known, teamLine.talk) : null;
        x.speed = lineOk ? shrink(x.speed_raw, x.line_cases, teamLine.speed) : null;
        x.sat = x.rated ? shrink(satOf(x.stars_avg), x.rated, satOf(teamStars)) : null;
        x.volume = vTop ? clamp(x.workload / vTop * 100) : null;
        const parts = [['talk', x.talk], ['speed', x.speed], ['sat', x.sat], ['volume', x.volume]].filter(([, v]) => v != null);
        const wsum = parts.reduce((a, [k]) => a + W2[k], 0);
        x.overall = wsum ? Math.round(parts.reduce((a, [k, v]) => a + v * W2[k], 0) / wsum) : null;
        x.tier = tierOf(x.overall);
        x.ranked = x.workload >= B.minCases && x.team !== 'management';   // หัวหน้าทีมแสดงไว้ แต่ไม่ติดอันดับ
      });
      return { list, teamStars };
    };
    const curS = buildStaff(cur, S.calllog, teamRaw), prevS = buildStaff(prevRows, S.prevCalllog || [], prevTeamRaw);
    const rankOf = (lst, k) => lst.filter(x => x.ranked && x[k] != null).sort((a, z) => z[k] - a[k]).map(x => x.id);
    const pr = Object.fromEntries(['overall', 'talk', 'speed', 'sat'].map(k => [k, rankOf(prevS.list, k)]));
    curS.list.forEach(x => {
      const p = prevS.list.find(y => y.id === x.id && y.ranked);
      for (const k of ['overall', 'talk', 'speed', 'sat']) {
        x['prev_' + k] = p ? p[k] : null;
        const i = pr[k].indexOf(x.id); x['prev_rank_' + k] = i < 0 ? null : i + 1;
      }
    });
    staff = curS.list.filter(x => x.workload || x.line_cases).sort((a, z) => z.ranked - a.ranked || (z.overall ?? -1) - (a.overall ?? -1));
    staffTeam = { stars_avg: curS.teamStars == null ? null : +curS.teamStars.toFixed(2), weights: W2,
      unmatched_line: [...lineEmp].filter(([, e]) => !e).map(([n]) => n) };
  }

  return { team: { ...stats(cur), ...teamRaw }, prev: { ...stats(prevRows), ...prevTeamRaw }, people, badges, review, by_day, by_category, staff, staff_team: staffTeam,
    by_signal: cur.reduce((m, c) => (m[c.resolution_signal] = (m[c.resolution_signal] || 0) + 1, m), {}) };
}

module.exports = { createLineResolution, workSec, buildBoard, talkSignals };
