/**
 * pbx-ai.js — AI ฟังสายโทรศัพท์ Support แล้วให้คะแนนตาม "Script รับสายลูกค้า – Support POS"
 *
 * อ่าน dbo.PBX_CallRecord (เติมโดย ~/pbx-export/pbx_export.py ตอนตี 1 — ไม่แตะสคริปต์นั้น)
 * → แปลงเสียง .gsm เป็น mp3 + ตัดช่วงเงียบ (ffmpeg) → Gemini → เขียนผลกลับแถวเดิม
 *
 * ประหยัด token (ตั้งใจ):
 *   - ไม่ถอดความทั้งสาย (token ขาออกแพงสุด) — ขอแค่เช็กลิสต์ใช่/ไม่ใช่ + สรุป 1 ประโยค
 *     เปิดถอดความได้ด้วย PBX_AI_TRANSCRIPT=on
 *   - ตัดช่วงเงียบก่อนส่ง (Gemini คิดเสียง ~32 token/วินาที ไม่ขึ้นกับ bitrate)
 *   - สุ่มตรวจ: ต่อเบอร์ต่อวันไม่เกิน PBX_AI_PER_EXT สาย (ค่าเริ่มต้น 5) กระจายทั้งวัน
 *   - สายสั้นกว่า PBX_AI_MIN_SEC (30 วินาที) ไม่ส่ง · ปิด thinking · จำกัด maxOutputTokens
 *   - คะแนนรวมคำนวณเองจากเช็กลิสต์ (ไม่ให้ AI เขียนเหตุผลยาว)
 *
 * ใช้ในเซิร์ฟเวอร์: const pbxAi = createPbxAi({...}); pbxAi.run({ date })
 * รันมือบนเซิร์ฟเวอร์: node pbx-ai.js --date 2026-11-11 --limit 10 [--all]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const env = (k, d) => (process.env[k] ?? '') === '' ? d : process.env[k];
const CFG = () => ({
  model: env('PBX_AI_MODEL', env('GEMINI_MODEL', 'gemini-2.5-flash')),
  perExt: Math.max(0, parseInt(env('PBX_AI_PER_EXT', '5')) || 0),   // 0 = ทุกสาย
  minSec: Math.max(15, parseInt(env('PBX_AI_MIN_SEC', '30')) || 30),
  transcript: env('PBX_AI_TRANSCRIPT', 'off').toLowerCase() === 'on',
  concurrency: Math.min(3, Math.max(1, parseInt(env('PBX_AI_CONCURRENCY', '2')) || 2)),
  maxAttempts: 3,           // ต่อรอบ
  maxTotalAttempts: 6,      // รวมทุกรอบ — เกินนี้เลิกพยายาม (กัน token รั่วกับไฟล์เสีย)
  inlineMax: 15 * 1024 * 1024,
});

// ── เช็กลิสต์ตามสคริปต์ (key สั้น = token ขาออกน้อย) ──
// null = ไม่เกี่ยวกับสายนี้ (เช่น ไม่ได้พักสาย) → ไม่นับ
const CHECKS = [
  ['greet',    '1. รับสาย: ทักทาย + บอกชื่อบริษัท (Easy Restaurant) + บอกชื่อตัวเอง'],
  ['shop',     '2. ถามชื่อร้านและสาขา'],
  ['contact',  '2. ถามชื่อลูกค้าและเบอร์ติดต่อกลับ'],
  ['probe',    '3. ถามรายละเอียดปัญหา (หน้าจอ/เมนู, เป็นตั้งแต่เมื่อไหร่, ทุกเครื่องหรือเครื่องเดียว, มี Error ไหม) อย่างน้อย 2 ข้อ'],
  ['can_sell', '3. ถามว่าตอนนี้ร้านยังขายได้ไหม'],
  ['recap',    '4. ทวนปัญหาให้ลูกค้ายืนยัน'],
  ['hold',     '5. ถ้าพักสาย: ขออนุญาต+บอกเวลา และขอบคุณที่รอ (ไม่ได้พักสาย = null)'],
  ['remote',   '5. ถ้าต้อง Remote: บอกให้เปิด AnyDesk แจ้ง ID และอย่าเพิ่งใช้เครื่อง (ไม่ได้ Remote = null)'],
  ['escalate', '6. ถ้าแก้ในสายไม่ได้: แจ้งส่งต่อทีม + เลขเคส/เวลาโทรกลับ + ทางเลี่ยงชั่วคราว (แก้ได้ในสาย = null)'],
  ['verify',   '7. ปิดสาย: ให้ลองใช้และถามว่าปกติหรือยัง'],
  ['more',     '7. ถามว่ามีอะไรให้ช่วยเพิ่มไหม'],
  ['thanks',   '7. ขอบคุณ + บอกช่องทางติดต่อ (เบอร์/LINE) + สวัสดี'],
  ['empathy',  'ลูกค้าโกรธ/ร้านขายไม่ได้: พูดแสดงความเข้าใจและเร่งดูให้ (ลูกค้าไม่ได้โกรธ = null)'],
];
const DONTS = {
  dont_know: 'พูดว่า "ไม่รู้" แทน "ขอเช็คแป๊บนึง"',
  promise:   'รับปากเวลาที่ไม่แน่ใจ',
  edit_data: 'แก้ยอด/ลบบิล โดยเจ้าของร้านไม่ยืนยัน',
  secret:    'บอก Password หรือข้อมูลหลังบ้าน',
};
const CATS = ['เครื่องพิมพ์', 'ยอดขาย/รายงาน', 'เมนู/ราคา', 'Login/สิทธิ์', 'ฮาร์ดแวร์', 'Grab/Delivery', 'อื่นๆ'];

function buildSchema(withTranscript) {
  const B = { type: 'boolean', nullable: true };
  const props = {
    ok: { type: 'boolean', description: 'false ถ้าเสียงไม่ชัด/ไม่มีบทสนทนา' },
    sum: { type: 'string', description: 'สรุปปัญหาและผล 1 ประโยค' },
    cat: { type: 'string', enum: CATS },
    res: { type: 'boolean', description: 'แก้ปัญหาจบในสาย' },
    fu: { type: 'boolean', description: 'ต้องติดตามต่อ' },
    senti: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    pol: { type: 'integer', description: 'ความสุภาพ 1-5' },
    clr: { type: 'integer', description: 'สื่อสารชัดเจน 1-5' },
    sol: { type: 'integer', description: 'แก้ปัญหาได้ดี 1-5' },
    ...Object.fromEntries(CHECKS.map(([k]) => [k, B])),
    bad: { type: 'array', items: { type: 'string', enum: Object.keys(DONTS) }, description: 'ข้อห้ามที่ทำ (ไม่มี = [])' },
    tip: { type: 'string', description: 'สิ่งที่ควรปรับ 1 ข้อ สั้นๆ (ไม่มี = "")' },
  };
  if (withTranscript) props.tx = { type: 'string', description: 'ถอดความ แยก พนักงาน:/ลูกค้า: พร้อม [mm:ss]' };
  return { type: 'object', properties: props, required: ['ok', 'sum', 'cat', 'res', 'senti', 'pol', 'clr', 'sol', 'bad'] };
}

function buildPrompt(row, withTranscript) {
  return `คุณคือ QA ทีม Support ระบบ POS ร้านอาหาร (Easy Restaurant) ฟังสายระหว่างพนักงาน (Ext ${row.Extension}) กับลูกค้า
สาย ${row.Direction === 'OUT' ? 'พนักงานโทรออก' : 'ลูกค้าโทรเข้า'} · ${row.DurationSec} วินาที
ตอบตาม schema โดยอิงสิ่งที่ได้ยินจริงเท่านั้น ห้ามเดา
เช็กลิสต์ตามสคริปต์ (true=ทำ, false=ไม่ทำ, null=ไม่เกี่ยวกับสายนี้):
${CHECKS.map(([k, d]) => `${k}: ${d}`).join('\n')}
${row.Direction === 'OUT' ? 'สายโทรออก: greet = แนะนำตัว+บริษัทเมื่อปลายสายรับ\n' : ''}ถ้าเป็นสายโทรกลับ/ติดตามเรื่องเดิมที่รู้ร้านและปัญหาอยู่แล้ว: shop, contact, can_sell, recap = null (ไม่ต้องถามซ้ำ)
bad = ข้อห้ามที่พนักงานทำ: ${Object.entries(DONTS).map(([k, d]) => `${k}=${d}`).join(' · ')}
pol/clr/sol ให้ 1-5 · ถ้าเสียงไม่ชัด/ไม่มีบทสนทนา ok=false${withTranscript ? '\ntx = ถอดความภาษาไทย' : ''}`;
}

// คะแนน: สคริปต์ 60% (ข้อที่เกี่ยว) + คุณภาพ 40% (pol/clr/sol) − ข้อห้าม 10 ต่อข้อ
function scoreOf(a) {
  if (!a || a.ok === false) return { score: null, script: null, quality: null };
  const app = CHECKS.map(([k]) => a[k]).filter(v => v === true || v === false);
  const script = app.length ? Math.round(app.filter(Boolean).length / app.length * 100) : null;
  const q = ['pol', 'clr', 'sol'].map(k => Math.min(5, Math.max(1, +a[k] || 0))).filter(Boolean);
  const quality = q.length ? Math.round((q.reduce((x, y) => x + y, 0) / q.length - 1) / 4 * 100) : null;
  const parts = [[script, 0.6], [quality, 0.4]].filter(([v]) => v != null);
  if (!parts.length) return { score: null, script, quality };
  const w = parts.reduce((x, [, k]) => x + k, 0);
  const base = parts.reduce((x, [v, k]) => x + v * k, 0) / w;
  const pen = (Array.isArray(a.bad) ? new Set(a.bad).size : 0) * 10;
  return { score: Math.max(0, Math.min(100, Math.round(base - pen))), script, quality };
}

const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, { timeout: 120000 }, (e, so, se) => e ? no(new Error((se || e.message).toString().slice(0, 300))) : ok(String(so))));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// แปลง + ตัดช่วงเงียบ (≥1.5 วินาที ที่เบากว่า -38dB) — ไฟล์ชั่วคราว ลบทิ้งหลังส่ง
async function toMp3(src, tmpDir) {
  const out = path.join(tmpDir, path.basename(src).replace(/\.[^.]+$/, '') + '.mp3');
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src,
    '-af', 'silenceremove=start_periods=1:start_threshold=-38dB:stop_periods=-1:stop_duration=1.5:stop_threshold=-38dB',
    '-ac', '1', '-ar', '16000', '-b:a', '24k', out]);
  let sec = null;
  try { sec = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out])) || null; } catch {}
  return { file: out, sec };
}

function createPbxAi({ req, sql, genAI, aiUsage = () => {}, aiCheckLimit = async () => {}, log = console }) {
  const FEATURE = 'pbx_call_qa';
  let ready = false;
  const state = { running: false, startedAt: null, date: null, total: 0, done: 0, failed: 0, skipped: 0, inTok: 0, outTok: 0, lastError: null, finishedAt: null };

  async function ensure() {
    if (ready) return;
    // ตารางของเราเอง (ไม่แก้ PBX_CallRecord): สถานะ/token ต่อสาย + สายที่ไม่ถูกสุ่ม
    await req().query(`IF OBJECT_ID('dbo.pbx_ai_log','U') IS NULL
      CREATE TABLE dbo.pbx_ai_log (
        record_id BIGINT NOT NULL PRIMARY KEY,
        status    VARCHAR(12) NOT NULL,          -- done | skipped | failed | no_audio | too_big
        attempts  INT NOT NULL DEFAULT 0,
        in_tok    INT NULL, out_tok INT NULL,
        audio_sec INT NULL,                      -- หลังตัดช่วงเงียบ
        model     NVARCHAR(60) NULL,
        err       NVARCHAR(300) NULL,
        updated_at DATETIME2 DEFAULT SYSDATETIME())`);
    ready = true;
  }
  const setLog = (id, f) => req().input('id', sql.BigInt, id).input('st', sql.VarChar, f.status)
    .input('a', sql.Int, f.attempts || 0).input('i', sql.Int, f.inTok ?? null).input('o', sql.Int, f.outTok ?? null)
    .input('s', sql.Int, f.audioSec ?? null).input('m', sql.NVarChar, f.model || null).input('e', sql.NVarChar, f.err ? String(f.err).slice(0, 300) : null)
    .query(`MERGE dbo.pbx_ai_log AS t USING (SELECT @id AS record_id) s ON t.record_id = s.record_id
      WHEN MATCHED THEN UPDATE SET status=@st, attempts=t.attempts+@a, in_tok=ISNULL(@i,t.in_tok), out_tok=ISNULL(@o,t.out_tok),
        audio_sec=ISNULL(@s,t.audio_sec), model=ISNULL(@m,t.model), err=@e, updated_at=SYSDATETIME()
      WHEN NOT MATCHED THEN INSERT (record_id, status, attempts, in_tok, out_tok, audio_sec, model, err)
        VALUES (@id, @st, @a, @i, @o, @s, @m, @e);`);

  // สุ่มตรวจ: เลือกกระจายทั้งวัน ต่อเบอร์ไม่เกิน perExt (สายที่วิเคราะห์ไปแล้วนับรวมโควตา)
  async function pick(date, { all = false, limit = 0 } = {}) {
    const c = CFG();
    const rows = (await req().input('d', sql.Date, new Date(date + 'T00:00:00Z')).input('min', sql.Int, c.minSec).input('mx', sql.Int, c.maxTotalAttempts).query(`
      SELECT r.Id, r.Extension, RTRIM(r.Direction) AS Direction, r.DurationSec, r.LocalPath, r.CallDateTime,
             CASE WHEN r.AnalyzedAt IS NOT NULL THEN 1 ELSE 0 END AS analyzed, l.status AS lst, ISNULL(l.attempts, 0) AS attempts
      FROM dbo.PBX_CallRecord r LEFT JOIN dbo.pbx_ai_log l ON l.record_id = r.Id
      WHERE r.Extension IS NOT NULL AND r.DurationSec >= @min AND r.LocalPath IS NOT NULL
        AND r.CallDateTime >= @d AND r.CallDateTime < DATEADD(day, 1, @d)
      ORDER BY r.CallDateTime`)).recordset;
    const todo = [], skip = [];
    const byExt = new Map();
    for (const r of rows) (byExt.get(r.Extension) || byExt.set(r.Extension, []).get(r.Extension)).push(r);
    for (const list of byExt.values()) {
      const doneN = list.filter(r => r.analyzed).length;
      const open = list.filter(r => !r.analyzed && !['no_audio', 'too_big'].includes(r.lst) && r.attempts < c.maxTotalAttempts
        && (all || r.lst !== 'skipped'));
      const quota = all || !c.perExt ? open.length : Math.max(0, c.perExt - doneN);
      // เลือกกระจายเท่าๆ กันตามเวลาในวัน
      const chosen = new Set();
      if (quota >= open.length) open.forEach(r => chosen.add(r));
      else for (let i = 0; i < quota; i++) chosen.add(open[Math.floor((i + 0.5) * open.length / quota)]);
      for (const r of open) (chosen.has(r) ? todo : skip).push(r);
    }
    todo.sort((a, b) => a.CallDateTime - b.CallDateTime);
    return { todo: limit ? todo.slice(0, limit) : todo, skip: limit ? [] : skip };
  }

  async function callGemini(row, mp3, c) {
    const buf = fs.readFileSync(mp3);
    if (buf.length > c.inlineMax) { const e = new Error('ไฟล์ใหญ่เกิน 15MB'); e.tooBig = true; throw e; }
    const model = genAI.getGenerativeModel({ model: c.model, generationConfig: {
      temperature: 0.2, maxOutputTokens: c.transcript ? 8192 : 700,
      responseMimeType: 'application/json', responseSchema: buildSchema(c.transcript),
      thinkingConfig: { thinkingBudget: 0 },
    } });
    const parts = [{ inlineData: { mimeType: 'audio/mp3', data: buf.toString('base64') } }, { text: buildPrompt(row, c.transcript) }];
    let res;
    try { res = await model.generateContent(parts); }
    catch (e) {
      if (!/thinking|400/i.test(String(e?.message))) throw e;
      // รุ่นที่ไม่รับ thinkingConfig → ส่งใหม่แบบไม่มี
      const m2 = genAI.getGenerativeModel({ model: c.model, generationConfig: {
        temperature: 0.2, maxOutputTokens: c.transcript ? 8192 : 700, responseMimeType: 'application/json', responseSchema: buildSchema(c.transcript) } });
      res = await m2.generateContent(parts);
    }
    const u = res.response?.usageMetadata || {};
    const inTok = u.promptTokenCount || 0, outTok = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
    aiUsage(FEATURE, 'gemini', c.model, inTok, outTok, u.thoughtsTokenCount || 0);
    let a;
    try { a = JSON.parse(res.response.text()); } catch { const e = new Error('AI ตอบไม่เป็น JSON'); e.inTok = inTok; e.outTok = outTok; throw e; }
    return { a, inTok, outTok };
  }

  async function analyzeOne(row, tmpDir) {
    const c = CFG();
    if (!fs.existsSync(row.LocalPath)) { await setLog(row.Id, { status: 'no_audio', err: 'ไม่พบไฟล์เสียง' }); state.skipped++; return; }
    let conv;
    try { conv = await toMp3(row.LocalPath, tmpDir); }
    catch (e) { await setLog(row.Id, { status: 'no_audio', attempts: 1, err: 'ffmpeg: ' + e.message }); state.failed++; return; }
    try {
      let lastErr;
      for (let i = 0; i < c.maxAttempts; i++) {
        try {
          await aiCheckLimit(FEATURE);
          const { a, inTok, outTok } = await callGemini(row, conv.file, c);
          const s = scoreOf(a);
          const json = { ...a, script_pct: s.script, quality_pct: s.quality, model: c.model, audio_sec: conv.sec ? Math.round(conv.sec) : null };
          const sent = { positive: 'positive', neutral: 'neutral', negative: 'negative' }[a.senti] || null;
          await req().input('id', sql.BigInt, row.Id)
            .input('tx', sql.NVarChar, a.tx || null).input('j', sql.NVarChar, JSON.stringify(json))
            .input('sc', sql.Int, s.score).input('rs', sql.Bit, a.ok === false ? null : (a.res ? 1 : 0))
            .input('se', sql.VarChar, sent).input('ca', sql.NVarChar, a.cat || null)
            .query(`UPDATE dbo.PBX_CallRecord SET Transcript=@tx, AnalysisJson=@j, Score=@sc, Resolved=@rs, Sentiment=@se,
                    Category=@ca, AnalyzedAt=SYSDATETIME() WHERE Id=@id AND AnalyzedAt IS NULL`);
          await setLog(row.Id, { status: 'done', attempts: i + 1, inTok, outTok, audioSec: conv.sec ? Math.round(conv.sec) : null, model: c.model });
          state.done++; state.inTok += inTok; state.outTok += outTok;
          return;
        } catch (e) {
          lastErr = e;
          if (e.tooBig) { await setLog(row.Id, { status: 'too_big', attempts: 1, err: e.message }); state.skipped++; return; }
          if (/ครบเพดาน/.test(String(e.message))) throw e;   // ครบเพดาน token วันนี้ → หยุดทั้งรอบ
          const retry = /429|500|502|503|504|ECONN|ETIMEDOUT|fetch failed|overloaded|JSON/i.test(String(e?.message));
          if (!retry || i === c.maxAttempts - 1) break;
          await sleep([3000, 12000, 40000][i] * (/429/.test(String(e.message)) ? 2 : 1));
        }
      }
      await setLog(row.Id, { status: 'failed', attempts: c.maxAttempts, err: lastErr?.message });
      state.failed++; state.lastError = lastErr?.message || null;
      log.warn(`pbx-ai: #${row.Id} ไม่สำเร็จ →`, lastErr?.message);
    } finally { try { fs.unlinkSync(conv.file); } catch {} }
  }

  async function run({ date, all = false, limit = 0 } = {}) {
    if (state.running) throw new Error('กำลังวิเคราะห์อยู่ — รอรอบนี้จบก่อน');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('วันที่ไม่ถูกต้อง');
    await ensure();
    Object.assign(state, { running: true, startedAt: new Date(), date, total: 0, done: 0, failed: 0, skipped: 0, inTok: 0, outTok: 0, lastError: null, finishedAt: null });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbx-ai-'));
    try {
      const { todo, skip } = await pick(date, { all, limit });
      for (const r of skip) await setLog(r.Id, { status: 'skipped' });
      state.total = todo.length;
      log.log(`📞 pbx-ai ${date}: วิเคราะห์ ${todo.length} สาย (สุ่มข้าม ${skip.length})`);
      const c = CFG();
      let i = 0, stop = null;
      await Promise.all(Array.from({ length: c.concurrency }, async () => {
        while (!stop && i < todo.length) {
          const r = todo[i++];
          try { await analyzeOne(r, tmpDir); } catch (e) { stop = e; }
        }
      }));
      if (stop) { state.lastError = stop.message; log.warn('pbx-ai: หยุดรอบนี้ →', stop.message); }
      log.log(`📞 pbx-ai ${date}: เสร็จ ${state.done} · ล้มเหลว ${state.failed} · ข้าม ${state.skipped} · token ${state.inTok.toLocaleString()} in + ${state.outTok.toLocaleString()} out`);
      return { ...state };
    } finally {
      state.running = false; state.finishedAt = new Date();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  return { run, ensure, status: () => ({ ...state }), FEATURE };
}

module.exports = { createPbxAi, scoreOf, CHECKS, DONTS, buildPrompt, buildSchema };

// ── รันมือ: node pbx-ai.js --date YYYY-MM-DD [--limit N] [--all] ──
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const sql = require('mssql');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
  (async () => {
    const e = process.env;
    const pool = await sql.connect({ server: e.DB_SERVER || 'localhost', database: e.DB_NAME || 'cs_team', user: e.DB_USER, password: e.DB_PASSWORD,
      port: +(e.DB_PORT || 1433), options: { encrypt: e.DB_ENCRYPT === 'true', trustServerCertificate: e.DB_TRUST_CERT !== 'false' } });
    const genAI = new GoogleGenerativeAI(e.GEMINI_API_KEY || '', { apiVersion: 'v1beta' });
    const ai = createPbxAi({ req: () => pool.request(), sql, genAI,
      aiUsage: (f, p, m, i, o) => console.log(`🪙 ${f}: ${i} in + ${o} out (${m})`) });
    const out = await ai.run({ date: arg('date'), limit: parseInt(arg('limit')) || 0, all: process.argv.includes('--all') });
    console.log(JSON.stringify(out));
    process.exit(0);
  })().catch(err => { console.error(err.message); process.exit(1); });
}
