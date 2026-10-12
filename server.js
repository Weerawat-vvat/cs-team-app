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
const { init, getPool, getExtPool, getInfoPool, getLineBotPool, sql } = require('./database');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const app        = express();
const PORT       = process.env.PORT || 3010;
const AI_MODEL   = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const JWT_SECRET = process.env.JWT_SECRET || 'cs-team-jwt-secret-change-in-prod';
const genAI      = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '', { apiVersion: 'v1' });
// Groq (OpenAI-compatible REST) — fallback provider, see aiGenerate() below
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL   = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';

// ══════════════════════════════════════════════════════════
//  AI PROVIDERS — Gemini เป็นตัวหลัก, Groq เป็นตัวสำรอง (AI_PREFER=groq สลับกลับได้)
//  ทุกฟีเจอร์ที่แค่ "ส่ง prompt เข้า → เอาข้อความออก" ให้เรียกผ่าน aiGenerate()
//  เจ้าใดเจ้าหนึ่งล่มจะได้ไม่ทำให้ฟีเจอร์ตายทั้งตัว
//  (ยกเว้น /api/ai/chat ที่ใช้ Gemini function-calling โดยเฉพาะ)
// ══════════════════════════════════════════════════════════
const aiErrText = (e) => {
  const d = e?.response?.data;
  if (d && typeof d === 'object' && typeof d.pipe !== 'function') return d.error?.message || e.message;
  if (e?.response?.status) return `HTTP ${e.response.status}`;
  return e?.message || String(e);
};

// ดึง JSON array ออกจากคำตอบ AI — ตัด code fence และข้อความเกินได้ในตัว
function parseJsonArrayReply(text) {
  const t = String(text || '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a === -1 || b <= a) {
    // บางรุ่นห่อมาเป็น {"items":[...]} หรือส่งมา object เดียว
    const o = t.indexOf('{'), c = t.lastIndexOf('}');
    if (o !== -1 && c > o) {
      const v = JSON.parse(t.slice(o, c + 1));
      const arr = Object.values(v).find(Array.isArray);
      if (arr) return arr;
      if (v && typeof v === 'object') return [v];
    }
    throw new Error(t ? 'AI ไม่ได้ตอบกลับเป็น JSON array' : 'AI ตอบกลับว่างเปล่า');
  }
  return JSON.parse(t.slice(a, b + 1));
}

// Groq chat-completions (OpenAI-compatible) — axios ล้วน ไม่ต้องลง package เพิ่ม
async function groqGenerate(prompt) {
  const r = await axios.post(GROQ_URL, {
    model: GROQ_MODEL,
    temperature: 0,
    // gpt-oss เป็นรุ่นที่คิดก่อนตอบ — คิดน้อยลง = ประหยัด token และไม่หมดโควตาก่อนได้คำตอบ
    ...(/gpt-oss/i.test(GROQ_MODEL) ? { reasoning_effort: 'low' } : {}),
    messages: [{ role: 'user', content: prompt }],
  }, {
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 60000,
  });
  const u = r.data?.usage || {};
  return { text: r.data?.choices?.[0]?.message?.content || '', inTok: u.prompt_tokens || 0, outTok: u.completion_tokens || 0 };
}

// ── นับ token ต่อฟีเจอร์ ──────────────────────────────────
// log ทุก call (🪙) + รวมยอดต่อวัน/ฟีเจอร์ลงตาราง ai_token_usage (เขียนรวดเดียวทุก 1 นาที)
// ดูสรุป: GET /api/ai/usage?days=7 · ปิด log รายครั้งได้ด้วย AI_USAGE_LOG=off (ยังนับลงตารางเหมือนเดิม)
const AI_USAGE_LOG = (process.env.AI_USAGE_LOG || 'on').toLowerCase() !== 'off';
const _aiUsageBuf = new Map();   // `${day}|${feature}|${provider}|${model}` → { calls, inTok, outTok }
function aiUsage(feature, provider, model, inTok, outTok) {
  inTok = +inTok || 0; outTok = +outTok || 0;
  const key = `${bangkokToday()}|${feature || 'other'}|${provider}|${model}`;
  const b = _aiUsageBuf.get(key) || { calls: 0, inTok: 0, outTok: 0 };
  b.calls++; b.inTok += inTok; b.outTok += outTok;
  _aiUsageBuf.set(key, b);
  if (AI_USAGE_LOG) console.log(`🪙 AI ${feature || 'other'}: ${inTok.toLocaleString()} in + ${outTok.toLocaleString()} out = ${(inTok + outTok).toLocaleString()} token (${provider} ${model})`);
}
const geminiUsage = (feature, model, result) => {
  const m = result?.response?.usageMetadata || {};
  aiUsage(feature, 'gemini', model, m.promptTokenCount, (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0));
};
let _aiUsageTable = false;
async function ensureAiUsageTable() {
    if (!_aiUsageTable) {
      await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_token_usage' AND xtype='U')
        CREATE TABLE ai_token_usage (
          day DATE NOT NULL, feature NVARCHAR(50) NOT NULL, provider NVARCHAR(20) NOT NULL, model NVARCHAR(100) NOT NULL,
          calls INT NOT NULL DEFAULT 0, in_tokens BIGINT NOT NULL DEFAULT 0, out_tokens BIGINT NOT NULL DEFAULT 0,
          updated_at DATETIME DEFAULT GETDATE(),
          CONSTRAINT pk_ai_token_usage PRIMARY KEY (day, feature, provider, model))`);
      _aiUsageTable = true;
    }
}
async function flushAiUsage() {
  if (!_aiUsageBuf.size) return;
  const rows = [..._aiUsageBuf]; _aiUsageBuf.clear();
  try {
    await ensureAiUsageTable();
    for (const [key, b] of rows) {
      const [day, feature, provider, model] = key.split('|');
      await req().input('d', sql.Date, new Date(day + 'T00:00:00Z')).input('f', sql.NVarChar, feature)
        .input('p', sql.NVarChar, provider).input('m', sql.NVarChar, model)
        .input('c', sql.Int, b.calls).input('i', sql.BigInt, b.inTok).input('o', sql.BigInt, b.outTok).query(`
        UPDATE ai_token_usage SET calls=calls+@c, in_tokens=in_tokens+@i, out_tokens=out_tokens+@o, updated_at=GETDATE()
          WHERE day=@d AND feature=@f AND provider=@p AND model=@m;
        IF @@ROWCOUNT = 0 INSERT INTO ai_token_usage (day, feature, provider, model, calls, in_tokens, out_tokens)
          VALUES (@d, @f, @p, @m, @c, @i, @o)`);
    }
  } catch (e) {
    console.error('ai usage flush failed:', e.message);
    for (const [key, b] of rows) {   // คืนเข้าบัฟเฟอร์ ลองใหม่รอบหน้า
      const a = _aiUsageBuf.get(key) || { calls: 0, inTok: 0, outTok: 0 };
      _aiUsageBuf.set(key, { calls: a.calls + b.calls, inTok: a.inTok + b.inTok, outTok: a.outTok + b.outTok });
    }
  }
}
setInterval(flushAiUsage, 60 * 1000);

// prompt → ข้อความ. parse ใช้แปลง/ตรวจคำตอบ (โยน error = ให้ไปลองอีกเจ้า)
// geminiConfig คือ responseSchema ฝั่ง Gemini เท่านั้น — Groq อาศัย prompt + parse เอา
// prefer เลือกว่าจะให้เจ้าไหนเป็นตัวหลัก อีกเจ้าเป็นตัวสำรองอัตโนมัติ
// ค่าเริ่มต้น = Gemini (ตั้ง AI_PREFER=groq ใน .env เพื่อสลับ)
const AI_PREFER = (process.env.AI_PREFER || 'gemini').toLowerCase() === 'groq' ? 'groq' : 'gemini';
async function aiGenerate(prompt, { parse = (t) => t, geminiConfig = null, prefer = AI_PREFER, feature = 'other' } = {}) {
  // นับ token ก่อน parse — คำตอบที่ parse ไม่ผ่านก็เสีย token ไปแล้ว
  const callGroq = async () => {
    const g = await groqGenerate(prompt);
    aiUsage(feature, 'groq', GROQ_MODEL, g.inTok, g.outTok);
    return { value: parse(g.text), usedModel: GROQ_MODEL };
  };
  const callGemini = async () => {
    const model  = genAI.getGenerativeModel({ model: AI_MODEL, ...(geminiConfig || {}) });
    const result = await model.generateContent(prompt);
    geminiUsage(feature, AI_MODEL, result);
    return { value: parse(result.response.text()), usedModel: AI_MODEL };
  };
  const groq   = { name: 'Groq',   hasKey: () => !!GROQ_API_KEY,               call: callGroq };
  const gemini = { name: 'Gemini', hasKey: () => !!process.env.GEMINI_API_KEY, call: callGemini };
  const order = prefer === 'gemini' ? [gemini, groq] : [groq, gemini];

  const errs = [];
  for (const p of order) {
    if (!p.hasKey()) { errs.push(`${p.name}: ยังไม่ได้ตั้ง API key`); continue; }
    try {
      const out = await p.call();
      if (errs.length) console.log(`AI: fallback ไป ${p.name} สำเร็จ →`, out.usedModel);
      return out;
    } catch (e) {
      errs.push(`${p.name}: ${aiErrText(e)}`);
      console.warn(`AI: ${p.name} ไม่สำเร็จ →`, aiErrText(e));
    }
  }
  throw new Error('AI ไม่สำเร็จ — ' + errs.join(' | '));
}

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
// Images, documents and the log/data files Support hands to customers.
// Deliberately no .html/.htm/.svg — /uploads is public and serves those inline.
const FU_ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf',
  '.txt', '.log', '.csv', '.json', '.xml', '.zip',
  '.xls', '.xlsx', '.doc', '.docx',
]);
const fuFileFilter = (req, file, cb) =>
  cb(null, FU_ALLOWED_EXT.has(path.extname(file.originalname).toLowerCase()));

const fuUpload = multer({
  storage: fuStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file — logs run large
  fileFilter: fuFileFilter,
});
// Same storage folder as fuUpload, smaller cap — customer-submitted via public board link
const fuPublicUpload = multer({
  storage: fuStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB per file
  fileFilter: fuFileFilter,
});

// ── Case (Calllog) attachment upload config ──────────────
const caseStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, 'cases', String(req.params.id || 'tmp'));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9ก-๙_-]/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});
const caseUpload = multer({
  storage: caseStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB per file — keep case attachments small so uploads/ doesn't balloon
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

// ── Monitor Tag script attachments (served only via authenticated API) ──
const MT_SCRIPT_EXT = new Set([
  '.sql', '.txt', '.log', '.ps1', '.bat', '.cmd', '.sh', '.py', '.js', '.json', '.xml', '.yaml', '.yml',
  '.ini', '.conf', '.cfg', '.reg', '.zip', '.csv', '.md',
]);
const mtUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, 'monitor', String(parseInt(req.params.id) || 'tmp'));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext  = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
      cb(null, `${Date.now()}_${base}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, MT_SCRIPT_EXT.has(path.extname(file.originalname).toLowerCase())),
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

// ── UAT attachment upload config ─────────────────────────
// Two scopes so job #1 and issue #1 never share a folder:
//   uploads/uat/job/<jobId>  |  uploads/uat/issue/<issueId>
function makeUatUpload(scope) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(UPLOAD_DIR, 'uat', scope, String(req.params.id || 'tmp'));
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const name = fixUploadName(file.originalname);
        const ext  = path.extname(name).toLowerCase();
        const base = path.basename(name, ext).replace(/[^a-zA-Z0-9ก-๙._-]/g, '_').slice(0, 60);
        cb(null, `${Date.now()}_${base}${ext}`);
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      cb(null, /\.(jpg|jpeg|png|gif|webp|pdf|doc|docx|xls|xlsx|txt|log)$/i.test(fixUploadName(file.originalname)));
    }
  });
}
const uatJobUpload   = makeUatUpload('job');
const uatIssueUpload = makeUatUpload('issue');

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

    -- Multi-bot support: several LINE OA tokens, each target picks which bot sends it
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='line_bots')
      CREATE TABLE line_bots (
        id INT PRIMARY KEY IDENTITY,
        name NVARCHAR(100) NOT NULL,
        channel_token NVARCHAR(500) NULL,
        active BIT DEFAULT 1,
        created_at DATETIME DEFAULT GETDATE()
      );
    -- Seed a default bot from the existing single token so nothing breaks
    IF NOT EXISTS (SELECT 1 FROM line_bots)
      INSERT INTO line_bots (name, channel_token)
      SELECT N'บอทหลัก', channel_token FROM line_settings WHERE id=1;
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('line_notify_targets') AND name='bot_id')
      ALTER TABLE line_notify_targets ADD bot_id INT NULL;

    -- Pod ที่กลุ่มนี้รับแจ้งเตือน Ticket ค้าง (triage_alert) — เก็บเป็น "1,2,5"
    -- ว่าง/NULL = รับสรุปรวมทุก Pod (พฤติกรรมเดิม)
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('line_notify_targets') AND name='pod_ids')
      ALTER TABLE line_notify_targets ADD pod_ids NVARCHAR(500) NULL;

    -- ส่งเฉพาะที่รอเกินกี่นาที (NULL/0 = ทุกระดับ) — ใช้กับ triage_alert
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('line_notify_targets') AND name='min_wait_min')
      ALTER TABLE line_notify_targets ADD min_wait_min INT NULL;

    -- ปลายทางที่กลุ่ม LINE นี้ส่งแจ้งเตือนไปหา — เก็บเป็น "1,2,5" (id ของ line_notify_targets)
    -- ตั้งค่าที่แท็บ "จัดกลุ่มไลน์เข้า Pod"; ว่าง/NULL = ไม่ส่งผ่าน event triage_alert_groups
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('line_group_pods') AND name='notify_target_ids')
      ALTER TABLE line_group_pods ADD notify_target_ids NVARCHAR(500) NULL;
  `);
  // ย้ายค่าจาก pod_id (เวอร์ชันเลือกได้ Pod เดียว) มาเป็น pod_ids
  try {
    await getPool().request().query(`
      IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('line_notify_targets') AND name='pod_id')
        UPDATE line_notify_targets SET pod_ids = CAST(pod_id AS NVARCHAR(20))
        WHERE pod_id IS NOT NULL AND (pod_ids IS NULL OR pod_ids = '')`);
  } catch(e) { console.warn('pod_id → pod_ids migration skipped:', e.message); }
}

// ── LINE token helpers (multi-bot) ────────────────────────
// Legacy single token (line_settings) — used as fallback when a target has no bot
async function getLineDefaultToken() {
  try {
    const row = (await getPool().request().query(`SELECT channel_token FROM line_settings WHERE id=1`)).recordset[0];
    return row?.channel_token || process.env.LINE_CHANNEL_TOKEN || null;
  } catch { return process.env.LINE_CHANNEL_TOKEN || null; }
}
// Map of bot_id → channel_token (active bots)
async function getLineBotsMap() {
  try {
    const rows = (await getPool().request().query(`SELECT id, channel_token FROM line_bots WHERE active=1`)).recordset;
    const m = {}; for (const r of rows) m[r.id] = r.channel_token; return m;
  } catch { return {}; }
}
// Resolve the token a given target sends with (its bot, else default)
async function resolveTargetToken(target) {
  if (target?.bot_id) {
    try {
      const b = (await getPool().request().input('id', sql.Int, target.bot_id)
        .query(`SELECT channel_token FROM line_bots WHERE id=@id`)).recordset[0];
      if (b?.channel_token) return b.channel_token;
    } catch { /* fall through to default */ }
  }
  return getLineDefaultToken();
}

// ── Notification helpers ──────────────────────────────────
// opts: { serveType?: string }  — used to filter targets by serve_types when event=service_request
// `message` can be a string, or a function (target) => string|null when each target
// needs its own text (e.g. Ticket-ค้าง alerts scoped to the target's Pod).
// Returning null/'' from that function skips the target.
async function sendLineNotify(message, eventType = null, opts = {}) {
  try {
    const botsMap = await getLineBotsMap();
    const defaultToken = await getLineDefaultToken();

    // Read active targets
    let targets = [];
    try {
      targets = (await getPool().request()
        .query(`SELECT id, name, group_id, events, serve_types, project_ids, bot_id, pod_ids, min_wait_min
                FROM line_notify_targets WHERE active=1`)).recordset;
    } catch {
      // Fallback to legacy single group if table not ready
      const groupId = process.env.LINE_GROUP_ID;
      if (groupId) targets = [{ name: 'default', group_id: groupId, events: null, serve_types: null, project_ids: null, bot_id: null, pod_ids: null, min_wait_min: null }];
    }
    let sent = 0;

    for (const target of targets) {
      // เหตุการณ์แบบ opt-in: กลุ่มที่ตั้ง "รับทุกเหตุการณ์" (events ว่าง) จะไม่ได้รับ ต้องติ๊กเลือกเอง
      if (eventType && opts.optIn && !String(target.events || '').trim()) continue;
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
      // Per-target text (Pod-scoped alerts); null/'' means "nothing for this target"
      let text;
      try {
        text = typeof message === 'function' ? await message(target) : message;
      } catch(e) { console.error(`LINE: message builder failed (target: ${target.name}):`, e.message); continue; }
      if (!text || !String(text).trim()) continue;

      const token = (target.bot_id && botsMap[target.bot_id]) || defaultToken;
      if (!token) { console.error(`LINE: no token for target ${target.name} (bot_id=${target.bot_id})`); continue; }
      try {
        await axios.post('https://api.line.me/v2/bot/message/push',
          { to: target.group_id, messages: [{ type: 'text', text: String(text).trim() }] },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        sent++;
      } catch(e) { console.error(`LINE Messaging API error (target: ${target.name}):`, e.response?.data || e.message); }
    }
    return sent;
  } catch(e) { console.error('sendLineNotify error:', e.message); return 0; }
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
app.use(express.json({ limit: '12mb' })); // 12mb to allow base64 image attachments in AI chat
// Serve HTML files without caching so clients always get the latest version
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// Serve uploaded files
// ไฟล์ script ของ Monitor Tag ห้ามเปิดผ่าน /uploads สาธารณะ — โหลดได้ทาง API ที่ต้อง login เท่านั้น
app.use('/uploads/monitor', (req, res) => res.status(404).end());
// - PDF/HTML: inline (browser opens them natively)
// - Office files: force download (avoid redirect to Office Online)
app.use('/uploads', (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (['.xlsx', '.xls', '.csv', '.doc', '.docx', '.zip', '.xml'].includes(ext)) {
    const filename = path.basename(req.path);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/octet-stream');
  } else if (ext === '.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
  } else if (['.txt', '.log'].includes(ext)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline');
  } else if (['.html', '.htm'].includes(ext)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline');
  }
  next();
}, express.static(UPLOAD_DIR));

const req        = () => getPool().request();
const extReq     = () => getExtPool().request();
const lineBotReq = () => getLineBotPool().request();

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

// Designated leave-request approvers — Pon (employee #2), Boek (employee #17), Nart (employee #14)
const LEAVE_APPROVER_EMPLOYEE_IDS = [2, 17, 14];
function leaveApproverRequired(request, res, next) {
  if (!LEAVE_APPROVER_EMPLOYEE_IDS.includes(request.user?.employee_id)) {
    return res.status(403).json({ error: 'เฉพาะผู้มีสิทธิ์อนุมัติวันลาเท่านั้น' });
  }
  next();
}

async function getScopedUsernames(user) {
  if (!user) return null;
  if (['manager', 'admin', 'staff'].includes(user.role)) return undefined; // no restriction
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
    s.TimeToResolve             AS time_to_resolve,
    cl.RegistrationId           AS registration_id,
    CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cr.GroupId END     AS group_id,
    CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cgm.GroupName END  AS group_name
  FROM Calllog cl
  INNER JOIN CustomerRegistration cr ON cr.RegistrationId  = cl.RegistrationId
  LEFT  JOIN CustomerGroup        cgm ON cgm.GroupId       = cr.GroupId
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
    if (role === 'team_lead') {
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
    if (role === 'team_lead') {
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
    if (role === 'team_lead') {
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
    if (role === 'team_lead') {
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

app.put('/api/leave-requests/:id/approve', authRequired, leaveApproverRequired, async (request, res) => {
  try {
    const lr = (await req().input('id', sql.Int, request.params.id)
      .query('SELECT * FROM leave_requests WHERE id=@id')).recordset[0];
    if (!lr) return res.status(404).json({ error: 'not found' });
    await req().input('by', sql.Int, request.user.employee_id).input('id', sql.Int, request.params.id)
      .query("UPDATE leave_requests SET status='approved',approved_by=@by WHERE id=@id");
    await req().input('eid', sql.Int, lr.employee_id).input('date', sql.Date, lr.leave_date)
      .query("UPDATE shifts SET status='approved_leave' WHERE employee_id=@eid AND shift_date=@date");
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leave-requests/:id/reject', authRequired, leaveApproverRequired, async (request, res) => {
  try {
    await req().input('by', sql.Int, request.user.employee_id).input('id', sql.Int, request.params.id)
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

// ── Case attachments (stored locally, keyed by CalllogId) ──
app.get('/api/cases/:id/attachments', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('id', sql.Int, parseInt(request.params.id))
      .query(`SELECT a.*, e.name AS uploaded_by_name FROM case_attachments a
              LEFT JOIN app_users au ON au.id=a.uploaded_by
              LEFT JOIN employees e ON e.id=au.employee_id
              WHERE a.calllog_id=@id ORDER BY a.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cases/:id/attachments', authRequired, caseUpload.array('files', 10), async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const files = request.files || [];
    if (!files.length) return res.status(400).json({ error: 'ไม่พบไฟล์' });
    const inserted = [];
    for (const f of files) {
      const r = await req()
        .input('cid', sql.Int, id)
        .input('fn',  sql.NVarChar, f.filename)
        .input('on',  sql.NVarChar, f.originalname)
        .input('fs',  sql.Int, f.size)
        .input('mt',  sql.NVarChar, f.mimetype)
        .input('ub',  sql.Int, request.user.id)
        .query(`INSERT INTO case_attachments(calllog_id,filename,original_name,file_size,mime_type,uploaded_by)
                OUTPUT INSERTED.id VALUES(@cid,@fn,@on,@fs,@mt,@ub)`);
      inserted.push({ id: r.recordset[0].id, filename: f.filename, original_name: f.originalname, file_size: f.size, mime_type: f.mimetype });
    }
    res.json({ ok: true, files: inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cases/attachments/:id', authRequired, async (request, res) => {
  try {
    const row = (await req().input('id', sql.Int, parseInt(request.params.id))
      .query(`SELECT * FROM case_attachments WHERE id=@id`)).recordset[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    const filePath = path.join(UPLOAD_DIR, 'cases', String(row.calllog_id), row.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await req().input('id', sql.Int, parseInt(request.params.id)).query(`DELETE FROM case_attachments WHERE id=@id`);
    res.json({ ok: true });
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
      SELECT e.id, au.ext_username, ISNULL(e.nickname, e.name) AS display_name, e.team
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const names = {}, teams = {}, byId = {};
    rows.forEach(r => {
      names[r.ext_username] = r.display_name;
      teams[r.ext_username] = r.team || '';
      byId[r.id] = { name: r.display_name, team: r.team || '', ext_username: r.ext_username };
    });
    res.json({ names, teams, byId });
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
    const rangeMs   = endDate - startDate;
    const prevEnd   = new Date(startDate);
    const prevStart = new Date(startDate.getTime() - rangeMs);

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

    // Previous period stats for trend comparison
    const prevAgents = (await req()
      .input('ps', sql.DateTime, prevStart)
      .input('pe', sql.DateTime, prevEnd)
      .query(`
        SELECT
          COALESCE(sl.assigned_to_user, au.employee_id) AS emp_id,
          COUNT(sl.id) AS prev_total,
          SUM(CASE WHEN sl.status IN ('resolved','assigned_to_programmer') THEN 1 ELSE 0 END) AS prev_resolved,
          AVG(CASE WHEN sl.resolved_at IS NOT NULL AND sl.assigned_at IS NOT NULL
                        AND sl.resolved_at >= sl.assigned_at
                   THEN DATEDIFF(minute, sl.assigned_at, sl.resolved_at) END) AS prev_avg_min
        FROM specialist_log sl
        LEFT JOIN app_users au ON au.id = sl.accepted_by
        WHERE sl.assigned_at >= @ps AND sl.assigned_at < @pe
          AND COALESCE(sl.assigned_to_user, au.employee_id) IS NOT NULL
        GROUP BY COALESCE(sl.assigned_to_user, au.employee_id)
      `)).recordset;
    const prevMap = {};
    prevAgents.forEach(r => { prevMap[r.emp_id] = r; });
    agents.forEach(a => {
      const p = prevMap[a.emp_id] || {};
      a.prev_total    = p.prev_total    || 0;
      a.prev_resolved = p.prev_resolved || 0;
      a.prev_avg_min  = p.prev_avg_min  ?? null;
    });

    // Grade score per specialist: query subject_id จาก app DB แล้ว join grade จาก ext DB
    try {
      if (getExtPool()) {
        // step 1: ดึง (emp_id, subject_id) pairs จาก app DB
        const spSubj = (await req()
          .input('s', sql.DateTime, startDate)
          .input('e', sql.DateTime, endDate)
          .query(`
            SELECT COALESCE(sl.assigned_to_user, au.employee_id) AS emp_id, sl.subject_id
            FROM specialist_log sl
            LEFT JOIN app_users au ON au.id = sl.accepted_by
            WHERE sl.assigned_at >= @s AND sl.assigned_at < @e
              AND sl.subject_id IS NOT NULL
              AND COALESCE(sl.assigned_to_user, au.employee_id) IS NOT NULL
          `)).recordset;

        if (spSubj.length) {
          // step 2: ดึง grade จาก ext DB ตาม SubjectId list
          const uniqueIds = [...new Set(spSubj.map(r => r.subject_id))];
          const inList = uniqueIds.map((_, i) => `@sid${i}`).join(',');
          const qr = extReq();
          uniqueIds.forEach((id, i) => qr.input(`sid${i}`, sql.Int, id));
          const subjects = (await qr.query(
            `SELECT SubjectId, Grade FROM Subject WHERE SubjectId IN (${inList})`
          )).recordset;
          const gradeBySubjId = {};
          subjects.forEach(s => { gradeBySubjId[s.SubjectId] = s.Grade; });

          // step 3: aggregate per emp_id
          const gradeAgg = {};
          spSubj.forEach(r => {
            const grade = gradeBySubjId[r.subject_id];
            if (!grade) return;
            const pts = {A:4,B:3,C:2,D:1}[grade] || 0;
            if (!pts) return;
            if (!gradeAgg[r.emp_id]) gradeAgg[r.emp_id] = { sum: 0, cnt: 0 };
            gradeAgg[r.emp_id].sum += pts;
            gradeAgg[r.emp_id].cnt++;
          });
          agents.forEach(a => {
            const g = gradeAgg[a.emp_id];
            a.grade_total_score = g ? g.sum : null;
            a.grade_avg_score   = g ? g.sum / g.cnt : null;
            a.grade_cases       = g ? g.cnt : 0;
          });
        }
      }
    } catch(e) { console.warn('[sp-kpi] grade calc skipped:', e.message); }

    // Expose ext_username per specialist (frontend will fetch Calllog grades via /api/kpi?team=specialist)
    try {
      const empIds = agents.map(a => a.emp_id).filter(Boolean);
      if (empIds.length) {
        const inList = empIds.map((_,i) => `@eid${i}`).join(',');
        const qr2 = req();
        empIds.forEach((id,i) => qr2.input(`eid${i}`, sql.Int, id));
        const extUsers = (await qr2.query(
          `SELECT employee_id, ext_username FROM app_users WHERE employee_id IN (${inList}) AND ext_username IS NOT NULL`
        )).recordset;
        const empToExt = {};
        extUsers.forEach(r => { empToExt[r.employee_id] = r.ext_username; });
        agents.forEach(a => { a.ext_username = empToExt[a.emp_id] || null; });
      }
    } catch(e) { console.warn('[sp-kpi] ext_username lookup skipped:', e.message); }

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

    // debug: test app_users lookup for specialist emp_ids
    let _dbgExtUsers = [];
    try {
      const testIds = agents.slice(0,3).map(a=>a.emp_id).filter(Boolean);
      if (testIds.length) {
        const il = testIds.map((_,i)=>`@t${i}`).join(',');
        const qt = req();
        testIds.forEach((id,i) => qt.input(`t${i}`, sql.Int, id));
        _dbgExtUsers = (await qt.query(`SELECT employee_id, ext_username FROM app_users WHERE employee_id IN (${il})`)).recordset;
      }
    } catch(dbgErr) { _dbgExtUsers = [{error: dbgErr.message}]; }
    res.json({ agents, problemTypes, _dbg: { extUsers: _dbgExtUsers, empIds: agents.slice(0,3).map(a=>a.emp_id), hdErr: agents._hdErr } });
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

// ── GET /api/kpi/activities — fetch knowledge-sharing activities for a date range ──
app.get('/api/kpi/activities', authRequired, async (request, res) => {
  try {
    const { month, dateFrom, dateTo } = request.query;
    // รองรับทั้ง dateFrom/dateTo และ month
    let ms, me;
    if (dateFrom && dateTo) {
      ms = dateFrom;
      // me = วันถัดจาก dateTo เพื่อให้ dateTo inclusive
      const d = new Date(dateTo); d.setDate(d.getDate() + 1);
      me = d.toISOString().slice(0, 10);
    } else {
      const ym = month || new Date().toISOString().slice(0, 7);
      ms = ym + '-01';
      const [y, m2] = ym.split('-').map(Number);
      me = m2 === 12 ? `${y+1}-01-01` : `${y}-${String(m2+1).padStart(2,'0')}-01`;
    }

    const [kbRows, trRows, fuRows, swRows] = await Promise.all([
      req().input('ms', sql.Date, ms).input('me', sql.Date, me)
        .query(`SELECT au.ext_username, COUNT(*) AS kb_count
                FROM shop_knowledge k JOIN app_users au ON au.id = k.created_by
                WHERE k.created_at >= @ms AND k.created_at < @me AND au.ext_username IS NOT NULL
                GROUP BY au.ext_username`),
      req().input('ms', sql.Date, ms).input('me', sql.Date, me)
        .query(`SELECT trainer_ext, COUNT(*) AS tr_count
                FROM kpi_trainings
                WHERE trained_date >= @ms AND trained_date < @me
                GROUP BY trainer_ext`),
      req().input('ms', sql.Date, ms).input('me', sql.Date, me)
        .query(`SELECT au.ext_username, COUNT(*) AS fu_count
                FROM fu_issues i
                JOIN employees e  ON e.id  = i.assigned_to
                JOIN app_users au ON au.employee_id = e.id
                WHERE i.status = 'resolved'
                  AND COALESCE(i.fix_date, CAST(i.updated_at AS DATE)) >= @ms
                  AND COALESCE(i.fix_date, CAST(i.updated_at AS DATE)) < @me
                  AND au.ext_username IS NOT NULL
                GROUP BY au.ext_username`),
      req().input('ms', sql.Date, ms).input('me', sql.Date, me)
        .query(`SELECT au.ext_username, COUNT(DISTINCT j.id) AS sw_count
                FROM sw_update_jobs j
                JOIN sw_update_assignees a ON a.job_id = j.id
                JOIN app_users au ON au.id = a.user_id
                WHERE j.status = 'done' AND j.updated_at >= @ms AND j.updated_at < @me
                  AND au.ext_username IS NOT NULL
                GROUP BY au.ext_username`)
    ]);
    const kbMap = {}, trMap = {}, fuMap = {}, swMap = {};
    kbRows.recordset.forEach(r => { kbMap[r.ext_username] = r.kb_count; });
    trRows.recordset.forEach(r => { trMap[r.trainer_ext]  = r.tr_count; });
    fuRows.recordset.forEach(r => { fuMap[r.ext_username] = r.fu_count; });
    swRows.recordset.forEach(r => { swMap[r.ext_username] = r.sw_count; });

    const result = await req()
      .input('month', sql.Date, ms)
      .query(`SELECT ext_username FROM kpi_activities WHERE month = @month`);

    // Merge all sources
    const allUsers = new Set([...Object.keys(kbMap), ...Object.keys(trMap), ...Object.keys(fuMap), ...Object.keys(swMap), ...result.recordset.map(r=>r.ext_username)]);
    const merged = {};
    allUsers.forEach(u => {
      merged[u] = { ext_username: u, kb_articles: kbMap[u]||0, trainings: trMap[u]||0, fu_resolved: fuMap[u]||0, sw_done: swMap[u]||0 };
    });

    res.json(Object.values(merged));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/kpi/trainings — list training logs (filter by trainer + month) ───
app.get('/api/kpi/trainings', authRequired, async (request, res) => {
  try {
    const { trainer, month } = request.query;
    let where = '1=1';
    const qr = req();
    if (trainer) { qr.input('trainer', sql.NVarChar, trainer); where += ' AND trainer_ext=@trainer'; }
    if (month) {
      const [y, m] = month.split('-').map(Number);
      const ms = `${y}-${String(m).padStart(2,'0')}-01`;
      const me = m === 12 ? `${y+1}-01-01` : `${y}-${String(m+1).padStart(2,'0')}-01`;
      qr.input('ms', sql.Date, ms).input('me', sql.Date, me);
      where += ' AND trained_date >= @ms AND trained_date < @me';
    }
    const rows = (await qr.query(`
      SELECT t.*, e.name AS created_by_name
      FROM kpi_trainings t
      LEFT JOIN employees e ON e.id = t.created_by
      WHERE ${where}
      ORDER BY trained_date DESC`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/kpi/trainings — add training log ────────────────────────────────
app.post('/api/kpi/trainings', authRequired, async (request, res) => {
  try {
    const { trainer_ext, trained_date, topic, trainees, notes } = request.body;
    if (!trainer_ext || !trained_date || !topic?.trim()) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    const r = await req()
      .input('tr',  sql.NVarChar, trainer_ext)
      .input('dt',  sql.Date,     trained_date)
      .input('tp',  sql.NVarChar, topic.trim())
      .input('tn',  sql.NVarChar, trainees || null)
      .input('nt',  sql.NVarChar, notes || null)
      .input('cb',  sql.Int,      request.user.employee_id || null)
      .query(`INSERT INTO kpi_trainings(trainer_ext,trained_date,topic,trainees,notes,created_by)
              OUTPUT INSERTED.id VALUES(@tr,@dt,@tp,@tn,@nt,@cb)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/kpi/trainings/:id ────────────────────────────────────────────────
app.put('/api/kpi/trainings/:id', authRequired, async (request, res) => {
  try {
    const { trainer_ext, trained_date, topic, trainees, notes } = request.body;
    if (!trainer_ext || !trained_date || !topic?.trim()) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    await req()
      .input('id',           sql.Int,       parseInt(request.params.id))
      .input('trainer_ext',  sql.NVarChar,  trainer_ext)
      .input('trained_date', sql.Date,      trained_date)
      .input('topic',        sql.NVarChar,  topic.trim())
      .input('trainees',     sql.NVarChar,  trainees || null)
      .input('notes',        sql.NVarChar,  notes || null)
      .query(`UPDATE kpi_trainings SET trainer_ext=@trainer_ext, trained_date=@trained_date,
              topic=@topic, trainees=@trainees, notes=@notes WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/kpi/trainings/:id ─────────────────────────────────────────────
app.delete('/api/kpi/trainings/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, parseInt(request.params.id))
      .query('DELETE FROM kpi_trainings WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/kpi/targets ──────────────────────────────────────────────────────
app.get('/api/kpi/targets', authRequired, async (request, res) => {
  try {
    const rows = (await req().query('SELECT role_key, target_grade, label FROM kpi_targets')).recordset;
    const map = {};
    rows.forEach(r => { map[r.role_key] = r; });
    res.json(map);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/kpi/targets ─────────────────────────────────────────────────────
app.post('/api/kpi/targets', authRequired, managerRequired, async (request, res) => {
  try {
    const updates = request.body; // { helpdesk: 1500, specialist: 800, ... }
    for (const [role_key, target_grade] of Object.entries(updates)) {
      await req()
        .input('rk', sql.NVarChar, role_key)
        .input('tg', sql.Int, +target_grade)
        .query(`IF EXISTS (SELECT 1 FROM kpi_targets WHERE role_key=@rk)
                  UPDATE kpi_targets SET target_grade=@tg, updated_at=GETDATE() WHERE role_key=@rk
                ELSE
                  INSERT INTO kpi_targets(role_key,target_grade) VALUES(@rk,@tg)`);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/kpi/punctuality ──────────────────────────────────────────────────
app.get('/api/kpi/punctuality', authRequired, async (request, res) => {
  try {
    const { month } = request.query;
    const result = await req()
      .input('month', sql.Date, month + '-01')
      .query(`SELECT ext_username, score, recorded_by, e.name AS recorder_name, updated_at
              FROM kpi_punctuality kp LEFT JOIN employees e ON e.id = kp.recorded_by
              WHERE month = @month`);
    res.json(result.recordset);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/kpi/punctuality ─────────────────────────────────────────────────
app.post('/api/kpi/punctuality', authRequired, managerRequired, async (request, res) => {
  try {
    const { ext_username, month, score, recorded_by } = request.body;
    const monthDate = month + '-01';
    const sc = Math.max(0, Math.min(10, +score || 0));
    const existing = await req()
      .input('u', sql.NVarChar, ext_username).input('m', sql.Date, monthDate)
      .query('SELECT id FROM kpi_punctuality WHERE ext_username=@u AND month=@m');
    if (existing.recordset[0]) {
      await req()
        .input('sc', sql.Int, sc).input('rec', sql.Int, recorded_by || null)
        .input('id', sql.Int, existing.recordset[0].id)
        .query('UPDATE kpi_punctuality SET score=@sc, recorded_by=@rec, updated_at=GETDATE() WHERE id=@id');
      res.json({ id: existing.recordset[0].id, updated: true });
    } else {
      const r = await req()
        .input('u', sql.NVarChar, ext_username).input('m', sql.Date, monthDate)
        .input('sc', sql.Int, sc).input('rec', sql.Int, recorded_by || null)
        .query(`INSERT INTO kpi_punctuality(ext_username,month,score,recorded_by) OUTPUT INSERTED.id VALUES(@u,@m,@sc,@rec)`);
      res.json({ id: r.recordset[0].id });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/kpi/activities — upsert knowledge-sharing activities ────────────
app.post('/api/kpi/activities', authRequired, managerRequired, async (request, res) => {
  try {
    const { ext_username, month, kb_articles, trainings, escalations_reduced, recorded_by } = request.body;
    const monthDate = month + '-01';
    const existing = await req()
      .input('u', sql.NVarChar, ext_username).input('m', sql.Date, monthDate)
      .query('SELECT id FROM kpi_activities WHERE ext_username=@u AND month=@m');
    if (existing.recordset[0]) {
      await req()
        .input('kb',  sql.Int, kb_articles || 0)
        .input('tr',  sql.Int, trainings || 0)
        .input('esc', sql.Int, escalations_reduced || 0)
        .input('rec', sql.Int, recorded_by || null)
        .input('id',  sql.Int, existing.recordset[0].id)
        .query(`UPDATE kpi_activities SET kb_articles=@kb, trainings=@tr,
                escalations_reduced=@esc, recorded_by=@rec, updated_at=GETDATE()
                WHERE id=@id`);
      res.json({ id: existing.recordset[0].id, updated: true });
    } else {
      const result = await req()
        .input('u',   sql.NVarChar, ext_username)
        .input('m',   sql.Date,     monthDate)
        .input('kb',  sql.Int,      kb_articles || 0)
        .input('tr',  sql.Int,      trainings || 0)
        .input('esc', sql.Int,      escalations_reduced || 0)
        .input('rec', sql.Int,      recorded_by || null)
        .query(`INSERT INTO kpi_activities (ext_username,month,kb_articles,trainings,escalations_reduced,recorded_by)
                OUTPUT INSERTED.id VALUES (@u,@m,@kb,@tr,@esc,@rec)`);
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
    if (role === 'team_lead') {
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
//  KPI MONTHLY SCORES — คะแนน KPI รายเดือน
// ══════════════════════════════════════════════════════════
app.get('/api/kpi/monthly-scores', authRequired, async (request, res) => {
  try {
    const { month, team } = request.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month' });
    const ms = new Date(month + '-01');
    const me = new Date(new Date(month + '-01').setMonth(ms.getMonth() + 1));

    // ── targets ──
    const targets = { helpdesk: 1500, specialist: 800, specialist_ticket: 500, sw_update: 20 };
    try {
      (await req().query('SELECT role_key, target_grade FROM kpi_targets')).recordset
        .forEach(r => { targets[r.role_key] = r.target_grade; });
    } catch(e) {}

    // ── employees ──
    const teamName = team === 'specialist' ? 'Specialist' : 'Helpdesk';
    const emps = (await req().input('team', sql.NVarChar, teamName).query(`
      SELECT e.id AS emp_id, ISNULL(e.nickname, e.name) AS name, e.team,
             au.ext_username, au.id AS user_id
      FROM employees e
      LEFT JOIN app_users au ON au.employee_id = e.id AND au.active = 1
      WHERE e.team = @team AND e.active = 1
      ORDER BY e.name
    `)).recordset;
    if (!emps.length) return res.json([]);

    const byEmpId  = {};
    const byExt    = {};
    const empIds   = [], userIds = [], extNames = [];
    emps.forEach(e => {
      byEmpId[e.emp_id] = { ...e };
      if (e.ext_username) byExt[e.ext_username] = e.emp_id;
      empIds.push(e.emp_id);
      if (e.user_id)     userIds.push(e.user_id);
      if (e.ext_username) extNames.push(e.ext_username);
    });

    const inI = (arr, pre, r) => { arr.forEach((v,i) => r.input(`${pre}${i}`, sql.Int, v)); return arr.map((_,i)=>`@${pre}${i}`).join(','); };
    const inS = (arr, pre, r) => { arr.forEach((v,i) => r.input(`${pre}${i}`, sql.NVarChar, v)); return arr.map((_,i)=>`@${pre}${i}`).join(','); };

    // ── KB articles ──
    if (userIds.length) {
      const r1 = req().input('ms', sql.DateTime, ms).input('me', sql.DateTime, me);
      const il = inI(userIds, 'u', r1);
      (await r1.query(`SELECT created_by AS uid, COUNT(*) AS n FROM shop_knowledge WHERE created_by IN (${il}) AND created_at>=@ms AND created_at<@me GROUP BY created_by`))
        .recordset.forEach(r => { const e = emps.find(e => e.user_id === r.uid); if (e) byEmpId[e.emp_id].kb_articles = r.n; });
    }

    // ── Punctuality (HR กรอก) ──
    if (extNames.length) {
      const r2 = req().input('month', sql.Date, ms);
      const il = inS(extNames, 'ex', r2);
      (await r2.query(`SELECT ext_username, score FROM kpi_punctuality WHERE month=@month AND ext_username IN (${il})`))
        .recordset.forEach(r => { const eid = byExt[r.ext_username]; if (eid) byEmpId[eid].punctuality_score = r.score; });
    }

    // ── SW Update jobs done (via assignees table) ──
    if (userIds.length) {
      const r3 = req().input('ms', sql.DateTime, ms).input('me', sql.DateTime, me);
      const il = inI(userIds, 'uid', r3);
      (await r3.query(`SELECT a.user_id AS uid, COUNT(DISTINCT j.id) AS n FROM sw_update_jobs j JOIN sw_update_assignees a ON a.job_id=j.id WHERE j.status='done' AND j.updated_at>=@ms AND j.updated_at<@me AND a.user_id IN (${il}) GROUP BY a.user_id`))
        .recordset.forEach(r => { const e = emps.find(e => e.user_id === r.uid); if (e) byEmpId[e.emp_id].sw_done = r.n; });
    }

    if (team === 'specialist') {
      // ── Specialist pending jobs ──
      if (empIds.length) {
        const r4 = req().input('ms', sql.DateTime, ms).input('me', sql.DateTime, me);
        const il = inI(empIds, 'eid', r4);
        (await r4.query(`
          SELECT COALESCE(sl.assigned_to_user, au.employee_id) AS eid,
                 SUM(CASE WHEN sl.status IN ('pending','in_progress','need_more_info') THEN 1 ELSE 0 END) AS n
          FROM specialist_log sl LEFT JOIN app_users au ON au.id=sl.accepted_by
          WHERE sl.assigned_at>=@ms AND sl.assigned_at<@me
            AND COALESCE(sl.assigned_to_user, au.employee_id) IN (${il})
          GROUP BY COALESCE(sl.assigned_to_user, au.employee_id)`))
          .recordset.forEach(r => { if (byEmpId[r.eid]) byEmpId[r.eid].pending_jobs = r.n; });
      }

      // ── Specialist agent grade pts (specialist_log + Subject) ──
      if (empIds.length) {
        try {
          const r5 = req().input('ms', sql.DateTime, ms).input('me', sql.DateTime, me);
          const il = inI(empIds, 'eid2', r5);
          const spSubj = (await r5.query(`
            SELECT COALESCE(sl.assigned_to_user, au.employee_id) AS eid, sl.subject_id
            FROM specialist_log sl LEFT JOIN app_users au ON au.id=sl.accepted_by
            WHERE sl.assigned_at>=@ms AND sl.assigned_at<@me AND sl.subject_id IS NOT NULL
              AND COALESCE(sl.assigned_to_user, au.employee_id) IN (${il})`)).recordset;
          if (spSubj.length && getExtPool()) {
            const uids = [...new Set(spSubj.map(r => r.subject_id))];
            const re = extReq();
            uids.forEach((id,i) => re.input(`sid${i}`, sql.Int, id));
            const gmap = {};
            (await re.query(`SELECT SubjectId, Grade FROM Subject WHERE SubjectId IN (${uids.map((_,i)=>`@sid${i}`).join(',')})`))
              .recordset.forEach(s => { gmap[s.SubjectId] = s.Grade; });
            const agg = {};
            spSubj.forEach(r => {
              const pts = {A:4,B:3,C:2,D:1}[gmap[r.subject_id]] || 0;
              if (pts) agg[r.eid] = (agg[r.eid] || 0) + pts;
            });
            Object.entries(agg).forEach(([eid, pts]) => { if (byEmpId[+eid]) byEmpId[+eid].sp_grade_pts = pts; });
          }
        } catch(e) { console.warn('[kpi-monthly] sp grade:', e.message); }
      }

      // ── ติดตามเคส grade pts (Calllog via ext_username) ──
      if (extNames.length && getExtPool()) {
        try {
          const r6 = extReq().input('ms', sql.DateTime, ms).input('me', sql.DateTime, me);
          const il = inS(extNames, 'ex2', r6);
          (await r6.query(`
            SELECT u.UserName,
              SUM(CASE s.Grade WHEN 'A' THEN 4 WHEN 'B' THEN 3 WHEN 'C' THEN 2 WHEN 'D' THEN 1 ELSE 0 END) AS pts
            FROM Calllog cl INNER JOIN Users u ON u.UserId=cl.SupportId LEFT JOIN Subject s ON s.SubjectId=cl.SubjectId
            WHERE cl.Active=1 AND cl.ReceiveDate>=@ms AND cl.ReceiveDate<@me AND u.UserName IN (${il})
            GROUP BY u.UserName`))
            .recordset.forEach(r => { const eid = byExt[r.UserName]; if (eid) byEmpId[eid].hd_grade_pts = r.pts || 0; });
        } catch(e) { console.warn('[kpi-monthly] hd grade for sp:', e.message); }
      }

      // ── Training (trainer_ext) ──
      if (extNames.length) {
        const r7 = req().input('ms', sql.Date, ms).input('me', sql.Date, me);
        const il = inS(extNames, 'ex3', r7);
        (await r7.query(`SELECT trainer_ext, COUNT(*) AS n FROM kpi_trainings WHERE trained_date>=@ms AND trained_date<@me AND trainer_ext IN (${il}) GROUP BY trainer_ext`))
          .recordset.forEach(r => { const eid = byExt[r.trainer_ext]; if (eid) byEmpId[eid].tr_count = r.n; });
      }

      // ── FU issues resolved ──
      if (empIds.length) {
        const r8 = req().input('ms', sql.DateTime, ms).input('me', sql.DateTime, me);
        const il = inI(empIds, 'eid3', r8);
        (await r8.query(`SELECT assigned_to AS eid, COUNT(*) AS n FROM fu_issues WHERE status='resolved' AND updated_at>=@ms AND updated_at<@me AND assigned_to IN (${il}) GROUP BY assigned_to`))
          .recordset.forEach(r => { if (byEmpId[r.eid]) byEmpId[r.eid].fu_resolved = r.n; });
      }

      // ── Calculate Specialist scores ──
      const spTgt = targets.specialist || 800;
      const tkTgt = targets.specialist_ticket || 500;
      const swTgt = targets.sw_update || 20;
      return res.json(emps.map(e => {
        const d = byEmpId[e.emp_id];
        const no_backlog  = Math.max(0, 5 - (d.pending_jobs  || 0));
        const knowledge   = Math.min(Math.round((d.kb_articles || 0) * 1.25), 5);
        const punctuality = Math.min(+(d.punctuality_score || 0), 5);
        const training    = Math.min((d.tr_count || 0) * 5, 10);
        const general     = Math.min(Math.round((d.hd_grade_pts || 0) / tkTgt * 10), 10);
        const agent       = Math.min(Math.round((d.sp_grade_pts || 0) / spTgt * 35), 35);
        const followup    = Math.min((d.fu_resolved || 0) * 5, 20);
        const sw_update   = Math.min(Math.round((d.sw_done || 0) / swTgt * 10), 10);
        const total = no_backlog + knowledge + punctuality + training + general + agent + followup + sw_update;
        return { emp_id: e.emp_id, name: e.name, team: e.team,
          raw: { pending_jobs: d.pending_jobs||0, kb_articles: d.kb_articles||0, punctuality_score: d.punctuality_score||0,
                 tr_count: d.tr_count||0, hd_grade_pts: d.hd_grade_pts||0, sp_grade_pts: d.sp_grade_pts||0,
                 fu_resolved: d.fu_resolved||0, sw_done: d.sw_done||0 },
          scores: { no_backlog, knowledge, punctuality, training, general, agent, followup, sw_update }, total };
      }).sort((a,b) => b.total - a.total));
    }

    // ── Helpdesk: Calllog data ──
    if (extNames.length && getExtPool()) {
      try {
        const r9 = extReq().input('ms', sql.DateTime, ms).input('me', sql.DateTime, me);
        const il = inS(extNames, 'ex4', r9);
        (await r9.query(`
          SELECT u.UserName,
            AVG(CASE WHEN cl.Stars IS NOT NULL AND cl.Stars>0 THEN CAST(cl.Stars AS FLOAT) END) AS avg_stars,
            SUM(CASE WHEN cs.StatusName NOT LIKE '%close%' AND cs.StatusName NOT LIKE '%complete%'
                          AND DATEDIFF(hour, cl.ReceiveDate, GETDATE())>24 THEN 1 ELSE 0 END) AS overdue,
            SUM(CASE s.Grade WHEN 'A' THEN 4 WHEN 'B' THEN 3 WHEN 'C' THEN 2 WHEN 'D' THEN 1 ELSE 0 END) AS grade_pts
          FROM Calllog cl
          INNER JOIN Users u ON u.UserId=cl.SupportId
          INNER JOIN CallStatus cs ON cs.StatusId=cl.StatusId
          LEFT JOIN Subject s ON s.SubjectId=cl.SubjectId
          WHERE cl.Active=1 AND cl.ReceiveDate>=@ms AND cl.ReceiveDate<@me AND u.UserName IN (${il})
          GROUP BY u.UserName`))
          .recordset.forEach(r => {
            const eid = byExt[r.UserName];
            if (eid) { byEmpId[eid].avg_stars = r.avg_stars; byEmpId[eid].overdue_cases = r.overdue || 0; byEmpId[eid].grade_pts = r.grade_pts || 0; }
          });
      } catch(e) { console.warn('[kpi-monthly] hd calllog:', e.message); }
    }

    // ── Calculate Helpdesk scores ──
    const hdTgt = targets.helpdesk || 1500;
    const swTgt = targets.sw_update || 20;
    return res.json(emps.map(e => {
      const d = byEmpId[e.emp_id];
      const satisfaction = Math.min(+(d.avg_stars || 0).toFixed(1), 5);
      const no_backlog   = Math.max(0, 5 - (d.overdue_cases || 0));
      const knowledge    = Math.min(Math.round((d.kb_articles || 0) * 2.5), 10);
      const punctuality  = Math.min(+(d.punctuality_score || 0), 10);
      const general      = Math.min(Math.round((d.grade_pts || 0) / hdTgt * 60), 60);
      const sw_update    = Math.min(Math.round((d.sw_done || 0) / swTgt * 10), 10);
      const total = satisfaction + no_backlog + knowledge + punctuality + general + sw_update;
      return { emp_id: e.emp_id, name: e.name, team: e.team,
        raw: { avg_stars: d.avg_stars||0, overdue_cases: d.overdue_cases||0, kb_articles: d.kb_articles||0,
               punctuality_score: d.punctuality_score||0, grade_pts: d.grade_pts||0, sw_done: d.sw_done||0 },
        scores: { satisfaction, no_backlog, knowledge, punctuality, general, sw_update }, total };
    }).sort((a,b) => b.total - a.total));

  } catch(e) { res.status(500).json({ error: e.message }); }
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
    // Build ext_username → display name + id → { name, ext_username } maps
    const nameMapRows = (await req().query(`
      SELECT e.id, au.ext_username, ISNULL(e.nickname, e.name) AS display_name
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const nameMap = {}, nameMapById = {};
    nameMapRows.forEach(r => {
      nameMap[r.ext_username] = r.display_name;
      nameMapById[r.id] = { name: r.display_name, ext_username: r.ext_username };
    });

    // ── On-shift now — sourced from the Google Calendar employee schedule
    // (ตารางงานพนักงาน), limited to the teams that keep it up to date daily.
    const nowHHMM = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' });
    const onShift = [];
    try {
      const empcalData = await computeEmpcalSummary(bangkokToday(), false);
      for (const t of (empcalData.teams || [])) {
        if (!EMPCAL_ONSHIFT_TEAMS.includes(t.team)) continue;
        for (const p of t.people) {
          const active = p.items.find(it =>
            (it.type === 'shift' || it.type === 'onsite') && it.start && it.end && it.start <= nowHHMM && nowHHMM <= it.end);
          if (!active) continue;
          const m = nameMapById[p.emp_id];
          onShift.push({
            employee_id: p.emp_id, team: t.team,
            shift_type: `${active.start}-${active.end}`, shift_start: active.start,
            name: m?.name || p.nickname, nickname: m?.name || p.nickname,
            ext_username: m?.ext_username || null,
          });
        }
      }
    } catch (e) { console.warn('empcal onShift error:', e.message); }

    // ── Count Calllog per employee since their (actual, per-person) shift start ─
    let shiftTaskCounts = {}; // employee_id → count
    if (ext && onShift.length > 0) {
      try {
        const onShiftIds = [...new Set(onShift.map(e => e.employee_id).filter(id => id > 0))];
        if (onShiftIds.length > 0) {
          const cuRows = (await req().query(
            `SELECT employee_id, calluserid FROM app_users WHERE employee_id IN (${onShiftIds.join(',')}) AND calluserid IS NOT NULL AND active=1`
          )).recordset;
          if (cuRows.length > 0) {
            const empToCalluser = {};
            cuRows.forEach(r => { empToCalluser[r.employee_id] = r.calluserid; });
            // Group by each person's actual shift-start time (from the calendar), not a fixed lookup table
            const byStart = {};
            onShift.forEach(e => {
              if (!e.employee_id || !empToCalluser[e.employee_id]) return;
              const key = e.shift_start || '08:00';
              (byStart[key] ||= []).push({ empId: e.employee_id, callId: empToCalluser[e.employee_id] });
            });
            for (const [startTime, emps] of Object.entries(byStart)) {
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

    res.json({
      ticketsToday, overdueTickets, ticketStats,
      kpiSummary, onShift, pendingLeaves,
      currentShifts, serverTime: now.toISOString(),
      extConnected: !!ext,
      dailyTrend, monthTotal, lastMonthTotal, totalYear, closedThisMonth,
      todayTotal, weekTotal, weekStart, nameMap, nameMapById, shiftTaskCounts
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
      AND e.team IN (SELECT name FROM teams WHERE show_in_schedule=1 AND active=1)
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

// ── Support-history search (used by AI chat function calling) ──
// Searches the full Calllog history by keyword / problem symptom
// (and optional company), respecting the caller's RBAC scope.
async function searchSupportHistory(user, { keywords = '', company = '', limit = 8 } = {}) {
  if (!getExtPool()) return { error: 'ฐานข้อมูล Calllog ไม่พร้อมใช้งานตอนนี้', results: [] };

  const scope = await getScopedUsernames(user);
  if (scope === null) return { count: 0, results: [] }; // no access

  const lim = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 20);
  const terms = String(keywords || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const co = String(company || '').trim();
  if (!terms.length && !co) {
    return { error: 'ต้องระบุคำค้น (keywords) หรือชื่อบริษัทอย่างน้อยหนึ่งอย่าง', results: [] };
  }

  const r = extReq();
  let q = `
    SELECT TOP (${lim})
      cl.CalllogId          AS id,
      cr.CompanyName        AS company,
      cl.ReceiveDate        AS opened_at,
      cl.CloseDate          AS closed_at,
      cs.StatusName         AS status,
      cl.Subject            AS subject,
      pt.ProblemTypeDetail  AS problem_type,
      LEFT(cl.CalllogDesc, 600) AS description,
      LEFT(cl.Solution,    600) AS solution,
      u.UserName            AS agent,
      cl.Stars              AS stars
    FROM Calllog cl
    INNER JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
    LEFT  JOIN CallStatus           cs ON cs.StatusId       = cl.StatusId
    INNER JOIN Users                u  ON u.UserId          = cl.SupportId
    LEFT  JOIN ProblemType          pt ON pt.ProblemTypeId  = cl.ProblemTypeId
    WHERE cl.Active = 1`;

  terms.forEach((t, i) => {
    r.input(`kw${i}`, sql.NVarChar, `%${t}%`);
    q += ` AND (cl.Subject LIKE @kw${i} OR cl.CalllogDesc LIKE @kw${i}
            OR cl.Solution LIKE @kw${i} OR pt.ProblemTypeDetail LIKE @kw${i} OR pt.Note LIKE @kw${i})`;
  });
  if (co) { r.input('co', sql.NVarChar, `%${co}%`); q += ' AND cr.CompanyName LIKE @co'; }
  q += appendScopeClause(r, scope);
  q += ' ORDER BY cl.ReceiveDate DESC';

  const rows = (await r.query(q)).recordset;
  // Normalise dates so they serialise cleanly into the function response
  const results = rows.map(x => ({
    ...x,
    opened_at: x.opened_at ? new Date(x.opened_at).toISOString().slice(0, 10) : null,
    closed_at: x.closed_at ? new Date(x.closed_at).toISOString().slice(0, 10) : null
  }));
  return { count: results.length, results };
}

// Search "สิ่งที่ควรรู้" (shop_knowledge) — brand/branch how-to articles
async function searchShopKnowledge({ query = '', brand = '', limit = 8 } = {}) {
  const q  = String(query || '').trim();
  const br = String(brand || '').trim();
  if (!q && !br) return { error: 'ต้องระบุคำค้น (query) หรือแบรนด์ (brand) อย่างน้อยหนึ่งอย่าง', results: [] };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 20);
  const r = req();
  let where = '1=1';
  if (br) { r.input('brand', sql.NVarChar, `%${br}%`); where += ' AND brand_name LIKE @brand'; }
  // Tokenise the query and match if ANY term appears in any field (KB is small → favour recall)
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
  if (terms.length) {
    const ors = terms.map((t, i) => {
      r.input(`t${i}`, sql.NVarChar, `%${t}%`);
      return `(title LIKE @t${i} OR content LIKE @t${i} OR category LIKE @t${i} OR branch_name LIKE @t${i} OR brand_name LIKE @t${i})`;
    });
    where += ' AND (' + ors.join(' OR ') + ')';
  }
  const rows = (await r.query(`
    SELECT TOP (${lim}) id, brand_name, branch_name, category, title,
           LEFT(content, 800) AS content, updated_at
    FROM shop_knowledge
    WHERE ${where}
    ORDER BY updated_at DESC`)).recordset;
  const results = rows.map(x => ({
    ...x,
    updated_at: x.updated_at ? new Date(x.updated_at).toISOString().slice(0, 10) : null
  }));
  return { count: results.length, results };
}

// Search "ข้อมูลรีโมท" (shop_entries) — remote-access details per branch/terminal
async function searchRemoteInfo({ query = '', limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { error: 'ต้องระบุคำค้น เช่น ชื่อแบรนด์/สาขา/ชื่อเครื่อง/Anydesk/IP', results: [] };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 20);
  const r = req();
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
  const fields = ['brand_name','branch_name','branch_code','contact_name','terminal_name','anydesk_id','teamviewer_id','ip_address','services'];
  const ors = terms.map((t, i) => {
    r.input(`t${i}`, sql.NVarChar, `%${t}%`);
    return '(' + fields.map(f => `${f} LIKE @t${i}`).join(' OR ') + ')';
  });
  const rows = (await r.query(`
    SELECT TOP (${lim}) id, brand_name, branch_name, branch_code, contact_name, telephone,
           terminal_type, terminal_name, anydesk_id, teamviewer_id, remote_password, ip_address, services, note
    FROM shop_entries
    WHERE ${ors.length ? ors.join(' OR ') : '1=1'}
    ORDER BY brand_name, branch_name`)).recordset;
  return { count: rows.length, results: rows };
}

// Gemini function-calling tool exposed to the CS Assistant chat
const SUPPORT_HISTORY_TOOL = {
  functionDeclarations: [{
    name: 'search_support_history',
    description: 'ค้นประวัติเคส support ย้อนหลังจาก Calllog ตามคำค้น/อาการปัญหา (และชื่อบริษัทถ้ามี). ' +
      'ใช้เครื่องมือนี้ทุกครั้งที่ผู้ใช้ถามถึงเคสในอดีต ปัญหาที่เคยเกิด หรือวิธีแก้ที่เคยใช้ — อย่าเดาคำตอบเอง',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        keywords: {
          type: SchemaType.STRING,
          description: 'คำสำคัญของอาการปัญหา — สำคัญมาก: ต้องแยกเป็นคำสั้น ๆ คั่นด้วยช่องว่างเสมอ ' +
            'ห้ามส่งเป็นวลียาวติดกัน (ทุกคำจะถูก match แบบ AND). ' +
            'ตัวอย่างที่ถูก: "เครื่องพิมพ์ ใบเสร็จ" หรือ "ปริ้น ไม่ออก" — ตัวอย่างที่ผิด: "เครื่องพิมพ์ไม่ออกใบเสร็จ". ' +
            'ถ้าค้นครั้งแรกไม่พบ ให้ลองใหม่ด้วยคำที่สั้น/กว้างขึ้น'
        },
        company: {
          type: SchemaType.STRING,
          description: 'ชื่อบริษัท/ลูกค้า ถ้าผู้ใช้ระบุ (เว้นว่างได้)'
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'จำนวนเคสสูงสุด (1-20, ค่าเริ่มต้น 8)'
        }
      },
      required: ['keywords']
    }
  }]
};

const SHOP_KNOWLEDGE_TOOL = {
  functionDeclarations: [{
    name: 'search_shop_knowledge',
    description: 'ค้น "สิ่งที่ควรรู้" ของร้าน/แบรนด์ (คู่มือ วิธีตั้งค่า ข้อควรระวัง เฉพาะแต่ละแบรนด์/สาขา). ' +
      'ใช้เมื่อผู้ใช้ถามถึงข้อมูลเฉพาะของร้าน วิธีทำงานกับระบบของแบรนด์นั้น ๆ หรือสิ่งที่ทีมควรรู้ก่อนซัพพอร์ต',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: 'คำค้น/หัวข้อ/อาการ เช่น "การตั้งค่าเครื่องพิมพ์" (เว้นว่างได้ถ้าระบุ brand)' },
        brand: { type: SchemaType.STRING, description: 'ชื่อแบรนด์/ร้าน ถ้าผู้ใช้ระบุ (เว้นว่างได้)' },
        limit: { type: SchemaType.NUMBER, description: 'จำนวนบทความสูงสุด (1-20, ค่าเริ่มต้น 8)' }
      },
      required: ['query']
    }
  }]
};

const REMOTE_INFO_TOOL = {
  functionDeclarations: [{
    name: 'search_remote_info',
    description: 'ค้น "ข้อมูลรีโมท" ของสาขา/เครื่อง (Anydesk ID, TeamViewer ID, IP, รหัสผ่านรีโมท, ผู้ติดต่อ, ประเภทเครื่อง). ' +
      'ใช้เมื่อผู้ใช้ถามวิธีรีโมทเข้าเครื่องของสาขา หรือขอข้อมูลการเชื่อมต่อของร้าน',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: 'คำค้น เช่น ชื่อแบรนด์/สาขา/รหัสสาขา/ชื่อเครื่อง/Anydesk/IP' },
        limit: { type: SchemaType.NUMBER, description: 'จำนวนรายการสูงสุด (1-20, ค่าเริ่มต้น 8)' }
      },
      required: ['query']
    }
  }]
};

// ── 1. AI Chat ─────────────────────────────────────────────
// GET /api/ai/usage?days=7 — token ที่ใช้ต่อฟีเจอร์ (รวมช่วง + รายวัน)
app.get('/api/ai/usage', authRequired, async (request, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(request.query.days) || 7));
    await ensureAiUsageTable();
    await flushAiUsage();
    const r = req().input('n', sql.Int, days - 1);
    const range = `day >= CAST(DATEADD(day, -@n, GETDATE()) AS DATE)`;
    const [byFeature, byDay] = await Promise.all([
      r.query(`SELECT feature, provider, model, SUM(calls) AS calls, SUM(in_tokens) AS in_tokens, SUM(out_tokens) AS out_tokens,
                      SUM(in_tokens + out_tokens) AS total_tokens
               FROM ai_token_usage WHERE ${range} GROUP BY feature, provider, model ORDER BY total_tokens DESC`),
      req().input('n', sql.Int, days - 1).query(`SELECT CONVERT(char(10), day, 23) AS day, feature, SUM(calls) AS calls,
                      SUM(in_tokens + out_tokens) AS total_tokens
               FROM ai_token_usage WHERE ${range} GROUP BY day, feature ORDER BY day DESC, total_tokens DESC`),
    ]);
    res.json({ days, by_feature: byFeature.recordset, by_day: byDay.recordset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/chat', authRequired, async (request, res) => {
  const { message, history = [], image } = request.body;
  if (!message && !image) return res.status(400).json({ error: 'message or image required' });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY ยังไม่ได้ตั้งค่าใน .env' });
  }
  try {
    const context = await getDashboardContext();
    const systemPrompt = `คุณคือผู้ช่วย AI สำหรับระบบบริหารทีม Customer Service ชื่อว่า "CS Assistant"
ตอบเป็นภาษาไทย กระชับ ชัดเจน เป็นมิตร

คุณมีเครื่องมือค้นข้อมูล 3 ชุด — เลือกใช้ให้ตรงกับคำถาม และห้ามเดาคำตอบเอง ให้ค้นก่อนเสมอ:
1. search_support_history — ประวัติเคส/ปัญหาที่เคยเกิด/วิธีแก้ที่เคยใช้ (จาก Calllog). สรุปโดยระบุเลขเคส (#id), บริษัท, อาการ และวิธีแก้ (Solution)
2. search_shop_knowledge — "สิ่งที่ควรรู้" เฉพาะร้าน/แบรนด์ (คู่มือ วิธีตั้งค่า ข้อควรระวัง). สรุปโดยอ้างอิงหัวข้อและแบรนด์/สาขา
3. search_remote_info — "ข้อมูลรีโมท" ของสาขา/เครื่อง (Anydesk, TeamViewer, IP, รหัสผ่านรีโมท, ผู้ติดต่อ)

ถ้าคำถามเกี่ยวข้องหลายด้าน ให้เรียกหลายเครื่องมือได้ ถ้าค้นแล้วไม่พบให้บอกตรง ๆ ว่าไม่พบ
ถ้าผู้ใช้แนบรูป (เช่น screenshot error) ให้อ่านข้อความ/อาการในรูป แล้วใช้เป็นคำค้นกับเครื่องมือข้างต้นเพื่อหาสาเหตุและวิธีแก้

ข้อมูลภาพรวมของทีมวันนี้:\n\n${context}`;

    const model = genAI.getGenerativeModel({
      model: AI_MODEL,
      systemInstruction: systemPrompt,
      tools: [SUPPORT_HISTORY_TOOL, SHOP_KNOWLEDGE_TOOL, REMOTE_INFO_TOOL]
    });
    // Build the conversation manually (role: user|model only) instead of using
    // model.startChat()/chat.sendMessage() — that helper hardcodes role:'function'
    // for function-response turns, which current Gemini backends reject
    // ("Role 'function' is not supported"). Passing functionResponse parts under
    // role:'user' via generateContent({contents}) sidesteps that entirely.
    const contents = history.slice(-8).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    // Build the user turn — text plus an optional attached image (data URL)
    const userParts = [{ text: message || 'ช่วยดูรูปที่แนบมานี้ แล้ววิเคราะห์/ค้นหาวิธีแก้ให้หน่อย' }];
    if (typeof image === 'string' && image.startsWith('data:')) {
      const m = image.match(/^data:([^;]+);base64,(.+)$/);
      if (m) userParts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }
    contents.push({ role: 'user', parts: userParts });

    // Function-calling loop — let the model search history, then answer
    const MAX_HOPS = 3; // each hop = 1 Gemini request; cap it to protect the daily quota
    let result = await model.generateContent({ contents });
    geminiUsage('ai_chat', AI_MODEL, result);
    let hop = 0;
    for (; hop < MAX_HOPS; hop++) {
      const calls = result.response.functionCalls();
      if (!calls || !calls.length) break;
      console.log(`[ai/chat] hop ${hop} calls:`, calls.map(c => `${c.name}(${JSON.stringify(c.args)})`).join(' | '));
      contents.push({ role: 'model', parts: result.response.candidates[0].content.parts });
      const parts = [];
      for (const call of calls) {
        let response;
        if (call.name === 'search_support_history') {
          response = await searchSupportHistory(request.user, call.args || {});
        } else if (call.name === 'search_shop_knowledge') {
          response = await searchShopKnowledge(call.args || {});
        } else if (call.name === 'search_remote_info') {
          response = await searchRemoteInfo(call.args || {});
        } else {
          response = { error: `ไม่รู้จักเครื่องมือ ${call.name}` };
        }
        console.log(`[ai/chat]   -> ${call.name} count=${response.count ?? 0} err=${response.error || '-'}`);
        parts.push({ functionResponse: { name: call.name, response } });
      }
      contents.push({ role: 'user', parts });
      result = await model.generateContent({ contents });
      geminiUsage('ai_chat', AI_MODEL, result);
    }

    let reply = '';
    try { reply = (result.response.text() || '').trim(); } catch { reply = ''; }
    // Model ended still wanting to call tools (or produced no text) — nudge it once for a plain answer
    if (!reply) {
      console.warn(`[ai/chat] empty reply after ${hop} hops (still calling tools?=${!!result.response.functionCalls()?.length}) — nudging`);
      try {
        contents.push({ role: 'model', parts: result.response.candidates[0].content.parts });
        contents.push({ role: 'user', parts: [{ text:
          'สรุปคำตอบเป็นข้อความภาษาไทยจากผลการค้นที่มีอยู่ตอนนี้ ถ้าไม่พบเคสที่เกี่ยวข้องให้บอกว่าไม่พบ (ห้ามเรียกเครื่องมือเพิ่ม)'
        }] });
        const nudge = await model.generateContent({ contents });
        geminiUsage('ai_chat', AI_MODEL, nudge);
        reply = (nudge.response.text() || '').trim();
      } catch (e) { console.warn('[ai/chat] nudge failed:', e.message); }
    }
    if (!reply) reply = 'ขออภัยครับ ผมยังสรุปคำตอบไม่ได้ ลองระบุอาการหรือชื่อบริษัทให้ชัดขึ้นอีกนิดได้ไหมครับ 🙏';

    res.json({ reply });
  } catch (e) {
    console.error('AI chat error:', e.message);
    const msg = String(e.message || '');
    // Paid account but out of prepaid credits
    if (/prepayment|credits are depleted|billing/i.test(msg)) {
      return res.status(402).json({
        error: 'เครดิต API หมด — กรุณาเติมเครดิต/ตรวจสอบ billing ของโปรเจกต์ที่ Google AI Studio (ai.studio/projects) แล้วลองใหม่'
      });
    }
    // Free-tier daily quota / rate limit
    if (/429|Too Many Requests|quota/i.test(msg)) {
      const m = msg.match(/retry in ([\d.]+)s/i);
      const wait = m ? ` (ลองใหม่ในอีก ~${Math.ceil(parseFloat(m[1]))} วินาที)` : '';
      return res.status(429).json({
        error: `โควตา AI เต็มชั่วคราว${wait} — กรุณาลองใหม่ภายหลัง ` +
               `(ถ้าใช้ free tier ให้เปิด billing ที่ Google AI Studio เพื่อเพิ่มลิมิต)`
      });
    }
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

    const { value } = await aiGenerate(prompt, { feature: 'dashboard_summary' });
    res.json({ summary: value });
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

    const { value: suggestions } = await aiGenerate(prompt, { parse: parseJsonArrayReply, feature: 'suggest_shifts' });
    res.json({ suggestions, week_start: startDate, end_date: endDate });
  } catch (e) {
    console.error('AI shift error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  EMPLOYEE SCHEDULE SUMMARY
//  Google Calendar (public) → AI parse+map (Groq/Gemini) → per-team summary
//  Per-day, cached to a JSON file (no production DB writes).
// ══════════════════════════════════════════════════════════
const GCAL_API_KEY     = process.env.GCAL_API_KEY || '';
const GCAL_CAL_ID      = process.env.GCAL_CALENDAR_ID || 'schedule.supinfo@gmail.com';
const EMPCAL_CACHE_DIR = path.join(UPLOAD_DIR, '_empcal_cache');
const empcalCachePath  = (date) => path.join(EMPCAL_CACHE_DIR, `${date}.json`);
const bangkokToday     = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
// Teams whose calendar entries are reliable enough to drive the Dashboard "on-shift now" card
const EMPCAL_ONSHIFT_TEAMS = ['specialist', 'helpdesk_bkk', 'helpdesk_cnx'];

async function computeEmpcalSummary(date, refresh) {
    if (!GCAL_API_KEY) { const e = new Error('ยังไม่ได้ตั้งค่า GCAL_API_KEY ใน .env — สร้าง API key ที่ Google Cloud Console แล้วใส่ใน .env'); e.status = 503; throw e; }
    if (!GROQ_API_KEY && !process.env.GEMINI_API_KEY) { const e = new Error('ยังไม่ได้ตั้งค่า GROQ_API_KEY หรือ GEMINI_API_KEY ใน .env'); e.status = 503; throw e; }

    // Serve cached result unless a refresh is requested
    if (!refresh) {
      try {
        const cached = JSON.parse(fs.readFileSync(empcalCachePath(date), 'utf8'));
        return { ...cached, cached: true };
      } catch { /* no cache yet */ }
    }

    // 1) Fetch that day's events (Bangkok day window) from Google Calendar API
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GCAL_CAL_ID)}/events`;
    const gcal = await axios.get(url, { params: {
      key: GCAL_API_KEY,
      timeMin: `${date}T00:00:00+07:00`,
      timeMax: `${date}T23:59:59+07:00`,
      singleEvents: true, orderBy: 'startTime', timeZone: 'Asia/Bangkok', maxResults: 250,
    }, timeout: 20000 });

    const rawEvents = (gcal.data.items || []).map((ev, i) => ({
      idx: i,
      summary: ev.summary || '',
      start:   ev.start?.dateTime || ev.start?.date || '',
      end:     ev.end?.dateTime   || ev.end?.date   || '',
      allDay:  !ev.start?.dateTime,
    }));

    // Deterministic time resolver — the shift time lives in the summary text
    // ("08:00-17:00 : Boek,Nnai") even when the calendar event is all-day.
    // Regex is far more reliable than the LLM for this, so we own it here.
    const hhmm = (iso) => {
      const d = new Date(iso);
      return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' });
    };
    const resolveTime = (raw) => {
      const m = (raw.summary || '').match(/(\d{1,2}[:.]\d{2})\s*[-–]\s*(\d{1,2}[:.]\d{2})/);
      if (m) {
        const norm = (s) => { s = s.replace('.', ':'); return s.length === 4 ? '0' + s : s; };
        return { start: norm(m[1]), end: norm(m[2]), allDay: false };
      }
      if (!raw.allDay && raw.start) return { start: hhmm(raw.start), end: hhmm(raw.end), allDay: false };
      return { start: '', end: '', allDay: true };
    };

    if (!rawEvents.length)
      return { date, teams: [], unknown: [], eventCount: 0, cached: false, generatedAt: new Date().toISOString() };

    // 2) Employee reference list (for name matching)
    const employees = (await req().query(
      `SELECT id, name, nickname, team FROM employees WHERE active=1`)).recordset
      .map(e => ({ id: e.id, name: e.name, nickname: e.nickname, team: e.team }));

    // 3) Gemini: parse each event + match names to employees
    const prompt = `คุณคือตัวช่วยแปลงข้อมูลปฏิทินงานของทีม Customer Service ให้เป็น JSON

รายชื่อพนักงานในระบบ (ใช้จับคู่ชื่อ):
${JSON.stringify(employees)}

event จากปฏิทิน Google ของวันที่ ${date} (เวลาเป็น ISO, allDay=true คือทั้งวัน):
${JSON.stringify(rawEvents)}

แปลงแต่ละ event เป็น object 1 ชิ้น (1 ต่อ 1 ตามลำดับเดิม) แล้วคืนเป็น JSON array เท่านั้น ตามสคีมานี้:
{
  "idx": 0,           // ใส่ค่า idx ของ event เดิมที่แปลงมา (สำคัญมาก ห้ามลืม)
  "type": "shift"|"leave"|"onsite"|"other",
     // shift = กะทำงานปกติ (มีช่วงเวลา HH:MM-HH:MM แล้วตามด้วยชื่อ)
     // leave = ลา (ลาพักร้อน/ลาป่วย/ลากิจ)
     // onsite = ออกหน้างาน/ลงร้าน/ติดตั้ง/เทรนนิ่ง (มักมีชื่อร้านและ #งาน)
     // other = อื่นๆ
  "note": "",         // คำอธิบายสั้นๆ เช่น ชื่อร้าน/เหตุผลลา (ไม่เกิน 60 ตัวอักษร)
  "people": [ { "raw": "Boek", "emp_id": 12, "nickname": "เบิก", "team": "BKK-1" } ]
     // ถ้าจับคู่พนักงานในระบบไม่ได้ → emp_id=null, nickname=null, team=null
}

กติกา:
- ชื่อคนมักอยู่ก่อนเครื่องหมาย ":" แรก คั่นด้วย "," (เช่น "08:00-17:00 : Boek,Nnai" → 2 คน; "Best : ลาพักร้อน" → 1 คน)
- ตัด "(OT)"/วงเล็บออกจากชื่อก่อนจับคู่ แต่ถ้ามี (OT) ให้ใส่ไว้ใน note
- จับคู่ชื่อกับ nickname เป็นหลัก (ไทย/อังกฤษ ไม่สนตัวพิมพ์เล็กใหญ่) ถ้าไม่ตรงค่อยเทียบ name
- ไม่มั่นใจว่าเป็นใคร → emp_id=null (ห้ามเดามั่ว)
- คืน JSON array อย่างเดียว ห้ามมีข้อความอื่น`;

    const { value: events, usedModel } = await aiGenerate(prompt, { parse: parseJsonArrayReply, feature: 'empcal_summary' });

    // 4) Aggregate per team + collect unmatched as "unknown"
    const teamAgg = {};  // team -> emp_id -> { emp_id, nickname, items[] }
    const unkAgg  = {};  // raw  -> { raw, items[] }
    const evArr = Array.isArray(events) ? events : [];
    const sameLen = evArr.length === rawEvents.length;  // AI usually returns 1:1 in order
    for (let i = 0; i < evArr.length; i++) {
      const ev = evArr[i];
      // Prefer AI's echoed idx; fall back to positional match when counts line up.
      const raw = (ev.idx != null && rawEvents[ev.idx]) ? rawEvents[ev.idx]
                : (sameLen ? rawEvents[i] : null);
      const t = raw ? resolveTime(raw) : { start: ev.start || '', end: ev.end || '', allDay: !!ev.allDay };
      const item = {
        start: t.start, end: t.end, allDay: t.allDay,
        type: ev.type || 'other', note: ev.note || '',
      };
      for (const p of (ev.people || [])) {
        if (p && p.emp_id) {
          const team = p.team || 'ไม่ระบุทีม';
          (teamAgg[team] ||= {});
          (teamAgg[team][p.emp_id] ||= { emp_id: p.emp_id, nickname: p.nickname || p.raw || '?', items: [] });
          teamAgg[team][p.emp_id].items.push(item);
        } else {
          const raw = ((p && p.raw) || '?').trim();
          (unkAgg[raw] ||= { raw, items: [] });
          unkAgg[raw].items.push(item);
        }
      }
    }
    // Fixed team display order; any unlisted team falls to the end (a→z)
    const TEAM_ORDER = ['specialist', 'helpdesk_bkk', 'helpdesk_cnx', 'implement', 'management'];
    const teamRank = (t) => { const i = TEAM_ORDER.indexOf(t); return i === -1 ? TEAM_ORDER.length : i; };
    // earliest start time of a person (all-day/leave sinks to the bottom)
    const minStart = (p) => {
      const t = p.items.map(i => i.start).filter(Boolean).sort();
      return t[0] || '99:99';
    };
    const teams = Object.keys(teamAgg)
      .sort((a, b) => (teamRank(a) - teamRank(b)) || a.localeCompare(b))
      .map(team => ({
        team,
        people: Object.values(teamAgg[team]).sort((a, b) =>
          minStart(a).localeCompare(minStart(b)) || String(a.nickname).localeCompare(String(b.nickname), 'th')),
      }));
    const unknown = Object.values(unkAgg);

    const payload = {
      date, teams, unknown,
      eventCount: (Array.isArray(events) ? events.length : 0),
      model: usedModel, generatedAt: new Date().toISOString(),
    };

    // Cache the day's parsed result (only when we actually got events)
    try {
      fs.mkdirSync(EMPCAL_CACHE_DIR, { recursive: true });
      fs.writeFileSync(empcalCachePath(date), JSON.stringify(payload));
    } catch (e) { console.error('empcal cache write failed:', e.message); }

    return { ...payload, cached: false };
}

// Render the summary as a LINE-friendly plain-text message
// ข้อความสรุปตารางงานเข้า LINE — แบบกระชับ:
//  · คนที่มีแค่กะงาน → รวมคนเวลาเดียวกันไว้บรรทัดเดียว "08-17 Fluke, Mike" (ไม่ต้องซ้ำ "กะงาน · Helpdesk Cnx")
//  · งานหน้างาน/อื่นๆ → "• ชื่อ เวลา งาน ร้าน" (งานจาก #แท็ก, ร้านตัดสาขา/วงเล็บ/เลข SO ออก)
//  · คนลา → รวมบรรทัดเดียวท้ายข้อความ
function formatEmpcalLine(data, opts = {}) {
  const [y, m, d] = data.date.split('-');
  const hm = t => /^\d{2}:00$/.test(t) ? t.slice(0, 2) : t;   // 08:00 → 08 · 08:30 คงไว้
  const timeOf = it => it.start ? (it.end ? `${hm(it.start)}-${hm(it.end)}` : hm(it.start)) : 'ทั้งวัน';
  const byStart = items => [...items].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const TASK = { 'แสตนบาย': 'Standby', 'สแตนบาย': 'Standby', 'standby': 'Standby', 'เทรนนิ่ง': 'Training', 'เทรนนิ้ง': 'Training', 'training': 'Training' };
  // "ร้าน AKIYOSHI (อะคิโยชิ) - Siam Square One #แสตนบาย SO69-1394" → { task: 'Standby', store: 'AKIYOSHI' }
  const workOf = note => {
    let n = String(note || '').replace(/\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}/g, '').replace(/\bSO\d{2}-\d+\b/gi, '');
    const tags = [...n.matchAll(/#([^#]+)/g)].map(x => x[1].trim()).filter(Boolean);
    n = n.replace(/#[^#]*/g, '');
    let store = n.replace(/^\s*ร้าน\s*/, '').replace(/\([^)]*\)/g, '').split(/\s+[-–]\s+|\s+สาขา\s*/)[0];
    store = store.replace(/\s{2,}/g, ' ').replace(/^[\s·:：|-]+|[\s·:：|-]+$/g, '').trim();
    const task = tags.map(t => TASK[t.toLowerCase()] || t).join(' / ');
    return [task, store].filter(Boolean).join(' · ');
  };
  // กะปกติของ Helpdesk (โน้ตมีแค่เวลา/"กะ"/"Helpdesk Bkk|Cnx") → ไม่ต้องแสดงโน้ต
  const isHelpdeskNote = n => {
    const s = String(n || '').replace(/\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}/g, '').replace(/^\s*กะ(งาน)?\s*/, '').replace(/[\s·:：-]+/g, ' ').trim();
    return !s || /^(helpdesk|hd)\b/i.test(s);
  };
  const leaves = [];
  const leaveOf = (name, it) => {
    const note = String(it.note || '').replace(/^ลา\s*/, '').trim();
    leaves.push(note && note !== 'ลา' ? `${name} (${note})` : name);
  };
  // คนหนึ่งคน → null (อยู่ในกลุ่มเวลา) หรือบรรทัด "•"
  const personLine = (name, items, slots) => {
    const work = byStart(items).filter(it => it.type !== 'leave');
    items.filter(it => it.type === 'leave').forEach(it => leaveOf(name, it));
    if (!work.length) return null;
    if (work.every(it => it.type === 'shift' && isHelpdeskNote(it.note))) {
      const key = work.map(timeOf).join(', ');
      (slots.get(key) || slots.set(key, []).get(key)).push(name);
      return null;
    }
    return `• ${name} ${work.map(it => {
      const w = it.type === 'shift' && isHelpdeskNote(it.note) ? '' : workOf(it.note);
      return `${timeOf(it)}${w ? ' ' + w : ''}`;
    }).join(' | ')}`;
  };
  const section = (title, people, nameOf) => {
    const slots = new Map(), lines = [];
    for (const p of people) { const l = personLine(nameOf(p), p.items, slots); if (l) lines.push(l); }
    const slotLines = [...slots].sort((a, b) => a[0].localeCompare(b[0])).map(([t, names]) => `${t} ${names.join(', ')}`);
    return slotLines.length || lines.length ? `\n${title}\n${[...slotLines, ...lines].join('\n')}\n` : '';
  };

  let out = `🗓️ ตารางงาน ${d}/${m}/${y}\n`;
  for (const t of (data.teams || [])) out += section(`👥 ${t.team}`, t.people, p => p.nickname);
  if ((data.unknown || []).length) out += section('❓ ไม่รู้จัก', data.unknown, u => u.raw);
  if (leaves.length) out += `\n🏖 ลา: ${leaves.join(', ')}\n`;
  // ดึงข้อมูลใหม่ไม่สำเร็จ ต้องใช้ข้อมูลเดิม → บอกในข้อความให้รู้ตัว
  if (opts.stale) out += `\n⚠️ ดึงปฏิทินใหม่ไม่สำเร็จ — ข้อมูลนี้มาจากที่บันทึกไว้ก่อนหน้า อาจไม่ตรงกับปฏิทินล่าสุด\n`;
  return out.trim();
}

// ── Persist each day's parsed schedule to the DB (in addition to the JSON file
// cache) once it's actually sent to LINE — gives a queryable attendance history.
async function ensureEmpcalLogTable() {
  await getPool().request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name='empcal_daily_log')
      CREATE TABLE empcal_daily_log (
        id INT PRIMARY KEY IDENTITY,
        log_date DATE NOT NULL,
        employee_id INT NULL,
        raw_name NVARCHAR(100) NULL,
        team NVARCHAR(50) NULL,
        type NVARCHAR(20) NULL,
        start_time NVARCHAR(5) NULL,
        end_time NVARCHAR(5) NULL,
        all_day BIT DEFAULT 0,
        note NVARCHAR(200) NULL,
        created_at DATETIME DEFAULT GETDATE()
      );
  `);
}

async function saveEmpcalToDb(data) {
  // Re-sending the same day (manual test button, or a rerun) replaces that day's rows
  await req().input('d', sql.Date, data.date).query(`DELETE FROM empcal_daily_log WHERE log_date=@d`);
  const rows = [];
  for (const t of (data.teams || [])) {
    for (const p of t.people) {
      for (const it of p.items) rows.push({ employee_id: p.emp_id, raw_name: p.nickname, team: t.team, ...it });
    }
  }
  for (const u of (data.unknown || [])) {
    for (const it of u.items) rows.push({ employee_id: null, raw_name: u.raw, team: null, ...it });
  }
  for (const r of rows) {
    await req()
      .input('d',  sql.Date,     data.date)
      .input('eid', sql.Int,     r.employee_id || null)
      .input('rn', sql.NVarChar, r.raw_name || null)
      .input('tm', sql.NVarChar, r.team || null)
      .input('ty', sql.NVarChar, r.type || null)
      .input('st', sql.NVarChar, r.start || null)
      .input('et', sql.NVarChar, r.end || null)
      .input('ad', sql.Bit,      r.allDay ? 1 : 0)
      .input('nt', sql.NVarChar, (r.note || '').slice(0,200))
      .query(`INSERT INTO empcal_daily_log (log_date, employee_id, raw_name, team, type, start_time, end_time, all_day, note)
              VALUES (@d, @eid, @rn, @tm, @ty, @st, @et, @ad, @nt)`);
  }
}

// GET /api/empcal/summary — structured summary for the UI
app.get('/api/empcal/summary', authRequired, async (request, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(request.query.date || '') ? request.query.date : bangkokToday();
    const data = await computeEmpcalSummary(date, request.query.refresh === '1');
    res.json(data);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('empcal summary error:', msg);
    res.status(e.status || 500).json({ error: msg });
  }
});

// ── ดึงข้อมูลปฏิทินใหม่ก่อนส่งทุกครั้ง ────────────────────
// cache ไฟล์ JSON มีไว้ให้หน้าจอโหลดเร็ว แต่ถ้าเอาไปส่ง LINE ตรง ๆ จะได้ข้อมูลเก่า
// เมื่อมีคนแก้ปฏิทินหลัง cache ถูกเขียน → ก่อนส่งจึงบังคับ refresh เสมอ
// ถ้า refresh ไม่สำเร็จ (Google/Gemini ล่ม) ค่อยถอยไปใช้ cache แล้วติดธง stale ไว้
async function empcalDataForSend(date) {
  try {
    return { data: await computeEmpcalSummary(date, true), stale: false };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error(`empcal: refresh before send failed (${date}):`, msg);
    // ไม่มี cache ของวันนั้น → computeEmpcalSummary จะคำนวณใหม่และโยน error เดิมออกไป
    const data = await computeEmpcalSummary(date, false);
    return { data, stale: !!data.cached, refreshError: msg };
  }
}

// Build today's summary and push it to LINE targets subscribed to 'empcal_summary'
// (targets are configured in Settings → LINE, same mechanism as other auto-notifications)
async function sendEmpcalSummaryToLine(date) {
  const { data, stale, refreshError } = await empcalDataForSend(date);
  if (!data.eventCount) { console.log(`empcal: no events on ${date}, skip LINE`); return { sent: false, reason: 'no-events', stale }; }
  try { await saveEmpcalToDb(data); } catch (e) { console.error('empcal DB save failed:', e.message); }
  await sendLineNotify(formatEmpcalLine(data, { stale }), 'empcal_summary');
  return { sent: true, eventCount: data.eventCount, refreshed: !stale, stale, refreshError };
}

// Daily auto-send scheduler (no cron lib) — checks every 30s, fires once/day
// at EMPCAL_LINE_SCHEDULE (HH:MM, Asia/Bangkok). Default 08:00.
const EMPCAL_SEND_TIME = (process.env.EMPCAL_LINE_SCHEDULE || '08:00').trim();
let _empcalLastSentDate = null;
async function empcalSchedulerTick() {
  try {
    const now  = new Date();
    const hhmm = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' });
    const today = bangkokToday();
    if (hhmm !== EMPCAL_SEND_TIME || _empcalLastSentDate === today) return;
    _empcalLastSentDate = today;               // guard against re-send within the same day
    const r = await sendEmpcalSummaryToLine(today);
    console.log(`📤 empcal auto-send (${today}):`, JSON.stringify(r));
  } catch (e) { console.error('empcal scheduler error:', e.message); }
}
setInterval(empcalSchedulerTick, 30 * 1000);

// POST /api/empcal/send-line-now — manual trigger (manager) for testing the auto-send
app.post('/api/empcal/send-line-now', authRequired, managerRequired, async (request, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(request.body?.date || '') ? request.body.date : bangkokToday();
    const r = await sendEmpcalSummaryToLine(date);
    res.json({ ok: true, ...r });
  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error?.message || e.message;
    console.error('empcal send-line-now error:', msg);
    res.status(e.status || 500).json({ error: msg });
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
    // Link complaints to a customer (Pod Assign system)
    try {
      await req().query(`
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                       WHERE TABLE_NAME='ticket_complaints' AND COLUMN_NAME='customer_id')
          ALTER TABLE ticket_complaints ADD customer_id INT NULL`);
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

    // Attach files (if any) so the customer can view/download them alongside each case
    const ticketIds = ticketRes.recordset.map(t => t.id);
    if (ticketIds.length) {
      const ar = req();
      ticketIds.forEach((id, i) => ar.input(`id${i}`, sql.Int, id));
      const inClause = ticketIds.map((_, i) => `@id${i}`).join(',');
      const attRows = (await ar.query(
        `SELECT calllog_id, id, filename, original_name, mime_type
         FROM case_attachments WHERE calllog_id IN (${inClause}) ORDER BY created_at`)).recordset;
      const attByCase = {};
      attRows.forEach(a => (attByCase[a.calllog_id] ||= []).push({
        id: a.id, filename: a.filename, original_name: a.original_name, mime_type: a.mime_type,
        url: `/uploads/cases/${a.calllog_id}/${a.filename}`,
      }));
      ticketRes.recordset.forEach(t => { t.attachments = attByCase[t.id] || []; });
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

// Multer for public file uploads (complaints & repair)
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
app.post('/api/public/complaint/direct', publicUpload.array('attachments', 5), async (request, res) => {
  try {
    const { company_name, contact_name, contact_phone, email, message } = request.body;
    if (!company_name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อร้าน / บริษัท' });
    if (!message?.trim())      return res.status(400).json({ error: 'กรุณาระบุข้อความร้องเรียน' });

    // Ensure optional columns exist (idempotent)
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ticket_complaints' AND COLUMN_NAME='contact_name')
        ALTER TABLE ticket_complaints ADD contact_name NVARCHAR(200) NULL;
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='ticket_complaints' AND COLUMN_NAME='contact_phone')
        ALTER TABLE ticket_complaints ADD contact_phone NVARCHAR(50) NULL;
    `);

    // Ensure complaint_attachments table exists
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME='complaint_attachments')
      CREATE TABLE complaint_attachments (
        id           INT IDENTITY PRIMARY KEY,
        complaint_id INT NOT NULL,
        file_type    NVARCHAR(10),
        file_name    NVARCHAR(500),
        file_path    NVARCHAR(1000),
        file_size    INT,
        created_at   DATETIME DEFAULT GETDATE()
      )`);

    const result = await req()
      .input('cn',   sql.NVarChar, company_name.trim())
      .input('cname',sql.NVarChar, contact_name?.trim() || null)
      .input('ctel', sql.NVarChar, contact_phone || null)
      .input('em',   sql.NVarChar, email || null)
      .input('msg',  sql.NVarChar, message.trim())
      .query(`INSERT INTO ticket_complaints (company_name, contact_name, contact_phone, email, message)
              OUTPUT INSERTED.id
              VALUES (@cn, @cname, @ctel, @em, @msg)`);

    const newId = result.recordset[0].id;

    // Save uploaded files
    if (request.files?.length) {
      const dir = path.join(UPLOAD_DIR, `complaint_${newId}`);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      for (const file of request.files) {
        const newPath = path.join(dir, file.filename);
        fs.renameSync(file.path, newPath);
        const relPath = `/uploads/complaint_${newId}/${file.filename}`;
        const ftype = /pdf/.test(path.extname(file.originalname).toLowerCase()) ? 'pdf' : 'image';
        await req()
          .input('cid', sql.Int,      newId)
          .input('ft',  sql.NVarChar, ftype)
          .input('fn',  sql.NVarChar, file.originalname)
          .input('fp',  sql.NVarChar, relPath)
          .input('fs',  sql.Int,      file.size)
          .query(`INSERT INTO complaint_attachments (complaint_id,file_type,file_name,file_path,file_size)
                  VALUES (@cid,@ft,@fn,@fp,@fs)`);
      }
    }

    await sendLineNotify(`\n📣 [ร้องเรียนใหม่] ${company_name.trim()}${contact_name?` | ${contact_name.trim()}`:''}${contact_phone?` | ${contact_phone}`:''}\n"${message.trim().substring(0,100)}${message.trim().length>100?'…':''}"${request.files?.length?`\n📎 แนบไฟล์ ${request.files.length} ไฟล์`:''}`, 'complaint');
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
    const complaints = result.recordset;

    // Attach files if table exists
    try {
      const attResult = await req().query(`SELECT * FROM complaint_attachments ORDER BY created_at`);
      const attMap = {};
      for (const a of attResult.recordset) {
        if (!attMap[a.complaint_id]) attMap[a.complaint_id] = [];
        attMap[a.complaint_id].push(a);
      }
      for (const c of complaints) c.attachments = attMap[c.id] || [];
    } catch { for (const c of complaints) c.attachments = []; }

    res.json(complaints);
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
      .query(`SELECT TOP 50
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
                AND r.AccurateData=1
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

// งานอัพเดท SW เดิมไม่มีแจ้งเตือน LINE เลย — เพิ่ม event 'sw_update' ให้ตั้งกลุ่มปลายทางได้
const SWU_PRIORITY_TH = { urgent: '⚠️ เร่งด่วน', high: 'สูง', normal: 'ปกติ', low: 'ต่ำ' };
const swuThaiDate = (d) => d
  ? new Date(d).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
  : '';

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
    // Attach assignees to each row
    if (rows.length) {
      const ids = rows.map(r => r.id).join(',');
      const assigneeRows = (await req().query(`
        SELECT a.job_id, a.user_id, ISNULL(e2.nickname, e2.name) AS name
        FROM sw_update_assignees a
        JOIN app_users au2 ON au2.id = a.user_id
        LEFT JOIN employees e2 ON e2.id = au2.employee_id
        WHERE a.job_id IN (${ids})
      `)).recordset;
      const aMap = {};
      assigneeRows.forEach(a => {
        if (!aMap[a.job_id]) aMap[a.job_id] = [];
        aMap[a.job_id].push({ user_id: a.user_id, name: a.name });
      });
      rows.forEach(r => { r.assignees = aMap[r.id] || []; });
    }
    // กลุ่ม License (CustomerGroup ที่ไม่ใช่ INF Group) — อยู่ใน LicenseDB; งานเก่าที่ไม่มี registration_id จับคู่ด้วยชื่อร้าน
    if (rows.length && getExtPool()) {
      try {
        const rids = [...new Set(rows.map(r => +r.registration_id).filter(Number.isInteger))];
        const names = [...new Set(rows.filter(r => !r.registration_id && r.company_name).map(r => r.company_name))].slice(0, 1000);
        const byRid = new Map(), byName = new Map();
        if (rids.length) {
          (await extReq().query(`
            SELECT cr.RegistrationId AS rid, cg.GroupName AS grp
            FROM CustomerRegistration cr JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
            WHERE cr.GroupId <> 1 AND cr.RegistrationId IN (${rids.join(',')})`)).recordset
            .forEach(x => byRid.set(x.rid, x.grp));
        }
        if (names.length) {
          const er = extReq();
          names.forEach((n, i) => er.input(`n${i}`, sql.NVarChar, n));
          (await er.query(`
            SELECT cr.CompanyName AS name, MIN(cg.GroupName) AS grp
            FROM CustomerRegistration cr JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
            WHERE cr.GroupId <> 1 AND cr.CompanyName IN (${names.map((_, i) => `@n${i}`).join(',')})
            GROUP BY cr.CompanyName`)).recordset
            .forEach(x => byName.set(x.name, x.grp));
        }
        rows.forEach(r => { r.license_group = byRid.get(+r.registration_id) || byName.get(r.company_name) || null; });
      } catch (e) { console.warn('[sw-update] license group lookup failed:', e.message); }
    }
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
    const newId = result.recordset[0].id;

    try {
      const uname = request.user.nickname || request.user.name || request.user.username || '—';
      const detail = String(b.description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const ap = swuThaiDate(b.appointment_date);
      await sendLineNotify(
        `\n💿[แจ้งงานอัพเดท SW] #${newId}` +
        (b.company_name ? `\nร้าน: ${b.company_name}` : '') +
        (detail ? `\nรายละเอียด: ${detail}` : '') +
        (b.version_recommend ? `\nเวอร์ชันที่แนะนำ: ${b.version_recommend}` : '') +
        (ap ? `\nนัดหมาย: ${ap}` : '') +
        (b.priority && b.priority !== 'normal' ? `\nความสำคัญ: ${SWU_PRIORITY_TH[b.priority] || b.priority}` : '') +
        (b.azure_id ? `\nAzure: ${b.azure_id}` : '') +
        `\nผู้แจ้ง: ${uname}`, 'sw_update');
    } catch (e) { console.warn('sw_update line notify failed:', e.message); }

    res.json({ id: newId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/sw-update/:id
app.put('/api/sw-update/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b  = request.body;
    // Fetch fu_issue_id before update (stored at creation)
    const cur = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM sw_update_jobs WHERE id=@id')).recordset[0];
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
    // Save assignees (replace all)
    if (Array.isArray(b.assignees)) {
      await req().input('jid', sql.Int, id).query(`DELETE FROM sw_update_assignees WHERE job_id=@jid`);
      for (const uid of b.assignees) {
        if (!uid) continue;
        try {
          await req().input('jid', sql.Int, id).input('uid', sql.Int, uid)
            .query(`INSERT INTO sw_update_assignees (job_id, user_id) VALUES (@jid, @uid)`);
        } catch(e) { /* ignore duplicate */ }
      }
    }
    // Auto-resolve linked Follow Up when SW Update is done
    if (b.status === 'done' && cur?.fu_issue_id) {
      try {
        await req().input('fuid', sql.Int, cur.fu_issue_id)
          .query(`UPDATE fu_issues SET status='resolved', updated_at=GETDATE()
                  WHERE id=@fuid AND status NOT IN ('resolved','cancelled')`);
      } catch(e) { console.warn('fu auto-resolve failed:', e.message); }
    }
    // แจ้งกลุ่มเฉพาะจังหวะที่เพิ่งเปลี่ยนเป็นเสร็จ ไม่ใช่ทุกครั้งที่กดบันทึก
    if (b.status === 'done' && cur && cur.status !== 'done') {
      try {
        const uname = request.user.nickname || request.user.name || request.user.username || '—';
        const company = b.company_name || cur.company_name;
        await sendLineNotify(
          `\n✅[อัพเดท SW เสร็จแล้ว] #${id}` +
          (company ? `\nร้าน: ${company}` : '') +
          ((b.version_recommend || cur.version_recommend) ? `\nเวอร์ชัน: ${b.version_recommend || cur.version_recommend}` : '') +
          `\nปิดงานโดย: ${uname}`, 'sw_update');
      } catch (e) { console.warn('sw_update done notify failed:', e.message); }
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
//  COORDINATION REQUESTS — "รับเรื่องประสานงาน" (งานภายใน)
//  เทรนนิ่ง / ทำเทมเพลท / ติดตั้งโปรแกรมเพิ่มเติม / ทำเมนูใหม่
//  แยกจาก service_requests เพราะอันนั้นเป็นงานของลูกค้าที่ซื้อบริการ
//  ส่วนอันนี้เป็นงานภายในทีม
// ══════════════════════════════════════════════════════════
const IMPL_TYPES = {
  training: 'เทรนนิ่ง',
  template: 'ทำเทมเพลท',
  install:  'ติดตั้งโปรแกรมเพิ่มเติม',
  new_menu: 'ทำเมนูใหม่',
};
const IMPL_STATUSES  = ['pending', 'accepted', 'in_progress', 'done', 'cancelled'];

const implUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, 'impl', String(req.params.id || 'tmp'));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const name = fixUploadName(file.originalname);
      const ext  = path.extname(name).toLowerCase();
      const base = path.basename(name, ext).replace(/[^a-zA-Z0-9ก-๙._-]/g, '_').slice(0, 60);
      cb(null, `${Date.now()}_${base}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.(jpg|jpeg|png|gif|webp|pdf|doc|docx|xls|xlsx|txt|log)$/i.test(fixUploadName(file.originalname)));
  }
});

async function ensureImplRequestTables() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='impl_requests' AND xtype='U')
      CREATE TABLE impl_requests (
        id           INT PRIMARY KEY IDENTITY,
        req_no       NVARCHAR(30)  NULL,
        req_type     NVARCHAR(30)  NOT NULL,
        title        NVARCHAR(500) NOT NULL,
        detail       NVARCHAR(MAX) NULL,
        customer     NVARCHAR(255) NULL,
        branch       NVARCHAR(255) NULL,
        contact_name NVARCHAR(200) NULL,
        contact_tel  NVARCHAR(100) NULL,
        contact_note NVARCHAR(255) NULL,
        want_date    DATE          NULL,
        appointment_date DATE      NULL,
        priority     NVARCHAR(20)  DEFAULT 'normal',
        status       NVARCHAR(30)  DEFAULT 'pending',
        assigned_to  INT           NULL,
        note         NVARCHAR(MAX) NULL,
        created_by   INT           NULL,
        created_at   DATETIME      DEFAULT GETDATE(),
        updated_at   DATETIME      DEFAULT GETDATE(),
        accepted_at  DATETIME      NULL,
        done_at      DATETIME      NULL
      )`);
    // ตารางที่สร้างไว้ก่อนมีช่องข้อมูลติดต่อ — เติมคอลัมน์ให้ย้อนหลัง
    for (const col of [
      ['contact_name', 'NVARCHAR(200)'],
      ['contact_tel',  'NVARCHAR(100)'],
      ['contact_note', 'NVARCHAR(255)'],
      ['appointment_date', 'DATE'],
    ]) {
      await req().query(
        `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('impl_requests') AND name='${col[0]}')
           ALTER TABLE impl_requests ADD ${col[0]} ${col[1]} NULL`);
    }
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='impl_request_files' AND xtype='U')
      CREATE TABLE impl_request_files (
        id          INT PRIMARY KEY IDENTITY,
        request_id  INT NOT NULL,
        file_name   NVARCHAR(500) NULL,
        stored_name NVARCHAR(500) NULL,
        size_bytes  INT NULL,
        uploaded_by INT NULL,
        uploaded_at DATETIME DEFAULT GETDATE()
      )`);
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='impl_request_comments' AND xtype='U')
      CREATE TABLE impl_request_comments (
        id         INT PRIMARY KEY IDENTITY,
        request_id INT NOT NULL,
        body       NVARCHAR(MAX) NOT NULL,
        created_by INT NULL,
        created_at DATETIME DEFAULT GETDATE()
      )`);
    console.log('✅ impl_requests tables ready');
  } catch (e) { console.error('❌ impl_requests table error:', e.message); }
}

// เลขที่คำขอ REQ-<ปี>-<ลำดับ 4 หลัก> — ไล่ลำดับใหม่ทุกปี
async function nextImplReqNo() {
  const year = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }).slice(0, 4);
  const row = (await req().input('pfx', sql.NVarChar, `REQ-${year}-%`).query(
    `SELECT ISNULL(MAX(TRY_CAST(RIGHT(req_no, 4) AS INT)), 0) AS n
     FROM impl_requests WHERE req_no LIKE @pfx`)).recordset[0];
  return `REQ-${year}-${String((row?.n || 0) + 1).padStart(4, '0')}`;
}

const implSelect = `
  SELECT r.*,
         ISNULL(ec.nickname, ec.name) AS creator_name,
         ISNULL(ea.nickname, ea.name) AS assignee_name,
         (SELECT COUNT(*) FROM impl_request_files f WHERE f.request_id = r.id) AS file_count
  FROM impl_requests r
  LEFT JOIN app_users auc ON auc.id = r.created_by
  LEFT JOIN employees ec  ON ec.id  = auc.employee_id
  LEFT JOIN app_users aua ON aua.id = r.assigned_to
  LEFT JOIN employees ea  ON ea.id  = aua.employee_id`;

// GET /api/impl-requests — ทุกคนที่ล็อกอินเห็นทั้งหมด (งานภายในทีม)
app.get('/api/impl-requests', authRequired, async (request, res) => {
  try {
    const { status, type, q } = request.query;
    let where = ' WHERE 1=1';
    const r = req();
    // รวม cancelled ไว้ด้วย — ยกเลิกแล้วต้องยังเห็นว่ายกเลิก ไม่ใช่หายไปเลย
    if (status === 'open')       where += ` AND r.status IN ('pending','accepted','in_progress','cancelled')`;
    else if (status)             { where += ' AND r.status=@st'; r.input('st', sql.NVarChar, status); }
    if (type)                    { where += ' AND r.req_type=@tp'; r.input('tp', sql.NVarChar, type); }
    if (q) {
      where += ' AND (r.title LIKE @q OR r.detail LIKE @q OR r.customer LIKE @q OR r.branch LIKE @q OR r.req_no LIKE @q)';
      r.input('q', sql.NVarChar, `%${q}%`);
    }
    // ด่วนขึ้นก่อน แล้วค่อยเรียงตามวันที่ต้องการ
    const rows = (await r.query(`${implSelect}${where}
      ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
               CASE WHEN r.want_date IS NULL THEN 1 ELSE 0 END, r.want_date, r.created_at DESC`)).recordset;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// route ของไฟล์แนบต้องมาก่อน /:id ไม่งั้น Express จะจับคำว่า "files" เป็น id
app.delete('/api/impl-requests/files/:fileId', authRequired, async (request, res) => {
  try {
    const fid = parseInt(request.params.fileId);
    const f = (await req().input('fid', sql.Int, fid)
      .query('SELECT * FROM impl_request_files WHERE id=@fid')).recordset[0];
    if (!f) return res.status(404).json({ error: 'ไม่พบไฟล์' });
    await req().input('fid', sql.Int, fid).query('DELETE FROM impl_request_files WHERE id=@fid');
    try { fs.unlinkSync(path.join(UPLOAD_DIR, 'impl', String(f.request_id), f.stored_name)); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/impl-requests/:id — พร้อมไฟล์แนบ
app.delete('/api/impl-requests/comments/:commentId', authRequired, async (request, res) => {
  try {
    const cid = parseInt(request.params.commentId);
    const c = (await req().input('cid', sql.Int, cid)
      .query('SELECT * FROM impl_request_comments WHERE id=@cid')).recordset[0];
    if (!c) return res.status(404).json({ error: 'ไม่พบข้อความนี้' });
    // ลบได้เฉพาะเจ้าของข้อความ หรือผู้จัดการ
    const isOwner = c.created_by === request.user.id;
    if (!isOwner && !['manager', 'admin'].includes(request.user.role)) {
      return res.status(403).json({ error: 'ลบได้เฉพาะข้อความของตัวเอง' });
    }
    await req().input('cid', sql.Int, cid).query('DELETE FROM impl_request_comments WHERE id=@cid');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/impl-requests/:id/comments', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const body = String(request.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'กรุณาพิมพ์ข้อความ' });
    const row = (await req()
      .input('rid', sql.Int, id)
      .input('bd',  sql.NVarChar, body)
      .input('cb',  sql.Int, request.user.id)
      .query(`INSERT INTO impl_request_comments (request_id, body, created_by)
              OUTPUT INSERTED.id, INSERTED.created_at VALUES (@rid,@bd,@cb)`)).recordset[0];
    // มีคนคุยในเรื่องนี้ = เรื่องยังเดินอยู่ ขยับ updated_at ให้ด้วย
    await req().input('id', sql.Int, id).query('UPDATE impl_requests SET updated_at=GETDATE() WHERE id=@id');
    res.json({ id: row.id, created_at: row.created_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/impl-requests/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const row = (await req().input('id', sql.Int, id).query(`${implSelect} WHERE r.id=@id`)).recordset[0];
    if (!row) return res.status(404).json({ error: 'ไม่พบคำขอนี้' });
    row.files = (await req().input('rid', sql.Int, id).query(
      `SELECT f.id, f.file_name, f.stored_name, f.size_bytes, f.uploaded_at,
              ISNULL(e.nickname, e.name) AS uploader_name
       FROM impl_request_files f
       LEFT JOIN app_users au ON au.id = f.uploaded_by
       LEFT JOIN employees e  ON e.id  = au.employee_id
       WHERE f.request_id=@rid ORDER BY f.uploaded_at`)).recordset;
    row.comments = (await req().input('rid2', sql.Int, id).query(
      `SELECT c.id, c.body, c.created_at,
              ISNULL(e.nickname, e.name) AS author_name, c.created_by
       FROM impl_request_comments c
       LEFT JOIN app_users au ON au.id = c.created_by
       LEFT JOIN employees e  ON e.id  = au.employee_id
       WHERE c.request_id=@rid2 ORDER BY c.created_at`)).recordset;
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/impl-requests', authRequired, async (request, res) => {
  try {
    const b = request.body || {};
    if (!IMPL_TYPES[b.req_type]) return res.status(400).json({ error: 'ประเภทงานไม่ถูกต้อง' });
    if (!String(b.title || '').trim()) return res.status(400).json({ error: 'กรุณาระบุเรื่องที่ขอ' });

    const reqNo = await nextImplReqNo();
    const id = (await req()
      .input('no',   sql.NVarChar, reqNo)
      .input('tp',   sql.NVarChar, b.req_type)
      .input('ti',   sql.NVarChar, String(b.title).trim())
      .input('de',   sql.NVarChar, b.detail   || null)
      .input('cu',   sql.NVarChar, b.customer || null)
      .input('br',   sql.NVarChar, b.branch   || null)
      .input('cn2',  sql.NVarChar, b.contact_name || null)
      .input('ct',   sql.NVarChar, b.contact_tel  || null)
      .input('cnote',sql.NVarChar, b.contact_note || null)
      .input('wd',   sql.Date,     b.want_date ? new Date(b.want_date) : null)
      .input('ap',   sql.Date,     b.appointment_date ? new Date(b.appointment_date) : null)
      .input('pr',   sql.NVarChar, ['low', 'normal', 'urgent'].includes(b.priority) ? b.priority : 'normal')
      .input('cb',   sql.Int,      request.user.id)
      .query(`INSERT INTO impl_requests
                (req_no, req_type, title, detail, customer, branch,
                 contact_name, contact_tel, contact_note, want_date, appointment_date, priority, created_by)
              OUTPUT INSERTED.id
              VALUES (@no,@tp,@ti,@de,@cu,@br,@cn2,@ct,@cnote,@wd,@ap,@pr,@cb)`)).recordset[0].id;

    try {
      const uname = request.user.nickname || request.user.name || request.user.username || '—';
      const wd = b.want_date
        ? new Date(b.want_date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })
        : '';
      const msg = `\n📨[รับเรื่องประสานงาน] ${reqNo}` +
        `\nประเภท: ${IMPL_TYPES[b.req_type]}` +
        `\nเรื่อง: ${String(b.title).trim()}` +
        (b.customer ? `\nร้าน: ${b.customer}${b.branch ? ` (${b.branch})` : ''}` : '') +
        (b.contact_name || b.contact_tel
          ? `\nผู้ติดต่อ: ${[b.contact_name, b.contact_tel].filter(Boolean).join(' · ')}` : '') +
        (b.contact_note ? `\nช่องทางอื่น: ${b.contact_note}` : '') +
        (wd ? `\nวันที่ต้องการ: ${wd}` : '') +
        (b.appointment_date
          ? `\nนัดหมาย: ${new Date(b.appointment_date).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' })}` : '') +
        (b.priority === 'urgent' ? `\nความสำคัญ: ⚠️ ด่วน` : '') +
        `\nผู้แจ้ง: ${uname}`;
      await sendLineNotify(msg, 'impl_request');
    } catch (e) { console.warn('impl_request line notify failed:', e.message); }

    res.json({ id, req_no: reqNo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/impl-requests/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b  = request.body || {};
    const cur = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM impl_requests WHERE id=@id')).recordset[0];
    if (!cur) return res.status(404).json({ error: 'ไม่พบคำขอนี้' });
    if (b.status && !IMPL_STATUSES.includes(b.status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    if (b.req_type && !IMPL_TYPES[b.req_type]) return res.status(400).json({ error: 'ประเภทงานไม่ถูกต้อง' });

    const status = b.status || cur.status;
    await req()
      .input('id', sql.Int, id)
      .input('tp', sql.NVarChar, b.req_type || cur.req_type)
      .input('ti', sql.NVarChar, b.title != null ? String(b.title).trim() : cur.title)
      .input('de', sql.NVarChar, b.detail   !== undefined ? b.detail   : cur.detail)
      .input('cu', sql.NVarChar, b.customer !== undefined ? b.customer : cur.customer)
      .input('br', sql.NVarChar, b.branch   !== undefined ? b.branch   : cur.branch)
      .input('cn2',  sql.NVarChar, b.contact_name !== undefined ? b.contact_name : cur.contact_name)
      .input('ct',   sql.NVarChar, b.contact_tel  !== undefined ? b.contact_tel  : cur.contact_tel)
      .input('cnote',sql.NVarChar, b.contact_note !== undefined ? b.contact_note : cur.contact_note)
      .input('wd', sql.Date,     b.want_date !== undefined ? (b.want_date ? new Date(b.want_date) : null) : cur.want_date)
      .input('ap', sql.Date,     b.appointment_date !== undefined ? (b.appointment_date ? new Date(b.appointment_date) : null) : cur.appointment_date)
      .input('pr', sql.NVarChar, ['low', 'normal', 'urgent'].includes(b.priority) ? b.priority : cur.priority)
      .input('st', sql.NVarChar, status)
      .input('at', sql.Int,      b.assigned_to !== undefined ? (b.assigned_to || null) : cur.assigned_to)
      .input('nt', sql.NVarChar, b.note !== undefined ? b.note : cur.note)
      // เก็บเวลาที่รับเรื่อง/ปิดงานครั้งแรกไว้ ไม่ทับของเดิมถ้าเคยตั้งแล้ว
      .input('acc', sql.DateTime, cur.accepted_at || (status !== 'pending' ? new Date() : null))
      .input('dn',  sql.DateTime, status === 'done' ? (cur.done_at || new Date()) : null)
      .query(`UPDATE impl_requests SET
                req_type=@tp, title=@ti, detail=@de, customer=@cu, branch=@br,
                contact_name=@cn2, contact_tel=@ct, contact_note=@cnote,
                want_date=@wd, appointment_date=@ap,
                priority=@pr, status=@st, assigned_to=@at, note=@nt,
                accepted_at=@acc, done_at=@dn, updated_at=GETDATE()
              WHERE id=@id`);

    // แจ้งกลุ่มเฉพาะจังหวะที่เพิ่งเปลี่ยนเป็น "เสร็จสิ้น" (กันแจ้งซ้ำตอนแก้อย่างอื่น)
    if (status === 'done' && cur.status !== 'done') {
      try {
        const uname = request.user.nickname || request.user.name || request.user.username || '—';
        await sendLineNotify(
          `\n✅[เรื่องประสานงานเสร็จแล้ว] ${cur.req_no || `#${id}`}` +
          `\nประเภท: ${IMPL_TYPES[b.req_type || cur.req_type] || '—'}` +
          `\nเรื่อง: ${b.title != null ? String(b.title).trim() : cur.title}` +
          `\nปิดงานโดย: ${uname}`, 'impl_request');
      } catch (e) { console.warn('impl_request done notify failed:', e.message); }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/impl-requests/:id', authRequired, managerRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const files = (await req().input('rid', sql.Int, id)
      .query('SELECT stored_name FROM impl_request_files WHERE request_id=@rid')).recordset;
    await req().input('rid', sql.Int, id).query('DELETE FROM impl_request_comments WHERE request_id=@rid');
    await req().input('rid', sql.Int, id).query('DELETE FROM impl_request_files WHERE request_id=@rid');
    await req().input('id',  sql.Int, id).query('DELETE FROM impl_requests WHERE id=@id');
    // ลบไฟล์บนดิสก์ตามไปด้วย ไม่ปล่อยค้าง
    for (const f of files) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, 'impl', String(id), f.stored_name)); } catch {}
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/impl-requests/:id/files', authRequired, implUpload.array('files', 10), async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const saved = [];
    for (const f of (request.files || [])) {
      const name = fixUploadName(f.originalname);
      const row = (await req()
        .input('rid', sql.Int, id)
        .input('fn',  sql.NVarChar, name)
        .input('sn',  sql.NVarChar, f.filename)
        .input('sz',  sql.Int, f.size)
        .input('ub',  sql.Int, request.user.id)
        .query(`INSERT INTO impl_request_files (request_id, file_name, stored_name, size_bytes, uploaded_by)
                OUTPUT INSERTED.id VALUES (@rid,@fn,@sn,@sz,@ub)`)).recordset[0];
      saved.push({ id: row.id, file_name: name, size_bytes: f.size });
    }
    res.json({ ok: true, files: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  UAT JOBS + ISSUES
//  Flow: support เปิดงาน → UAT Staff แจ้ง slot → support ยืนยันกับลูกค้า
//        → ทดสอบ → แนบเอกสารผล UAT → ส่งต่อทีม Update → ปิดจบ
// ══════════════════════════════════════════════════════════

// งานที่ยังไม่จบ (ใช้กับ badge / stat)
const UAT_JOB_OPEN   = `('requested','slot_proposed','confirmed','testing','issues_found','retesting','passed','handed_to_update')`;
// Issue ที่ยังไม่จบ
const UAT_ISSUE_OPEN = `('open','sent_dev','fixing','fixed','retest_failed')`;

const UAT_STATUSES = ['requested','slot_proposed','confirmed','testing','issues_found',
                      'retesting','passed','handed_to_update','closed','cancelled'];

// UAT-YYYYMM-XXXX (ใช้ MAX เผื่อมีการลบจนเลขขาด)
async function genUatJobNo() {
  const ym = new Date().toISOString().substring(0, 7).replace('-', '');
  const prefix = `UAT-${ym}-`;
  const row = await req()
    .query(`SELECT ISNULL(MAX(CAST(SUBSTRING(job_no, ${prefix.length + 1}, 4) AS INT)), 0) + 1 AS n
            FROM uat_jobs WHERE job_no LIKE '${prefix}%'`);
  return `${prefix}${String(row.recordset[0].n).padStart(4, '0')}`;
}

const uatUserName = (u) => u?.name || u?.username || '—';

// ── GET /api/uat/badge — MUST come before /api/uat/:id ──
app.get('/api/uat/badge', authRequired, async (request, res) => {
  try {
    const r = (await req().query(`
      SELECT
        (SELECT COUNT(*) FROM uat_jobs   WHERE status IN ${UAT_JOB_OPEN})    AS jobs,
        (SELECT COUNT(*) FROM uat_issues WHERE status IN ${UAT_ISSUE_OPEN})  AS issues
    `)).recordset[0];
    res.json({ count: r?.jobs || 0, open_issues: r?.issues || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Issue-scoped routes (ต้องมาก่อน /api/uat/:id เพื่อไม่ให้ชน) ──

// GET แนบไฟล์ของ Issue
app.get('/api/uat/issues/:id/attachments', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('id', sql.Int, parseInt(request.params.id))
      .query(`SELECT a.*, ISNULL(e.nickname, e.name) AS uploaded_by_name
              FROM uat_attachments a
              LEFT JOIN app_users au ON au.id = a.created_by
              LEFT JOIN employees e  ON e.id  = au.employee_id
              WHERE a.issue_id=@id ORDER BY a.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST แนบไฟล์เข้า Issue (ภาพหน้าจอ / หลักฐานประกอบ)
app.post('/api/uat/issues/:id/attachments', authRequired, uatIssueUpload.array('files', 10), async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const files = request.files || [];
    if (!files.length) return res.status(400).json({ error: 'ไม่พบไฟล์' });
    const jobRow = (await req().input('id', sql.Int, id)
      .query('SELECT job_id FROM uat_issues WHERE id=@id')).recordset[0];
    if (!jobRow) return res.status(404).json({ error: 'ไม่พบ Issue' });
    const inserted = [];
    for (const f of files) {
      const r = await req()
        .input('jid', sql.Int,      jobRow.job_id)
        .input('iid', sql.Int,      id)
        .input('fn',  sql.NVarChar, f.filename)
        .input('on',  sql.NVarChar, fixUploadName(f.originalname))
        .input('fs',  sql.Int,      f.size)
        .input('mt',  sql.NVarChar, f.mimetype)
        .input('cb',  sql.Int,      request.user.id)
        .query(`INSERT INTO uat_attachments (scope,doc_type,job_id,issue_id,filename,original_name,file_size,mime_type,created_by)
                OUTPUT INSERTED.id VALUES (N'issue',N'other',@jid,@iid,@fn,@on,@fs,@mt,@cb)`);
      inserted.push({ id: r.recordset[0].id, filename: f.filename, original_name: fixUploadName(f.originalname) });
    }
    res.json({ ok: true, files: inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT แก้ไข Issue
app.put('/api/uat/issues/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b  = request.body;
    const done = ['retest_passed', 'wont_fix'].includes(b.status);
    await req()
      .input('id',  sql.Int,      id)
      .input('tp',  sql.NVarChar, b.topic        || null)
      .input('de',  sql.NVarChar, b.description  || null)
      .input('ex',  sql.NVarChar, b.expected     || null)
      .input('ac',  sql.NVarChar, b.actual       || null)
      .input('rs',  sql.NVarChar, b.resolution   || null)
      .input('sv',  sql.NVarChar, b.severity     || 'medium')
      .input('st',  sql.NVarChar, b.status       || 'open')
      .input('az',  sql.NVarChar, b.azure_id     || null)
      .input('dv',  sql.NVarChar, b.assigned_dev || null)
      .input('fb',  sql.Int,      b.found_by     || null)
      .input('dn',  sql.Bit,      done ? 1 : 0)
      .input('ub',  sql.Int,      request.user.id)
      .query(`UPDATE uat_issues SET
        topic=@tp, description=@de, expected=@ex, actual=@ac, resolution=@rs,
        severity=@sv, status=@st, azure_id=@az, assigned_dev=@dv, found_by=@fb,
        resolved_at = CASE WHEN @dn=1 THEN ISNULL(resolved_at, GETDATE()) ELSE NULL END,
        updated_at=GETDATE(), updated_by=@ub
        WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE Issue (+ ไฟล์แนบ)
app.delete('/api/uat/issues/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const dir = path.join(UPLOAD_DIR, 'uat', 'issue', String(id));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    await req().input('id', sql.Int, id).query('DELETE FROM uat_attachments WHERE issue_id=@id');
    await req().input('id', sql.Int, id).query('DELETE FROM uat_issues WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE ไฟล์แนบ (ทั้ง job และ issue)
app.delete('/api/uat/attachments/:id', authRequired, async (request, res) => {
  try {
    const id  = parseInt(request.params.id);
    const row = (await req().input('id', sql.Int, id)
      .query('SELECT * FROM uat_attachments WHERE id=@id')).recordset[0];
    if (!row) return res.status(404).json({ error: 'ไม่พบไฟล์' });
    const ownerId = row.scope === 'issue' ? row.issue_id : row.job_id;
    const filePath = path.join(UPLOAD_DIR, 'uat', row.scope, String(ownerId), row.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await req().input('id', sql.Int, id).query('DELETE FROM uat_attachments WHERE id=@id');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/uat — รายการงาน UAT ──
app.get('/api/uat', authRequired, async (request, res) => {
  try {
    const { status, priority, job_type, q } = request.query;
    let where = 'WHERE 1=1';
    const r = req();
    if (status)   { where += ' AND j.status=@st';   r.input('st', sql.NVarChar, status); }
    if (priority) { where += ' AND j.priority=@pr'; r.input('pr', sql.NVarChar, priority); }
    if (job_type) { where += ' AND j.job_type=@jt'; r.input('jt', sql.NVarChar, job_type); }
    if (q) {
      where += ' AND (j.job_no LIKE @q OR j.title LIKE @q OR j.version_to LIKE @q)';
      r.input('q', sql.NVarChar, `%${q}%`);
    }
    const rows = (await r.query(`
      SELECT j.*,
        ISNULL(e.nickname, e.name)   AS reporter_name,
        ISNULL(es.nickname, es.name) AS slot_by_name,      -- ผู้ UAT ที่รับงาน (คนแจ้ง slot)
        ISNULL(ep.nickname, ep.name) AS uat_passed_by_name,
        (SELECT COUNT(*) FROM uat_issues i WHERE i.job_id = j.id) AS issue_total,
        (SELECT COUNT(*) FROM uat_issues i WHERE i.job_id = j.id AND i.status IN ${UAT_ISSUE_OPEN}) AS issue_open,
        (SELECT COUNT(*) FROM uat_attachments a WHERE a.job_id = j.id AND a.doc_type='result') AS result_docs,
        (SELECT COUNT(*) FROM uat_attachments a WHERE a.job_id = j.id AND a.doc_type='kickoff') AS kickoff_docs
      FROM uat_jobs j
      LEFT JOIN app_users au  ON au.id  = j.reported_by    LEFT JOIN employees e  ON e.id  = au.employee_id
      LEFT JOIN app_users asl ON asl.id = j.slot_by        LEFT JOIN employees es ON es.id = asl.employee_id
      LEFT JOIN app_users ap  ON ap.id  = j.uat_passed_by  LEFT JOIN employees ep ON ep.id = ap.employee_id
      ${where}
      ORDER BY j.created_at DESC
    `)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/uat — support/team เปิดงาน (ขั้นที่ 1) ──
app.post('/api/uat', authRequired, async (request, res) => {
  try {
    const b = request.body;
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'กรุณาระบุเรื่องที่ขอทดสอบ' });
    const jobNo = await genUatJobNo();
    const result = await req()
      .input('jn',  sql.NVarChar, jobNo)
      .input('ti',  sql.NVarChar, String(b.title).trim())
      .input('jt',  sql.NVarChar, b.job_type     || 'version_update')
      .input('vf',  sql.NVarChar, b.version_from || null)
      .input('vt',  sql.NVarChar, b.version_to   || null)
      .input('rq',  sql.Date,     b.requested_date ? new Date(b.requested_date) : null)
      .input('pr',  sql.NVarChar, b.priority     || 'normal')
      .input('nt',  sql.NVarChar, b.note         || null)
      .input('rb',  sql.Int,      b.reported_by  || request.user.id || null)
      .input('cb',  sql.Int,      request.user.id)
      .query(`INSERT INTO uat_jobs
        (job_no,title,job_type,version_from,version_to,requested_date,
         priority,status,note,reported_by,created_by)
        OUTPUT INSERTED.id, INSERTED.job_no
        VALUES (@jn,@ti,@jt,@vf,@vt,@rq,@pr,N'requested',@nt,@rb,@cb)`);
    const newId = result.recordset[0].id;
    await sendLineNotify(
      `\n🧪 Request UAT ใหม่ [${jobNo}]\n` +
      `${String(b.title).trim()}\n` +
      (b.version_to ? `📦 Version: ${b.version_from || '—'} → ${b.version_to}\n` : '') +
      `📅 วันที่ต้องการ: ${b.requested_date || 'ยังไม่ระบุ'}\n` +
      `👤 ผู้แจ้ง: ${uatUserName(request.user)}\n` +
      `⏳ รอทีม UAT แจ้ง slot`,
      'uat_job');
    res.json({ id: newId, job_no: result.recordset[0].job_no });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/uat/:id — รายละเอียด + issues + ไฟล์แนบ ──
app.get('/api/uat/:id', authRequired, async (request, res) => {
  try {
    const id  = parseInt(request.params.id);
    const job = (await req().input('id', sql.Int, id).query(`
      SELECT j.*,
        ISNULL(er.nickname, er.name) AS reporter_name,
        ISNULL(es.nickname, es.name) AS slot_by_name,
        ISNULL(ec.nickname, ec.name) AS confirmed_by_name,
        ISNULL(ep.nickname, ep.name) AS uat_passed_by_name,
        ISNULL(eh.nickname, eh.name) AS handed_by_name
      FROM uat_jobs j
      LEFT JOIN app_users ar ON ar.id = j.reported_by   LEFT JOIN employees er ON er.id = ar.employee_id
      LEFT JOIN app_users asl ON asl.id = j.slot_by     LEFT JOIN employees es ON es.id = asl.employee_id
      LEFT JOIN app_users ac ON ac.id = j.confirmed_by  LEFT JOIN employees ec ON ec.id = ac.employee_id
      LEFT JOIN app_users ap ON ap.id = j.uat_passed_by LEFT JOIN employees ep ON ep.id = ap.employee_id
      LEFT JOIN app_users ah ON ah.id = j.handed_by     LEFT JOIN employees eh ON eh.id = ah.employee_id
      WHERE j.id=@id`)).recordset[0];
    if (!job) return res.status(404).json({ error: 'ไม่พบงาน UAT' });
    job.issues = (await req().input('id', sql.Int, id).query(`
      SELECT i.*, ISNULL(e.nickname, e.name) AS found_by_name,
        (SELECT COUNT(*) FROM uat_attachments a WHERE a.issue_id = i.id) AS attach_count
      FROM uat_issues i
      LEFT JOIN app_users au ON au.id = i.found_by
      LEFT JOIN employees e  ON e.id  = au.employee_id
      WHERE i.job_id=@id ORDER BY i.issue_no, i.id`)).recordset;
    job.attachments = (await req().input('id', sql.Int, id)
      .query(`SELECT a.*, ISNULL(e.nickname, e.name) AS uploaded_by_name
              FROM uat_attachments a
              LEFT JOIN app_users au ON au.id = a.created_by
              LEFT JOIN employees e  ON e.id  = au.employee_id
              WHERE a.job_id=@id AND a.scope=N'job' ORDER BY a.created_at`)).recordset;
    res.json(job);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/uat/:id/issues ──
app.get('/api/uat/:id/issues', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('id', sql.Int, parseInt(request.params.id)).query(`
      SELECT i.*, ISNULL(e.nickname, e.name) AS found_by_name,
        (SELECT COUNT(*) FROM uat_attachments a WHERE a.issue_id = i.id) AS attach_count
      FROM uat_issues i
      LEFT JOIN app_users au ON au.id = i.found_by
      LEFT JOIN employees e  ON e.id  = au.employee_id
      WHERE i.job_id=@id ORDER BY i.issue_no, i.id`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/uat/:id/issues — บันทึกปัญหาตามฟอร์แมตในเอกสาร ──
app.post('/api/uat/:id/issues', authRequired, async (request, res) => {
  try {
    const jobId = parseInt(request.params.id);
    const b = request.body;
    if (!b.topic || !String(b.topic).trim()) return res.status(400).json({ error: 'กรุณาระบุ Topic' });
    const job = (await req().input('id', sql.Int, jobId)
      .query('SELECT job_no, title, status FROM uat_jobs WHERE id=@id')).recordset[0];
    if (!job) return res.status(404).json({ error: 'ไม่พบงาน UAT' });
    const nextNo = (await req().input('id', sql.Int, jobId)
      .query('SELECT ISNULL(MAX(issue_no),0)+1 AS n FROM uat_issues WHERE job_id=@id')).recordset[0].n;
    const result = await req()
      .input('jid', sql.Int,      jobId)
      .input('no',  sql.Int,      nextNo)
      .input('tp',  sql.NVarChar, String(b.topic).trim())
      .input('de',  sql.NVarChar, b.description  || null)
      .input('ex',  sql.NVarChar, b.expected     || null)
      .input('ac',  sql.NVarChar, b.actual       || null)
      .input('rs',  sql.NVarChar, b.resolution   || null)
      .input('sv',  sql.NVarChar, b.severity     || 'medium')
      .input('st',  sql.NVarChar, b.status       || 'open')
      .input('az',  sql.NVarChar, b.azure_id     || null)
      .input('dv',  sql.NVarChar, b.assigned_dev || null)
      .input('fb',  sql.Int,      b.found_by     || request.user.id || null)
      .input('cb',  sql.Int,      request.user.id)
      .query(`INSERT INTO uat_issues
        (job_id,issue_no,topic,description,expected,actual,resolution,severity,status,azure_id,assigned_dev,found_by,created_by)
        OUTPUT INSERTED.id VALUES (@jid,@no,@tp,@de,@ex,@ac,@rs,@sv,@st,@az,@dv,@fb,@cb)`);
    // กำลังทดสอบอยู่แล้วเจอปัญหา → เลื่อนสถานะเป็น "พบปัญหา" อัตโนมัติ
    if (job.status === 'testing') {
      await req().input('id', sql.Int, jobId)
        .query(`UPDATE uat_jobs SET status='issues_found', updated_at=GETDATE() WHERE id=@id`);
    }
    const sevLabel = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '⚪ Low' }[b.severity || 'medium'];
    await sendLineNotify(
      `\n🐞 พบปัญหาจาก UAT [${job.job_no}] #${nextNo}\n` +
      `${job.title}\n` +
      `Topic: ${String(b.topic).trim()}\n` +
      `ระดับ: ${sevLabel}\n` +
      (b.expected ? `Expected: ${String(b.expected).slice(0, 150)}\n` : '') +
      (b.actual   ? `Actual: ${String(b.actual).slice(0, 150)}\n` : '') +
      `👤 ผู้พบ: ${uatUserName(request.user)}`,
      'uat_issue');
    res.json({ id: result.recordset[0].id, issue_no: nextNo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ไฟล์แนบระดับงาน — ?doc_type=kickoff|result|other ──
app.get('/api/uat/:id/attachments', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('id', sql.Int, parseInt(request.params.id))
      .query(`SELECT a.*, ISNULL(e.nickname, e.name) AS uploaded_by_name
              FROM uat_attachments a
              LEFT JOIN app_users au ON au.id = a.created_by
              LEFT JOIN employees e  ON e.id  = au.employee_id
              WHERE a.job_id=@id AND a.scope=N'job' ORDER BY a.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/uat/:id/attachments', authRequired, uatJobUpload.array('files', 10), async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const files = request.files || [];
    if (!files.length) return res.status(400).json({ error: 'ไม่พบไฟล์' });
    const docType = ['kickoff', 'result', 'other'].includes(request.query.doc_type)
      ? request.query.doc_type : 'other';
    const inserted = [];
    for (const f of files) {
      const r = await req()
        .input('jid', sql.Int,      id)
        .input('dt',  sql.NVarChar, docType)
        .input('fn',  sql.NVarChar, f.filename)
        .input('on',  sql.NVarChar, fixUploadName(f.originalname))
        .input('fs',  sql.Int,      f.size)
        .input('mt',  sql.NVarChar, f.mimetype)
        .input('cb',  sql.Int,      request.user.id)
        .query(`INSERT INTO uat_attachments (scope,doc_type,job_id,issue_id,filename,original_name,file_size,mime_type,created_by)
                OUTPUT INSERTED.id VALUES (N'job',@dt,@jid,NULL,@fn,@on,@fs,@mt,@cb)`);
      inserted.push({ id: r.recordset[0].id, filename: f.filename, original_name: fixUploadName(f.originalname) });
    }
    res.json({ ok: true, doc_type: docType, files: inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ ขั้นตอนงาน ═════════════════════════════════════════════

// ขั้นที่ 2 — UAT Staff แจ้ง slot ว่าว่างวันไหน (requested → slot_proposed)
app.post('/api/uat/:id/schedule', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const { test_date_from, test_date_to } = request.body;
    if (!test_date_from) return res.status(400).json({ error: 'กรุณาระบุวันเริ่มทดสอบ' });
    const job = (await req().input('id', sql.Int, id)
      .query('SELECT job_no, title FROM uat_jobs WHERE id=@id')).recordset[0];
    if (!job) return res.status(404).json({ error: 'ไม่พบงาน UAT' });
    await req()
      .input('id', sql.Int,  id)
      .input('df', sql.Date, new Date(test_date_from))
      .input('dt', sql.Date, test_date_to ? new Date(test_date_to) : new Date(test_date_from))
      .input('ub', sql.Int,  request.user.id)
      .query(`UPDATE uat_jobs SET test_date_from=@df, test_date_to=@dt,
              status='slot_proposed', slot_by=@ub, slot_at=GETDATE(),
              confirmed_at=NULL, confirmed_by=NULL,
              updated_at=GETDATE(), updated_by=@ub WHERE id=@id`);
    await sendLineNotify(
      `\n📅 ทีม UAT แจ้ง slot [${job.job_no}]\n` +
      `${job.title}\n` +
      `Slot ที่ว่าง: ${test_date_from}${test_date_to && test_date_to !== test_date_from ? ` – ${test_date_to}` : ''}\n` +
      `👤 แจ้งโดย: ${uatUserName(request.user)}\n` +
      `⏳ รอ Support ยืนยันกับลูกค้าว่าตรงกันไหม`,
      'uat_job');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ขั้นที่ 3 — Support ยืนยันกับลูกค้าว่า slot ตรงกัน (slot_proposed → confirmed)
app.post('/api/uat/:id/confirm', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const job = (await req().input('id', sql.Int, id)
      .query('SELECT job_no, title, test_date_from, test_date_to FROM uat_jobs WHERE id=@id')).recordset[0];
    if (!job) return res.status(404).json({ error: 'ไม่พบงาน UAT' });
    if (!job.test_date_from) return res.status(400).json({ error: 'ทีม UAT ยังไม่ได้แจ้ง slot — ยืนยันกับลูกค้าไม่ได้' });
    await req().input('id', sql.Int, id).input('ub', sql.Int, request.user.id)
      .query(`UPDATE uat_jobs SET status='confirmed', confirmed_at=GETDATE(), confirmed_by=@ub,
              updated_at=GETDATE(), updated_by=@ub WHERE id=@id`);
    const d = (x) => x ? new Date(x).toISOString().slice(0,10) : '—';
    await sendLineNotify(
      `\n🤝 Support ยืนยัน slot กับลูกค้าแล้ว [${job.job_no}]\n` +
      `${job.title}\n` +
      `วันทดสอบ: ${d(job.test_date_from)}${job.test_date_to ? ` – ${d(job.test_date_to)}` : ''}\n` +
      `👤 ยืนยันโดย: ${uatUserName(request.user)}`,
      'uat_job');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ขั้นที่ 4 — เปลี่ยนสถานะ (เริ่มทดสอบ / UAT ผ่าน / ส่งต่อทีม Update / ปิดจบ)
app.post('/api/uat/:id/status', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const st = String(request.body?.status || '');
    if (!UAT_STATUSES.includes(st)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    const job = (await req().input('id', sql.Int, id)
      .query('SELECT job_no, title, version_to, status FROM uat_jobs WHERE id=@id')).recordset[0];
    if (!job) return res.status(404).json({ error: 'ไม่พบงาน UAT' });

    // กติกา: จะกด "UAT ผ่าน" ได้ต้องแนบเอกสารผลการทดสอบก่อน
    if (st === 'passed') {
      const n = (await req().input('id', sql.Int, id)
        .query(`SELECT COUNT(*) AS c FROM uat_attachments WHERE job_id=@id AND doc_type='result'`)).recordset[0].c;
      if (!n) return res.status(400).json({
        error: 'ต้องแนบเอกสารยืนยันผล UAT (ผ่าน) ก่อน จึงจะปิดผลการทดสอบได้' });
      const openIssues = (await req().input('id', sql.Int, id)
        .query(`SELECT COUNT(*) AS c FROM uat_issues WHERE job_id=@id AND status IN ${UAT_ISSUE_OPEN}`)).recordset[0].c;
      if (openIssues) return res.status(400).json({
        error: `ยังมี Issue ค้างอยู่ ${openIssues} รายการ — ต้อง Re-test ให้ผ่านก่อน` });
    }
    // จะส่งต่อทีม Update ได้ต้องผ่าน UAT ก่อน
    if (st === 'handed_to_update' && !['passed','handed_to_update'].includes(job.status)) {
      return res.status(400).json({ error: 'ต้องปิดผล UAT ว่าผ่านก่อน จึงจะส่งต่อทีม Update ได้' });
    }

    const extra = st === 'passed'           ? ', uat_passed_at=GETDATE(), uat_passed_by=@ub'
                : st === 'handed_to_update' ? ', handed_at=GETDATE(), handed_by=@ub'
                : '';
    await req().input('id', sql.Int, id).input('st', sql.NVarChar, st).input('ub', sql.Int, request.user.id)
      .query(`UPDATE uat_jobs SET status=@st${extra}, updated_at=GETDATE(), updated_by=@ub WHERE id=@id`);

    const who = uatUserName(request.user);
    if (st === 'passed') {
      await sendLineNotify(
        `\n✅ UAT ผ่านแล้ว [${job.job_no}]\n${job.title}\n` +
        `แนบเอกสารยืนยันผลเรียบร้อย\n👤 ปิดผลโดย: ${who}\n➡️ พร้อมส่งต่อทีม Update`, 'uat_job');
    } else if (st === 'handed_to_update') {
      await sendLineNotify(
        `\n📤 ส่งต่อทีม Update แล้ว [${job.job_no}]\n${job.title}\n` +
        (job.version_to ? `📦 Version: ${job.version_to}\n` : '') +
        `👤 ส่งต่อโดย: ${who}`, 'uat_job');
    } else if (st === 'closed') {
      await sendLineNotify(`\n🏁 ปิดงาน UAT [${job.job_no}]\n${job.title}\n👤 ปิดโดย: ${who}`, 'uat_job');
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/uat/:id/draft-doc ──
// เอกสารเปิดงานทดสอบ (Test Kickoff) แบบร่าง — เปิดใน Word ได้เลย ให้ผู้แจ้งกรอกแล้วอัพโหลดกลับ
app.get('/api/uat/:id/draft-doc', authRequired, async (request, res) => {
  try {
    const id  = parseInt(request.params.id);
    const job = (await req().input('id', sql.Int, id).query(`
      SELECT j.*, ISNULL(e.nickname, e.name) AS reporter_name
      FROM uat_jobs j
      LEFT JOIN app_users au ON au.id = j.reported_by
      LEFT JOIN employees e  ON e.id  = au.employee_id
      WHERE j.id=@id`)).recordset[0];
    if (!job) return res.status(404).json({ error: 'ไม่พบงาน UAT' });

    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const val = (s) => s ? esc(s) : '<span style="color:#999">— กรุณากรอก —</span>';
    const day = (d) => d ? new Date(d).toISOString().slice(0,10) : null;
    const period = job.test_date_from
      ? `${day(job.test_date_from)}${job.test_date_to && day(job.test_date_to) !== day(job.test_date_from) ? ` ถึง ${day(job.test_date_to)}` : ''}`
      : (job.requested_date ? `${day(job.requested_date)} (วันที่ผู้แจ้งต้องการ — รอทีม UAT แจ้ง slot)` : null);
    const TYPE_TH = { version_update:'อัพเดท Version', sync_test:'ทดสอบ Sync ข้าม Version',
                      feature:'ฟีเจอร์ใหม่', hotfix:'Hotfix', other:'อื่น ๆ' };
    const kv = (k, v) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`;
    const fill = (lines = 4) => '<p class="fill">' + Array(lines).fill('&nbsp;').join('</p><p class="fill">') + '</p>';

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(job.job_no)} Test Kickoff</title>
<style>
 @page { size: A4; margin: 2cm; }
 body { font-family: "TH SarabunPSK","Tahoma",sans-serif; font-size: 15pt; color:#000; }
 h1 { font-size: 19pt; margin: 0 0 2pt; }
 h2 { font-size: 15pt; margin: 16pt 0 4pt; border-bottom: 1px solid #999; padding-bottom: 2pt; }
 .sub { font-size: 12pt; color: #555; margin: 0 0 12pt; }
 table { border-collapse: collapse; width: 100%; margin-bottom: 6pt; }
 td { border: 1px solid #999; padding: 4pt 6pt; vertical-align: top; font-size: 13pt; }
 td.k { width: 32%; background: #f0f0f0; font-weight: bold; }
 p { margin: 3pt 0; font-size: 13pt; }
 p.fill { border-bottom: 1px dotted #aaa; min-height: 14pt; }
 ol, ul { margin: 3pt 0 3pt 18pt; font-size: 13pt; }
 .note { font-size: 11pt; color: #a00; }
</style></head>
<body>
<h1>เอกสารเปิดงานทดสอบระบบ (Test Kickoff Document)</h1>
<p class="sub">เลขที่งาน ${esc(job.job_no)} · ฉบับร่างสำหรับกรอก แล้วบันทึกและอัพโหลดกลับเข้าระบบ CS Team Manager</p>

<table>
  ${kv('โครงการ / Project', val(job.title))}
  ${kv('ประเภทงาน', esc(TYPE_TH[job.job_type] || TYPE_TH.other))}
  ${kv('วันที่ทดสอบ', period ? esc(period) : '<span style="color:#999">— รอทีม UAT แจ้ง slot —</span>')}
  ${kv('ทีมที่รับผิดชอบ', 'ทีม UAT')}
  ${kv('ผู้ประสานงาน / จัดทำโดย', '&nbsp;')}
  ${kv('ผู้แจ้ง', val(job.reporter_name))}
  ${kv('สถานะเอกสาร', 'ฉบับร่างสำหรับเปิดงาน (Draft for kickoff)')}
</table>

<h2>1. วัตถุประสงค์ (Objective)</h2>
${job.note ? `<p>${esc(job.note).replace(/\n/g,'</p><p>')}</p>${fill(2)}` : fill(4)}

<h2>2. ขอบเขตงาน (Scope)</h2>
<p><b>2.1 ระบบ / สาขาที่ทำการอัพเดท</b></p>
${fill(4)}
<p><b>2.2 ระบบ / สาขาที่ใช้ทดสอบเปรียบเทียบ (คงของเดิม)</b></p>
${fill(3)}

<h2>3. ข้อมูล Version สำหรับการอัพเดท</h2>
<table>
  <tr><td class="k">ส่วนประกอบ</td><td class="k">Version</td><td class="k">แหล่งดาวน์โหลด (FTP)</td></tr>
  <tr><td>Version ปัจจุบัน (ก่อนอัพเดท)</td><td>${val(job.version_from)}</td><td>—</td></tr>
  <tr><td>Version ที่จะอัพเดท</td><td>${val(job.version_to)}</td><td>&nbsp;</td></tr>
  <tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr>
</table>

<h2>4. ข้อมูลการเชื่อมต่อเครื่อง Remote</h2>
<table>
  ${kv('เลขรีโมทเครื่อง (Remote ID)', '&nbsp;')}
  ${kv('รหัสผ่าน (Password)', '&nbsp;')}
</table>
<p class="note">หมายเหตุ: ข้อมูลการเข้าถึงเครื่อง Remote เป็นข้อมูลสำคัญ กรุณาใช้เฉพาะผู้ที่เกี่ยวข้องกับงานนี้เท่านั้น และไม่เผยแพร่ต่อ · ระบบไม่ได้จัดเก็บข้อมูลนี้ไว้ในฐานข้อมูล</p>

<h2>5. ขั้นตอนการทดสอบ (Test Steps)</h2>
${fill(8)}

<h2>6. รูปแบบการบันทึกและแจ้งปัญหา (Issue Reporting Format)</h2>
<p>กรณีพบข้อผิดพลาด ให้บันทึกในระบบ CS Team Manager &gt; แจ้งงาน UAT &gt; ${esc(job.job_no)} &gt; แจ้ง Issue ตามรูปแบบ:</p>
<ul>
  <li><b>Topic</b> — หัวข้อ/ชื่อปัญหาโดยสรุป</li>
  <li><b>Description</b> — รายละเอียดของปัญหาที่พบ</li>
  <li><b>Expected Behavior</b> — พฤติกรรมที่ระบบควรทำงาน</li>
  <li><b>Actual Behavior</b> — พฤติกรรมที่ระบบทำงานจริง (ผิดปกติ)</li>
</ul>

<h2>7. เกณฑ์ผ่านการทดสอบ (Pass Criteria)</h2>
${fill(5)}

<h2>8. ผู้เกี่ยวข้อง (Stakeholders)</h2>
<table>
  <tr><td class="k">บทบาท</td><td class="k">ผู้รับผิดชอบ</td></tr>
  <tr><td>ผู้เปิดงาน (Support / Team)</td><td>${val(job.reporter_name)}</td></tr>
  <tr><td>ผู้ประสานงาน</td><td>&nbsp;</td></tr>
  <tr><td>ทีมทดสอบ (UAT Staff)</td><td>&nbsp;</td></tr>
  <tr><td>ทีมแก้ไขปัญหา (Developer)</td><td>&nbsp;</td></tr>
  <tr><td>ทีมอัพเดท (Update)</td><td>&nbsp;</td></tr>
</table>

<h2>9. สรุปผลการทดสอบ (กรอกเมื่อทดสอบเสร็จ)</h2>
<table>
  ${kv('ผลการทดสอบ', '☐ ผ่าน &nbsp;&nbsp; ☐ ไม่ผ่าน &nbsp;&nbsp; ☐ ผ่านแบบมีเงื่อนไข')}
  ${kv('วันที่ทดสอบจริง', '&nbsp;')}
  ${kv('ผู้ทดสอบ (UAT Staff)', '&nbsp;')}
  ${kv('ลงชื่อผู้ยืนยันผล', '&nbsp;')}
</table>
<p class="note">เอกสารหน้านี้เมื่อกรอกผลว่า “ผ่าน” แล้ว ให้อัพโหลดกลับเข้าระบบเป็น <b>เอกสารผล UAT</b> ก่อน จึงจะกดปิดผลและส่งต่อทีม Update ได้</p>
</body></html>`;

    const filename = `${job.job_no}_Test_Kickoff_Draft.doc`;
    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send('﻿' + html);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/uat/:id — แก้ข้อมูลที่ผู้แจ้งกรอก (สถานะ/วันที่คุมด้วยปุ่มขั้นตอนงาน) ──
app.put('/api/uat/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const b  = request.body;
    await req()
      .input('id',  sql.Int,      id)
      .input('ti',  sql.NVarChar, b.title        || null)
      .input('jt',  sql.NVarChar, b.job_type     || 'version_update')
      .input('vf',  sql.NVarChar, b.version_from || null)
      .input('vt',  sql.NVarChar, b.version_to   || null)
      .input('rq',  sql.Date,     b.requested_date ? new Date(b.requested_date) : null)
      .input('pr',  sql.NVarChar, b.priority     || 'normal')
      .input('nt',  sql.NVarChar, b.note         || null)
      .input('rb',  sql.Int,      b.reported_by  || null)
      .input('ub',  sql.Int,      request.user.id)
      .query(`UPDATE uat_jobs SET
        title=@ti, job_type=@jt, version_from=@vf, version_to=@vt,
        requested_date=@rq, priority=@pr, note=@nt, reported_by=@rb,
        updated_at=GETDATE(), updated_by=@ub
        WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/uat/:id — ลบงานพร้อม issue / ไฟล์แนบ ──
app.delete('/api/uat/:id', authRequired, managerRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const issueIds = (await req().input('id', sql.Int, id)
      .query('SELECT id FROM uat_issues WHERE job_id=@id')).recordset.map(x => x.id);
    for (const iid of issueIds) {
      const d = path.join(UPLOAD_DIR, 'uat', 'issue', String(iid));
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
    const jobDir = path.join(UPLOAD_DIR, 'uat', 'job', String(id));
    if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
    await req().input('id', sql.Int, id).query('DELETE FROM uat_attachments WHERE job_id=@id');
    await req().input('id', sql.Int, id).query('DELETE FROM uat_issues WHERE job_id=@id');
    await req().input('id', sql.Int, id).query('DELETE FROM uat_jobs WHERE id=@id');
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
//  POD ASSIGN — pods / members / customers (cs_team)
// ══════════════════════════════════════════════════════════

// ── Pods ──────────────────────────────────────────────────
app.get('/api/pods', authRequired, async (request, res) => {
  try {
    const result = await req().query(`
      SELECT p.id, p.code, p.display_name, p.region, p.lead_employee_id,
             p.color, p.sort_order, p.active, p.created_at,
             e.name AS lead_name, e.nickname AS lead_nickname,
             (SELECT COUNT(*) FROM pod_members pm WHERE pm.pod_id=p.id AND pm.active=1)            AS member_count,
             (SELECT COUNT(*) FROM customers c WHERE c.pod_id=p.id AND c.active=1)                 AS customer_count,
             (SELECT ISNULL(SUM(c.branches),0) FROM customers c WHERE c.pod_id=p.id AND c.active=1) AS total_branches
      FROM pods p
      LEFT JOIN employees e ON e.id = p.lead_employee_id
      WHERE p.active=1
      ORDER BY p.sort_order, p.code`);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pods', authRequired, managerRequired, async (request, res) => {
  const { code, display_name, region, lead_employee_id, color, sort_order } = request.body;
  if (!code || !display_name) return res.status(400).json({ error: 'code and display_name required' });
  try {
    const result = await req()
      .input('code',         sql.NVarChar, code)
      .input('display_name', sql.NVarChar, display_name)
      .input('region',       sql.NVarChar, region || 'BKK')
      .input('lead',         sql.Int,      lead_employee_id || null)
      .input('color',        sql.NVarChar, color || '#1d4ed8')
      .input('sort_order',   sql.Int,      sort_order || 0)
      .query(`INSERT INTO pods (code, display_name, region, lead_employee_id, color, sort_order)
              OUTPUT INSERTED.id
              VALUES (@code, @display_name, @region, @lead, @color, @sort_order)`);
    res.json({ id: result.recordset[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/pods/:id', authRequired, managerRequired, async (request, res) => {
  const { code, display_name, region, lead_employee_id, color, sort_order, active } = request.body;
  try {
    await req()
      .input('code',         sql.NVarChar, code)
      .input('display_name', sql.NVarChar, display_name)
      .input('region',       sql.NVarChar, region || 'BKK')
      .input('lead',         sql.Int,      lead_employee_id || null)
      .input('color',        sql.NVarChar, color || '#1d4ed8')
      .input('sort_order',   sql.Int,      sort_order || 0)
      .input('active',       sql.Bit,      active ?? 1)
      .input('id',           sql.Int,      request.params.id)
      .query(`UPDATE pods SET code=@code, display_name=@display_name, region=@region,
              lead_employee_id=@lead, color=@color, sort_order=@sort_order, active=@active
              WHERE id=@id`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pods/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, request.params.id)
      .query('UPDATE pods SET active=0 WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pod members ───────────────────────────────────────────
app.get('/api/pods/:id/members', authRequired, async (request, res) => {
  try {
    const result = await req().input('pid', sql.Int, request.params.id)
      .query(`SELECT pm.id, pm.pod_id, pm.employee_id, pm.role_in_pod, pm.assigned_at,
                     e.name, e.nickname, e.team,
                     s.shift_type,
                     CASE WHEN st.start_time IS NOT NULL AND st.end_time IS NOT NULL
                          THEN CONVERT(varchar(5), st.start_time, 108) + N'–' + CONVERT(varchar(5), st.end_time, 108)
                          ELSE NULL END AS shift_time
              FROM pod_members pm
              JOIN employees e ON e.id = pm.employee_id
              LEFT JOIN shifts s ON s.employee_id = pm.employee_id AND s.shift_date = CAST(GETDATE() AS DATE)
              LEFT JOIN shift_types st ON st.shift_key = s.shift_type
              WHERE pm.pod_id=@pid AND pm.active=1
              ORDER BY CASE pm.role_in_pod WHEN 'lead' THEN 0 WHEN 'junior' THEN 1 ELSE 2 END, e.name`);
    const statusOf = (t) => t == null ? 'none' : (t === 'dayoff' || String(t).startsWith('leave_') ? 'off' : 'work');
    res.json(result.recordset.map(r => ({ ...r, status: statusOf(r.shift_type) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pods/:id/members', authRequired, managerRequired, async (request, res) => {
  const { employee_id, role_in_pod } = request.body;
  if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
  try {
    const result = await req()
      .input('pid',  sql.Int,      request.params.id)
      .input('eid',  sql.Int,      employee_id)
      .input('role', sql.NVarChar, role_in_pod || 'member')
      .query(`INSERT INTO pod_members (pod_id, employee_id, role_in_pod)
              OUTPUT INSERTED.id VALUES (@pid, @eid, @role)`);
    res.json({ id: result.recordset[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/pod-members/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, request.params.id)
      .query('UPDATE pod_members SET active=0 WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Board data — pods + lead + all members, each with today's work status
// License load — distinct RegistrationId with call activity in the last 3 months (LicenseDB)
app.get('/api/pods/license-load', authRequired, async (request, res) => {
  try {
    const ext = getExtPool();
    if (!ext) return res.json({ licenses: null, calls: null, months: 3 });
    const r = await extReq().query(`
      SELECT COUNT(DISTINCT RegistrationId) AS licenses, COUNT(*) AS calls
      FROM Calllog
      WHERE Active = 1 AND ReceiveDate >= DATEADD(month, -3, GETDATE())`);
    res.json({ licenses: r.recordset[0].licenses, calls: r.recordset[0].calls, months: 3 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Customer groups from LicenseDB (CustomerGroup) with branch + ticket counts (year-to-date)
app.get('/api/pods/customer-groups', authRequired, async (request, res) => {
  try {
    const ext = getExtPool();
    if (!ext) return res.json([]);
    const groups = (await extReq().query(`
      SELECT cg.GroupName,
             COUNT(DISTINCT cr.RegistrationId) AS NumOfBranch,
             COUNT(cl.CalllogId)               AS NumOfTicket
      FROM Calllog cl
      INNER JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId AND cr.AccurateData = 1
      INNER JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
      WHERE cl.ReceiveDate >= DATEADD(month, -3, GETDATE())
      GROUP BY cg.GroupName
      ORDER BY NumOfTicket DESC`)).recordset;
    // match to internal customers to show current pod assignment
    const custs = (await req().query(`
      SELECT c.name, c.pod_id, p.code AS pod_code
      FROM customers c LEFT JOIN pods p ON p.id = c.pod_id
      WHERE c.active = 1`)).recordset;
    const byName = {};
    custs.forEach(c => { byName[c.name] = c; });
    res.json(groups.map(g => ({
      name: g.GroupName, branches: g.NumOfBranch, tickets: g.NumOfTicket,
      pod_id: byName[g.GroupName]?.pod_id || null,
      pod_code: byName[g.GroupName]?.pod_code || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Staffing helper — per-pod 3-month ticket load vs current headcount
app.get('/api/pods/staffing', authRequired, async (request, res) => {
  try {
    const ext = getExtPool();
    const tkBy = {};
    if (ext) {
      const tk = (await extReq().query(`
        SELECT cg.GroupName, COUNT(cl.CalllogId) AS tickets
        FROM Calllog cl
        JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId AND cr.AccurateData = 1
        JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
        WHERE cl.ReceiveDate >= DATEADD(month, -3, GETDATE())
        GROUP BY cg.GroupName`)).recordset;
      tk.forEach(r => { tkBy[r.GroupName] = r.tickets; });
    }
    const pods  = (await req().query(`SELECT id, code, display_name, region FROM pods WHERE active=1 ORDER BY sort_order, code`)).recordset;
    const cust  = (await req().query(`SELECT name, pod_id FROM customers WHERE active=1 AND pod_id IS NOT NULL`)).recordset;
    const mem   = (await req().query(`SELECT pod_id, employee_id FROM pod_members WHERE active=1`)).recordset;
    const leads = (await req().query(`SELECT id AS pod_id, lead_employee_id FROM pods WHERE active=1 AND lead_employee_id IS NOT NULL`)).recordset;
    const staff = {}; pods.forEach(p => staff[p.id] = new Set());
    mem.forEach(m => staff[m.pod_id] && staff[m.pod_id].add(m.employee_id));
    leads.forEach(l => staff[l.pod_id] && staff[l.pod_id].add(l.lead_employee_id));
    const podTk = {}; cust.forEach(c => { podTk[c.pod_id] = (podTk[c.pod_id] || 0) + (tkBy[c.name] || 0); });
    const months = 3;
    res.json({
      months, hasLicense: !!ext,
      pods: pods.map(p => ({
        code: p.code, region: p.region, display_name: p.display_name,
        tickets3mo: podTk[p.id] || 0,
        ticketsMonth: Math.round((podTk[p.id] || 0) / months),
        staff: staff[p.id].size,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Monitor — ticket trend by company × month (uses LicenseDB SP usp_RPT_TicketByCompanyMonth)
app.get('/api/pods/ticket-monthly', authRequired, async (request, res) => {
  try {
    const ext = getExtPool();
    if (!ext) return res.json({ rows: [], months: [] });
    const dealer = (request.query.dealer || 'INF').toString().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50) || 'INF';
    const r = await extReq().input('dc', sql.NVarChar, dealer)
      .query('EXEC usp_RPT_TicketByCompanyMonth @DealerCode=@dc');
    const rows = r.recordset || [];
    if (rows.length && rows[0].Message !== undefined && Object.keys(rows[0]).length === 1) {
      return res.json({ rows: [], months: [], message: rows[0].Message, dealer });
    }
    const cols = rows.length ? Object.keys(rows[0]) : [];
    // SP returns 6 months; trim to last 3 to stay consistent with the rest of the Pod page
    const months = cols.filter(c => /^\d{4}-\d{2}$/.test(c)).slice(-3);
    res.json({ rows, months, dealer });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// LINE Webhook Monitor — group/DM behavior summary (LineBotMonitor.dbo.LineWaitingReply)
app.get('/api/linebot/summary', authRequired, async (request, res) => {
  try {
    const lb = getLineBotPool();
    if (!lb) return res.status(503).json({ error: 'LineBotMonitor DB ไม่ได้เชื่อมต่อ' });

    const groupsR = await lineBotReq().query(`
      SELECT
        GroupId,
        MAX(GroupName) AS GroupName,
        COUNT(*) AS TotalMessages,
        SUM(CASE WHEN Answered = 1 THEN 1 ELSE 0 END) AS AnsweredCount,
        COUNT(DISTINCT CustomerUserId) AS UniqueCustomers,
        MIN(MessageTime) AS FirstMessage,
        MAX(MessageTime) AS LastMessage
      FROM dbo.LineWaitingReply
      GROUP BY GroupId
    `);
    const hourlyR = await lineBotReq().query(`
      SELECT GroupId, DATEPART(HOUR, MessageTime) AS HourOfDay, COUNT(*) AS MsgCount
      FROM dbo.LineWaitingReply
      WHERE MessageTime IS NOT NULL
      GROUP BY GroupId, DATEPART(HOUR, MessageTime)
    `);
    const dowR = await lineBotReq().query(`
      SELECT DATENAME(WEEKDAY, MessageTime) AS DayName, DATEPART(WEEKDAY, MessageTime) AS DayNum, COUNT(*) AS MsgCount
      FROM dbo.LineWaitingReply
      WHERE MessageTime IS NOT NULL
      GROUP BY DATENAME(WEEKDAY, MessageTime), DATEPART(WEEKDAY, MessageTime)
      ORDER BY DayNum
    `);

    const hourByGroup = {};
    hourlyR.recordset.forEach(r => {
      if (!hourByGroup[r.GroupId]) hourByGroup[r.GroupId] = {};
      hourByGroup[r.GroupId][r.HourOfDay] = r.MsgCount;
    });

    const LUNCH = [11, 12, 13], DINNER = [16, 17, 18, 19, 20, 21, 22];
    const NIGHT = [0, 1, 2, 3, 4, 5, 6], MORNING = [7, 8, 9, 10];
    const sumHours = (h, hrs) => hrs.reduce((s, x) => s + (h[x] || 0), 0);

    function classify(gid) {
      const h = hourByGroup[gid] || {};
      const lunch = sumHours(h, LUNCH), dinner = sumHours(h, DINNER);
      const night = sumHours(h, NIGHT), morning = sumHours(h, MORNING);
      let peakHour = null, peakCnt = -1;
      for (const [hr, cnt] of Object.entries(h)) if (cnt > peakCnt) { peakCnt = cnt; peakHour = parseInt(hr); }
      const total = lunch + dinner + night + morning;
      if (total === 0) return { peakHour, pattern: 'ไม่ระบุ' };
      const max = Math.max(lunch, dinner, night, morning);
      const pattern = max === dinner ? 'เน้นมื้อเย็น' : max === lunch ? 'เน้นมื้อเที่ยง' : max === morning ? 'เน้นเช้า' : 'ดึก/นอกเวลา';
      return { peakHour, pattern };
    }

    const rows = groupsR.recordset;
    const globalMin = rows.reduce((m, g) => !m || g.FirstMessage < m ? g.FirstMessage : m, null);
    const globalMax = rows.reduce((m, g) => !m || g.LastMessage > m ? g.LastMessage : m, null);
    const windowDays = globalMin && globalMax
      ? Math.max((new Date(globalMax) - new Date(globalMin)) / 86400000, 0.04)
      : 1;

    // Pod assignments — เก็บใน cs_team DB (ไม่ใช่ LineBotMonitor) แยกจาก License customers
    const assignR = await req().query(`
      SELECT lgp.group_id, lgp.pod_id, lgp.notify_target_ids, p.code AS pod_code, p.display_name AS pod_name
      FROM line_group_pods lgp LEFT JOIN pods p ON p.id = lgp.pod_id
    `);
    const podByGroup = {};
    assignR.recordset.forEach(r => { podByGroup[r.group_id] = r; });

    // Activity status from days since last message (quiet-group detection)
    const QUIET_ACTIVE = 3, QUIET_WARN = 7;
    const nowMs = Date.now();
    const groups = rows.map(g => {
      const { peakHour, pattern } = classify(g.GroupId);
      const assign = podByGroup[g.GroupId];
      const daysSinceLast = g.LastMessage
        ? Math.max(0, Math.floor((nowMs - new Date(g.LastMessage).getTime()) / 86400000))
        : null;
      const activity = daysSinceLast === null || daysSinceLast > QUIET_WARN ? 'quiet'
                     : daysSinceLast > QUIET_ACTIVE ? 'quieting'
                     : 'active';
      return {
        id: g.GroupId,
        name: g.GroupName || '(ไม่มีชื่อ)',
        type: (g.GroupId || '').startsWith('U') ? 'dm' : 'group',
        total: g.TotalMessages,
        answered: g.AnsweredCount,
        customers: g.UniqueCustomers,
        peakHour,
        pattern,
        msgsPerDay: +(g.TotalMessages / windowDays).toFixed(1),
        first: g.FirstMessage,
        last: g.LastMessage,
        daysSinceLast,
        activity,
        hourly: hourByGroup[g.GroupId] || {},
        podId: assign?.pod_id || null,
        podCode: assign?.pod_code || null,
        notifyTargetIds: parseIdList(assign?.notify_target_ids),
      };
    });

    const hourAgg = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    hourlyR.recordset.forEach(r => { hourAgg[r.HourOfDay].count += r.MsgCount; });

    const dowLabel = { Monday: 'จันทร์', Tuesday: 'อังคาร', Wednesday: 'พุธ', Thursday: 'พฤหัสบดี', Friday: 'ศุกร์', Saturday: 'เสาร์', Sunday: 'อาทิตย์' };
    const dow = dowR.recordset.map(r => ({ label: dowLabel[r.DayName] || r.DayName, count: r.MsgCount }));

    res.json({ groups, hourly: hourAgg, dow, generatedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assign a LINE group to a Pod (upsert into line_group_pods)
app.post('/api/linebot/assign-pod', authRequired, managerRequired, async (request, res) => {
  const { groupId, groupName, podId } = request.body;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  try {
    await req()
      .input('gid', sql.NVarChar, groupId)
      .input('gname', sql.NVarChar, groupName || null)
      .input('pid', sql.Int, podId || null)
      .input('by', sql.Int, request.user?.employee_id || null)
      .query(`
        MERGE line_group_pods AS target
        USING (SELECT @gid AS group_id) AS src ON target.group_id = src.group_id
        WHEN MATCHED THEN UPDATE SET pod_id = @pid, group_name = @gname, assigned_by = @by, updated_at = GETDATE()
        WHEN NOT MATCHED THEN INSERT (group_id, group_name, pod_id, assigned_by) VALUES (@gid, @gname, @pid, @by);
      `);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// เลือกว่ากลุ่ม LINE นี้จะส่งแจ้งเตือน Ticket ค้างไปที่ปลายทางไหนบ้าง
// (ปลายทางที่จะได้รับต้องติ๊ก event 'triage_alert_groups' ไว้ด้วย)
app.post('/api/linebot/group-notify', authRequired, managerRequired, async (request, res) => {
  const { groupId, groupName, targetIds } = request.body;
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const ids = Array.isArray(targetIds)
    ? [...new Set(targetIds.map(x => parseInt(x, 10)).filter(Number.isInteger))]
    : [];
  try {
    await req()
      .input('gid', sql.NVarChar, groupId)
      .input('gname', sql.NVarChar, groupName || null)
      .input('ids', sql.NVarChar, ids.length ? ids.join(',') : null)
      .input('by', sql.Int, request.user?.employee_id || null)
      .query(`
        MERGE line_group_pods AS target
        USING (SELECT @gid AS group_id) AS src ON target.group_id = src.group_id
        WHEN MATCHED THEN UPDATE SET notify_target_ids = @ids, updated_at = GETDATE()
        WHEN NOT MATCHED THEN INSERT (group_id, group_name, notify_target_ids, assigned_by)
                                 VALUES (@gid, @gname, @ids, @by);
      `);
    res.json({ ok: true, targetIds: ids });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  AI TRIAGE — classify LINE webhook messages (Gemini) into a team
//  inbox (category / sentiment / priority) that staff tick off.
//  Source: LineBotMonitor.dbo.LineWaitingReply → app table line_msg_triage.
//  We never modify the webhook writer's table; triage state lives in cs_team.
// ══════════════════════════════════════════════════════════
const TRIAGE_CATEGORIES = ['problem', 'complaint', 'followup', 'request', 'question', 'context', 'resolved', 'thank', 'other'];
// หมวดที่นับเป็นเคส (ต้องมีคนดำเนินการ) — นอกนั้นไม่ใช่เคสใหม่แม้ AI จะตอบ needs_action=true
const TRIAGE_CASE_CATEGORIES = new Set(['problem', 'complaint', 'followup', 'request', 'question']);
const TRIAGE_SENTIMENTS = ['positive', 'neutral', 'negative'];
const TRIAGE_PRIORITIES = ['urgent', 'normal', 'low'];
const TRIAGE_STATUSES   = ['open', 'claimed', 'done'];

const triageClean = (v, allowed, fallback) => {
  const s = String(v ?? '').toLowerCase().trim();
  return allowed.includes(s) ? s : fallback;
};

// Classify one batch of not-yet-triaged messages. Focus: unanswered + most recent first.
// Returns { classified, scanned, hasKey, error? }.
// ชื่อทีมงานที่ bot ไม่นับ (มันรู้จักแค่ "INF-" ตัวใหญ่): inf-/inf_/inf ไม่สนตัวพิมพ์ หรือลงท้าย _info
function triageIsStaffName(name) {
  const n = String(name || '').trim();
  return /^inf[\s_.\-]/i.test(n) || /[\s_.\-]info$/i.test(n);
}
let _triageAnsweredAtCol = null;
function ensureTriageAnsweredAt() {
  return _triageAnsweredAtCol ||= req().query(
    `IF COL_LENGTH('line_msg_triage','answered_at') IS NULL ALTER TABLE line_msg_triage ADD answered_at DATETIME NULL`)
    .catch(e => { _triageAnsweredAtCol = null; throw e; });
}
// ข้อความลูกค้าที่ยังไม่ถูกติดว่าตอบ แต่มีข้อความทีมงาน (ai_model='staff') ตามมาในแชทเดียวกันภายใน 1 วัน
// → ติด "ตอบในไลน์แล้ว" ด้วยชื่อ+เวลาของทีมงานคนแรกที่ตอบ (รันซ้ำได้ ไม่ทำซ้ำแถวเดิม)
async function triageMarkStaffReplies() {
  await ensureTriageAnsweredAt();
  const r = await req().query(`
    UPDATE c SET answered_in_line = 1, answered_by = s.customer_name, answered_at = s.message_time, updated_at = GETDATE()
    FROM line_msg_triage c
    CROSS APPLY (SELECT TOP 1 x.customer_name, x.message_time FROM line_msg_triage x
                 WHERE x.ai_model = 'staff' AND x.group_id = c.group_id
                   AND x.message_time > c.message_time AND x.message_time <= DATEADD(day, 1, c.message_time)
                 ORDER BY x.message_time) s
    WHERE ISNULL(c.answered_in_line, 0) = 0 AND ISNULL(c.ai_model, '') <> 'staff'
      AND c.message_time >= DATEADD(day, -2, GETDATE())`);
  const n = r.rowsAffected?.[0] || 0;
  if (n) console.log(`👤 triage: ${n} ข้อความถูกนับว่าตอบแล้วโดยทีมงานที่ชื่อไม่ใช่ INF- (เช่น Inf-Christ)`);
  return n;
}

async function classifyTriageBatch(batchSize = 30) {
  const r = await classifyTriageBatchInner(batchSize);
  try { await triageMarkStaffReplies(); } catch (e) { console.error('triage staff-reply mark error:', e.message); }
  return r;
}
async function classifyTriageBatchInner(batchSize) {
  if (!GROQ_API_KEY && !process.env.GEMINI_API_KEY) return { classified: 0, scanned: 0, hasKey: false };
  const lb = getLineBotPool();
  if (!lb) return { classified: 0, scanned: 0, hasKey: true, error: 'LineBotMonitor DB ไม่ได้เชื่อมต่อ' };

  batchSize = Math.max(1, Math.min(60, parseInt(batchSize) || 30));

  // Candidate window: unanswered first, newest first — then anti-join against already-triaged rows.
  const WINDOW = 400;
  const cand = (await lb.request().query(`
    SELECT TOP (${WINDOW}) Id, GroupId, GroupName, CustomerName, CustomerMessage, MessageTime, Answered
    FROM dbo.LineWaitingReply
    WHERE CustomerMessage IS NOT NULL AND LEN(LTRIM(RTRIM(CustomerMessage))) > 0
      -- เก่ากว่าอายุที่เก็บไว้ = ถูกล้างไปแล้ว ไม่ต้องคัดกรองซ้ำให้เปลืองโควตา
      AND (MessageTime IS NULL OR MessageTime >= DATEADD(day, -${TRIAGE_CFG.retentionDays}, GETDATE()))
    ORDER BY Answered ASC, MessageTime DESC
  `)).recordset;
  if (!cand.length) return { classified: 0, scanned: 0, hasKey: true };

  // เดิมส่งให้ AI ทุกกลุ่มแล้วค่อยกรองตอนแสดงผล — ตอนนี้กรองก่อนเรียก AI
  // จะได้ไม่เปลืองโควตากับกลุ่มที่ไม่ได้เฝ้า
  const scopeRows = (await req().query(
    `SELECT lgp.group_id, lgp.pod_id, lgp.notify_target_ids, p.code AS pod_code, p.active AS pod_active
     FROM line_group_pods lgp LEFT JOIN pods p ON p.id = lgp.pod_id`)).recordset;
  const scopeMap = new Map(scopeRows.map(r => [r.group_id, r]));
  const inScope = cand.filter(r => triageGroupInScope(scopeMap.get(r.GroupId)));
  if (!inScope.length) return { classified: 0, scanned: 0, hasKey: true, skippedOutOfScope: cand.length };

  // Filter out ids already classified (cross-DB, so anti-join in app; chunk the IN list)
  const ids = inScope.map(r => r.Id);
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = req();
    chunk.forEach((id, k) => r.input('e' + k, sql.Int, id));
    const rows = (await r.query(
      `SELECT source_msg_id FROM line_msg_triage WHERE source_msg_id IN (${chunk.map((_, k) => '@e' + k).join(',')})`
    )).recordset;
    rows.forEach(x => existing.add(x.source_msg_id));
  }
  const fresh = inScope.filter(r => !existing.has(r.Id));
  if (!fresh.length) return { classified: 0, scanned: inScope.length, hasKey: true, skippedOutOfScope: cand.length - inScope.length };

  // ข้อความจากทีมงานที่ bot จำไม่ได้ (ชื่อไม่ใช่ "INF-" ตัวใหญ่เป๊ะ เช่น Inf-Christ, INF_PARNIN)
  // → ไม่ส่ง AI · นับเป็น "ตอบแล้ว" ให้ข้อความลูกค้าที่รออยู่ในแชทนั้น (triageMarkStaffReplies หลังจบรอบ)
  let ruled = 0;
  for (const m of fresh) {
    if (!triageIsStaffName(m.CustomerName)) continue;
    m._ruled = true;
    if (await triageInsert(m, { category: 'other', sentiment: 'neutral', priority: 'low', needs_action: false,
      summary: `ข้อความจากทีมงาน (${String(m.CustomerName).trim()})` }, 'staff')) ruled++;
  }
  // ข้อความง่ายๆ (สติกเกอร์ / ขอบคุณ / โอเค / รับทราบ) ตัดสินด้วยกฎ ไม่ต้องเสีย token
  for (const m of fresh) {
    if (m._ruled) continue;
    const o = triageRuleClassify(m.CustomerMessage);
    if (!o) continue;
    m._ruled = true;
    if (await triageInsert(m, o, 'rule')) ruled++;
  }
  // เรียงตามแชท แล้วตามเวลา — ให้ AI เห็นข้อความของแชทเดียวกันต่อเนื่องกัน
  const todo = fresh.filter(m => !m._ruled).slice(0, batchSize)
    .sort((a, b) => String(a.GroupId).localeCompare(String(b.GroupId)) || new Date(a.MessageTime) - new Date(b.MessageTime));
  if (!todo.length) return { classified: ruled, ruled, scanned: inScope.length, hasKey: true, skippedOutOfScope: cand.length - inScope.length };

  // บริบท: สรุป 4 ข้อความก่อนหน้าในแชทเดียวกัน (ภายใน 3 ชม.) — ใช้แยก "เรื่องใหม่" กับ "ข้อมูลเพิ่มของเรื่องเดิม"
  const ctx = new Map();
  try {
    const gids = [...new Set(todo.map(m => m.GroupId).filter(Boolean))];
    for (let i = 0; i < gids.length; i += 100) {
      const r = req();
      const chunk = gids.slice(i, i + 100);
      chunk.forEach((g, k) => r.input('g' + k, sql.NVarChar, g));
      (await r.query(`SELECT group_id, category, summary, answered_in_line FROM (
          SELECT group_id, category, summary, answered_in_line, message_time,
                 ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY message_time DESC) AS rn
          FROM line_msg_triage
          WHERE group_id IN (${chunk.map((_, k) => '@g' + k).join(',')}) AND message_time >= DATEADD(hour, -3, GETDATE())
        ) x WHERE rn <= 4 ORDER BY group_id, message_time`)).recordset
        .forEach(x => (ctx.get(x.group_id) || ctx.set(x.group_id, []).get(x.group_id)).push(x));
    }
  } catch (e) { console.warn('triage context load failed:', e.message); }

  const clip = v => String(v || '').replace(/\s+/g, ' ').trim();
  const blocks = [];
  let curG = null;
  todo.forEach((m, i) => {
    if (m.GroupId !== curG) {
      curG = m.GroupId;
      const prev = (ctx.get(m.GroupId) || []).map(x => `  - [${x.category}] ${clip(x.summary).slice(0, 120)}${x.answered_in_line ? ' (แอดมินตอบแล้ว)' : ''}`);
      blocks.push(`=== แชท: ${clip(m.GroupName).slice(0, 60) || '-'} ===` + (prev.length ? `\nก่อนหน้า (สรุป):\n${prev.join('\n')}` : ''));
    }
    blocks.push(`[${i}] ${clip(m.CustomerMessage).slice(0, 300)}`);   // 300 ตัวอักษรพอให้จำแนกได้ — ประหยัด token
  });
  const list = blocks.join('\n');

  const prompt = `คุณคือระบบคัดกรองข้อความจากลูกค้าที่ทักเข้ามาในกลุ่ม/แชทไลน์ของทีม Customer Service
จำแนกข้อความแต่ละรายการด้านล่างนี้ แล้วตอบกลับเป็น JSON array เท่านั้น (ห้ามมีข้อความอื่นนอก JSON)

ข้อความถูกจัดกลุ่มตามแชท เรียงตามเวลา บางแชทมี "ก่อนหน้า (สรุป)" ให้ดูว่ากำลังคุยเรื่องอะไรอยู่
ให้ดูบริบทก่อนเสมอ — ข้อความที่ต่อจากเรื่องเดิม ไม่ใช่เคสใหม่

แต่ละ object ต้องมี field:
- i        : เลขลำดับข้อความ (ตรงกับ [i] ที่ให้มา)
- category : เลือก 1 อย่าง
    "problem"   = แจ้งปัญหาระบบ/เครื่องเสีย/error/ใช้งานไม่ได้ เป็นเรื่องใหม่
    "complaint" = ร้องเรียน ไม่พอใจ ตำหนิบริการ
    "followup"  = ทวงถาม/ตามเรื่องเดิมที่ยังไม่ได้รับการแก้ เช่น "ยังไม่ได้เลย" "รอนานแล้ว"
    "request"   = ขอให้ทำ/แก้ข้อมูล/ตั้งค่า เช่น ยกเลิกบิล เพิ่มเมนู ตั้งค่าเครื่องพิมพ์ เป็นเรื่องใหม่
    "question"  = ถามวิธีใช้/สอบถามข้อมูล เป็นเรื่องใหม่
    "context"   = ข้อมูลเพิ่มเติมของเรื่องที่คุยอยู่ เช่น ตอบคำถามแอดมิน ส่งเลข Anydesk/IP/รูป อธิบายเพิ่ม
    "resolved"  = แจ้งว่าแก้ได้แล้ว/ใช้งานได้แล้ว/หายเอง
    "thank"     = ขอบคุณ/ชม
    "other"     = ประสานงานทั่วไป นัดเวลา แจ้งอนุมัติ ทักทาย คุยกันเอง
- sentiment: "positive" | "neutral" | "negative"
- priority : "urgent"(ระบบล่ม ขายของไม่ได้ ลูกค้ารออยู่หน้าร้าน) | "normal" | "low"
- needs_action: true เฉพาะ problem/complaint/followup/request/question ที่ต้องมีทีมงานทำหรือตอบจริง
                ถ้าไม่แน่ใจว่าเป็นเรื่องใหม่หรือเรื่องเดิม ให้ดูบริบท ถ้าต่อจากเรื่องเดิมให้เป็น "context"
- summary  : สรุปใจความสั้นๆ 1 ประโยคภาษาไทยว่าลูกค้าต้องการอะไร

${list}`;

  // Gemini บังคับรูปแบบด้วย responseSchema ได้; Groq อาศัย prompt + parseJsonArrayReply แทน
  const geminiConfig = {
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            i:            { type: SchemaType.NUMBER },
            category:     { type: SchemaType.STRING },
            sentiment:    { type: SchemaType.STRING },
            priority:     { type: SchemaType.STRING },
            needs_action: { type: SchemaType.BOOLEAN },
            summary:      { type: SchemaType.STRING },
          },
          required: ['i', 'category', 'sentiment', 'priority', 'needs_action', 'summary'],
        },
      },
    },
  };

  let arr, usedModel;
  try {
    // หน้า Pod & Assign ใช้ Gemini เป็นตัวหลัก (responseSchema บังคับรูปแบบได้) Groq เป็นตัวสำรอง
    ({ value: arr, usedModel } = await aiGenerate(prompt, { parse: parseJsonArrayReply, geminiConfig, feature: 'triage_classify' }));
  } catch (e) {
    console.error('triage: AI/parse failed:', e.message);
    return { classified: 0, scanned: cand.length, hasKey: true, error: 'AI คัดกรองไม่สำเร็จ: ' + e.message };
  }
  if (!Array.isArray(arr)) return { classified: 0, scanned: cand.length, hasKey: true, error: 'AI ตอบผิดรูปแบบ' };

  const byIndex = new Map();
  arr.forEach(o => { if (o && Number.isInteger(o.i)) byIndex.set(o.i, o); });

  let classified = ruled;
  for (let i = 0; i < todo.length; i++) {
    if (await triageInsert(todo[i], byIndex.get(i) || {}, usedModel)) classified++;
  }
  return { classified, ruled, scanned: inScope.length, hasKey: true, skippedOutOfScope: cand.length - inScope.length };
}

// บันทึกผลคัดกรอง 1 ข้อความ (ข้ามถ้ามีอยู่แล้ว) — คืน true เมื่อสำเร็จ
async function triageInsert(m, o, model) {
    const cat = triageClean(o.category, TRIAGE_CATEGORIES, 'other');
    const needsAction = (o.needs_action === true || o.needs_action === 'true') && TRIAGE_CASE_CATEGORIES.has(cat) ? 1 : 0;
    try {
      await req()
        .input('sid',  sql.Int, m.Id)
        .input('gid',  sql.NVarChar, m.GroupId || null)
        .input('gname', sql.NVarChar, m.GroupName || null)
        .input('cust', sql.NVarChar, m.CustomerName || null)
        .input('txt',  sql.NVarChar(sql.MAX), m.CustomerMessage || null)
        .input('mtime', sql.DateTime, m.MessageTime || null)
        .input('cat',  sql.NVarChar, cat)
        .input('sen',  sql.NVarChar, triageClean(o.sentiment, TRIAGE_SENTIMENTS, 'neutral'))
        .input('pri',  sql.NVarChar, triageClean(o.priority, TRIAGE_PRIORITIES, 'normal'))
        .input('sum',  sql.NVarChar, String(o.summary || '').slice(0, 480))
        .input('na',   sql.Bit, needsAction)
        .input('model', sql.NVarChar, model)
        .query(`
          IF NOT EXISTS (SELECT 1 FROM line_msg_triage WHERE source_msg_id=@sid)
          INSERT INTO line_msg_triage
            (source_msg_id, group_id, group_name, customer_name, message_text, message_time,
             category, sentiment, priority, summary, needs_action, ai_model)
          VALUES (@sid,@gid,@gname,@cust,@txt,@mtime,@cat,@sen,@pri,@sum,@na,@model)
        `);
      return true;
    } catch (e) { console.error('triage insert failed for id', m.Id, e.message); return false; }
}

// กฎคัดกรองข้อความสั้นที่ไม่ต้องให้ทีมทำอะไร — ตรงทั้งข้อความเท่านั้น (ไม่แน่ใจ = คืน null ให้ AI ตัดสิน)
function triageRuleClassify(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 30) return null;
  if (/^\[?(sticker|สติกเกอร์|สติ๊กเกอร์)\]?$/i.test(t) || !/[\p{L}\p{N}]/u.test(t))   // สติกเกอร์ / อีโมจิล้วน
    return { category: 'other', sentiment: 'neutral', priority: 'low', needs_action: false, summary: 'ส่งสติกเกอร์/อีโมจิ' };
  const w = t.toLowerCase().replace(/[\s!.,~ๆ^_\-+*:;()\[\]"'🙏👍😊🙂😀😄❤️♥]+/gu, '')
    .replace(/(ครับผม|ครับ|คับ|ค่ะ|คะ|ค่า|จ้า|จ้ะ|นะ|น้า|มากๆ|มาก|เลย|kub|krub|ka|kha|na|jaa)+$/g, '');
  if (/^(ขอบคุณ|ขอบใจ|ขอบคุน|thank(s|you)?|thx|ty|tq)$/.test(w))
    return { category: 'thank', sentiment: 'positive', priority: 'low', needs_action: false, summary: 'ลูกค้าขอบคุณ' };
  if (/^(ได้แล้ว|ใช้ได้แล้ว|เรียบร้อย|เรียบร้อยแล้ว|หายแล้ว|ปกติแล้ว)$/.test(w))
    return { category: 'resolved', sentiment: 'positive', priority: 'low', needs_action: false, summary: 'ลูกค้าแจ้งว่าใช้งานได้แล้ว' };
  if (/^(ok|okay|โอเค|โอเช|รับทราบ|ทราบแล้ว|ได้|ค่ะ|ครับ|คับ|จ้า|ค่า|)$/.test(w))
    return { category: 'other', sentiment: 'neutral', priority: 'low', needs_action: false, summary: 'ลูกค้ารับทราบ' };
  return null;
}

// ── ขอบเขตที่คัดกรอง AI ต้องเฝ้า ─────────────────────────
// สองอย่างเท่านั้น: กลุ่มที่ตั้งกระดิ่งแจ้งเตือนไว้ (line_group_pods.notify_target_ids)
// และกลุ่มที่ยังไม่ได้ assign Pod (กลุ่มใหม่ที่ยังไม่มีใครรับไป — ต้องไม่ตกหล่น)
// ใช้ได้เฉพาะใน query ที่ join line_group_pods (lgp) ไว้แล้ว
const TRIAGE_BELL_SQL = (lgp = 'lgp') =>
  `(${lgp}.notify_target_ids IS NOT NULL AND LTRIM(RTRIM(${lgp}.notify_target_ids)) <> '')`;
// + ทุกกลุ่มใน Pod ที่รหัสตรง TRIAGE_SCOPE_PODS (ค่าเริ่มต้น BK%,CNX% = BKK-1..3, CNX-1..3) ไม่ต้องตั้งกระดิ่งรายกลุ่ม
const TRIAGE_SCOPE_PODS = String(process.env.TRIAGE_SCOPE_PODS ?? 'BK%,CNX%')
  .split(',').map(x => x.trim()).filter(x => /^[A-Za-z0-9%_\- ]+$/.test(x));   // ใช้ต่อใน SQL ตรงๆ — รับแค่ตัวอักษรปลอดภัย
const TRIAGE_SCOPE_POD_SQL = TRIAGE_SCOPE_PODS.length
  ? `SELECT id FROM pods WHERE active=1 AND (${TRIAGE_SCOPE_PODS.map(x => `code LIKE '${x}'`).join(' OR ')})` : '';
const TRIAGE_SCOPE_POD_RE = TRIAGE_SCOPE_PODS.length
  // แปลงรูปแบบ LIKE → regex (รูปแบบผ่านการกรองตัวอักษรข้างบนแล้ว ไม่มีอักขระพิเศษของ regex ให้ escape)
  ? new RegExp('^(' + TRIAGE_SCOPE_PODS.map(x => x.replace(/%/g, '.*').replace(/_/g, '.')).join('|') + ')$', 'i') : null;
function triageScopeSql(lgp = 'lgp') {
  return `(${lgp}.pod_id IS NULL OR ${TRIAGE_BELL_SQL(lgp)}${TRIAGE_SCOPE_POD_SQL ? ` OR ${lgp}.pod_id IN (${TRIAGE_SCOPE_POD_SQL})` : ''})`;
}

// เวอร์ชัน JS ของกฎเดียวกัน สำหรับกรองผู้สมัครข้าม DB (LineBotMonitor → cs_team)
function triageGroupInScope(row) {
  if (!row) return true;                                  // ไม่มีแถวเลย = ยังไม่ได้ assign
  if (row.pod_id === null || row.pod_id === undefined) return true;  // มีแถวแต่ยังไม่มี Pod
  if (TRIAGE_SCOPE_POD_RE && row.pod_active && TRIAGE_SCOPE_POD_RE.test(row.pod_code || '')) return true;   // Pod ที่เฝ้าทั้ง Pod
  return !!String(row.notify_target_ids || '').trim();     // Pod อื่น → ต้องตั้งกระดิ่ง
}

// Apply inbox filters from query params onto a request; returns the WHERE clause.
function buildTriageFilter(query, r) {
  const where = [triageScopeSql()];   // เฝ้าเฉพาะกลุ่มที่ตั้งกระดิ่ง + ที่ยังไม่ได้ assign Pod
  if (TRIAGE_CATEGORIES.includes(query.category)) { where.push('t.category=@cat'); r.input('cat', sql.NVarChar, query.category); }
  if (TRIAGE_SENTIMENTS.includes(query.sentiment)) { where.push('t.sentiment=@sen'); r.input('sen', sql.NVarChar, query.sentiment); }
  if (TRIAGE_PRIORITIES.includes(query.priority)) { where.push('t.priority=@pri'); r.input('pri', sql.NVarChar, query.priority); }
  if (TRIAGE_STATUSES.includes(query.status)) { where.push('t.status=@st'); r.input('st', sql.NVarChar, query.status); }
  if (query.group) { where.push('t.group_id=@gid'); r.input('gid', sql.NVarChar, query.group); }
  if (query.needsAction === '1') where.push('t.needs_action=1');
  // Multi-select Pod filter: comma-separated pod ids, plus optional 'none' (unassigned groups)
  if (query.pods) {
    const parts = String(query.pods).split(',');
    const ids = parts.map(x => parseInt(x)).filter(Boolean);   // parseInt guards against injection
    const ors = [];
    if (ids.length) ors.push(`lgp.pod_id IN (${ids.join(',')})`);
    if (parts.includes('none')) ors.push('lgp.pod_id IS NULL');
    if (ors.length) where.push('(' + ors.join(' OR ') + ')');
  }
  if (query.q) {
    const raw = String(query.q).slice(0, 80).trim();
    // รับเลข TASK ได้ทั้ง "TASK #171749" / "#171749" / "171749" — ตัดคำนำหน้าออกก่อนเทียบ
    const bare = raw.replace(/^TASK/i, '').trim().replace(/^#/, '').trim();
    where.push(`(t.message_text LIKE @q OR t.summary LIKE @q OR t.customer_name LIKE @q
                 OR t.group_name LIKE @q OR CAST(t.source_msg_id AS NVARCHAR(20)) LIKE @qid)`);
    r.input('q',   sql.NVarChar, '%' + raw + '%');
    r.input('qid', sql.NVarChar, '%' + (bare || raw) + '%');
  }
  return where.length ? 'WHERE ' + where.join(' AND ') : '';
}

// Manual trigger — classify the next batch (any signed-in user)
app.post('/api/triage/classify', authRequired, async (request, res) => {
  try {
    const r = await classifyTriageBatch(request.body?.limit || 30);
    if (!r.hasKey) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่า GROQ_API_KEY หรือ GEMINI_API_KEY ใน .env' });
    if (r.error)  return res.status(502).json({ error: r.error });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ปิดงานอัตโนมัติ (💡 น่าจะแก้แล้ว) — ค่าเริ่มต้นปิด: งานจบได้เฉพาะคนเปิดเคส หรือกด "ไม่ใช่เคส"
const TRIAGE_AUTO_CLOSE = (process.env.TRIAGE_AUTO_CLOSE || 'off').toLowerCase() === 'on';
// Inbox list with filters + pagination
let _triageInboxSyncAt = 0;
app.get('/api/triage/inbox', authRequired, async (request, res) => {
  try {
    // ดึงสถานะ "ตอบในไลน์แล้ว" ก่อนแสดงผล — ไม่เกินนาทีละครั้ง (เดิมทำทุก request หน้าเว็บที่รีเฟรชเองทุก 30 วิจึงถ่วง DB)
    if (Date.now() - _triageInboxSyncAt > 60000) {
      _triageInboxSyncAt = Date.now();
      try { await syncTriageAnswered(); } catch {}
    }
    // ปิด 💡 "น่าจะแก้แล้ว" ให้เป็นเสร็จก่อนแสดงผล — จะได้ไม่ค้างอยู่ในกล่องรอทำ
    if (TRIAGE_AUTO_CLOSE) {
      try { await closeMaybeResolved(); } catch {}
    }
    const page = Math.max(1, parseInt(request.query.page) || 1);
    const per  = Math.min(300, Math.max(5, parseInt(request.query.per) || 30));

    const r = req();
    const wsql = buildTriageFilter(request.query, r);
    r.input('off', sql.Int, (page - 1) * per).input('per', sql.Int, per);

    // Status-aware ordering (whitelisted, no injection):
    //  • open/claimed → waiting longest first (oldest message)
    //  • done         → most recently completed first
    //  • ทั้งหมด (no status) → most recently changed first, so just-actioned tickets surface
    const st = request.query.status;
    const orderBy =
      st === 'done' ? 't.done_at DESC, t.updated_at DESC'
      : (st === 'open' || st === 'claimed') ? 't.message_time ASC'
      : 't.updated_at DESC';
    const rowsQ = r.query(`
      SELECT t.id, t.source_msg_id, t.group_id, t.customer_name, t.message_text, t.message_time,
             COALESCE(t.group_name, lgp.group_name) AS group_name,
             t.category, t.sentiment, t.priority, t.summary, t.needs_action, t.status,
             t.answered_in_line, t.answered_by, t.auto_closed,
             CASE WHEN t.status='open' AND EXISTS (
               SELECT 1 FROM line_msg_triage t2
               WHERE t2.group_id = t.group_id
                 AND t2.message_time > t.message_time
                 AND t2.message_time <= DATEADD(hour, 24, t.message_time)  -- within 24h → likely related
                 AND (t2.category IN ('thank','resolved') OR t2.sentiment='positive')
             ) THEN 1 ELSE 0 END AS maybe_resolved,
             t.claimed_at, t.done_at, t.note, t.classified_at,
             lgp.pod_id, p.code AS pod_code, p.display_name AS pod_name, p.color AS pod_color,
             ISNULL(ce.nickname, ce.name) AS claimed_name,
             ISNULL(de.nickname, de.name) AS done_name
      FROM line_msg_triage t
      LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
      LEFT JOIN pods p       ON p.id = lgp.pod_id
      LEFT JOIN employees ce ON ce.id = t.claimed_by
      LEFT JOIN employees de ON de.id = t.done_by
      ${wsql}
      ORDER BY ${orderBy}
      OFFSET @off ROWS FETCH NEXT @per ROWS ONLY
    `);

    // นับจำนวนทั้งหมดวิ่งคู่ไปกับการดึงแถว — เดิมรอให้ดึงแถวเสร็จก่อนค่อยนับ
    // (ตาราง pods ไม่ได้ใช้ในเงื่อนไขนับ จึงไม่ต้อง join)
    const rc = req();
    const wsql2 = buildTriageFilter(request.query, rc);
    const totalQ = rc.query(`
      SELECT COUNT(*) AS n FROM line_msg_triage t
      LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
      ${wsql2}`);
    const [rowsRes, totalRes] = await Promise.all([rowsQ, totalQ]);
    const rows = rowsRes.recordset;
    const total = totalRes.recordset[0].n;

    res.json({ rows, total, page, per });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ประมาณการ backlog ต้องสแกนทั้งตารางฝั่ง LineBotMonitor (~450 ms) และเป็นแค่
// ตัวเลขคร่าวๆ จึงจำไว้ 60 วินาที ไม่ต้องนับใหม่ทุกครั้งที่เปิดหน้า
let _trBacklogCache = { at: 0, n: null };
async function triageSourceTotal() {
  if (_trBacklogCache.n !== null && Date.now() - _trBacklogCache.at < 60000) return _trBacklogCache.n;
  const lb = getLineBotPool();
  if (!lb) return null;
  const n = (await lb.request().query(
    `SELECT COUNT(*) AS n FROM dbo.LineWaitingReply
     WHERE CustomerMessage IS NOT NULL AND LEN(LTRIM(RTRIM(CustomerMessage)))>0`)).recordset[0].n;
  _trBacklogCache = { at: Date.now(), n };
  return n;
}

// Summary counters for the cards on top of the inbox
// เดิมยิงทีละ query 9 รอบ — DB อยู่คนละเครื่อง ค่าเดินทางอย่างเดียวก็ครึ่งวินาทีแล้ว
// ตอนนี้รวบเป็นชุดเดียว (หลาย recordset) แล้ววิ่งคู่ไปกับการนับ backlog
app.get('/api/triage/stats', authRequired, async (request, res) => {
  try {
    // ทุกตัวเลขนับเฉพาะกลุ่มที่คัดกรอง AI เฝ้าอยู่ — ให้ตรงกับที่เห็นในตาราง
    const SCOPE = `LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id`;
    const inScope = triageScopeSql();
    const batch = `
      -- หน้าจอใช้แค่ยอด "ปิดแล้ว" — เดิมนับครบทุกสถานะ + แยกตามประเภท/ความเร่งด่วน
      -- ที่ไม่มีหน้าไหนเรียกดู เสียไปเปล่าๆ เกือบ 300 ms ทุกครั้งที่เปิดหน้า
      SELECT COUNT(*) AS n FROM line_msg_triage t ${SCOPE}
       WHERE t.status='done' AND ${inScope};

      -- สามตัวเลขของงานที่ยังค้าง อ่านตารางรอบเดียวพอ
      -- (SUM ครอบ subquery ตรงๆ ไม่ได้ ต้องคิด CASE ในตารางย่อยก่อน)
      SELECT COUNT(*) AS openAction, MIN(x.message_time) AS oldest, SUM(x.maybe) AS maybeResolved
        FROM (
          SELECT t.message_time,
                 CASE WHEN EXISTS (
                   SELECT 1 FROM line_msg_triage t2
                   WHERE t2.group_id = t.group_id AND t2.message_time > t.message_time
                     AND t2.message_time <= DATEADD(hour, 24, t.message_time)
                     AND (t2.category IN ('thank','resolved') OR t2.sentiment='positive')
                 ) THEN 1 ELSE 0 END AS maybe
            FROM line_msg_triage t ${SCOPE}
           WHERE t.status='open' AND t.needs_action=1 AND ${inScope}
        ) x;

      SELECT COUNT(*) AS n FROM line_msg_triage;

      -- Pod ที่มีกลุ่มตั้งกระดิ่งไว้อย่างน้อยหนึ่งกลุ่ม — หน้าจอโชว์ปุ่มเฉพาะ Pod เหล่านี้
      SELECT DISTINCT lgp.pod_id FROM line_group_pods lgp
       WHERE lgp.pod_id IS NOT NULL AND ${TRIAGE_BELL_SQL()};`;

    const [rs, totalMsgs] = await Promise.all([
      req().query(batch).then(r => r.recordsets),
      triageSourceTotal(),
    ]);
    const [[done], [open], [classified], podRows] = rs;
    const totalClassified = classified.n;

    res.json({
      byStatus: [{ status: 'done', n: done.n }],
      openAction: open.openAction || 0,
      oldestOpenTicket: open.oldest || null,
      maybeResolved: open.maybeResolved || 0,
      totalClassified,
      backlog: totalMsgs === null ? null : Math.max(0, totalMsgs - totalClassified),
      scopePodIds: podRows.map(r => r.pod_id),
      autoOn: (process.env.TRIAGE_AUTO || '').toLowerCase() === 'on',
      alertOn: (process.env.TRIAGE_ALERT || '').toLowerCase() === 'on',
      alertEveryMin: TRIAGE_CFG.alertEveryMin,
      alertWindow: TRIAGE_CFG.alertWindow,
      autoMinutes: TRIAGE_AUTO_MIN,
      retentionDays: TRIAGE_CFG.retentionDays,
      autoPurge: TRIAGE_CFG.autoPurge,
      canEditSettings: ['manager', 'team_lead', 'admin'].includes(request.user?.role),
      lastAutoAt: _triageAutoLastAt ? _triageAutoLastAt.toISOString() : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── ล้าง backlog: ปิดงานค้างที่เก่ากว่า N ชั่วโมง ────────
// GET  = dry-run นับจำนวน (ไม่แก้ข้อมูล)   POST = ปิดจริง
// ใช้ตอนอยากเริ่มนับใหม่ เหลือไว้แต่ของสด ๆ ที่ยังตามได้ทัน
function staleHours(v) { return Math.max(1, Math.min(24 * 30, parseInt(v) || 1)); }

app.get('/api/triage/close-stale', authRequired, async (request, res) => {
  try {
    const hours = staleHours(request.query.hours);
    const r = (await req().input('h', sql.Int, hours).query(`
      SELECT
        SUM(CASE WHEN DATEDIFF(MINUTE, t.message_time, GETDATE()) >  @h*60 THEN 1 ELSE 0 END) AS will_close,
        SUM(CASE WHEN DATEDIFF(MINUTE, t.message_time, GETDATE()) <= @h*60 THEN 1 ELSE 0 END) AS will_keep,
        COUNT(*) AS total
      FROM line_msg_triage t
      LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
      LEFT JOIN pods p ON p.id = lgp.pod_id
      WHERE t.status='open' AND t.needs_action=1 AND t.message_time IS NOT NULL
        AND ${triageScopeSql()}`)).recordset[0];
    res.json({ hours, will_close: r.will_close || 0, will_keep: r.will_keep || 0, total: r.total || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/triage/close-stale', authRequired, managerRequired, async (request, res) => {
  try {
    const hours = staleHours(request.body?.hours);
    const r = await req().input('h', sql.Int, hours).query(`
      UPDATE line_msg_triage
      SET status='done', auto_closed=1, done_by=NULL,
          note = N'ปิดอัตโนมัติ (ล้างงานค้างเก่ากว่า ' + CAST(@h AS NVARCHAR(10)) + N' ชม.)',
          done_at=GETDATE(), updated_at=GETDATE()
      WHERE status='open' AND needs_action=1 AND message_time IS NOT NULL
        AND DATEDIFF(MINUTE, message_time, GETDATE()) > @h*60`);
    const closed = r.rowsAffected?.[0] || 0;
    const left = (await req().query(
      `SELECT COUNT(*) AS n FROM line_msg_triage t
       LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
       LEFT JOIN pods p ON p.id = lgp.pod_id
       WHERE t.status='open' AND t.needs_action=1 AND ${triageScopeSql()}`)).recordset[0].n;
    console.log(`🧹 triage: closed ${closed} stale ticket(s) older than ${hours}h — ${left} left open`);
    res.json({ ok: true, hours, closed, left });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk-close all open tickets that look already resolved
// (same LINE group got a thank/positive within 24h after the ticket).
// ปิดงานที่ติด 💡 "น่าจะแก้แล้ว" — เงื่อนไขเดียวกับ badge ในกล่องคัดกรองเป๊ะ
// (กลุ่มเดียวกันมีข้อความ thank/positive ตามหลังภายใน 24 ชม.)
async function closeMaybeResolved() {
  const r = await req().query(`
    UPDATE line_msg_triage
    SET status='done', auto_closed=1, done_by=NULL,
        note=N'ปิดอัตโนมัติ (น่าจะแก้แล้ว)', done_at=GETDATE(), updated_at=GETDATE()
    WHERE status='open' AND needs_action=1 AND EXISTS (
      SELECT 1 FROM line_msg_triage t2
      WHERE t2.group_id = line_msg_triage.group_id
        AND t2.message_time > line_msg_triage.message_time
        AND t2.message_time <= DATEADD(hour, 24, line_msg_triage.message_time)
        AND (t2.category IN ('thank','resolved') OR t2.sentiment='positive'))`);
  return r.rowsAffected?.[0] || 0;
}

app.post('/api/triage/close-maybe-resolved', authRequired, async (request, res) => {
  try {
    res.json({ ok: true, closed: await closeMaybeResolved() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ตั้งค่ารอบแจ้งเตือน LINE + การเก็บข้อมูล ──────────────
app.get('/api/triage/settings', authRequired, async (_, res) => {
  try {
    const c = await loadTriageSettings();
    res.json({
      alertOn: (process.env.TRIAGE_ALERT || '').toLowerCase() === 'on',
      alertEveryMin: c.alertEveryMin, alertWindow: c.alertWindow,
      retentionDays: c.retentionDays, autoPurge: c.autoPurge,
      lastPurgeAt: c.lastPurgeAt, updatedAt: c.updatedAt, updatedBy: c.updatedBy,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/triage/settings', authRequired, managerRequired, async (request, res) => {
  const b = request.body || {};
  const every = Math.max(1, Math.min(720, parseInt(b.alertEveryMin) || TRIAGE_ALERT_EVERY_DEFAULT));
  const win   = String(b.alertWindow || TRIAGE_ALERT_WINDOW_DEFAULT).trim();
  const days  = Math.max(1, Math.min(365, parseInt(b.retentionDays) || TRIAGE_RETENTION_DEFAULT));
  const auto  = b.autoPurge ? 1 : 0;
  if (!/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(win))
    return res.status(400).json({ error: 'ช่วงเวลาต้องอยู่ในรูปแบบ 08:00-00:00' });
  try {
    const who = request.user?.nickname || request.user?.name || request.user?.username || null;
    await req()
      .input('ev', sql.Int, every).input('wd', sql.NVarChar, win)
      .input('rd', sql.Int, days).input('ap', sql.Bit, auto)
      .input('by', sql.NVarChar, who)
      .query(`UPDATE triage_settings
                 SET alert_every_min=@ev, alert_window=@wd, retention_days=@rd,
                     auto_purge=@ap, updated_at=GETDATE(), updated_by=@by
               WHERE id=1`);
    await loadTriageSettings();
    console.log(`⚙️ triage settings → แจ้งเตือนทุก ${TRIAGE_CFG.alertEveryMin} นาที (${TRIAGE_CFG.alertWindow}) · เก็บ ${TRIAGE_CFG.retentionDays} วัน · ล้างอัตโนมัติ ${TRIAGE_CFG.autoPurge ? 'เปิด' : 'ปิด'} · โดย ${who || '—'}`);
    res.json({
      ok: true,
      alertEveryMin: TRIAGE_CFG.alertEveryMin, alertWindow: TRIAGE_CFG.alertWindow,
      retentionDays: TRIAGE_CFG.retentionDays, autoPurge: TRIAGE_CFG.autoPurge,
      // รอบที่หาร 1440 ไม่ลงตัวจะยิงไม่ครบทุกชั่วโมง (เช่น 50 นาที) — บอกให้หน้าจอเตือน
      notDivisible: 1440 % TRIAGE_CFG.alertEveryMin !== 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ล้างข้อมูลคัดกรองที่เก่ากว่า N วัน ───────────────────
// GET = ดูก่อนว่าจะลบเท่าไหร่ (ไม่แตะข้อมูล)   POST = ลบจริง (หัวหน้าทีมขึ้นไป)
app.get('/api/triage/purge', authRequired, async (request, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(request.query.days) || TRIAGE_CFG.retentionDays));
    res.json({ days, ...(await countTriageOlderThan(days)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/triage/purge', authRequired, managerRequired, async (request, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(request.body?.days) || TRIAGE_CFG.retentionDays));
    const deleted = await purgeTriageOlderThan(days);
    const left = (await req().query('SELECT COUNT(*) AS n FROM line_msg_triage')).recordset[0].n;
    console.log(`🗑️ triage purge: ลบ ${deleted} รายการที่เก่ากว่า ${days} วัน โดย ${request.user?.username || '—'} — เหลือ ${left}`);
    res.json({ ok: true, days, deleted, left });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ประวัติการปิดเคสจาก Line (เก็บถาวร — line_msg_triage ถูกล้างทุก 7 วัน) ──
const LC_CLOSE_REASONS = {
  case_system: 'เปิดเคสผ่านระบบ',
  manual:      'ลงระบบไปแล้ว (Manual)',
  not_case:    'ไม่ใช่เคส',
};
let _lcCloseLogTable = false;
async function ensureLcCloseLog() {
  if (_lcCloseLogTable) return;
  await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='line_case_close_log' AND xtype='U')
    CREATE TABLE line_case_close_log (
      id             INT IDENTITY PRIMARY KEY,
      triage_id      INT NULL,
      source_msg_id  INT NULL,
      group_id       NVARCHAR(100) NULL,
      group_name     NVARCHAR(300) NULL,
      pod_id         INT NULL,
      message_time   DATETIME NULL,
      category       NVARCHAR(20) NULL,
      summary        NVARCHAR(500) NULL,
      message_text   NVARCHAR(1000) NULL,
      reason         NVARCHAR(20) NOT NULL,      -- case_system | manual | not_case
      calllog_id     INT NULL,
      note           NVARCHAR(300) NULL,
      msg_count      INT NULL,                   -- จำนวนข้อความในเรื่อง (ลูกค้าพิมพ์หลายบรรทัด)
      closed_by      INT NULL,                   -- employees.id
      closed_by_name NVARCHAR(100) NULL,
      closed_at      DATETIME DEFAULT GETDATE())`);
  _lcCloseLogTable = true;
}
async function lcCloseLog(triageId, reason, calllogId, note, user, body = {}) {
  // ปิดทั้งเรื่องหน้าเว็บส่งมาทีละข้อความ — บันทึกประวัติแค่ข้อความแรกของเรื่อง (log=false = ข้าม)
  if (body.log === false) return;
  try {
    await ensureLcCloseLog();
    await req().input('id', sql.Int, triageId).input('r', sql.NVarChar, reason).input('cid', sql.Int, calllogId || null)
      .input('note', sql.NVarChar, note || null).input('by', sql.Int, user?.employee_id || null)
      .input('byn', sql.NVarChar, user?.username || null).input('mc', sql.Int, parseInt(body.count) || 1).query(`
      INSERT INTO line_case_close_log (triage_id, source_msg_id, group_id, group_name, pod_id, message_time, category, summary,
                                       message_text, reason, calllog_id, note, msg_count, closed_by, closed_by_name)
      SELECT t.id, t.source_msg_id, t.group_id, COALESCE(t.group_name, lgp.group_name), lgp.pod_id, t.message_time, t.category, t.summary,
             LEFT(t.message_text, 1000), @r, @cid, @note, @mc, @by, @byn
      FROM line_msg_triage t LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id WHERE t.id = @id`);
  } catch (e) { console.error('line case close log failed:', e.message); }
}

// GET /api/triage/close-log?days=7&reason= — ประวัติการปิดเคสจาก Line (ล่าสุดก่อน) + สรุปตามเหตุผล
app.get('/api/triage/close-log', authRequired, async (request, res) => {
  try {
    await ensureLcCloseLog();
    const days = Math.min(90, Math.max(1, parseInt(request.query.days) || 7));
    const reason = LC_CLOSE_REASONS[request.query.reason] ? request.query.reason : '';
    const r = req().input('n', sql.Int, days - 1);
    if (reason) r.input('r', sql.NVarChar, reason);
    const where = `closed_at >= CAST(DATEADD(day, -@n, GETDATE()) AS DATE)`;
    const rows = (await r.query(`
      SELECT TOP 300 l.*, p.code AS pod_code FROM line_case_close_log l LEFT JOIN pods p ON p.id = l.pod_id
      WHERE ${where} ${reason ? 'AND l.reason=@r' : ''} ORDER BY l.closed_at DESC`)).recordset;
    const summary = (await req().input('n', sql.Int, days - 1).query(`
      SELECT reason, COUNT(*) AS n FROM line_case_close_log WHERE ${where} GROUP BY reason`)).recordset;
    res.json({ days, reasons: LC_CLOSE_REASONS, summary, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Team action on a triaged message: claim / done / reopen / note
app.post('/api/triage/:id/action', authRequired, async (request, res) => {
  const id = parseInt(request.params.id);
  const { action, note } = request.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const empId = request.user?.employee_id || null;
  try {
    if (action === 'claim') {
      await req().input('id', sql.Int, id).input('by', sql.Int, empId).query(
        `UPDATE line_msg_triage SET status='claimed', claimed_by=@by, claimed_at=GETDATE(), updated_at=GETDATE() WHERE id=@id`);
    } else if (action === 'done') {
      await req().input('id', sql.Int, id).input('by', sql.Int, empId).query(
        `UPDATE line_msg_triage
         SET status='done', done_by=@by, done_at=GETDATE(),
             claimed_by=ISNULL(claimed_by,@by), claimed_at=ISNULL(claimed_at,GETDATE()), updated_at=GETDATE()
         WHERE id=@id`);
    } else if (action === 'reopen') {
      await req().input('id', sql.Int, id).query(
        `UPDATE line_msg_triage SET status='open', claimed_by=NULL, claimed_at=NULL, done_by=NULL, done_at=NULL, updated_at=GETDATE() WHERE id=@id`);
    } else if (action === 'note') {
      await req().input('id', sql.Int, id).input('note', sql.NVarChar, String(note || '').slice(0, 990)).query(
        `UPDATE line_msg_triage SET note=@note, updated_at=GETDATE() WHERE id=@id`);
    } else if (action === 'close' || action === 'dismiss') {
      // ปิดเคสจาก "คัดกรองเคสจาก Line" พร้อมเหตุผล (dismiss = ชื่อเก่าของ not_case)
      const reason = action === 'dismiss' ? 'not_case' : String(request.body?.reason || '');
      if (!LC_CLOSE_REASONS[reason] || reason === 'case_system') return res.status(400).json({ error: 'reason ไม่ถูกต้อง' });
      let cid = null;
      if (reason === 'manual' && request.body?.calllog_id) {
        cid = parseInt(String(request.body.calllog_id).replace(/\D/g, ''));
        if (!cid) return res.status(400).json({ error: 'เลขเคสไม่ถูกต้อง' });
        if (getExtPool()) {
          const ok = (await extReq().input('cid', sql.Int, cid).query('SELECT 1 AS x FROM Calllog WHERE CalllogId=@cid')).recordset.length;
          if (!ok) return res.status(400).json({ error: `ไม่พบเคส #${cid} ใน Calllog` });
        }
      }
      const extra = String(note || '').trim().slice(0, 300);
      const text = `ปิดเคส: ${LC_CLOSE_REASONS[reason]}${cid ? ` #${cid}` : ''}${extra ? ` — ${extra}` : ''} (${request.user?.username || '—'})`;
      await ensureTriageCaseCol();
      await req().input('id', sql.Int, id).input('by', sql.Int, empId).input('cid', sql.Int, cid)
        .input('note', sql.NVarChar, text.slice(0, 990)).query(
        `UPDATE line_msg_triage
         SET status='done', done_by=@by, done_at=GETDATE(), note=@note, calllog_id=ISNULL(@cid, calllog_id),
             claimed_by=ISNULL(claimed_by,@by), claimed_at=ISNULL(claimed_at,GETDATE()), updated_at=GETDATE()
         WHERE id=@id`);
      await lcCloseLog(id, reason, cid, extra, request.user, request.body);
    } else if (action === 'case') {
      // ลงเคสจาก "คัดกรองเคสจาก Line" สำเร็จ → ผูกเลขเคส + ปิดงานว่าแก้ไขและบันทึกเรียบร้อย
      const cid = parseInt(request.body?.calllog_id);
      if (!cid) return res.status(400).json({ error: 'calllog_id required' });
      await ensureTriageCaseCol();
      await req().input('id', sql.Int, id).input('by', sql.Int, empId).input('cid', sql.Int, cid)
        .input('note', sql.NVarChar, `ลงเคส #${cid} แล้ว — Case นี้แก้ไขเรียบร้อยและลงบันทึกเรียบร้อยแล้ว`).query(
        `UPDATE line_msg_triage
         SET status='done', done_by=@by, done_at=GETDATE(), calllog_id=@cid, note=@note,
             claimed_by=ISNULL(claimed_by,@by), claimed_at=ISNULL(claimed_at,GETDATE()), updated_at=GETDATE()
         WHERE id=@id`);
      await lcCloseLog(id, 'case_system', cid, '', request.user, request.body);
    } else {
      return res.status(400).json({ error: 'unknown action' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── คัดกรองเคสจาก Line → เปิดเคส ─────────────────────────
// line_msg_triage.calllog_id = เคสใน Calllog ที่ลงจากข้อความนี้
let _triageCaseColP = null;
function ensureTriageCaseCol() {
  return _triageCaseColP ||= req().query(
    `IF COL_LENGTH('line_msg_triage','calllog_id') IS NULL ALTER TABLE line_msg_triage ADD calllog_id INT NULL`)
    .catch(e => { _triageCaseColP = null; throw e; });
}

// "เรื่อง" = ข้อความที่ต้องดำเนินการในแชทเดียวกันที่ห่างกันไม่เกิน TRIAGE_THREAD_MIN นาที (และยังอยู่ฝั่งเดียวกันของการตอบ)
// ข้อความที่ไม่มีข้อความก่อนหน้าแบบนั้น = จุดเริ่มเรื่องใหม่ · หน้าเว็บรวมรายการด้วยกติกาเดียวกัน (lcThreads)
const TRIAGE_THREAD_MIN = Math.max(5, parseInt(process.env.TRIAGE_THREAD_MINUTES) || 30);
const TRIAGE_THREAD_START_SQL = (t = 't') => `NOT EXISTS (
  SELECT 1 FROM line_msg_triage p
  WHERE p.group_id = ${t}.group_id AND p.id <> ${t}.id AND p.needs_action = 1 AND p.status IN ('open','claimed')
    AND p.message_time <= ${t}.message_time AND p.message_time >= DATEADD(minute, -${TRIAGE_THREAD_MIN}, ${t}.message_time)
    AND (p.message_time < ${t}.message_time OR p.id < ${t}.id)
    AND ISNULL(p.answered_in_line, 0) = ISNULL(${t}.answered_in_line, 0))`;

// GET /api/triage/pod-counts — จำนวน "เรื่อง" ที่ต้องดำเนินการและยังไม่เสร็จ แยกตาม Pod (pod_id null = ยังไม่ได้ assign)
app.get('/api/triage/pod-counts', authRequired, async (request, res) => {
  try {
    const rows = (await req().query(`
      SELECT lgp.pod_id, COUNT(*) AS n
      FROM line_msg_triage t LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
      WHERE t.status IN ('open','claimed') AND t.needs_action=1 AND ${triageScopeSql()} AND ${TRIAGE_THREAD_START_SQL()}
      GROUP BY lgp.pod_id`)).recordset;
    res.json({ counts: rows.map(r => ({ pod_id: r.pod_id, n: r.n })), total: rows.reduce((s, r) => s + r.n, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/triage/new?after=<id> — ข้อความที่ AI ตรวจว่าต้องดำเนินการ ใหม่กว่า id ที่เห็นล่าสุด (แจ้งเตือนเสียงทุกหน้า)
// ไม่ส่ง after = คืนแค่ id ล่าสุด (ไม่เตือนของค้างเก่าตอนเพิ่งเปิดหน้า)
app.get('/api/triage/new', authRequired, async (request, res) => {
  try {
    const after = parseInt(request.query.after);
    const last = (await req().query(`SELECT MAX(id) AS id FROM line_msg_triage`)).recordset[0]?.id || 0;
    if (!Number.isInteger(after) || after >= last) return res.json({ last, rows: [] });
    const rows = (await req().input('after', sql.Int, after).query(`
      SELECT TOP 10 t.id, t.group_name, t.customer_name, t.summary, t.priority, t.message_time,
             lgp.pod_id, p.code AS pod_code, p.color AS pod_color
      FROM line_msg_triage t
      LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
      LEFT JOIN pods p ON p.id = lgp.pod_id
      WHERE t.id > @after AND t.status='open' AND t.needs_action=1 AND ${triageScopeSql()}
        AND ${TRIAGE_THREAD_START_SQL()}   -- เตือนเฉพาะเรื่องใหม่ ข้อความต่อจากเรื่องเดิมไม่เด้งซ้ำ
      ORDER BY t.id DESC`)).recordset;
    res.json({ last, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  Leaderboard ตอบเคสไลน์ไว — นับเฉพาะข้อความที่ AI คัดกรองว่า "ต้องดำเนินการ" (เป็นเคส)
//  เก็บผลไว้ในตาราง line_case_response เอง (line_msg_triage ถูกล้างทุก 7 วัน)
//  เวลาตอบ = เวลาที่มีคนตอบในไลน์ (AnsweredTime) − เวลาข้อความ · ข้อความที่เข้ามาก่อน 08:00 เริ่มนับ 08:00
// ══════════════════════════════════════════════════════════
const LINE_LB_START = /^\d{4}-\d{2}-\d{2}$/.test(process.env.LINE_LB_START || '') ? process.env.LINE_LB_START : '2026-10-10';
const LINE_LB_TARGET_MIN = Math.max(1, parseInt(process.env.LINE_LB_TARGET_MIN) || 5);
const LINE_LB_WORK_START = 8;   // 08:00 — เวลาทำงาน 08:00-24:00
let _lcrTable = false, _lcrSyncRunning = false;
async function ensureLineCaseResponse() {
  if (_lcrTable) return;
  await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='line_case_response' AND xtype='U')
    CREATE TABLE line_case_response (
      source_msg_id INT PRIMARY KEY,          -- LineWaitingReply.Id
      group_id      NVARCHAR(100) NULL,
      group_name    NVARCHAR(300) NULL,
      pod_id        INT NULL,
      message_time  DATETIME NOT NULL,
      summary       NVARCHAR(500) NULL,
      priority      NVARCHAR(20) NULL,
      answered_by   NVARCHAR(100) NULL,       -- ชื่อแอดมิน LINE OA (เช่น INF-BOEK)
      answered_time DATETIME NULL,
      calllog_id    INT NULL,
      created_at    DATETIME DEFAULT GETDATE(),
      updated_at    DATETIME DEFAULT GETDATE())`);
  _lcrTable = true;
}

// ทุก 2 นาที: เคสที่ AI คัดกรองแล้วและมีคนตอบในไลน์ → บันทึกคนตอบ + เวลาตอบ · อัปเดตเลขเคสที่ลงแล้ว
async function syncLineCaseResponse() {
  if (_lcrSyncRunning) return;
  const lb = getLineBotPool();
  if (!lb) return;
  _lcrSyncRunning = true;
  try {
    await ensureLineCaseResponse();
    await ensureTriageCaseCol();
    await ensureTriageAnsweredAt();
    const todo = (await req().input('st', sql.NVarChar, LINE_LB_START).query(`
      SELECT TOP 1000 t.source_msg_id, t.group_id, COALESCE(t.group_name, lgp.group_name) AS group_name, lgp.pod_id,
             t.message_time, t.summary, t.priority, t.calllog_id, t.answered_by AS staff_by, t.answered_at AS staff_at
      FROM line_msg_triage t
      LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
      LEFT JOIN line_case_response r ON r.source_msg_id = t.source_msg_id
      WHERE t.needs_action = 1 AND t.message_time >= CAST(@st AS DATE) AND t.message_time IS NOT NULL
        AND (r.source_msg_id IS NULL OR r.answered_time IS NULL)
      ORDER BY t.message_time`)).recordset;
    let saved = 0;
    for (let i = 0; i < todo.length; i += 200) {
      const chunk = todo.slice(i, i + 200);
      const lreq = lb.request();
      chunk.forEach((x, k) => lreq.input('a' + k, sql.Int, x.source_msg_id));
      const ans = new Map((await lreq.query(`SELECT Id, AnsweredBy, AnsweredTime FROM dbo.LineWaitingReply
        WHERE Answered=1 AND AnsweredTime IS NOT NULL AND Id IN (${chunk.map((_, k) => '@a' + k).join(',')})`)).recordset.map(a => [a.Id, a]));
      for (const x of chunk) {
        // คนตอบ: จาก bot (INF-) หรือทีมงานที่ bot จำชื่อไม่ได้ (answered_at จาก triageMarkStaffReplies) — เอาคนที่ตอบก่อน
        const botAns = ans.get(x.source_msg_id);
        const staffAns = x.staff_at ? { AnsweredBy: x.staff_by, AnsweredTime: x.staff_at } : null;
        const a = !botAns ? staffAns : !staffAns ? botAns
          : (new Date(staffAns.AnsweredTime) < new Date(botAns.AnsweredTime) ? staffAns : botAns);
        if (!a) continue;   // ยังไม่มีใครตอบ — รอบหน้าค่อยดูใหม่
        await req().input('id', sql.Int, x.source_msg_id).input('g', sql.NVarChar, x.group_id).input('gn', sql.NVarChar, x.group_name)
          .input('pod', sql.Int, x.pod_id).input('mt', sql.DateTime, x.message_time).input('sum', sql.NVarChar, x.summary)
          .input('pri', sql.NVarChar, x.priority).input('by', sql.NVarChar, a.AnsweredBy || null).input('at', sql.DateTime, a.AnsweredTime)
          .input('cid', sql.Int, x.calllog_id || null).query(`
          IF EXISTS (SELECT 1 FROM line_case_response WHERE source_msg_id=@id)
            UPDATE line_case_response SET answered_by=@by, answered_time=@at, calllog_id=ISNULL(calllog_id,@cid), updated_at=GETDATE() WHERE source_msg_id=@id
          ELSE
            INSERT INTO line_case_response (source_msg_id, group_id, group_name, pod_id, message_time, summary, priority, answered_by, answered_time, calllog_id)
            VALUES (@id, @g, @gn, @pod, @mt, @sum, @pri, @by, @at, @cid)`);
        saved++;
      }
    }
    // เคสที่ลงเคสทีหลัง (ตอบไปก่อน แล้วค่อยเปิดเคส)
    await req().query(`UPDATE r SET calllog_id = t.calllog_id, updated_at = GETDATE()
      FROM line_case_response r JOIN line_msg_triage t ON t.source_msg_id = r.source_msg_id
      WHERE r.calllog_id IS NULL AND t.calllog_id IS NOT NULL`);
    if (saved) console.log(`🏁 line leaderboard: บันทึกการตอบ ${saved} เคส`);
  } catch (e) { console.error('line leaderboard sync error:', e.message); }
  finally { _lcrSyncRunning = false; }
}
setInterval(syncLineCaseResponse, 2 * 60 * 1000);

// GET /api/line-leaderboard?from=YYYY-MM-DD&to=YYYY-MM-DD&pod=<id|none>
app.get('/api/line-leaderboard', authRequired, async (request, res) => {
  try {
    const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
    const today = bangkokToday();
    let from = day(request.query.from) || today, to = day(request.query.to) || from;
    if (from > to) [from, to] = [to, from];
    if (from < LINE_LB_START) from = LINE_LB_START;
    const pod = request.query.pod;
    await syncLineCaseResponse();   // ให้ตัวเลขล่าสุด (มีกันรันซ้อนในตัว)
    await ensureLineCaseResponse();

    const load = async (f, t) => {
      if (t < f) return [];
      const r = req().input('f', sql.NVarChar, f).input('t', sql.NVarChar, t);
      let podSql = '';
      if (pod === 'none') podSql = 'AND pod_id IS NULL';
      else if (parseInt(pod)) { podSql = 'AND pod_id = @pod'; r.input('pod', sql.Int, parseInt(pod)); }
      return (await r.query(`SELECT source_msg_id, group_id, group_name, pod_id, message_time, summary, priority, answered_by, answered_time, calllog_id
        FROM line_case_response
        WHERE answered_time IS NOT NULL AND message_time >= CAST(@f AS DATE) AND message_time < DATEADD(day, 1, CAST(@t AS DATE)) ${podSql}`)).recordset;
    };
    // ข้อความที่ลูกค้าพิมพ์ติดกันแล้วถูกตอบด้วยการตอบครั้งเดียว = 1 เคส (เริ่มนับจากข้อความแรก)
    const toEvents = rows => {
      const m = new Map();
      for (const r of rows) {
        const k = `${r.group_id}|${r.answered_by}|${+new Date(r.answered_time)}`;
        const e = m.get(k);
        if (!e) m.set(k, { ...r, urgent: r.priority === 'urgent', logged: !!r.calllog_id, msgs: 1 });
        else {
          e.msgs++; e.urgent ||= r.priority === 'urgent'; e.logged ||= !!r.calllog_id;
          if (new Date(r.message_time) < new Date(e.message_time)) Object.assign(e, { message_time: r.message_time, summary: r.summary, source_msg_id: r.source_msg_id });
        }
      }
      // วันที่/เวลาเก็บเป็นเวลาไทยแบบ face value (mssql ส่งมาเป็น UTC) — ใช้ getUTC* อ่านตามตัวเลขที่เก็บ
      return [...m.values()].map(e => {
        const mt = new Date(e.message_time), at = new Date(e.answered_time);
        const start = new Date(mt);
        if (mt.getUTCHours() < LINE_LB_WORK_START) start.setUTCHours(LINE_LB_WORK_START, 0, 0, 0);
        return { ...e, sec: Math.max(0, Math.round((at - start) / 1000)) };
      });
    };
    const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
    const T = LINE_LB_TARGET_MIN * 60;
    const stats = evs => {
      const secs = evs.map(e => e.sec), urg = evs.filter(e => e.urgent);
      return {
        cases: evs.length, median_sec: median(secs),
        within: secs.filter(s => s <= T).length,   // แต้ม = จำนวนเคสที่ตอบทันเป้า
        within_pct: evs.length ? Math.round(secs.filter(s => s <= T).length / evs.length * 100) : null,
        urgent: urg.length, urgent_within: urg.filter(e => e.sec <= T).length,
        logged: evs.filter(e => e.logged).length,
        buckets: [60, T, 900, Infinity].map((lim, i, arr) => secs.filter(s => s <= lim && (i === 0 || s > arr[i - 1])).length),
      };
    };

    const evs = toEvents(await load(from, to));
    // ช่วงก่อนหน้าความยาวเท่ากัน (ไว้เทียบเวลาตอบของทีม)
    const span = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const shift = n => new Date(Date.parse(from) - n * 86400000).toISOString().slice(0, 10);
    const prev = stats(toEvents(await load(shift(span) < LINE_LB_START ? LINE_LB_START : shift(span), shift(1))));

    const byPerson = new Map();
    evs.forEach(e => { const k = e.answered_by || '(ไม่ทราบ)'; (byPerson.get(k) || byPerson.set(k, []).get(k)).push(e); });
    // อันดับ = จำนวนเคสที่ตอบทันเป้า (ต้องทั้งเยอะและทัน) · เสมอกันดูคนที่ตอบไวกว่า
    const people = [...byPerson].map(([name, list]) => ({ name, ...stats(list) }))
      .sort((a, b) => b.within - a.within || (a.median_sec ?? 1e12) - (b.median_sec ?? 1e12) || b.cases - a.cases);

    // ยังรอคนตอบอยู่ตอนนี้ (เคสจาก AI ที่ยังไม่มีใครตอบในไลน์)
    const waitR = req().input('st', sql.NVarChar, LINE_LB_START);
    const waiting = (await waitR.query(`SELECT COUNT(*) AS n FROM line_msg_triage t
      WHERE t.needs_action=1 AND t.status <> 'done' AND ISNULL(t.answered_in_line,0)=0 AND t.message_time >= CAST(@st AS DATE)`)).recordset[0].n;

    res.json({
      from, to, start: LINE_LB_START, target_min: LINE_LB_TARGET_MIN, min_cases: 10,
      team: stats(evs), prev, waiting, people,
      slowest: [...evs].sort((a, b) => b.sec - a.sec).slice(0, 10)
        .map(e => ({ sec: e.sec, group_name: e.group_name, summary: e.summary, pod_id: e.pod_id, answered_by: e.answered_by, message_time: e.message_time, urgent: e.urgent })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

let _caseDraftSubj = null;
// GET /api/triage/:id/case-draft — AI ร่างเคสจากข้อความ (อาการ / วิธีแก้ / หัวข้อ) + เดาร้านจากชื่อกลุ่มไลน์
app.get('/api/triage/:id/case-draft', authRequired, async (request, res) => {
  const id = parseInt(request.params.id);
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const t = (await req().input('id', sql.Int, id).query(`
      SELECT t.id, t.group_id, COALESCE(t.group_name, lgp.group_name) AS group_name, t.customer_name,
             t.message_text, t.message_time, t.summary, t.category, t.priority
      FROM line_msg_triage t LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
      WHERE t.id=@id`)).recordset[0];
    if (!t) return res.status(404).json({ error: 'ไม่พบข้อความ' });

    // ข้อความรอบๆ ในกลุ่มเดียวกัน (ก่อน 1 ชม. – หลัง 6 ชม.) ให้ AI เห็นบริบท
    const thread = (await req().input('g', sql.NVarChar, t.group_id).input('mt', sql.DateTime, t.message_time).query(`
      SELECT TOP 20 customer_name, message_text, message_time FROM line_msg_triage
      WHERE group_id=@g AND message_time BETWEEN DATEADD(hour,-1,@mt) AND DATEADD(hour,6,@mt)
      ORDER BY message_time`)).recordset;

    // ร้านที่ชื่ออยู่ในชื่อกลุ่มไลน์ (ยาวสุดก่อน = ตรงสุด)
    let stores = [];
    if (getExtPool() && t.group_name) {
      stores = (await extReq().input('gn', sql.NVarChar, t.group_name).query(`
        SELECT TOP 5 r.RegistrationId, r.CompanyName, r.Phone, r.MobilePhone, r.ContactName
        FROM CustomerRegistration r
        WHERE (r.Hide=0 OR r.Hide IS NULL) AND r.AccurateData=1 AND LEN(r.CompanyName) >= 4
          AND @gn LIKE N'%' + r.CompanyName + N'%'
        ORDER BY LEN(r.CompanyName) DESC, r.RegistrationId DESC`).catch(() => ({ recordset: [] }))).recordset;
    }

    // หัวข้อให้ AI เลือก — ชุดเดียวกับฟอร์มเปิดเคส
    let subjects = [];
    if (getExtPool()) {
      // เฉพาะหัวข้อที่ใช้บ่อยใน 90 วันล่าสุด (100 อันดับ) — ส่งทั้งหมดเปลือง token มาก · จำไว้ 6 ชม.
      if (!_caseDraftSubj || Date.now() - _caseDraftSubj.at > 6 * 3600000) {
        _caseDraftSubj = { at: Date.now(), rows: (await extReq().query(`
          SELECT TOP 100 s.SubjectName AS name, MIN(s.ProblemTypeId) AS problem_type_id
          FROM Calllog cl JOIN Subject s ON s.SubjectName = cl.Subject AND s.Active=1
          WHERE cl.ReceiveDate >= DATEADD(day, -90, GETDATE())
          GROUP BY s.SubjectName ORDER BY COUNT(*) DESC`)).recordset };
      }
      subjects = _caseDraftSubj.rows;
    }

    const convo = thread.map(m => `- ${m.customer_name || 'ลูกค้า'}: ${String(m.message_text || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n');
    const prompt = `คุณคือ Support ที่กำลังลงบันทึกเคสจากข้อความที่ลูกค้าแจ้งในไลน์กลุ่ม "${t.group_name || ''}"
ข้อความหลัก: ${String(t.message_text || '').replace(/\s+/g, ' ').slice(0, 800)}
สรุปจากระบบคัดกรอง: ${t.summary || '-'}

บทสนทนาในกลุ่มช่วงนั้น:
${convo || '-'}

หัวข้อเคสที่เลือกได้ (ต้องเลือกให้ตรงตัวอักษร หรือเว้นว่างถ้าไม่มีที่เหมาะ):
${subjects.map(s => s.name).join(' | ')}

ตอบเป็น JSON object เดียวเท่านั้น:
- description: อาการ/รายละเอียดปัญหาที่ลูกค้าแจ้ง ภาษาไทย กระชับ 1-3 ประโยค
- solution: วิธีแก้ไขที่ทำหรือแนะนำให้ลูกค้า ภาษาไทย กระชับ (ถ้าบทสนทนาไม่บอก ให้เขียนวิธีแก้ที่เหมาะสมที่สุดตามอาการ)
- subject: หัวข้อเคสจากรายการด้านบน`;
    const parseObj = txt => {
      const m = String(txt).match(/\{[\s\S]*\}/);
      const o = JSON.parse(m ? m[0] : txt);
      if (!o || typeof o !== 'object') throw new Error('bad AI reply');
      return o;
    };
    let draft = { description: t.summary || t.message_text || '', solution: '', subject: '' }, aiError = null;
    try {
      const { value } = await aiGenerate(prompt, { parse: parseObj, feature: 'case_draft', geminiConfig: {
        generationConfig: { responseMimeType: 'application/json', responseSchema: {
          type: SchemaType.OBJECT,
          properties: { description: { type: SchemaType.STRING }, solution: { type: SchemaType.STRING }, subject: { type: SchemaType.STRING } },
          required: ['description', 'solution', 'subject'] } } } });
      draft = { description: String(value.description || draft.description), solution: String(value.solution || ''), subject: String(value.subject || '') };
    } catch (e) { aiError = e.message; }
    const subj = subjects.find(s => s.name === draft.subject.trim());

    res.json({
      triage: { id: t.id, group_name: t.group_name, customer_name: t.customer_name, message_text: t.message_text,
                message_time: t.message_time, summary: t.summary },
      description: draft.description, solution: draft.solution,
      subject: subj?.name || null, problem_type_id: subj?.problem_type_id || null,
      stores, ai_error: aiError,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Unified auto tick — one cadence (TRIAGE_AUTO_MINUTES, default 15) that first
// classifies new messages (if TRIAGE_AUTO=on), then sends the LINE alert with the
// fresh data (if TRIAGE_ALERT=on). Classify + alert stay in sync on the same cycle.
const TRIAGE_AUTO_MIN = Math.max(1, parseInt(process.env.TRIAGE_AUTO_MINUTES) || 15);
let _triageAutoRunning = false;
let _triageAutoLastAt = new Date();   // anchor for the countdown; matches setInterval's schedule below
async function triageAutoTick() {
  if (_triageAutoRunning) return;
  _triageAutoRunning = true;
  _triageAutoLastAt = new Date();
  try {
    if ((process.env.TRIAGE_AUTO || '').toLowerCase() === 'on') {
      const r = await classifyTriageBatch(60);
      if (r.classified) console.log(`🤖 triage auto: classified ${r.classified} msg(s)`);
      if (r.error) console.warn('triage auto error:', r.error);
    }
    // ปิดงานที่ติด 💡 "น่าจะแก้แล้ว" ให้เป็นเสร็จเอง — ทำหลัง classify เพราะต้องรู้ก่อน
    // ว่าข้อความที่ตามมาเป็น thank/positive ไหม — ค่าเริ่มต้นปิด (TRIAGE_AUTO_CLOSE=on เพื่อเปิด)
    if (TRIAGE_AUTO_CLOSE) {
      try {
        const closed = await closeMaybeResolved();
        if (closed) console.log(`💡 triage auto-close: ปิด ${closed} รายการที่น่าจะแก้แล้ว`);
      } catch (e) { console.error('triage auto-close error:', e.message); }
    }
    // ล้างข้อมูลเก่าวันละครั้ง ถ้าเปิดสวิตช์ไว้ในหน้าตั้งค่า
    try { await triageAutoPurgeTick(); }
    catch (e) { console.error('triage auto-purge error:', e.message); }
    // (แจ้งเตือน LINE ย้ายไปอยู่ triageAlertSchedulerTick ด้านล่าง — ต้องยิงตรงนาฬิกา
    //  :00/:30 ซึ่ง setInterval ของรอบนี้ทำไม่ได้ เพราะนับจากเวลาที่ server เริ่มทำงาน)
  } catch (e) { console.error('triage auto tick error:', e.message); }
  finally { _triageAutoRunning = false; }
}
setInterval(triageAutoTick, TRIAGE_AUTO_MIN * 60 * 1000);

// ── คัดกรองเกือบ real time ─────────────────────────────────
// ทุก TRIAGE_FAST_SECONDS (20) ถามแค่ MAX(Id) ของ LineWaitingReply (เบามาก ไม่เรียก AI)
// มีข้อความใหม่ → รอให้เงียบ TRIAGE_QUIET_SECONDS (30) ก่อน เพื่อรวมข้อความที่ลูกค้าพิมพ์ติดกันหลายบรรทัด
// เป็น AI call เดียว (ประหยัด token) · รอนานสุด TRIAGE_MAX_WAIT_SECONDS (90) แม้ยังมีข้อความเข้ามาเรื่อยๆ
// ปิดได้ด้วย TRIAGE_FAST=off (ยังเหลือรอบปกติทุก TRIAGE_AUTO_MINUTES)
const TRIAGE_FAST_SEC  = Math.max(5,  parseInt(process.env.TRIAGE_FAST_SECONDS) || 20);
const TRIAGE_QUIET_SEC = Math.max(0,  parseInt(process.env.TRIAGE_QUIET_SECONDS) || 30);
const TRIAGE_MAXW_SEC  = Math.max(10, parseInt(process.env.TRIAGE_MAX_WAIT_SECONDS) || 90);
let _triageSeenId = null, _triageNewSince = null;
let _triageFastFails = 0, _triageFastPauseUntil = 0;   // AI ล้ม → พักก่อนลองใหม่ (1, 2, 4 … สูงสุด 15 นาที) ไม่ยิงซ้ำทุก 20 วิ
async function triageFastTick() {
  if ((process.env.TRIAGE_AUTO || '').toLowerCase() !== 'on') return;
  if ((process.env.TRIAGE_FAST || 'on').toLowerCase() === 'off') return;
  if (_triageAutoRunning || Date.now() < _triageFastPauseUntil) return;
  const lb = getLineBotPool();
  if (!lb) return;
  try {
    // วัดความเงียบด้วยนาฬิกาของ LineBotMonitor เอง — กันเวลาคนละเครื่องไม่ตรงกัน
    const x = (await lb.request().query(`SELECT MAX(Id) AS id,
        DATEDIFF(second, MAX(MessageTime), GETDATE()) AS quiet FROM dbo.LineWaitingReply`)).recordset[0];
    if (!x?.id) return;
    if (_triageSeenId === null) { _triageSeenId = x.id; return; }   // เริ่ม server: รอบปกติเก็บของค้างให้
    if (x.id <= _triageSeenId) { _triageNewSince = null; return; }
    _triageNewSince ||= Date.now();
    const waited = (Date.now() - _triageNewSince) / 1000;
    if ((x.quiet ?? 1e9) < TRIAGE_QUIET_SEC && waited < TRIAGE_MAXW_SEC) return;

    _triageAutoRunning = true;
    try {
      const r = await classifyTriageBatch(60);
      if (r.error) {   // ไม่เลื่อน seenId — ลองใหม่หลังพัก
        _triageFastFails++;
        const mins = Math.min(15, 2 ** (_triageFastFails - 1));
        _triageFastPauseUntil = Date.now() + mins * 60000;
        console.warn(`triage fast error (พัก ${mins} นาที):`, r.error);
        return;
      }
      _triageFastFails = 0;
      if (r.classified) console.log(`⚡ triage fast: ${r.classified} msg(s)${r.ruled ? ` (กฎ ${r.ruled})` : ''}`);
      _triageSeenId = x.id; _triageNewSince = null;
    } finally { _triageAutoRunning = false; }
  } catch (e) { console.error('triage fast tick error:', e.message); }
}
setInterval(triageFastTick, TRIAGE_FAST_SEC * 1000);

// ── ตารางส่งแจ้งเตือน LINE ────────────────────────────────
// ยิงตรงนาฬิกา เช่น ทุก 30 นาที = 08:00, 08:30, 09:00 … ภายในช่วงเวลาทำงาน
// ค่าใน .env เป็นแค่ค่าตั้งต้นครั้งแรก — หลังจากนั้นแก้ได้จากหน้าเว็บ (ตาราง
// triage_settings) โดยไม่ต้องรีสตาร์ท server
const TRIAGE_ALERT_EVERY_DEFAULT  = Math.max(1, Math.min(720, parseInt(process.env.TRIAGE_ALERT_EVERY_MIN) || 30));
const TRIAGE_ALERT_WINDOW_DEFAULT = (process.env.TRIAGE_ALERT_WINDOW || '08:00-00:00').trim();
const TRIAGE_RETENTION_DEFAULT    = Math.max(1, Math.min(365, parseInt(process.env.TRIAGE_RETENTION_DAYS) || 7));

// "08:00-00:00" → { start: 480, end: 1440 } (นาทีนับจากเที่ยงคืน)
// ปลายทางที่ <= ต้นทาง แปลว่าข้ามเที่ยงคืน จึงบวก 24 ชม.
function parseAlertWindow(str) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(str);
  if (!m) return { start: 480, end: 1440 };
  const start = (+m[1]) * 60 + (+m[2]);
  let end = (+m[3]) * 60 + (+m[4]);
  if (end <= start) end += 1440;
  return { start, end };
}
// ค่าที่ใช้อยู่จริงตอนนี้ — โหลดจาก triage_settings ตอนเปิดเครื่อง และทุกครั้งที่กดบันทึก
// ตัวจับเวลาอ่านจากตัวนี้ทุก tick จึงเปลี่ยนรอบส่งได้ทันทีโดยไม่ต้องรีสตาร์ท
const TRIAGE_CFG = {
  alertEveryMin: TRIAGE_ALERT_EVERY_DEFAULT,
  alertWindow:   TRIAGE_ALERT_WINDOW_DEFAULT,
  win:           parseAlertWindow(TRIAGE_ALERT_WINDOW_DEFAULT),
  retentionDays: TRIAGE_RETENTION_DEFAULT,
  autoPurge:     false,
  lastPurgeAt:   null,
  updatedAt:     null,
  updatedBy:     null,
};

function triageAlertInWindow(mins) {
  const { start, end } = TRIAGE_CFG.win;
  return (mins >= start && mins < end) || (mins + 1440 >= start && mins + 1440 < end);
}

let _triageAlertLastSlot = null;   // กันยิงซ้ำช่องเวลาเดิม (tick ทุก 30 วินาที)
let _triageAlertRunning  = false;

async function triageAlertSchedulerTick() {
  if ((process.env.TRIAGE_ALERT || '').toLowerCase() !== 'on') return;
  if (_triageAlertRunning) return;
  const now  = new Date();
  const hhmm = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' });
  const [hh, mm] = hhmm.split(':').map(Number);
  const mins = hh * 60 + mm;
  if (mins % TRIAGE_CFG.alertEveryMin !== 0) return;      // ไม่ตรงช่องเวลา
  if (!triageAlertInWindow(mins)) return;           // นอกเวลาทำงาน
  const slot = `${bangkokToday()} ${hhmm}`;
  if (_triageAlertLastSlot === slot) return;        // ช่องนี้ยิงไปแล้ว
  _triageAlertLastSlot = slot;

  _triageAlertRunning = true;
  try {
    const a = await buildTriageAlert();
    if (!a.hasAny) { console.log(`🔕 triage alert ${hhmm}: ไม่มี ticket ค้าง — ไม่ส่ง`); return; }
    const groups = await sendTriageAlert(a);
    console.log(`🔔 triage alert ${hhmm} → ${groups} LINE group(s) (over1d ${a.overdayCount}, urgent ${a.urgentCount}, warn ${a.warnCount})`);
  } catch (e) { console.error('triage alert scheduler error:', e.message); }
  finally { _triageAlertRunning = false; }
}
setInterval(triageAlertSchedulerTick, 30 * 1000);

// ── แจ้งเตือน LINE: เคสด่วนจาก Line ค้างเกิน 30 นาที ─────────────────
// เงื่อนไข: AI ว่าด่วน + ต้องดำเนินการ · ยังไม่เปิดเคส/ปิดเคส (status ยังไม่ done) · ยังไม่มีใครตอบในไลน์
//         · รอเกิน TRIAGE_URGENT_ALERT_MIN นาที (ค่าเริ่มต้น 30) — แจ้งครั้งเดียวต่อข้อความ (urgent_alerted_at)
// ส่งถึงกลุ่ม LINE ที่ติ๊กเหตุการณ์ "urgent_line_case" ในตั้งค่า → LINE Notifications (กรองตาม Pod ของกลุ่มนั้นได้)
// ช่วงเวลาส่ง TRIAGE_URGENT_ALERT_HOURS (ค่าเริ่มต้น 8-23) · ปิดด้วย TRIAGE_URGENT_ALERT=off
const URGENT_ALERT_ON  = (process.env.TRIAGE_URGENT_ALERT || 'on').toLowerCase() !== 'off';
const URGENT_ALERT_MIN = Math.max(5, parseInt(process.env.TRIAGE_URGENT_ALERT_MIN) || 30);
const [URGENT_H_FROM, URGENT_H_TO] = (/^(\d{1,2})-(\d{1,2})$/.exec(process.env.TRIAGE_URGENT_ALERT_HOURS || '') || [0, 8, 23]).slice(1).map(Number);
let _urgentColP = null, _urgentRunning = false;
function ensureUrgentAlertCol() {
  return _urgentColP ||= req().query(
    `IF COL_LENGTH('line_msg_triage','urgent_alerted_at') IS NULL ALTER TABLE line_msg_triage ADD urgent_alerted_at DATETIME NULL`)
    .catch(e => { _urgentColP = null; throw e; });
}
async function urgentLineCaseTick() {
  if (!URGENT_ALERT_ON || _urgentRunning) return;
  const hh = +new Date().toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' }).slice(0, 2);
  if (hh < URGENT_H_FROM || hh > URGENT_H_TO) return;
  const lb = getLineBotPool();
  if (!lb) return;
  _urgentRunning = true;
  try {
    await ensureUrgentAlertCol();
    try { await syncTriageAnswered(); } catch {}   // สถานะ "ตอบในไลน์แล้ว" ล่าสุดก่อนตัดสิน
    // เวลาข้อความมาจากนาฬิกาเครื่อง LineBotMonitor — วัดเวลารอด้วยนาฬิกาเครื่องเดียวกัน (cs_team เดินไม่ตรงกัน)
    const lbNow = (await lb.request().query('SELECT GETDATE() AS now')).recordset[0].now;
    const cut = new Date(lbNow.getTime() - URGENT_ALERT_MIN * 60000);
    const rows = (await req().input('cut', sql.DateTime, cut).query(`
      SELECT t.id, t.group_id, COALESCE(t.group_name, lgp.group_name) AS group_name, t.customer_name, t.summary,
             t.message_time, lgp.pod_id, p.code AS pod_code
      FROM line_msg_triage t
      LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
      LEFT JOIN pods p ON p.id = lgp.pod_id
      WHERE t.needs_action = 1 AND t.priority = 'urgent' AND t.status IN ('open','claimed')
        AND ISNULL(t.answered_in_line, 0) = 0 AND t.urgent_alerted_at IS NULL
        AND t.message_time <= @cut AND t.message_time >= DATEADD(day, -1, @cut)
        AND ${triageScopeSql()}
      ORDER BY t.message_time`)).recordset;
    if (!rows.length) return;

    // แชทเดียวกัน = 1 บรรทัด (ใช้ข้อความแรกที่รอนานสุด)
    const byChat = new Map();
    rows.forEach(r => { if (!byChat.has(r.group_id)) byChat.set(r.group_id, { ...r, n: 0 }); byChat.get(r.group_id).n++; });
    const chats = [...byChat.values()];
    const waitTxt = mt => {
      const m = Math.round((lbNow - new Date(mt)) / 60000);
      return m >= 60 ? `${Math.floor(m / 60)} ชม.${m % 60 ? ` ${m % 60} นาที` : ''}` : `${m} นาที`;
    };
    const clip = (v, n) => { v = String(v || '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n - 1) + '…' : v; };
    const build = list => !list.length ? '' : [
      `🚨 เคสด่วนจาก LINE ค้างเกิน ${URGENT_ALERT_MIN >= 60 ? URGENT_ALERT_MIN / 60 + ' ชม.' : URGENT_ALERT_MIN + ' นาที'} (${list.length} เรื่อง)`,
      'ยังไม่มีคนตอบในไลน์ และยังไม่ได้เปิดเคส/ปิดเคส',
      '',
      ...list.slice(0, 15).map(c => `• [${c.pod_code || 'ยังไม่ได้ Assign'}] ${clip(c.group_name, 40)} — ${clip(c.summary, 70)} (รอ ${waitTxt(c.message_time)})`),
      ...(list.length > 15 ? [`…และอีก ${list.length - 15} เรื่อง`] : []),
      '',
      '👉 จัดการได้ที่ หน้าติดตามเคส → เคสจาก Line ค้าง',
    ].join('\n');

    // กลุ่มที่ผูก Pod ไว้ได้เฉพาะเรื่องของ Pod นั้น · ไม่ผูก = ได้ทุกเรื่อง
    const sent = await sendLineNotify(target => {
      const pods = parsePodIds(target.pod_ids);
      return build(pods.length ? chats.filter(c => pods.includes(c.pod_id ?? POD_UNASSIGNED)) : chats);
    }, 'urgent_line_case', { optIn: true });

    if (sent) {
      const ids = rows.map(r => +r.id).join(',');
      await req().query(`UPDATE line_msg_triage SET urgent_alerted_at = GETDATE() WHERE id IN (${ids})`);
      console.log(`🚨 urgent line case: แจ้งเตือน ${chats.length} เรื่อง → ${sent} กลุ่ม LINE`);
    }
  } catch (e) { console.error('urgent line case alert error:', e.message); }
  finally { _urgentRunning = false; }
}
setInterval(urgentLineCaseTick, 5 * 60 * 1000);

// ── ตั้งค่าคัดกรอง / แจ้งเตือน ที่แก้ได้จากหน้าเว็บ ────────
// เก็บเป็นแถวเดียว (id=1) แทนการแก้ .env แล้วรีสตาร์ท
async function ensureTriageSettingsTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='triage_settings' AND xtype='U')
      CREATE TABLE triage_settings (
        id              INT PRIMARY KEY,
        alert_every_min INT NOT NULL,
        alert_window    NVARCHAR(20) NOT NULL,
        retention_days  INT NOT NULL,
        auto_purge      BIT NOT NULL,
        last_purge_at   DATETIME NULL,
        updated_at      DATETIME DEFAULT GETDATE(),
        updated_by      NVARCHAR(100) NULL
      )`);
    await req()
      .input('ev', sql.Int, TRIAGE_ALERT_EVERY_DEFAULT)
      .input('wd', sql.NVarChar, TRIAGE_ALERT_WINDOW_DEFAULT)
      .input('rd', sql.Int, TRIAGE_RETENTION_DEFAULT)
      .query(`IF NOT EXISTS (SELECT 1 FROM triage_settings WHERE id=1)
                INSERT INTO triage_settings (id, alert_every_min, alert_window, retention_days, auto_purge)
                VALUES (1, @ev, @wd, @rd, 0)`);
    await loadTriageSettings();
    console.log(`✅ triage_settings ready — แจ้งเตือนทุก ${TRIAGE_CFG.alertEveryMin} นาที (${TRIAGE_CFG.alertWindow}) · เก็บข้อมูล ${TRIAGE_CFG.retentionDays} วัน · ล้างอัตโนมัติ ${TRIAGE_CFG.autoPurge ? 'เปิด' : 'ปิด'}`);
  } catch (e) { console.error('❌ triage_settings error:', e.message); }
}

async function loadTriageSettings() {
  const row = (await req().query('SELECT TOP 1 * FROM triage_settings WHERE id=1')).recordset[0];
  if (!row) return TRIAGE_CFG;
  TRIAGE_CFG.alertEveryMin = Math.max(1, Math.min(720, row.alert_every_min || TRIAGE_ALERT_EVERY_DEFAULT));
  TRIAGE_CFG.alertWindow   = String(row.alert_window || TRIAGE_ALERT_WINDOW_DEFAULT).trim();
  TRIAGE_CFG.win           = parseAlertWindow(TRIAGE_CFG.alertWindow);
  TRIAGE_CFG.retentionDays = Math.max(1, Math.min(365, row.retention_days || TRIAGE_RETENTION_DEFAULT));
  TRIAGE_CFG.autoPurge     = !!row.auto_purge;
  TRIAGE_CFG.lastPurgeAt   = row.last_purge_at || null;
  TRIAGE_CFG.updatedAt     = row.updated_at || null;
  TRIAGE_CFG.updatedBy     = row.updated_by || null;
  return TRIAGE_CFG;
}

// ── ล้างข้อมูลคัดกรองที่เก่ากว่า N วัน ───────────────────
// ลบเฉพาะตารางของแอป (line_msg_triage + ผลประเมินของ AI) ข้อความต้นทางใน
// LineBotMonitor ไม่ถูกแตะ — ที่หายไปคือผลคัดกรองกับสถานะที่ทีมกดไว้เท่านั้น
const TRIAGE_AGE_SQL = 'COALESCE(t.message_time, t.classified_at)';

async function countTriageOlderThan(days) {
  const row = (await req().input('d', sql.Int, days).query(`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN t.status='open' AND t.needs_action=1 THEN 1 ELSE 0 END) AS still_open,
           MIN(${TRIAGE_AGE_SQL}) AS oldest
    FROM line_msg_triage t
    WHERE ${TRIAGE_AGE_SQL} < DATEADD(day, -@d, GETDATE())`)).recordset[0] || {};
  const total = (await req().query('SELECT COUNT(*) AS n FROM line_msg_triage')).recordset[0].n;
  return { will_delete: row.n || 0, still_open: row.still_open || 0, oldest: row.oldest || null, total };
}

// ลบทีละก้อน — ของเก่าสะสมเป็นหมื่นแถว ถ้าลบรวดเดียวจะล็อกตารางนานจนหน้าเว็บค้าง
const TRIAGE_PURGE_BATCH = 5000;
async function purgeTriageBatched(stmt, days) {
  let total = 0;
  for (let round = 0; round < 500; round++) {
    const r = await req().input('d', sql.Int, days).query(stmt);
    const n = r.rowsAffected?.[0] || 0;
    total += n;
    if (n < TRIAGE_PURGE_BATCH) break;
  }
  return total;
}

async function purgeTriageOlderThan(days) {
  // ลบผลประเมินของ AI ที่ผูกกับข้อความที่กำลังจะหายไปก่อน จะได้ไม่เหลือแถวกำพร้า
  await purgeTriageBatched(`
    DELETE TOP (${TRIAGE_PURGE_BATCH}) s FROM triage_ai_screen s
    JOIN line_msg_triage t ON t.source_msg_id = s.source_msg_id
    WHERE ${TRIAGE_AGE_SQL} < DATEADD(day, -@d, GETDATE())`, days);
  const deleted = await purgeTriageBatched(`
    DELETE TOP (${TRIAGE_PURGE_BATCH}) t FROM line_msg_triage t
    WHERE ${TRIAGE_AGE_SQL} < DATEADD(day, -@d, GETDATE())`, days);
  await req().query('UPDATE triage_settings SET last_purge_at=GETDATE() WHERE id=1');
  TRIAGE_CFG.lastPurgeAt = new Date();
  return deleted;
}

// ล้างอัตโนมัติวันละครั้ง (ถ้าเปิดสวิตช์ไว้) — เรียกจากรอบ auto tick
let _triagePurgeDay = null;
async function triageAutoPurgeTick() {
  if (!TRIAGE_CFG.autoPurge) return;
  const today = bangkokToday();
  if (_triagePurgeDay === today) return;
  _triagePurgeDay = today;
  const n = await purgeTriageOlderThan(TRIAGE_CFG.retentionDays);
  if (n) console.log(`🗑️ triage purge: ลบข้อมูลเก่ากว่า ${TRIAGE_CFG.retentionDays} วัน ${n} รายการ`);
}

// ── Sync "answered in LINE" ───────────────────────────────
// If a staff member already replied in the LINE group (LineWaitingReply.Answered=1),
// auto-close that triage ticket so it drops off the inbox and never alerts again.
let _triageSyncRunning = false;
// ตอบในไลน์แล้ว → แค่ติดป้าย ไม่ปิดงานให้ (ต้องมีคนเปิดเคส/กด "ไม่ใช่เคส") · TRIAGE_ANSWERED_CLOSE=on = ปิดให้แบบเดิม
const TRIAGE_ANSWERED_CLOSE = (process.env.TRIAGE_ANSWERED_CLOSE || 'off').toLowerCase() === 'on';
async function syncTriageAnswered() {
  if (_triageSyncRunning) return 0;
  const lb = getLineBotPool();
  if (!lb) return 0;
  _triageSyncRunning = true;
  try {
    const open = (await req().query(`SELECT source_msg_id FROM line_msg_triage WHERE status='open' AND ISNULL(answered_in_line,0)=0`)).recordset;
    if (!open.length) return 0;
    let closed = 0;
    for (let i = 0; i < open.length; i += 200) {
      const chunk = open.slice(i, i + 200).map(r => r.source_msg_id);
      const lreq = lb.request();
      chunk.forEach((id, k) => lreq.input('a' + k, sql.Int, id));
      const answered = (await lreq.query(
        `SELECT Id, AnsweredBy, AnsweredTime FROM dbo.LineWaitingReply
         WHERE Answered=1 AND Id IN (${chunk.map((_, k) => '@a' + k).join(',')})`)).recordset;
      for (const a of answered) {
        await req()
          .input('id', sql.Int, a.Id)
          .input('by', sql.NVarChar, a.AnsweredBy || null)
          .input('at', sql.DateTime, a.AnsweredTime || null)
          .query(`
            UPDATE line_msg_triage
            SET answered_in_line=1, answered_by=@by, updated_at=GETDATE()
              ${TRIAGE_ANSWERED_CLOSE ? ", status='done', done_at=ISNULL(@at, GETDATE())" : ''}
            WHERE source_msg_id=@id AND status='open' AND ISNULL(answered_in_line,0)=0`);
        closed++;
      }
    }
    if (closed) console.log(`🔄 triage sync: ${closed} ticket(s) answered in LINE${TRIAGE_ANSWERED_CLOSE ? ' — ปิดอัตโนมัติ' : ' (ติดป้าย รอคนเปิดเคส)'}`);
    return closed;
  } catch (e) { console.error('triage sync error:', e.message); return 0; }
  finally { _triageSyncRunning = false; }
}
setInterval(syncTriageAnswered, 3 * 60 * 1000);

// ══════════════════════════════════════════════════════════
//  AI คัดกรองก่อนส่งแจ้งเตือน
//  syncTriageAnswered() จับได้แค่เคสที่กดตอบใน LINE จริง (Answered=1)
//  และตัวกรองเดิมเป็น rule แข็ง (มีข้อความ thank/positive ตามหลัง)
//  ชั้นนี้ให้ AI อ่านบทสนทนา "หลัง" ข้อความที่ค้าง แล้วบอกว่าน่าจะจบแล้วไหม
//  → ผลเก็บ cache ไว้ ประเมินซ้ำเฉพาะเมื่อบทสนทนายาวขึ้น (กันเรียก Gemini ซ้ำทุก 15 นาที)
// ══════════════════════════════════════════════════════════
const TRIAGE_SCREEN_ON    = (process.env.TRIAGE_AI_SCREEN || 'on').toLowerCase() !== 'off';
const TRIAGE_SCREEN_BATCH = Math.max(5, Math.min(80, parseInt(process.env.TRIAGE_AI_SCREEN_BATCH) || 40));
const TRIAGE_TAIL_MAX     = 6;   // ดูข้อความตามหลังไม่เกินกี่ข้อความ

async function ensureTriageScreenTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='triage_ai_screen' AND xtype='U')
      CREATE TABLE triage_ai_screen (
        id            INT PRIMARY KEY IDENTITY,
        group_id      NVARCHAR(100) NOT NULL,
        source_msg_id INT NOT NULL,          -- ข้อความค้างที่ถูกประเมิน
        tail_count    INT NOT NULL,          -- จำนวนข้อความตามหลังที่ใช้ตัดสิน
        resolved      BIT NOT NULL,
        confidence    NVARCHAR(10) NULL,     -- high | medium | low
        reason        NVARCHAR(500) NULL,
        checked_at    DATETIME DEFAULT GETDATE()
      )
    `);
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('triage_ai_screen') AND name='UQ_triage_screen_msg_tail')
        ALTER TABLE triage_ai_screen ADD CONSTRAINT UQ_triage_screen_msg_tail UNIQUE (source_msg_id, tail_count)
    `);
    console.log('✅ triage_ai_screen table ready');
  } catch (e) { console.error('❌ triage_ai_screen error:', e.message); }
}

// ดึงบทสนทนาที่ตามหลังข้อความค้างของแต่ละกลุ่ม (จาก line_msg_triage — มีสรุป AI อยู่แล้ว)
async function fetchTriageTails() {
  const rows = (await req().query(`
    WITH pend AS (
      SELECT group_id, MIN(message_time) AS pend_time
      FROM line_msg_triage
      WHERE status='open' AND needs_action=1 AND message_time IS NOT NULL
      GROUP BY group_id
    )
    SELECT t.group_id, t.message_time, t.category, t.sentiment, t.status,
           t.summary, t.message_text
    FROM line_msg_triage t
    JOIN pend p ON p.group_id = t.group_id
    WHERE t.message_time > p.pend_time
    ORDER BY t.group_id, t.message_time
  `)).recordset;
  const map = new Map();
  for (const r of rows) {
    // สติกเกอร์/อีโมจิล้วนไม่บอกอะไร — ไม่นับเป็นข้อความตามหลัง จะได้ไม่ต้องให้ AI ประเมินใหม่ทุกครั้งที่มีคนส่งสติกเกอร์
    if (triageRuleClassify(r.message_text)?.summary === 'ส่งสติกเกอร์/อีโมจิ') continue;
    if (!map.has(r.group_id)) map.set(r.group_id, []);
    map.get(r.group_id).push(r);
  }
  return map;
}

// คืน Set ของ source_msg_id ที่ AI บอกว่า "น่าจะมีคนแก้ไขแล้ว" + รายละเอียดไว้โชว์
// aiCalls=false → ใช้แต่ผลที่ประเมินไว้แล้ว ไม่เรียก Gemini (สำหรับ preview ให้ตอบเร็ว)
async function aiScreenTriage(items, { aiCalls = true } = {}) {
  const out = { skip: new Set(), verdicts: [], checked: 0, cached: 0, pending: 0, error: null };
  if (!TRIAGE_SCREEN_ON || (!GROQ_API_KEY && !process.env.GEMINI_API_KEY)) return out;

  let tails;
  try { tails = await fetchTriageTails(); }
  catch (e) { out.error = 'อ่านบทสนทนาไม่สำเร็จ: ' + e.message; return out; }

  // มีเฉพาะรายการที่มีข้อความตามหลังจึงจะมีอะไรให้ AI ตัดสิน — ที่ไม่มีก็แจ้งเตือนตามปกติ
  const cands = items
    .filter(x => x.sourceMsgId && (tails.get(x.groupId) || []).length)
    .map(x => ({ ...x, tail: tails.get(x.groupId).slice(0, TRIAGE_TAIL_MAX) }));
  if (!cands.length) return out;

  // ใช้ผลที่ประเมินไว้แล้ว ถ้าบทสนทนายังยาวเท่าเดิม
  const byKey = new Map();
  try {
    const ids = cands.map(c => c.sourceMsgId);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = req();
      chunk.forEach((id, k) => r.input('s' + k, sql.Int, id));
      const rows = (await r.query(
        `SELECT source_msg_id, tail_count, resolved, confidence, reason FROM triage_ai_screen
         WHERE source_msg_id IN (${chunk.map((_, k) => '@s' + k).join(',')})`)).recordset;
      rows.forEach(x => byKey.set(`${x.source_msg_id}:${x.tail_count}`, x));
    }
  } catch (e) { /* ตารางยังไม่พร้อม — ประเมินใหม่ทั้งหมด */ }

  const todo = [];
  for (const c of cands) {
    const hit = byKey.get(`${c.sourceMsgId}:${c.tail.length}`);
    if (hit) {
      out.cached++;
      if (hit.resolved && hit.confidence !== 'low') {
        out.skip.add(c.sourceMsgId);
        out.verdicts.push({ name: c.name, pod: c.pod, reason: hit.reason, confidence: hit.confidence });
      }
      continue;
    }
    todo.push(c);
  }
  out.pending = todo.length;                 // ยังไม่ถูกประเมิน — จะทยอยทำในรอบถัดๆ ไป
  if (!todo.length || !aiCalls) return out;

  const batch = todo.slice(0, TRIAGE_SCREEN_BATCH);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 200);
  const list = batch.map((c, i) => {
    const tail = c.tail.map(t =>
      `   - (${t.category || '-'}/${t.sentiment || '-'}) ${clean(t.summary) || clean(t.message_text)}`
    ).join('\n');
    return `[${i}] กลุ่ม: ${clean(c.name)}\n  เรื่องที่ค้าง: ${clean(c.detail)}\n  ข้อความถัดมาในกลุ่มนี้:\n${tail}`;
  }).join('\n\n');

  const prompt = `คุณคือผู้ช่วยหัวหน้าทีม Customer Service กำลังจะส่งแจ้งเตือน "ticket ค้าง" เข้ากลุ่มไลน์ของทีม
ก่อนส่ง ให้ช่วยกรองออกว่ารายการไหน "น่าจะมีคนจัดการไปแล้ว" จึงไม่ควรส่งไปรบกวนซ้ำ

ตัดสินจากข้อความที่ลูกค้าพิมพ์ตามหลังเรื่องที่ค้าง เช่น
- ลูกค้าบอกว่าได้แล้ว/เรียบร้อย/ใช้งานได้แล้ว/ขอบคุณ → ถือว่าจบแล้ว (resolved = true)
- ลูกค้าบอกว่ามีทีมงานติดต่อไปแล้ว/โทรมาแล้ว/แก้ให้แล้ว → จบแล้ว
- ลูกค้าแก้ปัญหาได้เอง → จบแล้ว
- ลูกค้ายังทวงถาม/ถามซ้ำ/บ่นว่ายังไม่มีใครตอบ/แจ้งปัญหาเพิ่ม → ยังไม่จบ (resolved = false)
- ข้อความถัดมาไม่เกี่ยวกับเรื่องที่ค้าง → ยังไม่จบ

ตอบกลับเป็น JSON array เท่านั้น แต่ละ object มี field:
- i          : เลขลำดับ (ตรงกับ [i])
- resolved   : true/false — น่าจะมีคนจัดการแล้วไหม
- confidence : "high" | "medium" | "low" — ความมั่นใจ (ไม่มั่นใจให้ใช้ low)
- reason     : เหตุผลสั้นๆ ภาษาไทย 1 ประโยค

สำคัญ: ถ้าไม่มั่นใจให้ตอบ resolved=false หรือ confidence="low" — การส่งเตือนเกินดีกว่าปล่อยให้ลูกค้าค้างโดยไม่มีใครรู้

รายการ:
${list}`;

  // Gemini บังคับรูปแบบด้วย responseSchema ได้; Groq อาศัย prompt + parseJsonArrayReply แทน
  const geminiConfig = {
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            i:          { type: SchemaType.NUMBER },
            resolved:   { type: SchemaType.BOOLEAN },
            confidence: { type: SchemaType.STRING },
            reason:     { type: SchemaType.STRING },
          },
          required: ['i', 'resolved', 'confidence', 'reason'],
        },
      },
    },
  };

  let arr;
  try {
    // หน้า Pod & Assign ใช้ Gemini เป็นตัวหลัก Groq เป็นตัวสำรอง
    ({ value: arr } = await aiGenerate(prompt, { parse: parseJsonArrayReply, geminiConfig, feature: 'triage_screen' }));
  } catch (e) {
    // AI ล่ม → ไม่กรองอะไรเลย ปล่อยให้แจ้งเตือนตามปกติ (ปลอดภัยกว่าเงียบ)
    console.error('triage screen: AI failed:', e.message);
    out.error = 'AI คัดกรองไม่สำเร็จ: ' + e.message;
    return out;
  }
  if (!Array.isArray(arr)) { out.error = 'AI ตอบผิดรูปแบบ'; return out; }

  const byIndex = new Map();
  arr.forEach(o => { if (o && Number.isInteger(o.i)) byIndex.set(o.i, o); });

  for (let i = 0; i < batch.length; i++) {
    const c = batch[i];
    const o = byIndex.get(i);
    if (!o) continue;
    const resolved   = o.resolved === true || o.resolved === 'true';
    const confidence = ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'low';
    const reason     = String(o.reason || '').slice(0, 500);
    out.checked++;
    try {
      await req()
        .input('gid',  sql.NVarChar, c.groupId)
        .input('sid',  sql.Int,      c.sourceMsgId)
        .input('tc',   sql.Int,      c.tail.length)
        .input('rs',   sql.Bit,      resolved ? 1 : 0)
        .input('cf',   sql.NVarChar, confidence)
        .input('rsn',  sql.NVarChar, reason)
        .query(`INSERT INTO triage_ai_screen (group_id, source_msg_id, tail_count, resolved, confidence, reason)
                VALUES (@gid, @sid, @tc, @rs, @cf, @rsn)`);
    } catch (e) { /* ชนกับ unique constraint = มีคนบันทึกไปแล้ว ข้ามได้ */ }
    if (resolved && confidence !== 'low') {
      out.skip.add(c.sourceMsgId);
      out.verdicts.push({ name: c.name, pod: c.pod, reason, confidence });
    }
  }
  return out;
}

// ── Overdue-ticket LINE alert ─────────────────────────────
// Only genuinely un-serviced tickets (open, needs action, no staff reply, and NO
// thank/positive follow-up within 24h). Bucketed by how long they've waited:
//   >1 วัน = คาดว่ายังไม่ได้รับบริการ (โปรดตรวจสอบด่วน) · >30 นาที = ด่วน · 15–30 นาที = เริ่มค้าง
// aiCalls=false → ใช้แต่ผลคัดกรองที่ cache ไว้ (preview ตอบเร็ว ไม่เผา quota)
async function buildTriageAlert({ aiCalls = true } = {}) {
  await syncTriageAnswered();   // close LINE-answered tickets before building the alert
  // หนึ่งแถวต่อหนึ่งกลุ่ม = ข้อความที่ค้างนานที่สุดของกลุ่มนั้น (พร้อมสรุปจาก AI)
  const rows = (await req().query(`
    WITH pending AS (
      SELECT COALESCE(t.group_name, lgp.group_name) AS group_name, t.customer_name, t.group_id, t.source_msg_id,
             t.message_time,
             lgp.pod_id, p.display_name AS pod_name,
             t.summary, t.message_text,
             ROW_NUMBER() OVER (PARTITION BY t.group_id ORDER BY t.message_time ASC) AS rn,
             COUNT(*)    OVER (PARTITION BY t.group_id) AS cnt,
             DATEDIFF(MINUTE, MIN(t.message_time) OVER (PARTITION BY t.group_id), GETDATE()) AS waitmin
      FROM line_msg_triage t
      LEFT JOIN line_group_pods lgp ON lgp.group_id = t.group_id
      LEFT JOIN pods p ON p.id = lgp.pod_id
      WHERE t.status='open' AND t.needs_action=1 AND t.message_time IS NOT NULL
        AND ISNULL(t.answered_in_line,0)=0             -- ตอบในไลน์แล้ว ไม่ต้องเตือนว่าค้างตอบ (แต่ยังรอเปิดเคส)
        AND ${triageScopeSql()}                       -- เฉพาะกลุ่มที่ตั้งกระดิ่ง + ที่ยังไม่ได้ assign
        AND NOT EXISTS (                                 -- exclude likely-resolved
          SELECT 1 FROM line_msg_triage t2
          WHERE t2.group_id = t.group_id AND t2.message_time > t.message_time
            AND t2.message_time <= DATEADD(hour, 24, t.message_time)
            AND (t2.category IN ('thank','resolved') OR t2.sentiment='positive'))
    )
    SELECT group_name, customer_name, group_id, source_msg_id, message_time, pod_id, pod_name, summary, message_text, waitmin, cnt
    FROM pending WHERE rn = 1
  `)).recordset;

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let items = rows.map(r => {
    const isDM = String(r.group_id || '').startsWith('U');
    // แชทส่วนตัวใช้ชื่อ LINE ของคนนั้น — ไม่งั้นทุกห้องขึ้นว่า "แชทส่วนตัว" เหมือนกันหมด
    const name = isDM
      ? (clean(r.customer_name) ? `${clean(r.customer_name)} (แชทส่วนตัว)` : '(แชทส่วนตัว)')
      : (r.group_name || r.group_id || '(ไม่ทราบกลุ่ม)');
    // สรุปจาก AI ก่อน ถ้าไม่มีค่อยใช้ข้อความจริงแบบตัดสั้น
    const detail = clean(r.summary) || clean(r.message_text).slice(0, 120) || '';
    return { name, groupId: r.group_id, sourceMsgId: r.source_msg_id, messageTime: r.message_time,
             podId: r.pod_id || null, pod: r.pod_name || 'ไม่มี Pod',
             waitMin: r.waitmin, cnt: r.cnt, detail };
  });

  // AI คัดกรองก่อนส่ง — ตัดรายการที่น่าจะมีคนจัดการไปแล้วออก
  let screen = { skip: new Set(), verdicts: [], checked: 0, cached: 0, pending: 0, error: null };
  try { screen = await aiScreenTriage(items, { aiCalls }); }
  catch (e) { console.error('triage screen error:', e.message); }
  if (screen.skip.size) items = items.filter(x => !screen.skip.has(x.sourceMsgId));

  const all = formatTriageAlert(items);
  // สรุปจำนวนค้างแยกตาม Pod — นับเฉพาะที่เข้าเกณฑ์แจ้งเตือน (รอ ≥ 15 นาที)
  // ให้ตัวเลขบนหน้าจอตรงกับจำนวนที่กลุ่มนั้นจะได้รับจริง
  const podMap = new Map();
  for (const x of items) {
    if (x.waitMin < 15) continue;
    const key = x.podId ?? 'none';
    if (!podMap.has(key)) podMap.set(key, { pod_id: x.podId, pod_name: x.pod, count: 0 });
    podMap.get(key).count++;
  }
  return {
    ...all, items,
    pods: [...podMap.values()].sort((a, b) => b.count - a.count),
    screen: {
      on: TRIAGE_SCREEN_ON && (!!GROQ_API_KEY || !!process.env.GEMINI_API_KEY),
      filtered: screen.verdicts.length,
      checked: screen.checked, cached: screen.cached, pending: screen.pending,
      error: screen.error,
      verdicts: screen.verdicts.slice(0, 30),
    },
  };
}

// Render the alert text.
//   podLabel   — ชื่อ Pod (หรือหลาย Pod คั่นด้วย ·) ที่จะขึ้นหัวเรื่อง; null = สรุปรวมทุก Pod
//   perLinePod — บังคับให้ทุกบรรทัดมี [ชื่อ Pod] กำกับ (ใช้เมื่อกลุ่มเดียวรับหลาย Pod)
// LINE รับข้อความละไม่เกิน 5,000 ตัวอักษร — ลิสต์ยาว ๆ ต้องตัดไม่ให้ push ถูกปฏิเสธ
const TRIAGE_ALERT_MAX_PER_BUCKET = 12;

// "รอ 2 ชม. 15 นาที" — บอกเป็นหน่วยที่อ่านแล้วเห็นภาพ ไม่ใช่ 135 นาที
function triageWaitText(min) {
  const m = Math.max(0, Math.round(min || 0));
  if (m < 60) return `รอ ${m} นาที`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `รอ ${h} ชม. ${mm} นาที` : `รอ ${h} ชม.`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `รอ ${d} วัน ${hh} ชม.` : `รอ ${d} วัน`;
}

// เวลาที่ลูกค้าทักเข้ามา + รอมานานแค่ไหน
// DATETIME ในฐานข้อมูลเก็บเวลาไทยแบบเปลือยๆ (ไม่มี timezone) แต่ driver ติดป้าย UTC มาให้
// จึงต้องอ่านกลับด้วย getUTC* ถึงจะได้ตัวเลขเดิมที่บันทึกไว้ — ถ้าใช้ toLocaleTimeString
// แบบ Asia/Bangkok จะบวก 7 ชม. ซ้ำอีกรอบ (หน้าเว็บแก้ปัญหาเดียวกันด้วยการตัด 'Z' ทิ้ง)
function triageTimeText(when, waitMin) {
  const wait = triageWaitText(waitMin);
  if (!when) return wait;
  const d = new Date(when);
  if (isNaN(d)) return wait;
  const p2 = (n) => String(n).padStart(2, '0');
  const hhmm = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  const ymd  = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  // ข้ามวันแล้วต้องมีวันที่กำกับ ไม่งั้น "08:05 น." ของเมื่อวานอ่านแล้วนึกว่าเช้านี้
  const stamp = ymd === bangkokToday()
    ? `${hhmm} น.`
    : `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} ${hhmm} น.`;
  return `${stamp} · ${wait}`;
}

function formatTriageAlert(items, podLabel = null, perLinePod = false, minWait = 0) {
  // ขั้นต่ำที่จะแจ้ง — ตั้งต่อกลุ่มได้ เช่น 30 = ไม่ต้องกวนด้วยของที่เพิ่งรอ 15–30 นาที
  // (ของที่ค้างนานกว่านั้นยังส่งเสมอ ไม่หายไปไหน)
  if (minWait > 0) items = items.filter(x => x.waitMin >= minWait);
  const byPod = (a, b) => String(a.pod).localeCompare(String(b.pod), 'th') || String(a.name).localeCompare(String(b.name), 'th');
  const overday = items.filter(x => x.waitMin > 1440).sort(byPod);                 // ค้างเกิน 1 วัน
  const urgent  = items.filter(x => x.waitMin > 30 && x.waitMin <= 1440).sort(byPod);
  const warn    = items.filter(x => x.waitMin >= 15 && x.waitMin <= 30).sort(byPod);
  // Pod เดียวไม่ต้องซ้ำชื่อ Pod ทุกรายการ — หลาย Pod ต้องกำกับให้รู้ว่าอันไหนของใคร
  const showPod = !podLabel || perLinePod;

  // รูปแบบต่อรายการ:  [ชื่อ Pod] / ชื่อร้าน / สรุปสิ่งที่ลูกค้าถาม
  const block = (x) => {
    const rows = [];
    if (showPod) rows.push(x.pod);
    rows.push(x.name + (x.cnt > 1 ? ` (${x.cnt} ข้อความ)` : ''));
    // เลข TASK = id ข้อความต้นทางจาก LineBotMonitor — ทีมใช้อ้างอิงกลับไปหาข้อความได้
    // ต่อด้วยเวลาที่ลูกค้าทัก + รอมานานแค่ไหน จะได้รู้ว่าเร่งแค่ไหนโดยไม่ต้องเปิดระบบ
    const when = triageTimeText(x.messageTime, x.waitMin);
    if (x.sourceMsgId) rows.push('TASK #' + x.sourceMsgId + (when ? ' · ' + when : ''));
    else if (when) rows.push(when);
    if (x.detail) rows.push(x.detail);
    return rows.join('\n');
  };
  const list = (arr) => {
    const shown = arr.slice(0, TRIAGE_ALERT_MAX_PER_BUCKET);
    let out = shown.map(block).join('\n\n');
    if (arr.length > shown.length) out += `\n\n… และอีก ${arr.length - shown.length} กลุ่ม (ดูทั้งหมดในระบบ)`;
    return out;
  };

  const nowTh = new Date().toLocaleTimeString('th-TH', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Bangkok' });
  let text = podLabel
    ? `🔔 ${podLabel} Ticket ค้าง — ${nowTh} น.\n`
    : `🔔 แจ้งเตือน Ticket ค้าง — ${nowTh} น.\n`;
  if (overday.length) {
    text += `\n🚨 คาดว่ายังไม่ได้รับบริการ — ค้างเกิน 1 วัน (${overday.length} กลุ่ม)\nโปรดตรวจสอบด่วน ‼️\n\n`;
    text += list(overday) + '\n';
  }
  if (urgent.length) {
    text += `\n🔴 ด่วนที่สุด — รอเกิน 30 นาที (${urgent.length} กลุ่ม)\n\n`;
    text += list(urgent) + '\n';
  }
  if (warn.length) {
    text += `\n🟡 เริ่มค้าง — รอ 15–30 นาที (${warn.length} กลุ่ม)\n\n`;
    text += list(warn) + '\n';
  }
  const total = overday.length + urgent.length + warn.length;
  if (!total) text += `\n✅ ไม่มี ticket ค้างที่ต้องรีบ`;

  // กันเหนียว: ถ้ายังยาวเกินลิมิต LINE ให้ตัดท้ายทิ้ง
  if (text.length > 4900) text = text.slice(0, 4870).trimEnd() + '\n…(ตัดข้อความ — ดูทั้งหมดในระบบ)';

  return { text, overdayCount: overday.length, urgentCount: urgent.length, warnCount: warn.length, hasAny: !!total };
}

// "1,2,5" → [1,2,5]  (parseInt กัน injection ไปด้วย)
// Pod id 0 = "ยังไม่ได้ Assign" (กลุ่มลูกค้าที่ยังไม่ผูก Pod) — เลือกในตั้งค่า LINE ได้เหมือน Pod ปกติ
const POD_UNASSIGNED = 0;
function parsePodIds(str) {
  return String(str || '').split(',').map(s => parseInt(s)).filter(n => Number.isInteger(n) && n >= 0);
}
const podLabel = (alert, id) => id === POD_UNASSIGNED ? 'ยังไม่ได้ Assign' : (alert.pods.find(p => p.pod_id === id)?.pod_name || `Pod #${id}`);

// รายการ id คั่นด้วยจุลภาค → array ของตัวเลข (ใช้กับ notify_target_ids ของกลุ่ม LINE)
const parseIdList = (str) => String(str || '').split(',').map(x => parseInt(x, 10)).filter(Boolean);

// ตัดเฉพาะรายการของ Pod ที่ระบุออกมาเป็นข้อความ — คืน null ถ้าไม่มีอะไรเข้าเกณฑ์
// label = ชื่อกลุ่ม LINE ปลายทาง (ถ้ามี) ใช้ขึ้นหัวเรื่องแทนการไล่ชื่อ Pod
function triageAlertForPods(alert, podIds, label = null, minWait = 0) {
  const want = new Set(podIds);
  if (!want.size) return null;
  let mine = (alert.items || []).filter(x => want.has(x.podId || POD_UNASSIGNED));
  if (minWait > 0) mine = mine.filter(x => x.waitMin >= minWait);
  if (!mine.length) return null;
  // ไม่มีชื่อกลุ่มก็ขึ้นหัวเรื่องด้วย Pod ที่มีของค้างจริงเท่านั้น
  const names = [...new Set(mine.map(x => x.pod))].sort((a, b) => String(a).localeCompare(String(b), 'th'));
  const out = formatTriageAlert(mine, label || `[${names.join(' · ')}]`, names.length > 1, minWait);
  // มีรายการแต่ยังรอไม่ถึง 15 นาที → ยังไม่เข้าเกณฑ์ ไม่ต้องส่งข้อความ "ไม่มีค้าง" ไปรบกวนกลุ่ม
  return out.hasAny ? out : null;
}

// ส่งแจ้งเตือน: กลุ่มที่เลือก Pod ไว้จะได้เฉพาะของ Pod ที่เลือก, กลุ่มที่ไม่เลือกได้สรุปรวม
// group_id → [id ของปลายทางแจ้งเตือน] ตามที่ตั้งไว้รายกลุ่ม
async function getGroupNotifyMap() {
  const rows = (await req().query(
    `SELECT group_id, notify_target_ids FROM line_group_pods
     WHERE notify_target_ids IS NOT NULL AND LTRIM(RTRIM(notify_target_ids)) <> ''`)).recordset;
  const map = new Map();
  for (const r of rows) {
    const ids = parseIdList(r.notify_target_ids);
    if (ids.length) map.set(r.group_id, ids);
  }
  return map;
}

// ตัวเลือก "ส่งเฉพาะที่รอนานเกิน" ถูกเอาออกจากหน้าตั้งค่าแล้ว — ทุกกลุ่มได้ทุกระดับ (ค่าเก่าใน line_notify_targets.min_wait_min ไม่มีผล)
const targetMinWait = () => 0;
async function sendTriageAlert(alert) {
  // ปลายทางที่ติ๊ก 'triage_alert_groups' จะได้เฉพาะกลุ่ม LINE ที่เลือกให้มันไว้
  let byGroup = 0;
  try {
    const gmap = await getGroupNotifyMap();
    if (gmap.size) {
      byGroup = await sendLineNotify((target) => {
        const minW  = targetMinWait(target);
        const items = (alert.items || []).filter(x => (gmap.get(x.groupId) || []).includes(target.id));
        if (!items.length) return null;              // กลุ่มที่เลือกไว้ไม่มีของค้าง → ไม่ต้องรบกวน
        const sub = formatTriageAlert(items, target.name, true, minW);
        return sub.hasAny ? sub.text : null;
      }, 'triage_alert_groups');
    }
  } catch (e) { console.error('triage alert (per LINE group) failed:', e.message); }

  const byPod = await sendLineNotify((target) => {
    const ids  = parsePodIds(target.pod_ids);
    const minW = targetMinWait(target);
    if (ids.length) {
      const sub = triageAlertForPods(alert, ids, target.name, minW);
      return sub ? sub.text : null;          // Pod ที่เลือกไม่มีของค้าง → ไม่ต้องรบกวนกลุ่ม
    }
    if (minW > 0) {                          // กลุ่มสรุปรวมที่ตั้งขั้นต่ำไว้
      const sub = formatTriageAlert(alert.items || [], null, false, minW);
      return sub.hasAny ? sub.text : null;
    }
    return alert.hasAny ? alert.text : null;
  }, 'triage_alert');
  return byPod + byGroup;
}

// Preview the alert text (does NOT send to LINE).
//   ?pods=1,2   → ข้อความที่กลุ่มซึ่งเลือก Pod เหล่านั้นจะได้รับ
//   ?target=N   → ข้อความที่กลุ่มแจ้งเตือน id นั้นจะได้รับจริง (ตามที่ตั้งค่าไว้)
app.get('/api/triage/alert-preview', authRequired, async (request, res) => {
  try {
    // preview ใช้ผลคัดกรองที่ cache ไว้ให้ตอบเร็ว — ?rescreen=1 คือสั่งให้ AI ตรวจรอบใหม่
    const a = await buildTriageAlert({ aiCalls: request.query.rescreen === '1' });
    // กลุ่มที่รับ event นี้ + Pod ที่เลือก + จำนวนที่จะได้รับจริง — ให้หน้าจอตรวจการตั้งค่าได้
    let targets = [];
    try {
      const rows = (await req().query(
        // ดึงทั้งที่เปิดและปิด — จะได้ดูตัวอย่างของกลุ่มที่ยังปิดอยู่ได้ (จะขึ้นว่ายังไม่ส่ง)
        `SELECT id, name, pod_ids, min_wait_min, active, events FROM line_notify_targets
         WHERE events IS NULL OR events='' OR events LIKE '%triage_alert%'
         ORDER BY name`)).recordset;
      targets = rows.map(t => {
        const ids  = parsePodIds(t.pod_ids);
        const minW = targetMinWait(t);
        const sub = ids.length ? triageAlertForPods(a, ids, t.name, minW)
                  : minW > 0   ? (() => { const s = formatTriageAlert(a.items || [], null, false, minW); return s.hasAny ? s : null; })()
                  : (a.hasAny ? a : null);
        return {
          id: t.id, name: t.name, pod_ids: ids, min_wait_min: minW, active: !!t.active,
          pod_names: ids.map(id => podLabel(a, id)),
          count: sub ? (sub.overdayCount + sub.urgentCount + sub.warnCount) : 0,
          will_send: !!sub && !!t.active,     // ปิดอยู่ = ไม่ส่ง แม้จะมีของค้าง
        };
      });
    } catch { /* ตารางยังไม่พร้อม — ข้ามส่วนนี้ */ }

    const targetId = parseInt(request.query.target);
    let podIds  = parsePodIds(request.query.pods || request.query.pod_id);
    let minWait = Math.max(0, parseInt(request.query.min_wait) || 0);
    let label   = null;
    if (targetId) {
      const t = targets.find(x => x.id === targetId);
      if (t) { podIds = t.pod_ids; minWait = t.min_wait_min; label = t.name; }
    }

    if (podIds.length) {
      const sub = triageAlertForPods(a, podIds, label, minWait);
      const names = podIds.map(id => a.pods.find(p => p.pod_id === id)?.pod_name || `Pod #${id}`);
      return res.json(sub
        ? { ...sub, pod_ids: podIds, pods: a.pods, targets, screen: a.screen }
        : { text: `✅ [${names.join(' · ')}] ไม่มี ticket ค้างที่ต้องรีบ — จะไม่ส่งเข้ากลุ่ม`,
            overdayCount: 0, urgentCount: 0, warnCount: 0, hasAny: false,
            pod_ids: podIds, pods: a.pods, targets, screen: a.screen });
    }
    const { items, ...rest } = a;            // items เป็นข้อมูลดิบ ไม่ต้องส่งออกไป
    res.json({ ...rest, targets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manually send the alert now to LINE targets subscribed to 'triage_alert'
app.post('/api/triage/alert-send', authRequired, async (request, res) => {
  try {
    const a = await buildTriageAlert();
    if (!a.hasAny) return res.json({ ok: true, sent: false, reason: 'ไม่มี ticket ค้างที่ต้องรีบ' });
    const groups = await sendTriageAlert(a);
    res.json({ ok: true, sent: groups > 0, groups,
               overdayCount: a.overdayCount, urgentCount: a.urgentCount, warnCount: a.warnCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// (Auto alert is now fired from triageAutoTick above, on the same cadence as
//  classification — TRIAGE_AUTO_MINUTES — so the two stay in sync.)

// Today's shift per employee (for member/lead dropdowns)
app.get('/api/today-shifts', authRequired, async (request, res) => {
  try {
    const rows = (await req().query(`
      SELECT s.employee_id, s.shift_type,
             CASE WHEN st.start_time IS NOT NULL AND st.end_time IS NOT NULL
                  THEN CONVERT(varchar(5), st.start_time, 108) + N'–' + CONVERT(varchar(5), st.end_time, 108)
                  ELSE NULL END AS shift_time
      FROM shifts s
      LEFT JOIN shift_types st ON st.shift_key = s.shift_type
      WHERE s.shift_date = CAST(GETDATE() AS DATE)`)).recordset;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pods/board', authRequired, async (request, res) => {
  try {
    const pods = (await req().query(`
      SELECT p.id, p.code, p.display_name, p.region, p.lead_employee_id,
             p.color, p.sort_order
      FROM pods p WHERE p.active=1 ORDER BY p.sort_order, p.code`)).recordset;
    const members = (await req().query(`
      SELECT pm.pod_id, pm.employee_id, pm.role_in_pod, e.name, e.nickname
      FROM pod_members pm JOIN employees e ON e.id=pm.employee_id
      WHERE pm.active=1 AND e.active=1`)).recordset;
    // lead employees (in case lead is not a pod_member row)
    const leads = (await req().query(`
      SELECT p.id AS pod_id, e.id AS employee_id, e.name, e.nickname
      FROM pods p JOIN employees e ON e.id=p.lead_employee_id WHERE p.active=1`)).recordset;
    // today's shifts → work status + shift time per employee
    const shifts = (await req().query(`
      SELECT s.employee_id, s.shift_type, st.name AS shift_name,
             CASE WHEN st.start_time IS NOT NULL AND st.end_time IS NOT NULL
                  THEN CONVERT(varchar(5), st.start_time, 108) + N'–' + CONVERT(varchar(5), st.end_time, 108)
                  ELSE NULL END AS shift_time
      FROM shifts s
      LEFT JOIN shift_types st ON st.shift_key = s.shift_type
      WHERE s.shift_date = CAST(GETDATE() AS DATE)`)).recordset;
    const shiftMap = {};
    shifts.forEach(s => { shiftMap[s.employee_id] = s; });
    const statusOf = (eid) => {
      const s = shiftMap[eid];
      if (!s) return 'none';                                  // not scheduled today
      if (s.shift_type === 'dayoff' || String(s.shift_type).startsWith('leave_')) return 'off';
      return 'work';                                          // any work shift
    };
    const shiftInfo = (eid) => {
      const s = shiftMap[eid];
      return s ? { shift_type: s.shift_type, shift_name: s.shift_name, shift_time: s.shift_time } : {};
    };
    const byPod = {};
    pods.forEach(p => { byPod[p.id] = { ...p, lead_status: null, members: [] }; });
    leads.forEach(l => {
      const pod = byPod[l.pod_id]; if (!pod) return;
      pod.lead_status = statusOf(l.employee_id);
      pod.lead_name = l.name; pod.lead_nickname = l.nickname;
    });
    const seen = {}; // pod_id|emp dedupe (lead may also be a member row)
    members.forEach(m => {
      const pod = byPod[m.pod_id]; if (!pod) return;
      const key = m.pod_id + '|' + m.employee_id;
      if (seen[key]) return; seen[key] = 1;
      const isLead = m.employee_id === pod.lead_employee_id || m.role_in_pod === 'lead';
      pod.members.push({
        employee_id: m.employee_id, name: m.name, nickname: m.nickname,
        role_in_pod: isLead ? 'lead' : m.role_in_pod, status: statusOf(m.employee_id),
        ...shiftInfo(m.employee_id),
      });
    });
    // ensure lead shows in members list even if no pod_members row
    leads.forEach(l => {
      const pod = byPod[l.pod_id]; if (!pod) return;
      const key = l.pod_id + '|' + l.employee_id;
      if (seen[key]) return; seen[key] = 1;
      pod.members.unshift({
        employee_id: l.employee_id, name: l.name, nickname: l.nickname,
        role_in_pod: 'lead', status: statusOf(l.employee_id),
        ...shiftInfo(l.employee_id),
      });
    });
    // sort: lead first, then junior, then member
    const rank = { lead:0, junior:1, member:2 };
    Object.values(byPod).forEach(p => p.members.sort((a,b)=>(rank[a.role_in_pod]??3)-(rank[b.role_in_pod]??3)));

    // employees in scheduled teams who are NOT in any pod but ARE working today
    const assigned = new Set();
    leads.forEach(l => assigned.add(l.employee_id));
    members.forEach(m => assigned.add(m.employee_id));
    const teamEmps = (await req().query(`
      SELECT e.id, e.name, e.nickname, e.team
      FROM employees e
      WHERE e.active=1 AND e.team IN (SELECT name FROM teams WHERE show_in_schedule=1 AND active=1)`)).recordset;
    const unassignedWorking = teamEmps
      .filter(e => !assigned.has(e.id) && statusOf(e.id) === 'work')
      .map(e => ({ employee_id: e.id, name: e.name, nickname: e.nickname, team: e.team, ...shiftInfo(e.id) }));

    // designated shift SR per pod/period
    const srRows = (await req().query('SELECT pod_id, period, employee_id FROM pod_shift_sr')).recordset;
    Object.values(byPod).forEach(p => { p.sr = {}; });
    srRows.forEach(r => { if (byPod[r.pod_id]) byPod[r.pod_id].sr[r.period] = r.employee_id; });

    res.json({ pods: pods.map(p => byPod[p.id]), unassignedWorking });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set designated shift SR (หัวหน้ากะ) per period for a pod
app.put('/api/pods/:id/shift-sr', authRequired, managerRequired, async (request, res) => {
  const { srs } = request.body || {}; // { morning: id|null, afternoon: id|null, night: id|null }
  if (!srs || typeof srs !== 'object') return res.status(400).json({ error: 'srs required' });
  try {
    const pid = request.params.id;
    for (const period of ['morning', 'afternoon', 'night']) {
      const eid = srs[period] || null;
      await req().input('pid', sql.Int, pid).input('per', sql.NVarChar, period)
        .query('DELETE FROM pod_shift_sr WHERE pod_id=@pid AND period=@per');
      if (eid) {
        await req().input('pid', sql.Int, pid).input('per', sql.NVarChar, period).input('eid', sql.Int, eid)
          .query('INSERT INTO pod_shift_sr (pod_id, period, employee_id) VALUES (@pid, @per, @eid)');
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customers ─────────────────────────────────────────────
app.get('/api/customers', authRequired, async (request, res) => {
  try {
    const { pod_id } = request.query;
    const r = req();
    let where = 'c.active=1';
    if (pod_id === 'none')      where += ' AND c.pod_id IS NULL';
    else if (pod_id)          { where += ' AND c.pod_id=@pid'; r.input('pid', sql.Int, pod_id); }
    const result = await r.query(`
      SELECT c.id, c.name, c.branches, c.pod_id, c.priority, c.note, c.created_at,
             p.code AS pod_code, p.display_name AS pod_name, p.color AS pod_color
      FROM customers c
      LEFT JOIN pods p ON p.id = c.pod_id
      WHERE ${where}
      ORDER BY c.name`);
    res.json(result.recordset);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/customers', authRequired, managerRequired, async (request, res) => {
  const { name, branches, pod_id, priority, note } = request.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = await req()
      .input('name',     sql.NVarChar, name)
      .input('branches', sql.Int,      branches || 0)
      .input('pod_id',   sql.Int,      pod_id || null)
      .input('priority', sql.NVarChar, priority || 'green')
      .input('note',     sql.NVarChar, note || null)
      .query(`INSERT INTO customers (name, branches, pod_id, priority, note)
              OUTPUT INSERTED.id VALUES (@name, @branches, @pod_id, @priority, @note)`);
    const id = result.recordset[0].id;
    if (pod_id) {
      await req()
        .input('cid', sql.Int, id)
        .input('pid', sql.Int, pod_id)
        .input('by',  sql.Int, request.user?.employee_id || null)
        .query(`INSERT INTO customer_assignments (customer_id, pod_id, assigned_by)
                VALUES (@cid, @pid, @by)`);
    }
    res.json({ id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/customers/:id', authRequired, managerRequired, async (request, res) => {
  const { name, branches, priority, note } = request.body;
  try {
    await req()
      .input('name',     sql.NVarChar, name)
      .input('branches', sql.Int,      branches || 0)
      .input('priority', sql.NVarChar, priority || 'green')
      .input('note',     sql.NVarChar, note || null)
      .input('id',       sql.Int,      request.params.id)
      .query(`UPDATE customers SET name=@name, branches=@branches,
              priority=@priority, note=@note WHERE id=@id`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assign / move a customer to a pod (logs history)
app.put('/api/customers/:id/assign', authRequired, managerRequired, async (request, res) => {
  const { pod_id } = request.body;
  try {
    const cid = request.params.id;
    await req()
      .input('pod_id', sql.Int, pod_id || null)
      .input('id',     sql.Int, cid)
      .query('UPDATE customers SET pod_id=@pod_id WHERE id=@id');
    // close previous open assignment, then open a new one
    await req().input('cid', sql.Int, cid)
      .query(`UPDATE customer_assignments SET unassigned_at=GETDATE()
              WHERE customer_id=@cid AND unassigned_at IS NULL`);
    if (pod_id) {
      await req()
        .input('cid', sql.Int, cid)
        .input('pid', sql.Int, pod_id)
        .input('by',  sql.Int, request.user?.employee_id || null)
        .query(`INSERT INTO customer_assignments (customer_id, pod_id, assigned_by)
                VALUES (@cid, @pid, @by)`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/customers/:id', authRequired, managerRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, request.params.id)
      .query('UPDATE customers SET active=0 WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Complaint history for one customer (by customer_id, or matched company_name)
app.get('/api/customers/:id/complaints', authRequired, async (request, res) => {
  try {
    const cust = (await req().input('id', sql.Int, request.params.id)
      .query('SELECT id, name FROM customers WHERE id=@id')).recordset[0];
    if (!cust) return res.status(404).json({ error: 'customer not found' });
    const result = await req()
      .input('cid', sql.Int,      cust.id)
      .input('nm',  sql.NVarChar, cust.name)
      .query(`SELECT id, ticket_id, company_name, contact_name, contact_phone, email,
                     message, status, created_at, resolved_at
              FROM ticket_complaints
              WHERE customer_id=@cid OR company_name=@nm
              ORDER BY created_at DESC`);
    res.json(result.recordset);
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
                        dailyTrend:[], hourlyStats:[], dowStats:[], catDailyTrend:[],
                        channelStats:[], nameMap:{} });
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
    const r12 = mkR(msDate, meDate);  const sc12 = appendScopeClause(r12, scope);

    const [d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12] = await Promise.all([
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
      // ช่องทางที่ลูกค้าติดต่อเข้ามา (Calllog.InformType)
      // ข้อมูลเก่ามีค่าว่างและ '[EditValue is null]' ปนอยู่ — รวมเป็น 'ไม่ระบุ' ทั้งคู่
      r12.query(`SELECT
          CASE WHEN LTRIM(RTRIM(ISNULL(cl.InformType,''))) IN ('', '[EditValue is null]')
               THEN N'ไม่ระบุ' ELSE LTRIM(RTRIM(cl.InformType)) END AS channel,
          COUNT(*) AS cnt
        FROM Calllog cl INNER JOIN Users u ON u.UserId = cl.SupportId
        WHERE cl.Active=1 AND cl.ReceiveDate >= @ms AND cl.ReceiveDate < @me${sc12}
        GROUP BY CASE WHEN LTRIM(RTRIM(ISNULL(cl.InformType,''))) IN ('', '[EditValue is null]')
                      THEN N'ไม่ระบุ' ELSE LTRIM(RTRIM(cl.InformType)) END
        ORDER BY cnt DESC`),
    ]);

    // Build ext_username → display name + id → { name, ext_username } maps
    const nameMapRows = (await req().query(`
      SELECT e.id, au.ext_username, ISNULL(e.nickname, e.name) AS display_name
      FROM app_users au JOIN employees e ON e.id = au.employee_id
      WHERE au.ext_username IS NOT NULL AND au.active = 1 AND e.active = 1
    `)).recordset;
    const nameMap = {}, nameMapById = {};
    nameMapRows.forEach(r => {
      nameMap[r.ext_username] = r.display_name;
      nameMapById[r.id] = { name: r.display_name, ext_username: r.ext_username };
    });

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
      channelStats:    d12.recordset,
      closedLast:      d11.recordset[0]?.cnt || 0,
      nameMap, nameMapById,
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
      .query(`SELECT TOP 50 RegistrationId AS id, CompanyName AS name
              FROM CustomerRegistration
              WHERE CompanyName LIKE @q AND (Hide=0 OR Hide IS NULL) AND AccurateData=1
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
             i.note, i.issue_url, i.created_at, i.updated_at,
             i.release_date, i.release_version, i.uat_date, i.pilot_date, i.golive_date,
             i.fix_date, ISNULL(er.nickname, er.name) AS resolved_by_name,
             ISNULL(ea.nickname, ea.name) AS assigned_to_name,
             b.id AS board_id, b.name AS board_name,
             f.id AS folder_id, f.name AS folder_name,
             (SELECT COUNT(*) FROM fu_comments c WHERE c.issue_id = i.id) AS comment_count,
             (SELECT COUNT(*) FROM fu_attachments a WHERE a.issue_id = i.id) AS attachment_count
      FROM fu_issues i
      JOIN fu_boards b ON b.id = i.board_id
      JOIN fu_folders f ON f.id = b.folder_id
      LEFT JOIN employees ea ON ea.id = i.assigned_to
      LEFT JOIN app_users ur ON ur.id = i.resolved_by
      LEFT JOIN employees er ON er.id = ur.employee_id
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
    const { board_id, detail, category, priority, note } = request.body;
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
      .input('nt', sql.NVarChar,note||null)
      .query(`INSERT INTO fu_issues(board_id,detail,category,priority,note)
              OUTPUT INSERTED.id VALUES(@bid,@det,@cat,@pri,@nt)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/public/track/:token/fu-issue/:id ────────────
// Customer edits their own issue (detail, category, priority, note)
app.put('/api/public/track/:token/fu-issue/:id', async (request, res) => {
  try {
    const tok = request.params.token;
    const id  = parseInt(request.params.id);
    const { detail, category, priority, note } = request.body;
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
      .input('nt',  sql.NVarChar, note||null)
      .query(`UPDATE fu_issues SET detail=@det,category=@cat,priority=@pri,note=@nt,updated_at=GETDATE() WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Helper: verify a customer_links token + that an fu_issue belongs to its group ──
// Returns { status, error } on failure, or { groupId } on success.
async function trackIssueGuard(tok, issueId) {
  if (!issueId) return { status: 400, error: 'invalid issue id' };
  const link = (await req().input('tok', sql.NVarChar, tok)
    .query('SELECT group_id FROM customer_links WHERE token=@tok')).recordset[0];
  if (!link) return { status: 404, error: 'Link ไม่พบ' };
  if (!link.group_id) return { status: 403, error: 'ไม่มีสิทธิ์' };
  const issue = (await req().input('id', sql.Int, issueId).input('gid', sql.Int, link.group_id)
    .query(`SELECT i.id FROM fu_issues i
            JOIN fu_boards b ON b.id=i.board_id
            JOIN fu_folders f ON f.id=b.folder_id
            WHERE i.id=@id AND f.group_id=@gid`)).recordset[0];
  if (!issue) return { status: 403, error: 'Issue ไม่พบหรือไม่มีสิทธิ์' };
  return { groupId: link.group_id };
}

// ── GET /api/public/track/:token/fu-issue/:id/attachments ──
app.get('/api/public/track/:token/fu-issue/:id/attachments', async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const g  = await trackIssueGuard(request.params.token, id);
    if (g.error) return res.status(g.status).json({ error: g.error });

    const rows = (await req().input('id', sql.Int, id)
      .query(`SELECT a.id, a.filename, a.original_name, a.file_size, a.mime_type, a.created_at,
                     ISNULL(e.nickname, e.name) AS uploaded_by_name
              FROM fu_attachments a
              LEFT JOIN app_users au ON au.id = a.created_by
              LEFT JOIN employees e  ON e.id  = au.employee_id
              WHERE a.issue_id=@id ORDER BY a.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/public/track/:token/fu-issue/:id/attachments ──
// Customer attaches files (no auth, 2MB/file cap, 5 files)
app.post('/api/public/track/:token/fu-issue/:id/attachments', (request, res, next) => {
  fuPublicUpload.array('files', 5)(request, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 2MB' : err.message });
    next();
  });
}, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const g  = await trackIssueGuard(request.params.token, id);
    if (g.error) return res.status(g.status).json({ error: g.error });

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
        .query(`INSERT INTO fu_attachments(issue_id,filename,original_name,file_size,mime_type,created_by) OUTPUT INSERTED.id VALUES(@iid,@fn,@on,@fs,@mt,NULL)`);
      inserted.push({ id: r.recordset[0].id, filename: f.filename, original_name: f.originalname, file_size: f.size, mime_type: f.mimetype });
    }
    res.json({ ok: true, files: inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/public/track/:token/fu-issue/:id/comments ──
app.get('/api/public/track/:token/fu-issue/:id/comments', async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const g  = await trackIssueGuard(request.params.token, id);
    if (g.error) return res.status(g.status).json({ error: g.error });

    const comments = (await req().input('id', sql.Int, id).query(`
      SELECT c.id, c.body, c.created_at,
             COALESCE(e.nickname, e.name, c.author_name, N'ลูกค้า') AS user_name,
             LEFT(UPPER(COALESCE(e.nickname, e.name, c.author_name, N'ลูกค้า')), 1) AS avatar_char,
             CASE WHEN c.user_id IS NULL THEN 1 ELSE 0 END AS is_customer
      FROM fu_comments c
      LEFT JOIN app_users au ON au.id = c.user_id
      LEFT JOIN employees e  ON e.id  = au.employee_id
      WHERE c.issue_id = @id
      ORDER BY c.created_at ASC`)).recordset;
    res.json(comments);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/public/track/:token/fu-issue/:id/comments ──
// Customer adds a comment (no auth, user_id NULL + free-text author_name)
app.post('/api/public/track/:token/fu-issue/:id/comments', async (request, res) => {
  try {
    const id   = parseInt(request.params.id);
    const body = request.body.body?.trim();
    const authorName = request.body.author_name?.trim() || null;
    if (!body) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });

    const g = await trackIssueGuard(request.params.token, id);
    if (g.error) return res.status(g.status).json({ error: g.error });

    const r = await req()
      .input('iid', sql.Int, id)
      .input('an',  sql.NVarChar, authorName)
      .input('b',   sql.NVarChar, body)
      .query(`INSERT INTO fu_comments(issue_id,user_id,author_name,body) OUTPUT INSERTED.id VALUES(@iid,NULL,@an,@b)`);
    res.json({ id: r.recordset[0].id });
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
    // Release plan — filled in by hand once a fix has a schedule
    for (const col of ['release_date','uat_date','pilot_date','golive_date']) {
      try { await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('fu_issues') AND name='${col}') ALTER TABLE fu_issues ADD ${col} DATE NULL`); } catch(e2) {}
    }
    try { await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('fu_issues') AND name='release_version') ALTER TABLE fu_issues ADD release_version NVARCHAR(50) NULL`); } catch(e2) {}
    // Who closed an issue — the date lives in the existing fix_date column
    try { await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('fu_issues') AND name='resolved_by') ALTER TABLE fu_issues ADD resolved_by INT NULL`); } catch(e2) {}
    // Customer-submitted comments have no app_users row — allow NULL user_id + a free-text display name
    try { await req().query(`ALTER TABLE fu_comments ALTER COLUMN user_id INT NULL`); } catch(e2) {}
    try { await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('fu_comments') AND name='author_name') ALTER TABLE fu_comments ADD author_name NVARCHAR(200) NULL`); } catch(e2) {}

    // Share tokens for public board view
    await req().query(`IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='fu_board_tokens' AND xtype='U')
      CREATE TABLE fu_board_tokens (
        id INT PRIMARY KEY IDENTITY,
        board_id INT NOT NULL UNIQUE,
        token NVARCHAR(64) NOT NULL UNIQUE,
        created_by INT,
        created_at DATETIME DEFAULT GETDATE()
      )`);

    console.log('✅ Follow Up v2 tables ready');
  } catch(e) { console.error('❌ Follow Up v2 tables error:', e.message); }
}

// ══ FOLLOW UP v2 — BOARD SHARE TOKEN ══════════════════════
// POST /api/fu/boards/:id/share-token  → get or create public share token
app.post('/api/fu/boards/:id/share-token', authRequired, async (request, res) => {
  try {
    const boardId = parseInt(request.params.id);
    if (!boardId) return res.status(400).json({ error: 'invalid board id' });
    // Check board exists
    const board = (await req().input('bid', sql.Int, boardId)
      .query(`SELECT id, name FROM fu_boards WHERE id=@bid`)).recordset[0];
    if (!board) return res.status(404).json({ error: 'board not found' });
    // Get or create token
    let row = (await req().input('bid', sql.Int, boardId)
      .query(`SELECT token FROM fu_board_tokens WHERE board_id=@bid`)).recordset[0];
    if (!row) {
      const token = crypto.randomBytes(24).toString('hex');
      await req().input('bid', sql.Int, boardId)
        .input('tok', sql.NVarChar, token)
        .input('uid', sql.Int, request.user.id)
        .query(`INSERT INTO fu_board_tokens (board_id, token, created_by) VALUES (@bid,@tok,@uid)`);
      row = { token };
    }
    res.json({ token: row.token, board_name: board.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/fu/boards/:id/share-token  → revoke token
app.delete('/api/fu/boards/:id/share-token', authRequired, async (request, res) => {
  try {
    const boardId = parseInt(request.params.id);
    await req().input('bid', sql.Int, boardId)
      .query(`DELETE FROM fu_board_tokens WHERE board_id=@bid`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/board/:token/data  → public board issues (no auth)
app.get('/api/public/board/:token/data', async (request, res) => {
  try {
    const row = (await req().input('tok', sql.NVarChar, request.params.token)
      .query(`SELECT t.board_id, b.name AS board_name, f.name AS folder_name
              FROM fu_board_tokens t
              JOIN fu_boards b ON b.id=t.board_id
              JOIN fu_folders f ON f.id=b.folder_id
              WHERE t.token=@tok`)).recordset[0];
    if (!row) return res.status(404).json({ error: 'invalid or expired link' });
    const issues = (await req().input('bid', sql.Int, row.board_id)
      .query(`SELECT i.id, i.detail AS title, i.branch, i.status, i.priority, i.category,
                     i.note, i.issue_url, i.created_at, i.updated_at,
                     i.release_date, i.uat_date, i.pilot_date, i.golive_date, i.release_version,
                     i.fix_date, ISNULL(er.nickname, er.name) AS resolved_by_name,
                     ISNULL(e.nickname, e.name) AS assigned_to_name,
                     (SELECT COUNT(*) FROM fu_comments c WHERE c.issue_id = i.id) AS comment_count,
                     (SELECT COUNT(*) FROM fu_attachments a WHERE a.issue_id = i.id) AS attachment_count,
                     (SELECT TOP 1 a.filename      FROM fu_attachments a WHERE a.issue_id = i.id ORDER BY CASE WHEN a.mime_type LIKE 'image/%' THEN 0 ELSE 1 END, a.created_at, a.id) AS thumb_filename,
                     (SELECT TOP 1 a.mime_type     FROM fu_attachments a WHERE a.issue_id = i.id ORDER BY CASE WHEN a.mime_type LIKE 'image/%' THEN 0 ELSE 1 END, a.created_at, a.id) AS thumb_mime,
                     (SELECT TOP 1 a.original_name FROM fu_attachments a WHERE a.issue_id = i.id ORDER BY CASE WHEN a.mime_type LIKE 'image/%' THEN 0 ELSE 1 END, a.created_at, a.id) AS thumb_name
              FROM fu_issues i
              LEFT JOIN employees e ON e.id = i.assigned_to
              LEFT JOIN app_users ur ON ur.id = i.resolved_by
              LEFT JOIN employees er ON er.id = ur.employee_id
              WHERE i.board_id=@bid
              ORDER BY i.created_at DESC`)).recordset;
    res.set('Cache-Control', 'no-store');
    res.json({ board_name: row.board_name, folder_name: row.folder_name, issues });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/public/board/:token/issues  → customer adds a new issue to this board (no auth)
app.post('/api/public/board/:token/issues', async (request, res) => {
  try {
    const tok = request.params.token;
    const { detail, category, priority, note } = request.body;
    if (!detail?.trim()) return res.status(400).json({ error: 'กรุณาระบุหัวข้อปัญหา' });

    const tokenRow = (await req().input('tok', sql.NVarChar, tok)
      .query(`SELECT board_id FROM fu_board_tokens WHERE token=@tok`)).recordset[0];
    if (!tokenRow) return res.status(404).json({ error: 'invalid token' });

    const r = await req()
      .input('bid', sql.Int, tokenRow.board_id)
      .input('det', sql.NVarChar, detail.trim())
      .input('cat', sql.NVarChar, category || null)
      .input('pri', sql.NVarChar, priority || 'normal')
      .input('nt',  sql.NVarChar, note || null)
      .query(`INSERT INTO fu_issues(board_id,detail,category,priority,note)
              OUTPUT INSERTED.id VALUES(@bid,@det,@cat,@pri,@nt)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/public/board/:token/issues/:id  → customer edits an issue on this board (no auth)
app.put('/api/public/board/:token/issues/:id', async (request, res) => {
  try {
    const tok = request.params.token;
    const id  = parseInt(request.params.id);
    const { detail, category, priority, note } = request.body;
    if (!detail?.trim()) return res.status(400).json({ error: 'กรุณาระบุหัวข้อปัญหา' });

    const tokenRow = (await req().input('tok', sql.NVarChar, tok)
      .query(`SELECT board_id FROM fu_board_tokens WHERE token=@tok`)).recordset[0];
    if (!tokenRow) return res.status(404).json({ error: 'invalid token' });

    // Verify issue belongs to this board (no cross-board writes via a stolen id)
    const issue = (await req().input('id', sql.Int, id).input('bid', sql.Int, tokenRow.board_id)
      .query(`SELECT id FROM fu_issues WHERE id=@id AND board_id=@bid`)).recordset[0];
    if (!issue) return res.status(403).json({ error: 'Issue ไม่พบหรือไม่มีสิทธิ์' });

    await req()
      .input('id',  sql.Int,     id)
      .input('det', sql.NVarChar, detail.trim())
      .input('cat', sql.NVarChar, category || null)
      .input('pri', sql.NVarChar, priority || 'normal')
      .input('nt',  sql.NVarChar, note || null)
      .query(`UPDATE fu_issues SET detail=@det,category=@cat,priority=@pri,note=@nt,updated_at=GETDATE() WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/board/:token/issues/:id/attachments  → public attachment list (no auth)
app.get('/api/public/board/:token/issues/:id/attachments', async (request, res) => {
  try {
    const tok = request.params.token;
    const id  = parseInt(request.params.id);
    const tokenRow = (await req().input('tok', sql.NVarChar, tok)
      .query(`SELECT board_id FROM fu_board_tokens WHERE token=@tok`)).recordset[0];
    if (!tokenRow) return res.status(404).json({ error: 'invalid token' });

    const issue = (await req().input('id', sql.Int, id).input('bid', sql.Int, tokenRow.board_id)
      .query(`SELECT id FROM fu_issues WHERE id=@id AND board_id=@bid`)).recordset[0];
    if (!issue) return res.status(403).json({ error: 'Issue ไม่พบหรือไม่มีสิทธิ์' });

    const rows = (await req().input('id', sql.Int, id)
      .query(`SELECT a.id, a.filename, a.original_name, a.file_size, a.mime_type, a.created_at,
                     ISNULL(e.nickname, e.name) AS uploaded_by_name
              FROM fu_attachments a
              LEFT JOIN app_users au ON au.id = a.created_by
              LEFT JOIN employees e  ON e.id  = au.employee_id
              WHERE a.issue_id=@id ORDER BY a.created_at`)).recordset;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/public/board/:token/issues/:id/attachments  → customer attaches files (no auth, 2MB/file cap)
app.post('/api/public/board/:token/issues/:id/attachments', (request, res, next) => {
  fuPublicUpload.array('files', 5)(request, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 2MB' : err.message });
    next();
  });
}, async (request, res) => {
  try {
    const tok = request.params.token;
    const id  = parseInt(request.params.id);
    const tokenRow = (await req().input('tok', sql.NVarChar, tok)
      .query(`SELECT board_id FROM fu_board_tokens WHERE token=@tok`)).recordset[0];
    if (!tokenRow) return res.status(404).json({ error: 'invalid token' });

    const issue = (await req().input('id', sql.Int, id).input('bid', sql.Int, tokenRow.board_id)
      .query(`SELECT id FROM fu_issues WHERE id=@id AND board_id=@bid`)).recordset[0];
    if (!issue) return res.status(403).json({ error: 'Issue ไม่พบหรือไม่มีสิทธิ์' });

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
        .query(`INSERT INTO fu_attachments(issue_id,filename,original_name,file_size,mime_type,created_by) OUTPUT INSERTED.id VALUES(@iid,@fn,@on,@fs,@mt,NULL)`);
      inserted.push({ id: r.recordset[0].id, filename: f.filename, original_name: f.originalname, file_size: f.size, mime_type: f.mimetype });
    }
    res.json({ ok: true, files: inserted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/board/:token/issues/:id/comments  → public comments (no auth)
app.get('/api/public/board/:token/issues/:id/comments', async (request, res) => {
  try {
    const tok = request.params.token;
    const iid = parseInt(request.params.id);
    // Verify token exists and issue belongs to that board
    const tokenRow = (await req().input('tok', sql.NVarChar, tok)
      .query(`SELECT board_id FROM fu_board_tokens WHERE token=@tok`)).recordset[0];
    if (!tokenRow) return res.status(404).json({ error: 'invalid token' });
    const issueRow = (await req().input('iid', sql.Int, iid).input('bid', sql.Int, tokenRow.board_id)
      .query(`SELECT id FROM fu_issues WHERE id=@iid AND board_id=@bid`)).recordset[0];
    if (!issueRow) return res.status(404).json({ error: 'issue not found' });
    const comments = (await req().input('id', sql.Int, iid).query(`
      SELECT c.id, c.body, c.created_at,
             COALESCE(e.nickname, e.name, c.author_name, N'ลูกค้า') AS user_name,
             LEFT(UPPER(COALESCE(e.nickname, e.name, c.author_name, N'ลูกค้า')), 1) AS avatar_char,
             CASE WHEN c.user_id IS NULL THEN 1 ELSE 0 END AS is_customer
      FROM fu_comments c
      LEFT JOIN app_users au ON au.id = c.user_id
      LEFT JOIN employees e  ON e.id  = au.employee_id
      WHERE c.issue_id = @id
      ORDER BY c.created_at ASC`)).recordset;
    res.json(comments);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/public/board/:token/issues/:id/comments  → customer adds a comment (no auth)
app.post('/api/public/board/:token/issues/:id/comments', async (request, res) => {
  try {
    const tok  = request.params.token;
    const iid  = parseInt(request.params.id);
    const body = request.body.body?.trim();
    const authorName = request.body.author_name?.trim() || null;
    if (!body) return res.status(400).json({ error: 'กรุณาระบุข้อความ' });

    const tokenRow = (await req().input('tok', sql.NVarChar, tok)
      .query(`SELECT board_id FROM fu_board_tokens WHERE token=@tok`)).recordset[0];
    if (!tokenRow) return res.status(404).json({ error: 'invalid token' });

    const issueRow = (await req().input('iid', sql.Int, iid).input('bid', sql.Int, tokenRow.board_id)
      .query(`SELECT id FROM fu_issues WHERE id=@iid AND board_id=@bid`)).recordset[0];
    if (!issueRow) return res.status(404).json({ error: 'issue not found' });

    const r = await req()
      .input('iid', sql.Int, iid)
      .input('an',  sql.NVarChar, authorName)
      .input('b',   sql.NVarChar, body)
      .query(`INSERT INTO fu_comments(issue_id,user_id,author_name,body) OUTPUT INSERTED.id VALUES(@iid,NULL,@an,@b)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/public/board/:token/issues/:id/status  → customer updates status (no auth)
app.put('/api/public/board/:token/issues/:id/status', async (request, res) => {
  try {
    const tok    = request.params.token;
    const id     = parseInt(request.params.id);
    const status = request.body.status;
    const allowed = ['pending','in_progress','waiting','fixed_waiting_update','resolved','cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });

    const tokenRow = (await req().input('tok', sql.NVarChar, tok)
      .query(`SELECT board_id FROM fu_board_tokens WHERE token=@tok`)).recordset[0];
    if (!tokenRow) return res.status(404).json({ error: 'invalid token' });

    const issue = (await req().input('id', sql.Int, id).input('bid', sql.Int, tokenRow.board_id)
      .query(`SELECT id FROM fu_issues WHERE id=@id AND board_id=@bid`)).recordset[0];
    if (!issue) return res.status(403).json({ error: 'Issue ไม่พบหรือไม่มีสิทธิ์' });

    // Same resolution stamp as the internal route — a customer has no app_users row to credit
    const stamp = status === 'resolved' ? ', fix_date=CAST(GETDATE() AS DATE), resolved_by=NULL'
                : ', fix_date=NULL, resolved_by=NULL';
    await req().input('id', sql.Int, id).input('st', sql.NVarChar, status)
      .query(`UPDATE fu_issues SET status=@st, updated_at=GETDATE()${stamp} WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/public/board/:token/issues/:id/priority  → customer updates priority (no auth)
app.put('/api/public/board/:token/issues/:id/priority', async (request, res) => {
  try {
    const tok      = request.params.token;
    const id       = parseInt(request.params.id);
    const priority = request.body.priority;
    const allowed  = ['urgent','high','normal','low'];
    if (!allowed.includes(priority)) return res.status(400).json({ error: 'ความสำคัญไม่ถูกต้อง' });

    const tokenRow = (await req().input('tok', sql.NVarChar, tok)
      .query(`SELECT board_id FROM fu_board_tokens WHERE token=@tok`)).recordset[0];
    if (!tokenRow) return res.status(404).json({ error: 'invalid token' });

    const issue = (await req().input('id', sql.Int, id).input('bid', sql.Int, tokenRow.board_id)
      .query(`SELECT id FROM fu_issues WHERE id=@id AND board_id=@bid`)).recordset[0];
    if (!issue) return res.status(403).json({ error: 'Issue ไม่พบหรือไม่มีสิทธิ์' });

    await req().input('id', sql.Int, id).input('pr', sql.NVarChar, priority)
      .query(`UPDATE fu_issues SET priority=@pr, updated_at=GETDATE() WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /public/board/:token  → serve public HTML page
app.get('/public/board/:token', (req2, res) => {
  res.sendFile(require('path').join(__dirname, 'public', 'board-public.html'));
});

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
    // ตัวกรอง (ไม่บังคับ): folder_id, assigned_to (id หรือ 'none'), priority, category, dateFrom/dateTo (วันที่สร้าง)
    const q = request.query;
    const conds = [], bind = r => {
      if (q.folder_id) r.input('fid', sql.Int, +q.folder_id);
      if (q.assigned_to && q.assigned_to !== 'none') r.input('asg', sql.Int, +q.assigned_to);
      if (q.priority) r.input('pri', sql.NVarChar, String(q.priority));
      if (q.category) r.input('cat', sql.NVarChar, String(q.category));
      if (q.dateFrom) r.input('df', sql.Date, new Date(q.dateFrom));
      if (q.dateTo) r.input('dt', sql.Date, new Date(q.dateTo));
      return r;
    };
    if (q.assigned_to === 'none') conds.push('i.assigned_to IS NULL'); else if (q.assigned_to) conds.push('i.assigned_to=@asg');
    if (q.priority) conds.push('i.priority=@pri');
    if (q.category) conds.push('i.category=@cat');
    if (q.dateFrom) conds.push('CAST(i.created_at AS DATE) >= @df');
    if (q.dateTo) conds.push('CAST(i.created_at AS DATE) <= @dt');
    const iCond = conds.length ? ' AND ' + conds.join(' AND ') : '';
    const fCond = q.folder_id ? ' AND b.folder_id=@fid' : '';
    const [boardRows, staleRows, assigneeRows] = await Promise.all([
      bind(req()).query(`
        SELECT
          f.id AS folder_id, f.name AS folder_name,
          b.id AS board_id,  b.name AS board_name,
          ISNULL(i.status,'none') AS status,
          COUNT(i.id) AS cnt
        FROM fu_folders f
        JOIN fu_boards b ON b.folder_id = f.id
        LEFT JOIN fu_issues i ON i.board_id = b.id${iCond}
        WHERE 1=1${fCond}
        GROUP BY f.id, f.name, b.id, b.name, i.status
        ORDER BY f.name, b.name, i.status`),
      bind(req()).query(`
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
          AND DATEDIFF(day, i.updated_at, GETDATE()) >= 7${iCond}${fCond}
        ORDER BY days_stale DESC`),
      bind(req()).query(`
        SELECT
          i.assigned_to,
          ISNULL(e.nickname, e.name) AS assignee_name,
          i.status,
          COUNT(i.id) AS cnt
        FROM fu_issues i
        LEFT JOIN employees e ON e.id = i.assigned_to
        LEFT JOIN fu_boards b ON b.id = i.board_id
        WHERE i.status NOT IN ('resolved','cancelled')${iCond}${fCond}
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
        i.issue_url, i.assigned_to, i.created_by,
        i.release_date, i.release_version, i.uat_date, i.pilot_date, i.golive_date,
        ISNULL(e.nickname, e.name)   AS assignee_name,
        ISNULL(e.nickname, e.name)   AS assigned_to_name,
        ISNULL(ec.nickname, ec.name) AS created_by_name,
        i.fix_date, ISNULL(er.nickname, er.name) AS resolved_by_name,
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
      LEFT JOIN app_users  ur ON ur.id = i.resolved_by
      LEFT JOIN employees  er ON er.id = ur.employee_id
      LEFT JOIN fu_boards  b  ON b.id  = i.board_id
      LEFT JOIN fu_folders f  ON f.id  = b.folder_id
      WHERE i.status NOT IN ('resolved','cancelled')
      ORDER BY assignee_name, i.status, i.priority`);
    res.json(await fuApplyAzureRelease(result.recordset));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══ FOLLOW UP v2 — GLOBAL SEARCH (across every folder/board) ══
app.get('/api/fu/search', authRequired, async (request, res) => {
  try {
    const raw = (request.query.q || '').trim();
    if (!raw) return res.json([]);
    const idOnly = raw.replace(/^#/, '');
    const result = await req()
      .input('q',   sql.NVarChar, `%${raw}%`)
      .input('idQ', sql.NVarChar, idOnly)
      .query(`
        SELECT TOP 50
          i.id, i.detail, i.note, i.status, i.priority, i.category,
          ISNULL(e.nickname, e.name) AS assigned_to_name,
          b.id AS board_id, b.name AS board_name,
          f.id AS folder_id, f.name AS folder_name
        FROM fu_issues i
        LEFT JOIN employees e  ON e.id  = i.assigned_to
        LEFT JOIN fu_boards  b ON b.id  = i.board_id
        LEFT JOIN fu_folders f ON f.id  = b.folder_id
        WHERE i.detail LIKE @q OR i.note LIKE @q OR i.category LIKE @q
           OR ISNULL(e.nickname, e.name) LIKE @q
           OR CAST(i.id AS NVARCHAR) = @idQ
        ORDER BY i.created_at DESC`);
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
      .query(`INSERT INTO fu_activity(issue_id,user_id,action,new_val,created_at) VALUES(@iid,@uid,@ct,@nv,GETDATE())`);
    res.json({ ok:true, board_name: bRow.bname, folder_name: bRow.fname });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fu/boards/:bid/issues', authRequired, async (request, res) => {
  try {
    const rows = (await req().input('bid',sql.Int,parseInt(request.params.bid)).query(`
      SELECT i.*,
        ISNULL(ea.nickname, ea.name) AS assigned_to_name,
        ISNULL(ec.nickname, ec.name) AS created_by_name,
        ISNULL(er.nickname, er.name) AS resolved_by_name,
        (SELECT COUNT(*) FROM fu_comments c WHERE c.issue_id=i.id) AS comment_count,
        (SELECT TOP 1 c.created_at FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_at,
        (SELECT TOP 1 c.body     FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_body
      FROM fu_issues i
      LEFT JOIN employees ea ON ea.id=i.assigned_to
      LEFT JOIN app_users uc ON uc.id=i.created_by
      LEFT JOIN employees ec ON ec.id=uc.employee_id
      LEFT JOIN app_users ur ON ur.id=i.resolved_by
      LEFT JOIN employees er ON er.id=ur.employee_id
      WHERE i.board_id=@bid ORDER BY i.position,i.created_at`)).recordset;
    res.json(await fuApplyAzureRelease(rows));
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
        ISNULL(er.nickname, er.name) AS resolved_by_name,
        (SELECT COUNT(*) FROM fu_comments c WHERE c.issue_id=i.id) AS comment_count,
        (SELECT TOP 1 c.created_at FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_at,
        (SELECT TOP 1 c.body     FROM fu_comments c WHERE c.issue_id=i.id ORDER BY c.created_at DESC) AS last_comment_body
      FROM fu_issues i
      LEFT JOIN employees ea ON ea.id=i.assigned_to
      LEFT JOIN app_users uc ON uc.id=i.created_by
      LEFT JOIN employees ec ON ec.id=uc.employee_id
      LEFT JOIN app_users ur ON ur.id=i.resolved_by
      LEFT JOIN employees er ON er.id=ur.employee_id
      WHERE i.id=@id`)).recordset;
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json((await fuApplyAzureRelease(rows))[0]);
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
      .input('nt',sql.NVarChar,b.note||null)
      .input('cb',sql.Int,request.user.id).input('spref',sql.Int,b.sp_ref||null)
      .input('iu',sql.NVarChar,b.issue_url||null)
      .query(`INSERT INTO fu_issues(board_id,branch,detail,category,priority,assigned_to,note,created_by,sp_ref,issue_url) OUTPUT INSERTED.id VALUES(@bid,@br,@det,@cat,@pri,@at,@nt,@cb,@spref,@iu)`);
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
    if (b.hasOwnProperty('fix_date'))    { r=r.input('fd',sql.Date,b.fix_date||null);            updates.push('fix_date=@fd'); }
    if (b.hasOwnProperty('note'))        { r=r.input('nt',sql.NVarChar,b.note??null);            updates.push('note=@nt'); }
    if (b.hasOwnProperty('release_date')) { r=r.input('rd',sql.Date,b.release_date||null);        updates.push('release_date=@rd'); }
    if (b.hasOwnProperty('uat_date'))    { r=r.input('ud',sql.Date,b.uat_date||null);            updates.push('uat_date=@ud'); }
    if (b.hasOwnProperty('pilot_date'))  { r=r.input('pd',sql.Date,b.pilot_date||null);          updates.push('pilot_date=@pd'); }
    if (b.hasOwnProperty('golive_date')) { r=r.input('gd',sql.Date,b.golive_date||null);         updates.push('golive_date=@gd'); }
    if (b.hasOwnProperty('release_version')) { r=r.input('rv',sql.NVarChar,b.release_version??null); updates.push('release_version=@rv'); }
    if (b.hasOwnProperty('issue_url'))   { r=r.input('iu',sql.NVarChar,b.issue_url??null);       updates.push('issue_url=@iu'); }

    // Closing an issue stamps the date and the person; reopening clears both
    const statusChanged = b.hasOwnProperty('status') && b.status !== cur.status;
    if (statusChanged) {
      if (b.status === 'resolved')      { r=r.input('rby',sql.Int,uid); updates.push('fix_date=CAST(GETDATE() AS DATE)','resolved_by=@rby'); }
      else if (cur.status === 'resolved') { updates.push('fix_date=NULL','resolved_by=NULL'); }
    }
    await r.query(`UPDATE fu_issues SET ${updates.join(',')} WHERE id=@id`);

    // Hand the new stamp back so the panel can show it without a reload
    let stamp = null;
    if (statusChanged) {
      stamp = (await req().input('id',sql.Int,id).query(`
        SELECT i.fix_date, ISNULL(er.nickname, er.name) AS resolved_by_name
        FROM fu_issues i
        LEFT JOIN app_users ur ON ur.id=i.resolved_by
        LEFT JOIN employees er ON er.id=ur.employee_id
        WHERE i.id=@id`)).recordset[0] || null;
    }

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
    res.json({ ok: true, ...(stamp || {}) });
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
      SELECT 'comment' AS type,c.id,c.body AS content,c.created_at,
             COALESCE(e.nickname,e.name,c.author_name,N'ลูกค้า') AS user_name,
             CASE WHEN c.user_id IS NULL THEN 1 ELSE 0 END AS is_customer
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
// ══ FOLLOW UP — Azure DevOps work item lookup (shared, cached 5 นาที) ══
const FU_AZ_URL_RE = /infogrammer\/([^\/]+)\/_workitems\/edit\/(\d+)/;
const fuAzWorkItemId = url => { const m = FU_AZ_URL_RE.exec(url || ''); return m ? parseInt(m[2], 10) : null; };
const _fuAzCache = new Map();          // workItemId → { at, data }
const FU_AZ_TTL = 5 * 60 * 1000;
function fuAzGet(url, timeout) {
  const pat = process.env.AZURE_DEVOPS_PAT || '';
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = require('https').get({
      hostname: u.hostname, path: u.pathname + u.search, timeout,
      headers: { Authorization: 'Basic ' + Buffer.from(':' + pat).toString('base64'), Accept: 'application/json' },
    }, resp => {
      let body = '';
      resp.on('data', c => { body += c; });
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Azure JSON parse: ' + body.slice(0, 120))); } });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('Azure timeout')); });
    r.on('error', reject);
  });
}
// คืน { [workItemId]: { title, state, workItemType, assignedTo, levelOfUrgency, releaseDate, releaseVersion } }
async function fuAzureFetch(ids, { timeout = 15000 } = {}) {
  const out = {};
  if (!process.env.AZURE_DEVOPS_PAT) return out;
  const now = Date.now(), need = [];
  for (const id of new Set(ids.filter(Boolean))) {
    const c = _fuAzCache.get(id);
    if (c && now - c.at < FU_AZ_TTL) { if (c.data) out[id] = c.data; } else need.push(id);
  }
  const FIELDS = ['System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo',
    'Custom.LevelofUrgency', 'Custom.ReleaseDate', 'Custom.ReleaseVersion'].join(',');
  for (let i = 0; i < need.length; i += 200) {
    const batch = need.slice(i, i + 200);
    try {
      // errorPolicy=omit: work item ที่ถูกลบ/อ่านไม่ได้ถูกข้าม ไม่ทำให้ทั้ง batch ล้ม
      const data = await fuAzGet(`https://dev.azure.com/infogrammer/_apis/wit/workitems?ids=${batch.join(',')}&fields=${encodeURIComponent(FIELDS)}&errorPolicy=omit&api-version=7.0`, timeout);
      if (data.message) { console.error('[Azure] API error:', data.message); break; }
      const got = new Set();
      (data.value || []).filter(Boolean).forEach(item => {
        const f = item.fields || {}, a = f['System.AssignedTo'];
        const d = {
          title: f['System.Title'] || null, state: f['System.State'] || null, workItemType: f['System.WorkItemType'] || null,
          assignedTo: typeof a === 'object' ? (a?.displayName || null) : (a || null),
          levelOfUrgency: f['Custom.LevelofUrgency'] || null,
          releaseDate: f['Custom.ReleaseDate'] || null, releaseVersion: f['Custom.ReleaseVersion'] || null,
        };
        out[item.id] = d; got.add(item.id); _fuAzCache.set(item.id, { at: now, data: d });
      });
      batch.filter(id => !got.has(id)).forEach(id => _fuAzCache.set(id, { at: now, data: null }));   // ไม่มีใน Azure — อย่าถามซ้ำทุกครั้ง
    } catch (e) { console.error(`[Azure] Work Items API error (batch ${i}):`, e.message); }
  }
  return out;
}

// Issue ที่ผูก Azure (issue_url) → ใช้ Release Date / Release Version จาก Azure และบันทึกกลับลง fu_issues
// ถ้า Azure ช้า/ล่ม ใช้ค่าเดิมใน DB
const fuBkkDate = v => { const d = new Date(v); return isNaN(d) ? null : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(d); };
async function fuApplyAzureRelease(rows) {
  const linked = rows.filter(r => fuAzWorkItemId(r.issue_url));
  if (!linked.length || !process.env.AZURE_DEVOPS_PAT) return rows;
  let az = {};
  try { az = await fuAzureFetch(linked.map(r => fuAzWorkItemId(r.issue_url)), { timeout: 6000 }); } catch { return rows; }
  const updates = [];
  for (const r of linked) {
    const a = az[fuAzWorkItemId(r.issue_url)];
    if (!a) continue;
    r.azure_state = a.state;
    const curDate = r.release_date ? new Date(r.release_date).toISOString().slice(0, 10) : null;
    const azDate = a.releaseDate ? fuBkkDate(a.releaseDate) : null;
    const azVer = a.releaseVersion ? String(a.releaseVersion).trim().slice(0, 50) : null;
    // แสดงค่าจาก Azure เสมอ · บันทึกลง DB เฉพาะช่องที่ยังว่าง (ไม่ทับค่าที่ทีมกรอกไว้เอง)
    const set = {};
    if (azDate) {
      r.release_from_azure = true;
      if (curDate && curDate !== azDate) r.release_date_local = curDate;   // ค่าในระบบต่างจาก Azure — บอกผู้ใช้
      if (!curDate) set.release_date = azDate;
      r.release_date = azDate;
    }
    if (azVer) {
      r.release_from_azure = true;
      if (r.release_version && r.release_version !== azVer) r.release_version_local = r.release_version;
      if (!r.release_version) set.release_version = azVer;
      r.release_version = azVer;
    }
    if (Object.keys(set).length) updates.push({ id: r.id, ...set });
  }
  for (const u of updates) {
    try {
      const q = req().input('id', sql.Int, u.id), parts = [];
      if (u.release_date) { q.input('rd', sql.Date, new Date(u.release_date + 'T00:00:00Z')); parts.push('release_date=@rd'); }
      if (u.release_version) { q.input('rv', sql.NVarChar, u.release_version); parts.push('release_version=@rv'); }
      await q.query(`UPDATE fu_issues SET ${parts.join(', ')} WHERE id=@id`);   // ไม่แตะ updated_at — ไม่ใช่การแก้งานโดยคน
    } catch (e) { console.error('[Azure] save release for fu#' + u.id + ':', e.message); }
  }
  if (updates.length) console.log(`[Azure] release/version synced for ${updates.length} follow-up issue(s)`);
  return rows;
}

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

    if (!process.env.AZURE_DEVOPS_PAT) console.warn('[Azure] AZURE_DEVOPS_PAT not set — work item details unavailable');
    const azureMap = await fuAzureFetch(parsed.map(r => r.workItemId));

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
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='requester_phone') ALTER TABLE service_requests ADD requester_phone NVARCHAR(50) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='requester_line_id') ALTER TABLE service_requests ADD requester_line_id NVARCHAR(200) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='cancel_reason') ALTER TABLE service_requests ADD cancel_reason NVARCHAR(MAX) NULL`);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('service_requests') AND name='cancelled_at') ALTER TABLE service_requests ADD cancelled_at DATETIME NULL`);
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

// Attachments for Cases (Calllog lives on the external LicenseDB — keep attachment
// metadata local in cs_team, keyed by CalllogId, same pattern as fu_attachments)
async function ensureCaseAttachmentsTable() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='case_attachments' AND xtype='U')
      CREATE TABLE case_attachments (
        id            INT PRIMARY KEY IDENTITY,
        calllog_id    INT NOT NULL,
        filename      NVARCHAR(300) NOT NULL,
        original_name NVARCHAR(300) NOT NULL,
        file_size     INT,
        mime_type     NVARCHAR(100),
        uploaded_by   INT,
        created_at    DATETIME DEFAULT GETDATE()
      )`);
    console.log('✅ case_attachments table ready');
  } catch(e) { console.error('❌ case_attachments error:', e.message); }
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
    // Create sw_update_assignees table for multiple assignees per job
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sw_update_assignees' AND xtype='U')
      CREATE TABLE sw_update_assignees (
        id       INT PRIMARY KEY IDENTITY,
        job_id   INT NOT NULL,
        user_id  INT NOT NULL,
        created_at DATETIME DEFAULT GETDATE()
      )
    `);
    // Add unique constraint if not exists
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('sw_update_assignees') AND name='UQ_sw_assignees_job_user')
        ALTER TABLE sw_update_assignees ADD CONSTRAINT UQ_sw_assignees_job_user UNIQUE (job_id, user_id)
    `);
    console.log('✅ sw_update_jobs table ready');
  } catch(e) { console.error('❌ sw_update_jobs error:', e.message); }
}

// ══════════════════════════════════════════════════════════
//  UAT — รอบทดสอบ (uat_jobs) → Issue (uat_issues)
//  โครงสร้างตาม "เอกสารเปิดงานทดสอบระบบ (Test Kickoff Document)"
// ══════════════════════════════════════════════════════════
async function ensureUatTables() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='uat_jobs' AND xtype='U')
      CREATE TABLE uat_jobs (
        id              INT PRIMARY KEY IDENTITY,
        job_no          NVARCHAR(20)  NOT NULL,          -- UAT-YYYYMM-0001
        title           NVARCHAR(300) NOT NULL,          -- ชื่อรอบทดสอบ / โครงการ
        job_type        NVARCHAR(30)  DEFAULT 'version_update',
        -- version_update | sync_test | feature | hotfix | other
        version_from    NVARCHAR(100) NULL,
        version_to      NVARCHAR(100) NULL,
        requested_date  DATE NULL,                       -- วันที่ผู้แจ้งอยากได้
        test_date_from  DATE NULL,                       -- slot ที่ UAT Staff แจ้ง
        test_date_to    DATE NULL,
        slot_by         INT NULL,                        -- UAT Staff ที่แจ้ง slot
        slot_at         DATETIME NULL,
        confirmed_at    DATETIME NULL,                   -- Support ยืนยันกับลูกค้าแล้ว
        confirmed_by    INT NULL,
        uat_passed_at   DATETIME NULL,                   -- UAT ผ่าน (ต้องมีเอกสารผลแนบก่อน)
        uat_passed_by   INT NULL,
        handed_at       DATETIME NULL,                   -- ส่งต่อทีม Update
        handed_by       INT NULL,
        priority        NVARCHAR(20)  DEFAULT 'normal',
        status          NVARCHAR(30)  DEFAULT 'requested',
        -- requested | slot_proposed | confirmed | testing | issues_found
        -- | retesting | passed | handed_to_update | closed | cancelled
        note            NVARCHAR(MAX) NULL,
        reported_by     INT NULL,
        created_by      INT NULL,
        created_at      DATETIME DEFAULT GETDATE(),
        updated_at      DATETIME DEFAULT GETDATE(),
        updated_by      INT NULL
      )
    `);
    // คอลัมน์ที่เพิ่มทีหลัง (สำหรับ DB ที่สร้างตารางไปแล้ว)
    for (const [col, ddl] of [
      ['requested_date', 'DATE NULL'],
      ['slot_by',        'INT NULL'],
      ['slot_at',        'DATETIME NULL'],
      ['confirmed_at',   'DATETIME NULL'],
      ['confirmed_by',   'INT NULL'],
      ['uat_passed_at',  'DATETIME NULL'],
      ['uat_passed_by',  'INT NULL'],
      ['handed_at',      'DATETIME NULL'],
      ['handed_by',      'INT NULL'],
    ]) {
      await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('uat_jobs') AND name='${col}')
        ALTER TABLE uat_jobs ADD ${col} ${ddl}`);
    }
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='uat_issues' AND xtype='U')
      CREATE TABLE uat_issues (
        id           INT PRIMARY KEY IDENTITY,
        job_id       INT NOT NULL,
        issue_no     INT NULL,                           -- ลำดับภายในรอบทดสอบ
        topic        NVARCHAR(300) NOT NULL,             -- Topic
        description  NVARCHAR(MAX) NULL,                 -- Description
        expected     NVARCHAR(MAX) NULL,                 -- Expected Behavior
        actual       NVARCHAR(MAX) NULL,                 -- Actual Behavior
        resolution   NVARCHAR(MAX) NULL,                 -- แนวทางการแก้ไข (ฝั่ง Developer)
        severity     NVARCHAR(20)  DEFAULT 'medium',     -- critical | high | medium | low
        status       NVARCHAR(30)  DEFAULT 'open',
        -- open | sent_dev | fixing | fixed | retest_passed | retest_failed | wont_fix
        azure_id     NVARCHAR(200) NULL,
        assigned_dev NVARCHAR(200) NULL,
        found_by     INT NULL,
        found_at     DATETIME DEFAULT GETDATE(),
        resolved_at  DATETIME NULL,
        created_by   INT NULL,
        created_at   DATETIME DEFAULT GETDATE(),
        updated_at   DATETIME DEFAULT GETDATE(),
        updated_by   INT NULL
      )
    `);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('uat_issues') AND name='resolution')
      ALTER TABLE uat_issues ADD resolution NVARCHAR(MAX) NULL`);
    await req().query(`
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('uat_issues') AND name='IX_uat_issues_job')
        CREATE INDEX IX_uat_issues_job ON uat_issues (job_id)
    `);
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='uat_attachments' AND xtype='U')
      CREATE TABLE uat_attachments (
        id            INT PRIMARY KEY IDENTITY,
        scope         NVARCHAR(10) NOT NULL,             -- 'job' | 'issue'
        doc_type      NVARCHAR(20) DEFAULT 'other',      -- 'kickoff' | 'result' | 'other'
        job_id        INT NULL,
        issue_id      INT NULL,
        filename      NVARCHAR(300) NOT NULL,
        original_name NVARCHAR(300) NOT NULL,
        file_size     INT NULL,
        mime_type     NVARCHAR(100) NULL,
        created_by    INT NULL,
        created_at    DATETIME DEFAULT GETDATE()
      )
    `);
    await req().query(`IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('uat_attachments') AND name='doc_type')
      ALTER TABLE uat_attachments ADD doc_type NVARCHAR(20) NULL`);
    console.log('✅ uat_jobs / uat_issues tables ready');
  } catch(e) { console.error('❌ uat tables error:', e.message); }
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
             ISNULL(ea.nickname, ea.name) AS assigned_to_name,
             dl.delivered_by_name, dl.delivered_at
      FROM service_requests sr
      LEFT JOIN app_users  uc ON uc.id = sr.created_by
      LEFT JOIN employees  ec ON ec.id = uc.employee_id
      LEFT JOIN app_users  ua ON ua.id = sr.assigned_to
      LEFT JOIN employees  ea ON ea.id = ua.employee_id
      -- ผู้ส่งมอบ = คนที่แนบหลักฐาน "ส่งมอบ" ล่าสุด
      OUTER APPLY (
        SELECT TOP 1 COALESCE(ed.nickname, ed.name, ud.username) AS delivered_by_name, sa.uploaded_at AS delivered_at
        FROM service_attachments sa
        LEFT JOIN app_users ud ON ud.id = sa.uploaded_by
        LEFT JOIN employees ed ON ed.id = ud.employee_id
        WHERE sa.service_request_id = sr.id AND sa.stage = 'delivered'
        ORDER BY sa.uploaded_at DESC
      ) dl
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
      .input('requester_phone',    sql.NVarChar, b.requester_phone||null)
      .input('requester_line_id',  sql.NVarChar, b.requester_line_id||null)
      .input('period_start',       sql.Date,     b.period_start?new Date(b.period_start):null)
      .input('period_end',         sql.Date,     b.period_end?new Date(b.period_end):null)
      .input('objective',          sql.NVarChar, b.objective||null)
      .input('condition',          sql.NVarChar, b.condition||null)
      .input('attachment_name',    sql.NVarChar, b.attachment_name||null)
      .input('status',             sql.NVarChar, 'received')
      .input('created_by',         sql.Int,      request.user.id)
      .query(`INSERT INTO service_requests
        (project_id,job_no,serve_type,brands,branches,title,request_no,request_date,
         requester_position,requester_name,requester_phone,requester_line_id,period_start,period_end,
         objective,condition,attachment_name,status,created_by)
        OUTPUT INSERTED.id
        VALUES(@project_id,@job_no,@serve_type,@brands,@branches,@title,@request_no,@request_date,
               @requester_position,@requester_name,@requester_phone,@requester_line_id,@period_start,@period_end,
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
      .query(`SELECT a.id, a.file_name, a.file_path, a.file_size, a.mime_type, a.stage, a.uploaded_at,
                     COALESCE(e.nickname, e.name, u.username) AS uploaded_by_name
              FROM service_attachments a
              LEFT JOIN app_users u ON u.id = a.uploaded_by
              LEFT JOIN employees e ON e.id = u.employee_id
              WHERE a.service_request_id=@sid ORDER BY a.uploaded_at`))
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
                     requester_name, requester_position, requester_phone, requester_line_id,
                     brands, branches, period_start, period_end, objective, condition, created_at,
                     cancel_reason, cancelled_at
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
      .input('requester_phone',   sql.NVarChar, b.requester_phone||null)
      .input('requester_line_id', sql.NVarChar, b.requester_line_id||null)
      .input('period_start',      sql.Date,     b.period_start?new Date(b.period_start):null)
      .input('period_end',        sql.Date,     b.period_end?new Date(b.period_end):null)
      .input('objective',         sql.NVarChar, b.objective||null)
      .input('condition',         sql.NVarChar, b.condition||null)
      .input('status',            sql.NVarChar, 'received')
      .query(`INSERT INTO service_requests
        (project_id,job_no,serve_type,brands,branches,title,request_no,request_date,
         requester_position,requester_name,requester_phone,requester_line_id,
         period_start,period_end,objective,condition,status)
        OUTPUT INSERTED.id, INSERTED.job_no
        VALUES(@project_id,@job_no,@serve_type,@brands,@branches,@title,@request_no,@request_date,
               @requester_position,@requester_name,@requester_phone,@requester_line_id,
               @period_start,@period_end,@objective,@condition,@status)`);
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

// ── POST /api/public/project/:token/jobs/:id/cancel ──────────
// Public: customer cancels a job only while status is still 'received'
app.post('/api/public/project/:token/jobs/:id/cancel', async (request, res) => {
  try {
    const token = request.params.token;
    const id    = parseInt(request.params.id);
    const proj  = (await req()
      .input('token', sql.NVarChar, token)
      .query(`SELECT id FROM service_projects WHERE public_token=@token AND is_active=1`))
      .recordset[0];
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    const reason = String((request.body && request.body.reason) || '').trim().slice(0, 1000) || null;
    // Conditional update so a job picked up by staff in the meantime can't be cancelled
    const result = await req()
      .input('id',     sql.Int,      id)
      .input('pid',    sql.Int,      proj.id)
      .input('reason', sql.NVarChar, reason)
      .query(`UPDATE service_requests SET status='cancelled', cancel_reason=@reason,
                cancelled_at=GETDATE(), updated_at=GETDATE()
              OUTPUT INSERTED.job_no, INSERTED.title, INSERTED.requester_name, INSERTED.serve_type
              WHERE id=@id AND project_id=@pid AND status='received'`);
    const row = result.recordset[0];
    if (!row) {
      const exists = (await req().input('id', sql.Int, id).input('pid', sql.Int, proj.id)
        .query(`SELECT status FROM service_requests WHERE id=@id AND project_id=@pid`)).recordset[0];
      if (!exists) return res.status(404).json({ error: 'Job not found' });
      return res.status(403).json({ error: 'ไม่สามารถยกเลิกได้ เนื่องจากมีเจ้าหน้าที่รับงานแล้ว' });
    }
    try {
      const msg = `\n🚫 [ลูกค้ายกเลิกงานบริการ] ${row.job_no}` +
        (row.title          ? `\nหัวข้อ: ${row.title}` : '') +
        (row.requester_name ? `\nผู้แจ้ง: ${row.requester_name}` : '') +
        (reason             ? `\nเหตุผล: ${reason}` : '');
      await sendLineNotify(msg, 'service_request', { serveType: row.serve_type, projectId: proj.id });
    } catch(e) { console.warn('service_request cancel line notify failed:', e.message); }
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
app.get('/api/dashboard/issue-tickets', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const { subject, category, dateFrom, dateTo } = request.query;
    if (!subject) return res.status(400).json({ error: 'subject required' });

    const s = dateFrom ? new Date(dateFrom) : new Date(new Date().setHours(0, 0, 0, 0));
    const e = dateTo ? new Date(new Date(dateTo).setHours(23, 59, 59, 999))
                     : new Date(new Date().setHours(23, 59, 59, 999));

    const r = extReq()
      .input('s', sql.DateTime, s)
      .input('e', sql.DateTime, e)
      .input('sub', sql.NVarChar, subject);
    let where = `WHERE cl.Active=1 AND cl.ReceiveDate>=@s AND cl.ReceiveDate<=@e AND cl.Subject=@sub`;
    if (category) {
      // '(ไม่ระบุ)' มาจาก ISNULL ฝั่งกราฟ — ตรงนี้จึงต้องแปลว่า "ไม่มี ProblemType"
      if (category === '(ไม่ระบุ)') where += ' AND pt.ProblemTypeDetail IS NULL';
      else { where += ' AND pt.ProblemTypeDetail=@cat'; r.input('cat', sql.NVarChar, category); }
    }

    const rows = (await r.query(`
      SELECT TOP 300
        cl.CalllogId            AS id,
        cl.ReceiveDate          AS opened_at,
        cl.CloseDate            AS closed_at,
        cl.RegistrationId       AS registration_id,
        cr.CompanyName          AS company,
        CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cg.GroupName END AS customer_group,
        CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cr.GroupId END AS group_id,
        cl.Subject              AS subject,
        ISNULL(pt.ProblemTypeDetail, '(ไม่ระบุ)') AS category,
        cs.StatusName           AS status,
        u.UserName              AS agent,
        LEFT(cl.CalllogDesc, 2000) AS description,   -- ยาวพอให้ Monitor Tag ดึงไปเป็น note
        LEFT(cl.Solution, 2000)   AS solution      -- ดึงไปเป็น "วิธีแก้ไข" ของ Monitor Tag
      FROM Calllog cl
      LEFT JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
      LEFT JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
      LEFT JOIN ProblemType pt ON pt.ProblemTypeId = cl.ProblemTypeId
      LEFT JOIN CallStatus  cs ON cs.StatusId      = cl.StatusId
      LEFT JOIN Users       u  ON u.UserId         = cl.SupportId
      ${where}
      ORDER BY cl.ReceiveDate DESC`)).recordset;

    const total = (await extReq()
      .input('s', sql.DateTime, s).input('e', sql.DateTime, e)
      .input('sub', sql.NVarChar, subject)
      .query(`SELECT COUNT(*) AS n FROM Calllog cl
              LEFT JOIN ProblemType pt ON pt.ProblemTypeId = cl.ProblemTypeId
              WHERE cl.Active=1 AND cl.ReceiveDate>=@s AND cl.ReceiveDate<=@e AND cl.Subject=@sub`)).recordset[0].n;

    res.json({ rows, total, shown: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// ══════════════════════════════════════════════════════════
//  MONITOR TAGS — ติดตามหัวข้อปัญหาของสาขาหนึ่ง ๆ หลังตั้ง Tag
//  Rule ของ tag = Calllog ที่ RegistrationId (สาขา) + Subject ตรงกัน
//  เทียบค่าเฉลี่ยต่อวัน: baseline (N วันก่อนตั้ง) กับช่วงหลังตั้งจนถึงวันนี้/วันปิด tag
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
//  EXTERNAL API v1 — ให้ระบบอื่นดึงข้อมูล "ติดตามเคส" (อ่านอย่างเดียว)
//  ยืนยันตัวตนด้วย API Key (X-API-Key) แยกตามระบบที่เชื่อม · มี scope · จำกัดจำนวนครั้ง · เก็บ log
//  เอกสาร: GET /api/v1/docs  (OpenAPI: /api/v1/openapi.json)
// ══════════════════════════════════════════════════════════
const API_SCOPES        = ['cases:read', 'cases:write'];   // write = เปิดเคส / ปิดเคส
const API_RATE_PER_MIN  = Math.max(1, parseInt(process.env.API_RATE_PER_MIN) || 60);
const API_MAX_RANGE_DAY = 31;     // ช่วงวันที่ต่อครั้งไม่เกิน — กัน query หนักไปถึง LicenseDB
const API_MAX_LIMIT     = 500;
const API_LOG_KEEP_DAYS = 90;

async function ensureApiTables() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='api_clients' AND xtype='U')
      CREATE TABLE api_clients (
        id            INT PRIMARY KEY IDENTITY,
        name          NVARCHAR(120) NOT NULL,
        key_prefix    NVARCHAR(16)  NOT NULL,     -- แสดงให้รู้ว่า key ไหน (ไม่ใช่ key จริง)
        key_hash      CHAR(64)      NOT NULL,     -- sha256 ของ key — ไม่เก็บ key จริง
        scopes        NVARCHAR(200) NOT NULL,
        note          NVARCHAR(400) NULL,
        active        BIT           NOT NULL DEFAULT 1,
        expires_at    DATETIME      NULL,
        created_by    NVARCHAR(100) NULL,
        created_at    DATETIME      DEFAULT GETDATE(),
        last_used_at  DATETIME      NULL,
        request_count INT           NOT NULL DEFAULT 0
      )`);
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='api_request_log' AND xtype='U')
      CREATE TABLE api_request_log (
        id         BIGINT PRIMARY KEY IDENTITY,
        client_id  INT           NULL,
        method     NVARCHAR(8)   NULL,
        path       NVARCHAR(300) NULL,
        status     INT           NULL,
        rows_out   INT           NULL,
        ms         INT           NULL,
        ip         NVARCHAR(64)  NULL,
        created_at DATETIME      DEFAULT GETDATE()
      )`);
  } catch (e) { console.error('[api] ensure tables:', e.message); }
}

const apiHash = key => crypto.createHash('sha256').update(String(key)).digest('hex');
const apiNewKey = () => 'cst_' + crypto.randomBytes(24).toString('base64url');   // แสดงครั้งเดียวตอนสร้าง

// error รูปแบบเดียวกันทุก endpoint
const apiErr = (res, status, code, message) => res.status(status).json({ error: { code, message } });

// เวลาใน LicenseDB เป็นเวลาไทย (mssql อ่านเป็นค่า UTC) → ส่งออกเป็น ISO พร้อม +07:00 ให้ชัดเจน
const apiIso = d => d ? new Date(d).toISOString().replace('Z', '+07:00').replace('.000', '') : null;

const _apiKeyCache = new Map();   // hash → { at, client } (60 วิ — ไม่ต้องอ่าน DB ทุก request)
const _apiRate = new Map();       // client id → timestamps ใน 1 นาทีล่าสุด

function apiKeyRequired(scope) {
  return async (request, res, next) => {
    const t0 = Date.now();
    const auth = request.headers['authorization'] || '';
    const key = request.headers['x-api-key'] || (auth.startsWith('Bearer cst_') ? auth.slice(7) : '');
    if (!key) return apiErr(res, 401, 'missing_api_key', 'ต้องส่ง API Key ใน header X-API-Key');
    const h = apiHash(key);
    let c = _apiKeyCache.get(h);
    if (!c || Date.now() - c.at > 60000) {
      try {
        const row = (await req().input('h', sql.Char(64), h).query(
          'SELECT id, name, scopes, active, expires_at FROM api_clients WHERE key_hash=@h')).recordset[0] || null;
        c = { at: Date.now(), client: row };
        _apiKeyCache.set(h, c);
      } catch (e) { return apiErr(res, 500, 'server_error', 'ตรวจ API Key ไม่สำเร็จ'); }
    }
    const client = c.client;
    if (!client || !client.active) return apiErr(res, 401, 'invalid_api_key', 'API Key ไม่ถูกต้องหรือถูกยกเลิกแล้ว');
    if (client.expires_at && new Date(client.expires_at) < new Date()) return apiErr(res, 401, 'expired_api_key', 'API Key หมดอายุแล้ว');
    if (scope && !String(client.scopes || '').split(',').includes(scope)) return apiErr(res, 403, 'insufficient_scope', `API Key นี้ไม่มีสิทธิ์ ${scope}`);

    // จำกัดจำนวนครั้งต่อ key (หน้าต่าง 1 นาที)
    const now = Date.now(), win = (_apiRate.get(client.id) || []).filter(t => now - t < 60000);
    if (win.length >= API_RATE_PER_MIN) {
      res.set('Retry-After', String(Math.ceil((60000 - (now - win[0])) / 1000)));
      return apiErr(res, 429, 'rate_limited', `เรียกได้ไม่เกิน ${API_RATE_PER_MIN} ครั้งต่อนาที`);
    }
    win.push(now); _apiRate.set(client.id, win);
    res.set('X-RateLimit-Limit', String(API_RATE_PER_MIN));
    res.set('X-RateLimit-Remaining', String(API_RATE_PER_MIN - win.length));

    request.apiClient = client;
    res.on('finish', () => {   // log การเรียกใช้ (ไม่รอ — ไม่ทำให้ response ช้า)
      req().input('cid', sql.Int, client.id).input('m', sql.NVarChar, request.method)
        .input('p', sql.NVarChar, request.originalUrl.slice(0, 300)).input('st', sql.Int, res.statusCode)
        .input('rw', sql.Int, res.locals.apiRows ?? null).input('ms', sql.Int, Date.now() - t0)
        .input('ip', sql.NVarChar, String(request.ip || '').slice(0, 64))
        .query(`INSERT INTO api_request_log (client_id, method, path, status, rows_out, ms, ip) VALUES (@cid,@m,@p,@st,@rw,@ms,@ip);
                UPDATE api_clients SET last_used_at=GETDATE(), request_count=request_count+1 WHERE id=@cid`)
        .catch(e => console.error('[api] log:', e.message));
    });
    next();
  };
}

// ล้าง log เก่ากว่า 90 วัน (เช็คทุก 6 ชม.)
setInterval(() => {
  req().input('d', sql.Int, API_LOG_KEEP_DAYS)
    .query('DELETE FROM api_request_log WHERE created_at < DATEADD(day, -@d, GETDATE())')
    .catch(() => {});
}, 6 * 3600 * 1000);

// ── ตัวกรองแบบเดียวกับหน้า "ติดตามเคส" ─────────────────────
const API_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
async function apiCaseFilter(q, r) {
  const today = bangkokToday();
  const from = API_DAY_RE.test(q.from || '') ? q.from : today;
  const to   = API_DAY_RE.test(q.to || '') ? q.to : (API_DAY_RE.test(q.from || '') ? q.from : today);
  if (to < from) return { error: ['invalid_range', '`to` ต้องไม่ก่อน `from`'] };
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days > API_MAX_RANGE_DAY) return { error: ['range_too_large', `ช่วงวันที่ต้องไม่เกิน ${API_MAX_RANGE_DAY} วันต่อครั้ง`] };
  const where = ['cl.Active=1', 'cl.ReceiveDate >= CAST(@from AS DATE)', 'cl.ReceiveDate < DATEADD(day, 1, CAST(@to AS DATE))'];
  r.input('from', sql.NVarChar, from).input('to', sql.NVarChar, to);
  const add = (cond, name, val) => { where.push(cond); r.input(name, sql.NVarChar, String(val).slice(0, 200)); };
  if (q.status)        add('cs.StatusName=@st', 'st', q.status);
  if (q.problem_type)  add('pt.ProblemTypeDetail=@pt', 'pt', q.problem_type);
  if (q.subject)       add('cl.Subject=@subj', 'subj', q.subject);
  if (q.agent)         add('u.UserName=@agent', 'agent', q.agent);
  if (q.channel)       add("LOWER(LTRIM(RTRIM(ISNULL(cl.InformType,''))))=LOWER(@ch)", 'ch', q.channel);
  if (q.q)             add('(cl.Subject LIKE @kw OR cr.CompanyName LIKE @kw OR CAST(cl.CalllogDesc AS NVARCHAR(MAX)) LIKE @kw)', 'kw', `%${q.q}%`);
  if (q.state === 'open')   where.push("ISNULL(cs.StatusName,'') NOT LIKE '%close%'");
  if (q.state === 'closed') where.push("cs.StatusName LIKE '%close%'");
  if (q.team) {   // ทีม → username ของคนในทีม (เหมือนตัวกรองทีมในหน้าติดตามเคส)
    const users = (await req().input('tm', sql.NVarChar, String(q.team)).query(
      `SELECT DISTINCT au.ext_username FROM app_users au JOIN employees e ON e.id=au.employee_id
       WHERE e.team=@tm AND au.active=1 AND e.active=1 AND au.ext_username IS NOT NULL`)).recordset.map(x => x.ext_username);
    if (!users.length) where.push('1=0');
    else { users.forEach((u, i) => r.input('tu' + i, sql.NVarChar, u)); where.push(`u.UserName IN (${users.map((_, i) => '@tu' + i).join(',')})`); }
  }
  return { where: where.join(' AND '), from, to };
}

const API_CASE_FROM = `
  FROM Calllog cl
  LEFT JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
  LEFT JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
  LEFT JOIN CallStatus  cs ON cs.StatusId      = cl.StatusId
  LEFT JOIN Users       u  ON u.UserId         = cl.SupportId
  LEFT JOIN ProblemType pt ON pt.ProblemTypeId = cl.ProblemTypeId
  LEFT JOIN Subject     sb ON sb.SubjectName   = cl.Subject AND sb.Active = 1`;
// เฉพาะฟิลด์ที่อนุญาต — ไม่มีชื่อ/เบอร์ผู้ติดต่อ, LINE ID หรือข้อมูลรีโมท
const API_CASE_SELECT = `
  cl.CalllogId AS id, cl.ReceiveDate AS opened_at, cl.CloseDate AS closed_at,
  CASE WHEN cl.CloseDate IS NOT NULL THEN DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate) END AS resolve_minutes,
  sb.TimeToResolve AS target_minutes, cs.StatusName AS status,
  cl.Subject AS subject, pt.Note AS problem_type, pt.ProblemTypeDetail AS problem_type_detail,
  cl.RegistrationId AS registration_id, cr.CompanyName AS company,
  CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cg.GroupName END AS license_group,
  u.UserName AS agent, NULLIF(LTRIM(RTRIM(ISNULL(cl.InformType,''))), '') AS channel,
  CAST(cl.CalllogDesc AS NVARCHAR(MAX)) AS description, CAST(cl.Solution AS NVARCHAR(MAX)) AS solution,
  cl.Stars AS stars, cl.IssueURL AS issue_url`;

async function apiShapeCases(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => +r.id).join(',');
  // Monitor Tag ที่ติดอยู่ + งาน Specialist (อยู่คนละฐานข้อมูล)
  const [tagRows, spRows] = await Promise.all([
    req().query(`SELECT c.calllog_id, t.id, t.title, t.tag_type, t.tag_group FROM monitor_tag_cases c JOIN monitor_tags t ON t.id=c.tag_id
                 WHERE t.status='active' AND c.calllog_id IN (${ids})`).then(x => x.recordset).catch(() => []),
    req().query(`SELECT calllog_id, id, status FROM specialist_log WHERE status <> 'cancelled' AND calllog_id IN (${ids})`).then(x => x.recordset).catch(() => []),
  ]);
  return rows.map(r => {
    const closed = /close/i.test(r.status || '');
    return {
      id: r.id, opened_at: apiIso(r.opened_at), closed_at: apiIso(r.closed_at),
      status: r.status, is_closed: closed,
      overdue: !closed && r.opened_at && (Date.now() + 7 * 3600000 - new Date(r.opened_at).getTime()) > 86400000,
      resolve_minutes: r.resolve_minutes, target_minutes: r.target_minutes,
      over_target: r.resolve_minutes != null && r.target_minutes != null ? r.resolve_minutes > r.target_minutes : null,
      subject: r.subject, problem_type: r.problem_type, problem_type_detail: r.problem_type_detail,
      customer: { registration_id: r.registration_id, company: r.company, license_group: r.license_group },
      agent: r.agent, channel: r.channel, description: r.description, solution: r.solution,
      stars: r.stars || null, issue_url: r.issue_url || null,
      specialist: (s => s ? { id: s.id, status: s.status } : null)(spRows.find(s => s.calllog_id === r.id)),
      monitor_tags: tagRows.filter(t => t.calllog_id === r.id).map(t => ({ id: t.id, title: t.title, group: t.tag_group || 'problem', type: t.tag_type || null })),
    };
  });
}

// GET /api/v1/health — เช็คว่า API ทำงาน (ไม่ต้องใช้ key)
app.get('/api/v1/health', (request, res) => res.json({ status: 'ok', version: 'v1', time: apiIso(new Date(Date.now() + 7 * 3600000)) }));

// GET /api/v1/cases — รายการเคส (ข้อมูลเดียวกับหน้า ติดตามเคส)
app.get('/api/v1/cases', apiKeyRequired('cases:read'), async (request, res) => {
  try {
    if (!getExtPool()) return apiErr(res, 503, 'source_unavailable', 'เชื่อมต่อฐานข้อมูลเคสไม่ได้');
    const r = extReq();
    const f = await apiCaseFilter(request.query, r);
    if (f.error) return apiErr(res, 400, ...f.error);
    const limit = Math.min(API_MAX_LIMIT, Math.max(1, parseInt(request.query.limit) || 100));
    const page = Math.max(1, parseInt(request.query.page) || 1);
    r.input('off', sql.Int, (page - 1) * limit).input('lim', sql.Int, limit);
    const rows = (await r.query(`SELECT ${API_CASE_SELECT}, COUNT(*) OVER() AS _total ${API_CASE_FROM}
      WHERE ${f.where} ORDER BY cl.ReceiveDate DESC, cl.CalllogId DESC
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`)).recordset;
    const total = rows[0]?._total ?? 0;
    res.locals.apiRows = rows.length;
    res.json({
      data: await apiShapeCases(rows),
      page: { page, limit, total, has_more: page * limit < total },
      meta: { from: f.from, to: f.to, generated_at: apiIso(new Date(Date.now() + 7 * 3600000)) },
    });
  } catch (e) { console.error('[api] cases:', e.message); apiErr(res, 500, 'server_error', 'ดึงข้อมูลไม่สำเร็จ'); }
});

// GET /api/v1/cases/summary — ตัวเลขสรุปของช่วงวันที่ (ตัวกรองเดียวกับ /cases)
app.get('/api/v1/cases/summary', apiKeyRequired('cases:read'), async (request, res) => {
  try {
    if (!getExtPool()) return apiErr(res, 503, 'source_unavailable', 'เชื่อมต่อฐานข้อมูลเคสไม่ได้');
    const r = extReq();
    const f = await apiCaseFilter(request.query, r);
    if (f.error) return apiErr(res, 400, ...f.error);
    const sets = (await r.query(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN cs.StatusName LIKE '%close%' THEN 1 ELSE 0 END) AS closed,
             SUM(CASE WHEN ISNULL(cs.StatusName,'') NOT LIKE '%close%' AND DATEDIFF(hour, cl.ReceiveDate, GETDATE()) > 24 THEN 1 ELSE 0 END) AS overdue,
             AVG(CASE WHEN cl.CloseDate IS NOT NULL THEN CAST(DATEDIFF(minute, cl.ReceiveDate, cl.CloseDate) AS FLOAT) END) AS avg_resolve_minutes
      ${API_CASE_FROM} WHERE ${f.where};
      SELECT ISNULL(cs.StatusName,'(ไม่ระบุ)') AS name, COUNT(*) AS cnt ${API_CASE_FROM} WHERE ${f.where} GROUP BY cs.StatusName ORDER BY cnt DESC;
      SELECT ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(cl.InformType,''))),''),'(ไม่ระบุ)') AS name, COUNT(*) AS cnt ${API_CASE_FROM} WHERE ${f.where}
        GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(cl.InformType,''))),''),'(ไม่ระบุ)') ORDER BY cnt DESC;
      SELECT TOP 20 ISNULL(cl.Subject,'(ไม่ระบุ)') AS name, COUNT(*) AS cnt ${API_CASE_FROM} WHERE ${f.where} GROUP BY cl.Subject ORDER BY cnt DESC;
      SELECT ISNULL(u.UserName,'(ไม่ระบุ)') AS name, COUNT(*) AS cnt ${API_CASE_FROM} WHERE ${f.where} GROUP BY u.UserName ORDER BY cnt DESC;`)).recordsets;
    const t = sets[0][0] || {};
    const kv = rows => rows.map(x => ({ name: x.name, count: x.cnt }));
    res.json({ data: {
      total: t.total || 0, open: (t.total || 0) - (t.closed || 0), closed: t.closed || 0, overdue: t.overdue || 0,
      avg_resolve_minutes: t.avg_resolve_minutes != null ? Math.round(t.avg_resolve_minutes) : null,
      by_status: kv(sets[1]), by_channel: kv(sets[2]), top_subjects: kv(sets[3]), by_agent: kv(sets[4]),
    }, meta: { from: f.from, to: f.to, generated_at: apiIso(new Date(Date.now() + 7 * 3600000)) } });
  } catch (e) { console.error('[api] summary:', e.message); apiErr(res, 500, 'server_error', 'ดึงข้อมูลไม่สำเร็จ'); }
});

// GET /api/v1/cases/{id} — เคสเดียว
app.get('/api/v1/cases/:id', apiKeyRequired('cases:read'), async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return apiErr(res, 400, 'invalid_id', 'id ต้องเป็นตัวเลข');
    if (!getExtPool()) return apiErr(res, 503, 'source_unavailable', 'เชื่อมต่อฐานข้อมูลเคสไม่ได้');
    const rows = (await extReq().input('id', sql.Int, id).query(
      `SELECT ${API_CASE_SELECT} ${API_CASE_FROM} WHERE cl.Active=1 AND cl.CalllogId=@id`)).recordset;
    if (!rows.length) return apiErr(res, 404, 'not_found', 'ไม่พบเคสนี้');
    res.locals.apiRows = 1;
    res.json({ data: (await apiShapeCases(rows))[0] });
  } catch (e) { console.error('[api] case:', e.message); apiErr(res, 500, 'server_error', 'ดึงข้อมูลไม่สำเร็จ'); }
});

// ══ เขียนเคส (scope: cases:write) — ลงตาราง Calllog แบบเดียวกับปุ่ม "เปิด Case" ในหน้าเว็บ ══
const API_CHANNELS = ['Phone', 'Line', 'Email', 'Walk-in', 'Remote'];
const API_DEFAULT_PROJECT_ID = parseInt(process.env.API_DEFAULT_PROJECT_ID) || 12;   // Easy Restaurant (Trunk)
// เวลา: รับ ISO มี timezone (2026-10-11T09:30:00+07:00) หรือไม่มี (2026-10-11 09:30 = เวลาไทย)
// → ค่า "face value" เวลาไทยแบบที่ Calllog เก็บ · undefined = ไม่ได้ส่งมา · null = รูปแบบผิด
function apiParseTime(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    return isNaN(d) ? null : new Date(d.getTime() + 7 * 3600000);
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3] || ':00'}Z`);
  return isNaN(d) ? null : d;
}
async function apiUserId(name) {
  if (!name) return null;
  const u = (await extReq().input('un', sql.NVarChar, String(name).trim()).query('SELECT TOP 1 UserId FROM Users WHERE UserName=@un')).recordset[0];
  return u ? u.UserId : null;
}
let _apiCloseStatusId = null;
async function apiCloseStatusId() {
  if (_apiCloseStatusId) return _apiCloseStatusId;
  const r = (await extReq().query(`SELECT TOP 1 StatusId FROM CallStatus WHERE StatusName LIKE '%close%' ORDER BY StatusId`)).recordset[0];
  return (_apiCloseStatusId = r?.StatusId || 4);   // "Close Job"
}
const apiCaseById = async id => {
  const rows = (await extReq().input('id', sql.Int, id).query(`SELECT ${API_CASE_SELECT} ${API_CASE_FROM} WHERE cl.Active=1 AND cl.CalllogId=@id`)).recordset;
  return rows.length ? (await apiShapeCases(rows))[0] : null;
};

// POST /api/v1/cases — เปิดเคสใหม่
app.post('/api/v1/cases', apiKeyRequired('cases:write'), async (request, res) => {
  try {
    if (!getExtPool()) return apiErr(res, 503, 'source_unavailable', 'เชื่อมต่อฐานข้อมูลเคสไม่ได้');
    const b = request.body || {};
    const rid = parseInt(b.registration_id);
    if (!rid) return apiErr(res, 400, 'invalid_registration_id', 'registration_id (รหัสร้าน) ต้องเป็นตัวเลข');
    const desc = String(b.description || '').trim();
    if (!desc) return apiErr(res, 400, 'description_required', 'ต้องส่ง description (อาการ/รายละเอียดปัญหา)');
    if (!b.subject) return apiErr(res, 400, 'subject_required', 'ต้องส่ง subject (หัวข้อเคส ตรงกับรายการหัวข้อในระบบ)');
    if (!b.agent) return apiErr(res, 400, 'agent_required', 'ต้องส่ง agent (username ผู้รับเรื่องใน Calllog)');
    const channel = b.channel ? API_CHANNELS.find(c => c.toLowerCase() === String(b.channel).trim().toLowerCase()) : 'Line';
    if (!channel) return apiErr(res, 400, 'invalid_channel', `channel ต้องเป็นหนึ่งใน ${API_CHANNELS.join(', ')}`);
    const st = String(b.status || 'pending').toLowerCase();
    if (!['pending', 'inprogress'].includes(st)) return apiErr(res, 400, 'invalid_status', 'status ตอนเปิดเคสใช้ได้แค่ pending หรือ inprogress (ปิดเคสใช้ /cases/{id}/close)');
    const receivedAt = apiParseTime(b.received_at);
    if (receivedAt === null) return apiErr(res, 400, 'invalid_received_at', 'received_at ต้องเป็น ISO 8601 เช่น 2026-10-11T09:30:00+07:00');

    const store = (await extReq().input('rid', sql.Int, rid).query(
      'SELECT TOP 1 RegistrationId FROM CustomerRegistration WHERE RegistrationId=@rid AND (Hide=0 OR Hide IS NULL)')).recordset[0];
    if (!store) return apiErr(res, 400, 'unknown_registration_id', `ไม่พบร้าน registration_id ${rid}`);
    const subj = (await extReq().input('s', sql.NVarChar, String(b.subject).trim()).query(
      'SELECT TOP 1 SubjectName, ProblemTypeId FROM Subject WHERE Active=1 AND SubjectName=@s')).recordset[0];
    if (!subj) return apiErr(res, 400, 'unknown_subject', `ไม่พบหัวข้อ "${b.subject}" ในระบบ`);
    const agentId = await apiUserId(b.agent);
    if (!agentId) return apiErr(res, 400, 'unknown_agent', `ไม่พบ username "${b.agent}" ใน Calllog`);
    const statusId = (await extReq().input('n', sql.NVarChar, st === 'pending' ? 'Pending' : 'Inprogress').query(
      'SELECT TOP 1 StatusId FROM CallStatus WHERE StatusName=@n')).recordset[0]?.StatusId || null;

    const id = (await extReq()
      .input('rid',  sql.Int, rid)
      .input('rd',   sql.DateTime, receivedAt || null)
      .input('desc', sql.NVarChar, desc.slice(0, 4000))
      .input('iname', sql.NVarChar, b.inform_name ? String(b.inform_name).slice(0, 200) : null)
      .input('itel', sql.NVarChar, b.inform_tel ? String(b.inform_tel).slice(0, 100) : null)
      .input('itype', sql.NVarChar, channel)
      .input('line', sql.NVarChar, b.line_contact ? String(b.line_contact).slice(0, 200) : null)
      .input('sid',  sql.Int, agentId)
      .input('stid', sql.Int, statusId)
      .input('pid',  sql.Int, parseInt(b.project_id) || API_DEFAULT_PROJECT_ID)
      .input('ptid', sql.Int, subj.ProblemTypeId || null)
      .input('subj', sql.NVarChar, subj.SubjectName)
      .input('sol',  sql.NVarChar, b.solution ? String(b.solution).slice(0, 4000) : null)
      .input('solvety', sql.NVarChar, ['Walk-in'].includes(channel) ? 'Walk-in' : 'Remote')
      .query(`INSERT INTO Calllog
        (RegistrationId, ReceiveDate, CloseDate, DueDate, CalllogDesc, InformName, InformTel,
         InformType, OnsiteRemark, SupportId, StatusId, ProjectId, ProblemTypeId,
         Subject, Solution, SolveType, UserId, CloseById, Active, InsertDate, UpdateDate)
        OUTPUT INSERTED.CalllogId AS id
        VALUES (@rid, ISNULL(@rd, GETDATE()), NULL, NULL, @desc, @iname, @itel,
                @itype, @line, @sid, @stid, @pid, @ptid, @subj, @sol, @solvety, @sid, NULL, 1, GETDATE(), GETDATE())`)).recordset[0].id;
    console.log(`[api] ${request.apiClient?.name}: เปิดเคส #${id}`);
    res.locals.apiRows = 1;
    res.status(201).json({ data: await apiCaseById(id) });
  } catch (e) { console.error('[api] create case:', e.message); apiErr(res, 500, 'server_error', 'เปิดเคสไม่สำเร็จ'); }
});

// POST /api/v1/cases/{id}/close — ปิดเคส (สถานะ Close Job)
app.post('/api/v1/cases/:id/close', apiKeyRequired('cases:write'), async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return apiErr(res, 400, 'invalid_id', 'id ต้องเป็นตัวเลข');
    if (!getExtPool()) return apiErr(res, 503, 'source_unavailable', 'เชื่อมต่อฐานข้อมูลเคสไม่ได้');
    const b = request.body || {};
    const cur = (await extReq().input('id', sql.Int, id).query(
      `SELECT CalllogId, StatusId, ReceiveDate, SupportId, CAST(Solution AS NVARCHAR(MAX)) AS Solution FROM Calllog WHERE Active=1 AND CalllogId=@id`)).recordset[0];
    if (!cur) return apiErr(res, 404, 'not_found', 'ไม่พบเคสนี้');
    const closeId = await apiCloseStatusId();
    if (cur.StatusId === closeId) {
      res.locals.apiRows = 1;
      return res.status(409).json({ error: { code: 'already_closed', message: 'เคสนี้ปิดไปแล้ว' }, data: await apiCaseById(id) });
    }
    const sol = String(b.solution || '').trim();
    if (!sol && !String(cur.Solution || '').trim()) return apiErr(res, 400, 'solution_required', 'ต้องส่ง solution (วิธีแก้ไข) ก่อนปิดเคส');
    const closedAt = apiParseTime(b.closed_at);
    if (closedAt === null) return apiErr(res, 400, 'invalid_closed_at', 'closed_at ต้องเป็น ISO 8601 เช่น 2026-10-11T10:15:00+07:00');
    if (closedAt && cur.ReceiveDate && closedAt < new Date(cur.ReceiveDate)) return apiErr(res, 400, 'invalid_closed_at', 'closed_at ต้องไม่ก่อนเวลารับเคส');
    let closer = cur.SupportId;
    if (b.agent) {
      closer = await apiUserId(b.agent);
      if (!closer) return apiErr(res, 400, 'unknown_agent', `ไม่พบ username "${b.agent}" ใน Calllog`);
    }
    await extReq().input('id', sql.Int, id).input('st', sql.Int, closeId).input('cd', sql.DateTime, closedAt || null)
      .input('sol', sql.NVarChar, sol ? sol.slice(0, 4000) : null).input('cb', sql.Int, closer || null).query(`
      UPDATE Calllog SET StatusId=@st, CloseDate=ISNULL(@cd, GETDATE()), DueDate=ISNULL(@cd, GETDATE()),
             Solution=ISNULL(@sol, Solution), CloseById=@cb, UpdateDate=GETDATE()
      WHERE CalllogId=@id AND Active=1`);
    console.log(`[api] ${request.apiClient?.name}: ปิดเคส #${id}`);
    res.locals.apiRows = 1;
    res.json({ data: await apiCaseById(id) });
  } catch (e) { console.error('[api] close case:', e.message); apiErr(res, 500, 'server_error', 'ปิดเคสไม่สำเร็จ'); }
});

// PATCH /api/v1/cases/{id} — แก้ไขเคส ส่งเฉพาะช่องที่จะแก้ (ปิดเคสใช้ /close)
const API_PATCH_TEXT = {   // ช่องข้อความ → คอลัมน์ใน Calllog, ความยาวสูงสุด
  description:  ['CalllogDesc', 4000], solution: ['Solution', 4000],
  inform_name:  ['InformName', 200],   inform_tel: ['InformTel', 100], line_contact: ['OnsiteRemark', 200],
};
app.patch('/api/v1/cases/:id', apiKeyRequired('cases:write'), async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return apiErr(res, 400, 'invalid_id', 'id ต้องเป็นตัวเลข');
    if (!getExtPool()) return apiErr(res, 503, 'source_unavailable', 'เชื่อมต่อฐานข้อมูลเคสไม่ได้');
    const b = request.body || {};
    const cur = (await extReq().input('id', sql.Int, id).query('SELECT CalllogId, StatusId FROM Calllog WHERE Active=1 AND CalllogId=@id')).recordset[0];
    if (!cur) return apiErr(res, 404, 'not_found', 'ไม่พบเคสนี้');

    const r = extReq().input('id', sql.Int, id), sets = [];
    for (const [k, [col, max]] of Object.entries(API_PATCH_TEXT)) {
      if (!(k in b)) continue;
      const v = b[k] === null ? '' : String(b[k]).trim();
      if (k === 'description' && !v) return apiErr(res, 400, 'description_required', 'description ห้ามว่าง');
      r.input(k, sql.NVarChar, v ? v.slice(0, max) : null);
      sets.push(`${col}=@${k}`);
    }
    if ('subject' in b) {
      const subj = (await extReq().input('s', sql.NVarChar, String(b.subject || '').trim()).query(
        'SELECT TOP 1 SubjectName, ProblemTypeId FROM Subject WHERE Active=1 AND SubjectName=@s')).recordset[0];
      if (!subj) return apiErr(res, 400, 'unknown_subject', `ไม่พบหัวข้อ "${b.subject}" ในระบบ`);
      r.input('subj', sql.NVarChar, subj.SubjectName).input('ptid', sql.Int, subj.ProblemTypeId || null);
      sets.push('Subject=@subj', 'ProblemTypeId=@ptid');
    }
    if ('agent' in b) {
      const uid = await apiUserId(b.agent);
      if (!uid) return apiErr(res, 400, 'unknown_agent', `ไม่พบ username "${b.agent}" ใน Calllog`);
      r.input('sid', sql.Int, uid);
      sets.push('SupportId=@sid');
    }
    if ('channel' in b) {
      const ch = API_CHANNELS.find(c => c.toLowerCase() === String(b.channel || '').trim().toLowerCase());
      if (!ch) return apiErr(res, 400, 'invalid_channel', `channel ต้องเป็นหนึ่งใน ${API_CHANNELS.join(', ')}`);
      r.input('itype', sql.NVarChar, ch).input('solvety', sql.NVarChar, ch === 'Walk-in' ? 'Walk-in' : 'Remote');
      sets.push('InformType=@itype', 'SolveType=@solvety');
    }
    if ('status' in b) {
      const st = String(b.status || '').toLowerCase();
      if (st === 'closed' || st === 'close') return apiErr(res, 400, 'use_close_endpoint', 'ปิดเคสใช้ POST /api/v1/cases/{id}/close');
      if (!['pending', 'inprogress'].includes(st)) return apiErr(res, 400, 'invalid_status', 'status ใช้ได้แค่ pending หรือ inprogress');
      if (cur.StatusId === await apiCloseStatusId()) return apiErr(res, 409, 'case_closed', 'เคสนี้ปิดแล้ว เปลี่ยนสถานะผ่าน API ไม่ได้');
      const sid = (await extReq().input('n', sql.NVarChar, st === 'pending' ? 'Pending' : 'Inprogress').query(
        'SELECT TOP 1 StatusId FROM CallStatus WHERE StatusName=@n')).recordset[0]?.StatusId;
      if (!sid) return apiErr(res, 500, 'server_error', 'ไม่พบสถานะในระบบ');
      r.input('stid', sql.Int, sid);
      sets.push('StatusId=@stid');
    }
    if (!sets.length) return apiErr(res, 400, 'nothing_to_update',
      `ส่งอย่างน้อย 1 ช่อง: ${[...Object.keys(API_PATCH_TEXT), 'subject', 'agent', 'channel', 'status'].join(', ')}`);
    await r.query(`UPDATE Calllog SET ${sets.join(', ')}, UpdateDate=GETDATE() WHERE CalllogId=@id AND Active=1`);
    console.log(`[api] ${request.apiClient?.name}: แก้เคส #${id} (${sets.map(s => s.split('=')[0]).join(', ')})`);
    res.locals.apiRows = 1;
    res.json({ data: await apiCaseById(id) });
  } catch (e) { console.error('[api] update case:', e.message); apiErr(res, 500, 'server_error', 'แก้ไขเคสไม่สำเร็จ'); }
});

// ── เอกสาร OpenAPI + Swagger UI ───────────────────────────
app.get('/api/v1/openapi.json', (request, res) => res.json(apiOpenApiSpec(`${request.protocol}://${request.get('host')}`)));
app.get('/api/v1/docs', (request, res) => res.type('html').send(`<!doctype html><html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>CS Team API v1</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div><script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#ui', persistAuthorization: true });</script></body></html>`));

function apiOpenApiSpec(server) {
  const day = { type: 'string', format: 'date', example: bangkokToday() };
  const filters = [
    { name: 'from', in: 'query', schema: day, description: 'วันที่เริ่ม (YYYY-MM-DD) ค่าเริ่มต้นวันนี้' },
    { name: 'to', in: 'query', schema: day, description: `วันที่สิ้นสุด ช่วงไม่เกิน ${API_MAX_RANGE_DAY} วัน` },
    { name: 'state', in: 'query', schema: { type: 'string', enum: ['open', 'closed'] }, description: 'เปิดอยู่ / ปิดแล้ว' },
    { name: 'status', in: 'query', schema: { type: 'string' }, description: 'ชื่อสถานะตรงตัว เช่น Closed' },
    { name: 'team', in: 'query', schema: { type: 'string' }, description: 'ชื่อทีม' },
    { name: 'agent', in: 'query', schema: { type: 'string' }, description: 'username ผู้รับเรื่อง' },
    { name: 'problem_type', in: 'query', schema: { type: 'string' } },
    { name: 'subject', in: 'query', schema: { type: 'string' } },
    { name: 'channel', in: 'query', schema: { type: 'string' }, description: 'ช่องทางที่แจ้ง เช่น line, phone' },
    { name: 'q', in: 'query', schema: { type: 'string' }, description: 'ค้นหาในหัวข้อ / ร้าน / รายละเอียด' },
  ];
  const err = { description: 'error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  const caseOut = d => ({ description: d, content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Case' } } } } } });
  const createSpec = { summary: 'เปิดเคสใหม่ (scope: cases:write)', requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['registration_id', 'subject', 'description', 'agent'],
      properties: {
        registration_id: { type: 'integer', description: 'รหัสร้าน (RegistrationId)', example: 12345 },
        subject: { type: 'string', description: 'หัวข้อเคส — ต้องตรงกับรายการหัวข้อในระบบ (ประเภทปัญหาจะใส่ให้ตามหัวข้อ)' },
        description: { type: 'string', description: 'อาการ / รายละเอียดปัญหา' },
        agent: { type: 'string', description: 'username ผู้รับเรื่องใน Calllog', example: 'boek' },
        solution: { type: 'string', description: 'วิธีแก้ไข (ใส่ทีหลังตอนปิดเคสก็ได้)' },
        channel: { type: 'string', enum: API_CHANNELS, default: 'Line' },
        status: { type: 'string', enum: ['pending', 'inprogress'], default: 'pending' },
        received_at: { type: 'string', format: 'date-time', description: 'เวลารับเคส ค่าเริ่มต้นตอนนี้', example: '2026-10-11T09:30:00+07:00' },
        inform_name: { type: 'string', description: 'ชื่อผู้แจ้ง' }, inform_tel: { type: 'string' }, line_contact: { type: 'string', description: 'LINE / ชื่อกลุ่มไลน์' },
        project_id: { type: 'integer', description: `โปรแกรม ค่าเริ่มต้น ${API_DEFAULT_PROJECT_ID}` },
      } } } } },
    responses: { 201: caseOut('สร้างแล้ว'), 400: err, 401: err, 403: err, 429: err } };
  const patchSpec = { summary: 'แก้ไขเคส — ส่งเฉพาะช่องที่จะแก้ (scope: cases:write)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
      description: { type: 'string' }, solution: { type: 'string' },
      subject: { type: 'string', description: 'หัวข้อในระบบ (ประเภทปัญหาเปลี่ยนตาม)' },
      agent: { type: 'string', description: 'username ผู้รับเรื่องคนใหม่' },
      channel: { type: 'string', enum: API_CHANNELS },
      status: { type: 'string', enum: ['pending', 'inprogress'], description: 'ปิดเคสใช้ /close · เคสที่ปิดแล้วเปลี่ยนสถานะไม่ได้' },
      inform_name: { type: 'string' }, inform_tel: { type: 'string' }, line_contact: { type: 'string' } } } } } },
    responses: { 200: caseOut('แก้แล้ว'), 400: err, 404: err, 409: err, 401: err, 403: err } };
  const closeSpec = { summary: 'ปิดเคส — สถานะ Close Job (scope: cases:write)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {
      solution: { type: 'string', description: 'วิธีแก้ไข — ต้องมี ถ้าเคสยังไม่เคยใส่' },
      closed_at: { type: 'string', format: 'date-time', description: 'เวลาปิด ค่าเริ่มต้นตอนนี้' },
      agent: { type: 'string', description: 'username คนปิดเคส ค่าเริ่มต้น = ผู้รับเรื่อง' } } } } } },
    responses: { 200: caseOut('ปิดแล้ว'), 400: err, 404: err, 409: { description: 'ปิดไปแล้ว (ส่ง data ของเคสกลับมาด้วย)' }, 401: err, 403: err } };
  return {
    openapi: '3.0.3',
    info: { title: 'CS Team API', version: 'v1', description:
      `ดึงข้อมูล "ติดตามเคส" (cases:read) · เปิดเคส / ปิดเคส (cases:write — ลงตาราง Calllog จริง)\n\n- ส่ง API Key ใน header \`X-API-Key\` (ขอ key จากผู้ดูแลระบบ)\n- จำกัด ${API_RATE_PER_MIN} ครั้ง/นาที ต่อ key (เกินจะได้ 429)\n- เวลาเป็นเวลาไทย (+07:00)` },
    servers: [{ url: server }],
    components: {
      securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
        Case: { type: 'object', properties: {
          id: { type: 'integer' }, opened_at: { type: 'string' }, closed_at: { type: 'string', nullable: true },
          status: { type: 'string' }, is_closed: { type: 'boolean' }, overdue: { type: 'boolean' },
          resolve_minutes: { type: 'integer', nullable: true }, target_minutes: { type: 'integer', nullable: true }, over_target: { type: 'boolean', nullable: true },
          subject: { type: 'string' }, problem_type: { type: 'string' }, problem_type_detail: { type: 'string' },
          customer: { type: 'object', properties: { registration_id: { type: 'integer' }, company: { type: 'string' }, license_group: { type: 'string', nullable: true } } },
          agent: { type: 'string' }, channel: { type: 'string', nullable: true }, description: { type: 'string' }, solution: { type: 'string' },
          stars: { type: 'integer', nullable: true }, issue_url: { type: 'string', nullable: true },
          specialist: { type: 'object', nullable: true, properties: { id: { type: 'integer' }, status: { type: 'string' } } },
          monitor_tags: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, group: { type: 'string', enum: ['problem', 'service'] }, type: { type: 'string', nullable: true } } } } } },
      },
    },
    security: [{ ApiKey: [] }],
    paths: {
      '/api/v1/health': { get: { summary: 'เช็คสถานะ API', security: [], responses: { 200: { description: 'ok' } } } },
      '/api/v1/cases': { post: createSpec, get: { summary: 'รายการเคส (scope: cases:read)', parameters: [...filters,
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: API_MAX_LIMIT } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Case' } },
          page: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, has_more: { type: 'boolean' } } },
          meta: { type: 'object' } } } } } }, 400: err, 401: err, 403: err, 429: err } } },
      '/api/v1/cases/summary': { get: { summary: 'ตัวเลขสรุป (scope: cases:read)', parameters: filters, responses: { 200: { description: 'ok' }, 400: err, 401: err, 429: err } } },
      '/api/v1/cases/{id}': { patch: patchSpec, get: { summary: 'เคสเดียว (scope: cases:read)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Case' } } } } } }, 404: err, 401: err } } },
      '/api/v1/cases/{id}/close': { post: closeSpec },
    },
  };
}

// ── จัดการ API Key — manager/admin เท่านั้น (key เปิดข้อมูลเคสทั้งระบบ จึงไม่รวม team_lead) ──
function apiAdminRequired(request, res, next) {
  if (!['manager', 'admin'].includes(request.user?.role)) return res.status(403).json({ error: 'เฉพาะผู้จัดการ/แอดมิน' });
  next();
}
app.get('/api/api-clients', authRequired, apiAdminRequired, async (request, res) => {
  try {
    const rows = (await req().query(`
      SELECT c.id, c.name, c.key_prefix, c.scopes, c.note, c.active, c.expires_at, c.created_by, c.created_at, c.last_used_at, c.request_count,
             (SELECT COUNT(*) FROM api_request_log l WHERE l.client_id=c.id AND l.created_at >= DATEADD(day,-7,GETDATE())) AS req_7d,
             (SELECT COUNT(*) FROM api_request_log l WHERE l.client_id=c.id AND l.created_at >= DATEADD(day,-7,GETDATE()) AND l.status >= 400) AS err_7d
      FROM api_clients c ORDER BY c.active DESC, c.created_at DESC`)).recordset;
    res.json({ clients: rows, scopes: API_SCOPES, rate_per_min: API_RATE_PER_MIN });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/api-clients', authRequired, apiAdminRequired, async (request, res) => {
  try {
    const b = request.body || {};
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'กรุณาตั้งชื่อระบบที่จะเชื่อม' });
    const scopes = (Array.isArray(b.scopes) ? b.scopes : API_SCOPES).filter(x => API_SCOPES.includes(x));
    if (!scopes.length) return res.status(400).json({ error: 'ต้องเลือกสิทธิ์อย่างน้อย 1 อย่าง' });
    const days = parseInt(b.expires_days);
    const key = apiNewKey();
    const row = (await req().input('n', sql.NVarChar, name).input('kp', sql.NVarChar, key.slice(0, 12))
      .input('kh', sql.Char(64), apiHash(key)).input('sc', sql.NVarChar, scopes.join(','))
      .input('nt', sql.NVarChar, String(b.note || '').trim().slice(0, 400) || null)
      .input('ex', sql.Int, days > 0 ? days : null).input('by', sql.NVarChar, request.user?.username || null)
      .query(`INSERT INTO api_clients (name, key_prefix, key_hash, scopes, note, expires_at, created_by)
              OUTPUT INSERTED.id, INSERTED.name, INSERTED.key_prefix, INSERTED.scopes, INSERTED.expires_at
              VALUES (@n, @kp, @kh, @sc, @nt, CASE WHEN @ex IS NULL THEN NULL ELSE DATEADD(day, @ex, GETDATE()) END, @by)`)).recordset[0];
    res.json({ ...row, api_key: key });   // key จริงส่งกลับครั้งเดียว
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/api-clients/:id/rotate', authRequired, apiAdminRequired, async (request, res) => {
  try {
    const key = apiNewKey();
    const out = await req().input('id', sql.Int, +request.params.id).input('kp', sql.NVarChar, key.slice(0, 12)).input('kh', sql.Char(64), apiHash(key))
      .query('UPDATE api_clients SET key_prefix=@kp, key_hash=@kh OUTPUT INSERTED.id WHERE id=@id');
    if (!out.recordset.length) return res.status(404).json({ error: 'ไม่พบ' });
    _apiKeyCache.clear();
    res.json({ id: +request.params.id, key_prefix: key.slice(0, 12), api_key: key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/api-clients/:id', authRequired, apiAdminRequired, async (request, res) => {
  try {
    const b = request.body || {};
    const sets = [], r = req().input('id', sql.Int, +request.params.id);
    if ('active' in b) { r.input('a', sql.Bit, b.active ? 1 : 0); sets.push('active=@a'); }
    if ('name' in b && String(b.name).trim()) { r.input('n', sql.NVarChar, String(b.name).trim().slice(0, 120)); sets.push('name=@n'); }
    if ('note' in b) { r.input('nt', sql.NVarChar, String(b.note || '').trim().slice(0, 400) || null); sets.push('note=@nt'); }
    if (!sets.length) return res.status(400).json({ error: 'ไม่มีอะไรให้แก้' });
    await r.query(`UPDATE api_clients SET ${sets.join(', ')} WHERE id=@id`);
    _apiKeyCache.clear();   // ยกเลิก key มีผลทันที
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function ensureMonitorTagTables() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='monitor_tags' AND xtype='U')
      CREATE TABLE monitor_tags (
        id               INT PRIMARY KEY IDENTITY,
        customer_name    NVARCHAR(200) NOT NULL,
        store_name       NVARCHAR(200) NOT NULL,
        registration_id  INT           NULL,
        subject          NVARCHAR(400) NOT NULL,
        category         NVARCHAR(200) NULL,
        title            NVARCHAR(300) NOT NULL,
        note             NVARCHAR(MAX) NULL,
        baseline_days    INT           NOT NULL DEFAULT 30,
        source_ticket_id INT           NULL,
        status           NVARCHAR(20)  NOT NULL DEFAULT 'active',
        created_by       NVARCHAR(100) NULL,
        created_at       DATETIME      DEFAULT GETDATE(),
        resolved_by      NVARCHAR(100) NULL,
        resolved_at      DATETIME      NULL,
        resolve_note     NVARCHAR(MAX) NULL
      )`);
    // scope: 'group' = นับทุกสาขาใน License Group, 'store' (หรือ NULL ของ tag เก่า) = นับสาขาเดียว
    await req().query(`
      IF COL_LENGTH('monitor_tags','scope') IS NULL ALTER TABLE monitor_tags ADD scope NVARCHAR(10) NULL;
      IF COL_LENGTH('monitor_tags','group_id') IS NULL ALTER TABLE monitor_tags ADD group_id INT NULL;
      IF COL_LENGTH('monitor_tags','check_script') IS NULL ALTER TABLE monitor_tags ADD check_script NVARCHAR(MAX) NULL;
      IF COL_LENGTH('monitor_tags','fix_script') IS NULL ALTER TABLE monitor_tags ADD fix_script NVARCHAR(MAX) NULL;
      IF COL_LENGTH('monitor_tags','scripts_updated_by') IS NULL ALTER TABLE monitor_tags ADD scripts_updated_by NVARCHAR(100) NULL;
      IF COL_LENGTH('monitor_tags','scripts_updated_at') IS NULL ALTER TABLE monitor_tags ADD scripts_updated_at DATETIME NULL;
      IF COL_LENGTH('monitor_tags','start_at') IS NULL ALTER TABLE monitor_tags ADD start_at DATETIME NULL;
      IF COL_LENGTH('monitor_tags','keywords') IS NULL ALTER TABLE monitor_tags ADD keywords NVARCHAR(1000) NULL;
      IF COL_LENGTH('monitor_tags','any_subject') IS NULL ALTER TABLE monitor_tags ADD any_subject BIT NULL;
      IF COL_LENGTH('monitor_tags','match_mode') IS NULL ALTER TABLE monitor_tags ADD match_mode NVARCHAR(10) NULL;
      IF COL_LENGTH('monitor_tags','tag_type') IS NULL ALTER TABLE monitor_tags ADD tag_type NVARCHAR(20) NULL;
      IF COL_LENGTH('monitor_tags','tag_group') IS NULL ALTER TABLE monitor_tags ADD tag_group NVARCHAR(12) NULL;`);
    await req().query(`UPDATE monitor_tags SET scope='global', group_id=NULL, registration_id=NULL,
        customer_name=N'ทุก License', store_name=N'ทุก License'
      WHERE match_mode='manual' AND ISNULL(scope,'')<>'global'`);
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='monitor_tag_files' AND xtype='U')
      CREATE TABLE monitor_tag_files (
        id            INT PRIMARY KEY IDENTITY,
        tag_id        INT           NOT NULL,
        kind          NVARCHAR(10)  NOT NULL,      -- 'check' | 'fix'
        filename      NVARCHAR(300) NOT NULL,
        original_name NVARCHAR(300) NOT NULL,
        file_size     INT           NULL,
        created_by    NVARCHAR(100) NULL,
        created_at    DATETIME      DEFAULT GETDATE()
      )`);
    // เคสที่ Support เลือกผูกเข้ากับ tag เอง — นับเสมอ แม้ไม่ตรงหัวข้อ/คำค้น
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='monitor_tag_cases' AND xtype='U')
      CREATE TABLE monitor_tag_cases (
        id          INT PRIMARY KEY IDENTITY,
        tag_id      INT           NOT NULL,
        calllog_id  INT           NOT NULL,
        linked_by   NVARCHAR(100) NULL,
        linked_at   DATETIME      DEFAULT GETDATE(),
        CONSTRAINT uq_monitor_tag_case UNIQUE (tag_id, calllog_id)
      )`);
    // AI แนะนำ Tag ให้เคสรายวัน — 1 แถวต่อ (เคส, Tag) ที่แนะนำ · tag_id NULL = ประเมินแล้วไม่ตรง Tag ไหน
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='monitor_tag_suggestions' AND xtype='U')
      CREATE TABLE monitor_tag_suggestions (
        id          INT PRIMARY KEY IDENTITY,
        calllog_id  INT           NOT NULL,
        tag_id      INT           NULL,
        case_day    DATE          NOT NULL,
        confidence  NVARCHAR(10)  NULL,
        reason      NVARCHAR(500) NULL,
        status      NVARCHAR(12)  NOT NULL DEFAULT 'pending',   -- pending | accepted | rejected | none
        tag_set     NVARCHAR(400) NULL,                          -- Tag ที่มีตอนประเมิน (มี Tag ใหม่ → ประเมินใหม่ได้)
        ai_model    NVARCHAR(60)  NULL,
        created_at  DATETIME      DEFAULT GETDATE(),
        decided_by  NVARCHAR(100) NULL,
        decided_at  DATETIME      NULL
      )`);
  } catch (e) { console.error('[monitor-tags] ensure table:', e.message); }
}

const MONITOR_BASELINE_OPTIONS = [7, 14, 30, 60, 90];
const MONITOR_STABLE_PCT = 2;   // เปลี่ยนแปลงไม่เกิน ±2% ถือว่าคงที่

// เงื่อนไขจับคู่ Calllog กับ tag — ใช้ RegistrationId ถ้ามี ไม่งั้นตกไปใช้ชื่อสาขา
// คำค้นในรายละเอียดเคส: "ปิดการขายไม่ได้, ปิดบิลไม่ได้" → ['ปิดการขายไม่ได้','ปิดบิลไม่ได้']
// หัวข้อ (Subject) เดียวกันมีหลายอาการ — คำค้นแยกอาการที่ต้องการติดตามจริง ๆ ออกมา
function monitorKeywords(v) {
  return [...new Set(String(v || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean))]
    .slice(0, 10).map(k => k.slice(0, 100));
}

// เงื่อนไขจับคู่ Calllog กับ tag: ขอบเขต (กลุ่ม/สาขา) + หัวข้อ (ยกเว้น any_subject) + คำค้นข้อใดข้อหนึ่ง
// match_mode 'manual' = Tag ที่ตั้งชื่อเอง: นับเคสที่ติด Tag + เคสที่รายละเอียดมีคำค้น (ถ้าใส่) ไม่สนหัวข้อ
// match_mode NULL/'subject' = Tag แบบเดิม: นับตามหัวข้อ (+ คำค้น)
function monitorMatch(r, tag) {
  const kws = monitorKeywords(tag.keywords);
  const manual = tag.match_mode === 'manual';
  const conds = [];
  if (manual && !kws.length) conds.push('1=0');   // ไม่มีกฎอัตโนมัติ — เหลือแต่เคสที่ติด Tag
  if (!manual && !(tag.any_subject && kws.length)) { r.input('sub', sql.NVarChar, tag.subject); conds.push('cl.Subject=@sub'); }
  if (kws.length) {
    // ใช้ ! เป็นตัว escape ของ LIKE — คำค้นที่มี % _ [ จะถูกค้นตามตัวอักษร
    kws.forEach((k, i) => r.input('kw' + i, sql.NVarChar, '%' + k.replace(/[!%_[]/g, '!$&') + '%'));
    conds.push('(' + kws.map((_, i) => `cl.CalllogDesc LIKE @kw${i} ESCAPE '!'`).join(' OR ') + ')');
  }
  const rest = conds.length ? ' AND ' + conds.join(' AND ') : '';
  // เคสที่ผูกเอง (monitor_tag_cases อยู่คนละฐานกับ Calllog) — ใส่เป็นเลข int ตรง ๆ
  const linked = (tag.linked_ids || []).map(Number).filter(Number.isInteger);
  const withLinked = w => linked.length ? `((${w}) OR cl.CalllogId IN (${linked.join(',')}))` : w;
  // Tag กลาง — ไม่จำกัดร้าน: เคสที่ติด Tag จากทุก License + คำค้น (ถ้ามี) ทุกร้าน
  if (tag.scope === 'global') return { join: '', where: withLinked(conds.join(' AND ') || '1=0') };
  if (tag.scope === 'group' && tag.group_id) {
    r.input('gid', sql.Int, tag.group_id);
    return { join: 'INNER JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId', where: withLinked('cr.GroupId=@gid' + rest) };
  }
  if (tag.registration_id) {
    r.input('rid', sql.Int, tag.registration_id);
    return { join: '', where: withLinked('cl.RegistrationId=@rid' + rest) };
  }
  r.input('store', sql.NVarChar, tag.store_name);
  return { join: 'INNER JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId', where: withLinked('cr.CompanyName=@store' + rest) };
}

async function monitorLinkedIds(tagIds) {
  if (!tagIds.length) return {};
  const rows = (await req().query(`SELECT tag_id, calllog_id FROM monitor_tag_cases
    WHERE tag_id IN (${tagIds.map(Number).filter(Number.isInteger).join(',')})`)).recordset;
  const by = {};
  rows.forEach(x => (by[x.tag_id] = by[x.tag_id] || []).push(x.calllog_id));
  return by;
}

// range = { s, e } จากตัวกรองวันที่ด้านบน (ไม่ส่งมา = 30 วันก่อนตั้ง tag → วันนี้)
// ฝั่ง "ก่อน" = s → วันตั้ง tag, ฝั่ง "หลัง" = วันตั้ง tag → e (tag ที่ปิดแล้วหยุดนับที่วันปิด)
// เวลาใน monitor_tags มาจากนาฬิกา cs_team แต่ Calllog.ReceiveDate มาจากนาฬิกา LicenseDB
// ซึ่งไม่ตรงกัน (เคยห่างกัน 1 ชม.) — ถ้าไม่ปรับ tag ที่เพิ่งตั้งจะกลายเป็น "อนาคต" ในมุม LicenseDB
// และไม่มีช่วงหลังตั้ง tag เลย จึงวัดส่วนต่างนาฬิกาไว้ (cache 10 นาที) แล้วแปลงเวลา tag ก่อน query
let _mtClockSkew = { ms: 0, at: 0 };
async function monitorClockSkew() {
  if (Date.now() - _mtClockSkew.at < 10 * 60 * 1000) return _mtClockSkew.ms;
  try {
    const [a, b] = await Promise.all([
      req().query('SELECT GETDATE() AS n'),
      extReq().query('SELECT GETDATE() AS n')
    ]);
    const ms = a.recordset[0].n - b.recordset[0].n;
    _mtClockSkew = { ms: Math.abs(ms) < 60 * 1000 ? 0 : Math.round(ms / 60000) * 60000, at: Date.now() };
    if (_mtClockSkew.ms) console.log(`[monitor-tags] cs_team clock is ${_mtClockSkew.ms / 60000} min ahead of LicenseDB — adjusting`);
  } catch (e) { console.error('[monitor-tags] clock skew:', e.message); }
  return _mtClockSkew.ms;
}
const monitorToExt = (d, skew) => d ? new Date(new Date(d).getTime() - skew) : null;
// วันเริ่ม monitor: ผู้ใช้ระบุย้อนหลังได้ (start_at) ไม่ระบุ = เวลาที่สร้าง tag
const monitorStart = tag => tag.start_at || tag.created_at;

// วันเริ่ม Monitor กลางของทุก Tag (ไม่ขึ้นกับวันที่ติด Tag) — ตั้งเป็นวันที่ตามปฏิทิน LicenseDB
// เปลี่ยนได้ด้วย env MONITOR_START_DATE=YYYY-MM-DD · ตั้งเป็นค่าว่างเพื่อกลับไปใช้วันเริ่มราย Tag
const MONITOR_START_DATE = process.env.MONITOR_START_DATE ?? '2026-09-22';
// เวลาเริ่มของ tag ในนาฬิกา LicenseDB (mssql เขียน Date เป็นเวลาผนังตามค่า UTC — เหมือนค่าที่อ่านมาจาก DB)
function monitorStartExt(tag, skew) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(MONITOR_START_DATE)) return new Date(MONITOR_START_DATE + 'T00:00:00Z');
  return monitorToExt(monitorStart(tag), skew);
}

// รับ 'YYYY-MM-DDTHH:mm' (เวลาตามนาฬิกาผนัง) — ส่งเป็นข้อความให้ SQL แปลงเอง ไม่ผ่าน timezone ของ Node
const MT_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
async function monitorCheckStart(v) {
  if (!MT_START_RE.test(v)) return 'รูปแบบวันที่เริ่มไม่ถูกต้อง';
  const r = (await req().input('st', sql.NVarChar, v + ':00').query(`
    SELECT CASE WHEN TRY_CONVERT(datetime, @st, 126) IS NULL THEN 'bad'
                WHEN TRY_CONVERT(datetime, @st, 126) > DATEADD(minute, 5, GETDATE()) THEN 'future'
                WHEN TRY_CONVERT(datetime, @st, 126) < DATEADD(day, -365, GETDATE()) THEN 'old'
                ELSE 'ok' END AS v`)).recordset[0].v;
  return { bad: 'วันที่เริ่มไม่ถูกต้อง', future: 'วันที่เริ่มต้องไม่เกินเวลาปัจจุบัน', old: 'ย้อนหลังได้ไม่เกิน 365 วัน' }[r] || null;
}

async function monitorTagStats(tag, range) {
  const skew = await monitorClockSkew();
  const r = extReq()
    .input('c',  sql.DateTime, monitorStartExt(tag, skew))
    .input('en', sql.DateTime, tag.status === 'resolved' ? monitorToExt(tag.resolved_at, skew) : null)
    .input('bd', sql.Int, tag.baseline_days)
    .input('fs', sql.DateTime, range?.s || null)
    .input('fe', sql.DateTime, range?.e || null);
  const m = monitorMatch(r, tag);
  const out = await r.query(`
    DECLARE @s DATETIME = ISNULL(@fs, DATEADD(day, -@bd, @c));
    DECLARE @e DATETIME = ISNULL(@fe, GETDATE());
    IF @e > GETDATE() SET @e = GETDATE();
    IF @en IS NOT NULL AND @e > @en SET @e = @en;
    SELECT CONVERT(char(10), @s, 23) AS from_day, CONVERT(char(10), @c, 23) AS tag_day,
           CONVERT(char(10), @e, 23) AS end_day,
           CASE WHEN @c > @s THEN DATEDIFF(minute, @s, CASE WHEN @c < @e THEN @c ELSE @e END) ELSE 0 END AS pre_mins,
           CASE WHEN @e > @c THEN DATEDIFF(minute, CASE WHEN @c > @s THEN @c ELSE @s END, @e) ELSE 0 END AS post_mins,
           DATEDIFF(minute, @c, GETDATE()) AS age_mins;
    SELECT CONVERT(char(10), cl.ReceiveDate, 23) AS d,
           SUM(CASE WHEN cl.ReceiveDate <  @c THEN 1 ELSE 0 END) AS pre,
           SUM(CASE WHEN cl.ReceiveDate >= @c THEN 1 ELSE 0 END) AS post
    FROM Calllog cl ${m.join}
    WHERE cl.Active=1 AND ${m.where}
      AND cl.ReceiveDate >= @s AND cl.ReceiveDate <= @e
    GROUP BY CONVERT(char(10), cl.ReceiveDate, 23)`);
  const meta = out.recordsets[0][0];

  let pre = 0, post = 0;
  const byDay = {};
  for (const d of out.recordsets[1]) { pre += d.pre; post += d.post; byDay[d.d] = d.pre + d.post; }

  // ตัวเลขรายวันตลอดช่วง — วันที่ตั้ง tag นับเป็นฝั่ง "หลัง"
  const tagT = Date.parse(meta.tag_day + 'T00:00:00Z');
  const daily = [];
  for (let t = Date.parse(meta.from_day + 'T00:00:00Z'), end = Date.parse(meta.end_day + 'T00:00:00Z');
       t <= end && daily.length < 400; t += 86400000) {
    const k = new Date(t).toISOString().slice(0, 10);
    daily.push({ d: k, n: byDay[k] || 0, phase: t < tagT ? 'pre' : 'post' });
  }
  // ช่วงที่ไม่ครบวัน (วันตั้ง tag / วันนี้) ปัดขึ้นเป็น 1 วัน — อย่าให้ค่าเฉลี่ยพุ่ง
  const preDays  = meta.pre_mins  > 0 ? Math.max(1, meta.pre_mins / 1440) : 0;
  const postDays = meta.post_mins > 0 ? Math.max(1, meta.post_mins / 1440) : 0;
  const preAvg  = preDays  ? pre / preDays   : null;
  const postAvg = postDays ? post / postDays : null;
  let pct = null, trend = null;
  // หลังตั้ง tag ยังไม่ถึง 1 วัน — ตัวเลขยังไม่มีความหมาย (0 เคสใน 15 นาที ≠ ลดลง 100%)
  const early = meta.post_mins > 0 && meta.post_mins < 1440;
  const noBaseline = tag.match_mode === 'manual' && !monitorKeywords(tag.keywords).length && pre === 0;
  if (preAvg !== null && postAvg !== null && !early && !noBaseline) {
    if (preAvg > 0) {
      pct = (postAvg - preAvg) / preAvg * 100;
      trend = Math.abs(pct) <= MONITOR_STABLE_PCT ? 'stable' : pct < 0 ? 'improved' : 'worsened';
    } else {
      trend = post > 0 ? 'worsened' : 'stable';    // ก่อนหน้าไม่มีเคสเลย: มีเคสใหม่ = แย่ลง
    }
  }
  return {
    from_day: meta.from_day, tag_day: meta.tag_day, end_day: meta.end_day,
    pre_count: pre, post_count: post,
    pre_days: +preDays.toFixed(2), post_days: +postDays.toFixed(2),
    pre_avg: preAvg === null ? null : +preAvg.toFixed(3),
    post_avg: postAvg === null ? null : +postAvg.toFixed(3),
    pct_change: pct === null ? null : +pct.toFixed(1),
    trend,                                    // null = ยังเทียบไม่ได้ (ไม่มีช่วงก่อน/หลัง หรือ early)
    early,
    no_baseline: noBaseline,   // Tag ตั้งชื่อเอง ยังไม่มีเคสก่อนติด Tag ให้เทียบ
    days_monitored: Math.floor(Math.max(0, meta.age_mins) / 1440),
    daily
  };
}

// GET /api/monitor-tags?status=active|resolved|all
app.get('/api/monitor-tags', authRequired, async (request, res) => {
  try {
    const status = ['active', 'resolved', 'all'].includes(request.query.status) ? request.query.status : 'active';
    const r = req();
    let where = '';
    if (status !== 'all') { where = 'WHERE status=@st'; r.input('st', sql.NVarChar, status); }
    const tags = (await r.query(`SELECT * FROM monitor_tags ${where} ORDER BY customer_name, store_name, created_at DESC`)).recordset;
    if (tags.length) {
      const files = (await req().query(`
        SELECT id, tag_id, kind, original_name, file_size, created_by, created_at FROM monitor_tag_files
        WHERE tag_id IN (${tags.map(t => +t.id).join(',')}) ORDER BY created_at`)).recordset;
      const linked = await monitorLinkedIds(tags.map(t => t.id));
      tags.forEach(t => { t.files = files.filter(f => f.tag_id === t.id); t.linked_ids = linked[t.id] || []; });
    }
    // lite=1 — แค่รายชื่อ tag (ไว้ติดป้ายในรายการงาน) ไม่ต้องคำนวณสถิติจาก Calllog
    const monitor_start = MONITOR_START_DATE || null;
    if (request.query.lite === '1') return res.json({ tags, monitor_start });
    if (!getExtPool()) return res.json({ tags: tags.map(t => ({ ...t, stats: null })), ext: false, monitor_start });
    // ช่วงวันที่จากตัวกรองด้านบน (ไม่บังคับ)
    const { dateFrom, dateTo } = request.query;
    const range = dateFrom && dateTo
      ? { s: new Date(dateFrom), e: new Date(new Date(dateTo).setHours(23, 59, 59, 999)) } : null;
    // Tag กลุ่ม IT Service ไม่ได้ดูก่อน/หลัง — ดูที่ /board แทน ไม่ต้องคำนวณ
    const stats = await Promise.all(tags.map(t => t.tag_group === 'service' ? null
      : monitorTagStats(t, range).catch(e => ({ error: e.message }))));
    res.json({ tags: tags.map((t, i) => ({ ...t, stats: stats[i] })), ext: true, generated_at: new Date(), monitor_start });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/monitor-tags/:id/tickets — drill-down: เคสที่เข้าเงื่อนไข ทั้งช่วง baseline และหลังตั้ง tag
app.get('/api/monitor-tags/:id/tickets', authRequired, async (request, res) => {
  try {
    const tag = (await req().input('id', sql.Int, +request.params.id)
      .query('SELECT * FROM monitor_tags WHERE id=@id')).recordset[0];
    if (!tag) return res.status(404).json({ error: 'ไม่พบ Monitor Tag' });
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    tag.linked_ids = (await monitorLinkedIds([tag.id]))[tag.id] || [];
    const skew = await monitorClockSkew();
    const days = MT_SERVICE_DAYS.includes(+request.query.days) ? +request.query.days : null;
    const r = extReq()
      .input('c',  sql.DateTime, monitorStartExt(tag, skew))
      .input('en', sql.DateTime, tag.status === 'resolved' ? monitorToExt(tag.resolved_at, skew) : null)
      .input('bd', sql.Int, tag.baseline_days)
      .input('days', sql.Int, days);
    const m = monitorMatch(r, tag);
    // ?store= — drill-down จากตารางร้านในหน้า Monitor Tag
    const store = String(request.query.store || '').trim();
    let storeCond = '';
    if (store) {
      r.input('fstore', sql.NVarChar, store);
      storeCond = ' AND EXISTS (SELECT 1 FROM CustomerRegistration fx WHERE fx.RegistrationId = cl.RegistrationId AND fx.CompanyName = @fstore)';
    }
    // ?brand= — ทุกสาขาของแบรนด์ (License Group ที่ไม่ใช่ INF Group)
    const brand = String(request.query.brand || '').trim();
    if (brand) {
      r.input('fbrand', sql.NVarChar, brand);
      storeCond += ` AND EXISTS (SELECT 1 FROM CustomerRegistration fx JOIN CustomerGroup fg ON fg.GroupId = fx.GroupId
        WHERE fx.RegistrationId = cl.RegistrationId AND fx.GroupId <> 1 AND fg.GroupName = @fbrand)`;
    }
    const rows = (await r.query(`
      DECLARE @e DATETIME = ISNULL(@en, GETDATE());
      SELECT TOP 1000
        cl.CalllogId AS id, cl.RegistrationId AS rid, cl.ReceiveDate AS opened_at, cl.CloseDate AS closed_at,
        CASE WHEN cl.ReceiveDate >= @c THEN 'post' ELSE 'pre' END AS phase,
        cs.StatusName AS status, u.UserName AS agent,
        LEFT(cl.CalllogDesc, 400) AS description, LEFT(cl.Solution, 600) AS solution,
        (SELECT TOP 1 x.CompanyName FROM CustomerRegistration x WHERE x.RegistrationId = cl.RegistrationId) AS company
      FROM Calllog cl ${m.join}
      LEFT JOIN CallStatus cs ON cs.StatusId = cl.StatusId
      LEFT JOIN Users      u  ON u.UserId    = cl.SupportId
      WHERE cl.Active=1 AND ${m.where}${storeCond}
        AND cl.ReceiveDate >= CASE WHEN @days IS NULL THEN DATEADD(day, -@bd, @c)
                                   ELSE DATEADD(day, 1 - @days, CAST(GETDATE() AS DATE)) END
        AND cl.ReceiveDate <= @e
      ORDER BY cl.ReceiveDate DESC`)).recordset;
    const ls = new Set(tag.linked_ids);
    rows.forEach(x => { x.linked = ls.has(x.id); });
    if (request.query.ai === '1') {
      const inst = await aiInstalledMap();
      return res.json({ tag, rows: rows.filter(x => inst.has(x.rid)) });
    }
    res.json({ tag, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ หน้า Monitor Tag: เคสที่ติด Tag (Bug โปรแกรม / IT Service) ตามช่วงวัน ══
// ช่วงปัจจุบัน = N วันล่าสุด (รวมวันนี้ ตามปฏิทิน LicenseDB) · ช่วงก่อนหน้า = N วันก่อนนั้น ไว้เทียบ
const MT_SERVICE_DAYS = [7, 30, 90, 180, 365];
// วันแรกที่มีข้อมูล = วันแรกที่ติด Tag ได้อย่างน้อย MT_DATA_MIN_PER_DAY เคส — ช่วงที่เลือกจะไม่ย้อนก่อนวันนั้น
// (เคสเก่าที่คนผูกไว้ประปรายก่อน AI จัดย้อนหลัง ไม่นับเป็นวันเริ่ม ไม่งั้นวันก่อนหน้าเป็นศูนย์ เส้นแนวโน้มเพี้ยน)
// บังคับเองได้ด้วย MONITOR_DATA_START=YYYY-MM-DD
const MT_DATA_START_ENV = /^\d{4}-\d{2}-\d{2}$/.test(process.env.MONITOR_DATA_START || '') ? process.env.MONITOR_DATA_START : null;
let _mtDataStart = { at: 0, d: null };
const MT_DATA_MIN_PER_DAY = 10;
async function mtDataStart(ids) {
  if (MT_DATA_START_ENV) return MT_DATA_START_ENV;
  if (_mtDataStart.d && Date.now() - _mtDataStart.at < 10 * 60 * 1000) return _mtDataStart.d;
  const perDay = new Map();
  for (let i = 0; i < ids.length; i += 2000) {
    (await extReq().query(`SELECT CONVERT(char(10), ReceiveDate, 23) AS d, COUNT(*) AS n FROM Calllog
      WHERE Active=1 AND CalllogId IN (${ids.slice(i, i + 2000).join(',')}) GROUP BY CONVERT(char(10), ReceiveDate, 23)`))
      .recordset.forEach(r => perDay.set(r.d, (perDay.get(r.d) || 0) + r.n));
  }
  const days = [...perDay.keys()].sort();
  const d = days.find(x => perDay.get(x) >= MT_DATA_MIN_PER_DAY) || days[0] || null;
  _mtDataStart = { at: Date.now(), d };
  return d;
}
app.get('/api/monitor-tags/board', authRequired, async (request, res) => {
  try {
    const days = MT_SERVICE_DAYS.includes(+request.query.days) ? +request.query.days : 30;
    const tags = (await req().query(`SELECT id, tag_group FROM monitor_tags WHERE status='active'`)).recordset;
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    // ?ai=1 — เฉพาะร้านที่ติดตั้ง AI (รายชื่อเดียวกับแท็บผลการติดตั้ง AI)
    const aiRids = request.query.ai === '1' ? [...(await aiInstalledMap()).keys()].map(Number).filter(Number.isInteger) : null;
    const aiSet = aiRids ? new Set(aiRids) : null;
    const today = (await extReq().query(`SELECT CONVERT(char(10), GETDATE(), 23) AS d`)).recordset[0].d;
    const dayStr = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
    const links = tags.length ? (await req().query(`SELECT tag_id, calllog_id FROM monitor_tag_cases
      WHERE tag_id IN (${tags.map(t => +t.id).join(',')})`)).recordset : [];
    const ids = [...new Set(links.map(l => +l.calllog_id).filter(Number.isInteger))];
    const dataStart = (await mtDataStart(ids)) || today;
    const labels = []; for (let i = days - 1; i >= 0; i--) if (dayStr(i) >= dataStart) labels.push(dayStr(i));
    if (!labels.length) labels.push(today);
    const from = labels[0], prevFrom = dayStr(days * 2 - 1);
    const prevOk = dayStr(days * 2 - 1) >= dataStart;   // ช่วงก่อนหน้ามีข้อมูลครบ — เทียบได้
    const idx = new Map(labels.map((d, i) => [d, i]));
    const info = new Map();
    for (let i = 0; i < ids.length; i += 2000) {
      (await extReq().input('pf', sql.NVarChar, prevFrom).query(`
        SELECT cl.CalllogId AS id, CONVERT(char(10), cl.ReceiveDate, 23) AS d, cl.ReceiveDate AS at,
               cl.RegistrationId AS rid, xr.CompanyName AS company,
               CASE WHEN xr.GroupId IS NOT NULL AND xr.GroupId <> 1 THEN xg.GroupName END AS grp
        FROM Calllog cl
        LEFT JOIN CustomerRegistration xr ON xr.RegistrationId = cl.RegistrationId
        LEFT JOIN CustomerGroup        xg ON xg.GroupId        = xr.GroupId
        WHERE cl.Active=1 AND cl.CalllogId IN (${ids.slice(i, i + 2000).join(',')}) AND cl.ReceiveDate >= CAST(@pf AS DATE)`))
        .recordset.forEach(r => { if (!aiSet || aiSet.has(r.rid)) info.set(r.id, r); });
    }
    // เคสทั้งหมดต่อวัน (ไว้ดูสัดส่วนที่ติด Tag)
    const all = new Array(labels.length).fill(0);
    if (!aiSet || aiRids.length) (await extReq().input('f', sql.NVarChar, from).query(`
      SELECT CONVERT(char(10), ReceiveDate, 23) AS d, COUNT(*) AS n FROM Calllog
      WHERE Active=1 AND ReceiveDate >= CAST(@f AS DATE)${aiSet ? ` AND RegistrationId IN (${aiRids.join(',')})` : ''}
      GROUP BY CONVERT(char(10), ReceiveDate, 23)`))
      .recordset.forEach(r => { if (idx.has(r.d)) all[idx.get(r.d)] = r.n; });

    const T = new Map(tags.map(t => [t.id, { id: t.id, cur: 0, prev: 0, daily: new Array(labels.length).fill(0), stores: new Set(), last_at: null }]));
    const stores = new Map(), tagged = new Set();
    for (const l of links) {
      const c = info.get(+l.calllog_id), t = T.get(l.tag_id);
      if (!c || !t) continue;
      if (c.d < from) { t.prev++; continue; }
      if (!idx.has(c.d)) continue;
      t.cur++; t.daily[idx.get(c.d)]++;
      tagged.add(c.id);
      const k = c.rid ? 'r' + c.rid : 'c' + (c.company || '');
      t.stores.add(k);
      if (!t.last_at || c.at > t.last_at) t.last_at = c.at;
      const st = stores.get(k) || { rid: c.rid || null, company: c.company || '(ไม่ระบุร้าน)', grp: c.grp || null, by: {}, td: {}, last_at: null };
      st.by[t.id] = (st.by[t.id] || 0) + 1;
      if (c.d === today) st.td[t.id] = (st.td[t.id] || 0) + 1;   // วันนี้ยังไม่ครบวัน — หน้าเว็บไม่นับในค่าเฉลี่ย
      if (!st.last_at || c.at > st.last_at) st.last_at = c.at;
      stores.set(k, st);
    }
    res.json({
      days, from, to: today, labels, all, tagged: tagged.size, prev_ok: prevOk, data_start: dataStart, ai_only: !!aiSet, ai_stores: aiRids?.length ?? null,
      tags: [...T.values()].map(t => ({ ...t, stores: t.stores.size })),
      stores: [...stores.values()]
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ ผลการติดตั้ง AI: ปัญหาลดลงไหมหลังติดตั้ง ══════════════════
// ร้านที่ติดตั้ง = ร้านที่มีเคสคำว่า SSH / Dataslot / Tunnel / ติดตั้ง ai (น้องลง log ตอนติดตั้ง) ตั้งแต่ AI_INSTALL_SINCE
// ห้ามใช้ "ai" เดี่ยวๆ — ไปตรงกับ training, email, AIS ฯลฯ
// วัดผล: ต่อร้าน เทียบ N วันก่อนวันติดตั้ง กับหลังวันติดตั้งถึงเมื่อวาน (ไม่นับวันติดตั้งและวันนี้)
// แสดงเฉพาะร้านที่ติดตั้ง — แยกเป็นเส้นตาม Tag ของเคส
const AI_INSTALL_KEYWORDS = (process.env.AI_INSTALL_KEYWORDS || 'ssh,dataslot,tunnel,ติดตั้ง ai,ติดตั้งai,ติดตั้งโปรแกรม ai,ติดตั้งโปรแกรมai')
  .split(',').map(k => k.trim()).filter(Boolean).slice(0, 10);
const AI_INSTALL_SINCE = /^\d{4}-\d{2}-\d{2}$/.test(process.env.AI_INSTALL_SINCE || '') ? process.env.AI_INSTALL_SINCE : '2026-06-01';
const AI_PRE_DAYS = [14, 30, 60];

// ร้านที่ติดตั้ง AI = เฉพาะร้านที่ Support ยืนยันแล้ว (ai_impact_manual: เพิ่มเอง / นำเข้า / กดยืนยันจากเคส)
// เคสที่มีคำค้น (ติดตั้ง ai / SSH ฯลฯ) ไม่นับเองอัตโนมัติ — ขึ้นเป็น "รอยืนยัน" ให้คนกดยืนยันก่อน
async function aiImpactAutoDetect() { return false; }
async function ensureAiImpactTables() {
  try {
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_impact_excludes' AND xtype='U')
      CREATE TABLE ai_impact_excludes (
        rid         INT           PRIMARY KEY,   -- RegistrationId ที่ไม่ใช่ร้านติดตั้ง AI (คำค้นจับผิด)
        created_by  NVARCHAR(100) NULL,
        created_at  DATETIME      DEFAULT GETDATE()
      )`);
    // ร้านที่เพิ่มเอง (ไม่มีเคสคำค้น หรือแก้วันติดตั้ง) — มีแถวนี้ = ใช้วันติดตั้งนี้แทนที่ระบบหาเจอ
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_impact_manual' AND xtype='U')
      CREATE TABLE ai_impact_manual (
        rid         INT           PRIMARY KEY,
        install_day DATE          NOT NULL,
        note        NVARCHAR(300) NULL,
        created_by  NVARCHAR(100) NULL,
        created_at  DATETIME      DEFAULT GETDATE()
      )`);
    await req().query(`
      IF COL_LENGTH('ai_impact_manual','case_id') IS NULL ALTER TABLE ai_impact_manual ADD case_id INT NULL;
      IF COL_LENGTH('ai_impact_manual','installer') IS NULL ALTER TABLE ai_impact_manual ADD installer NVARCHAR(100) NULL;`);
    // เคสคำค้นที่กด "ไม่ใช่การติดตั้ง" — ไม่ขึ้นในรายการรอยืนยันอีก
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_impact_rejects' AND xtype='U')
      CREATE TABLE ai_impact_rejects (
        cid         INT           PRIMARY KEY,
        created_by  NVARCHAR(100) NULL,
        created_at  DATETIME      DEFAULT GETDATE()
      )`);
    // ค่าตั้งค่าของแท็บ
    await req().query(`
      IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ai_impact_settings' AND xtype='U')
      CREATE TABLE ai_impact_settings (
        k           NVARCHAR(50)  PRIMARY KEY,
        v           NVARCHAR(200) NULL,
        updated_by  NVARCHAR(100) NULL,
        updated_at  DATETIME      DEFAULT GETDATE()
      )`);
  } catch (e) { console.error('[ai-impact] ensure table:', e.message); }
}

// ── ร้านที่ติดตั้ง AI แล้ว (ชุดเดียวกับแท็บผลการติดตั้ง) — rid → { d: วันติดตั้ง, src: 'case'|'manual', cid }
// ใช้ที่หน้าเปิด Case (ป้าย "ติดตั้ง AI แล้ว") และรายงานตามพนักงาน · cache 1 นาที ล้างทุกครั้งที่มีการแก้รายการ
let _aiInstCache = { at: 0, map: null };
app.use('/api/ai-impact', (request, res, next) => { if (request.method !== 'GET') _aiInstCache.at = 0; next(); });
async function aiInstalledMap() {
  if (_aiInstCache.map && Date.now() - _aiInstCache.at < 60 * 1000) return _aiInstCache.map;
  const map = new Map();
  if (getExtPool() && await aiImpactAutoDetect()) {
    const r = extReq().input('since', sql.NVarChar, AI_INSTALL_SINCE);
    AI_INSTALL_KEYWORDS.forEach((k, i) => r.input('k' + i, sql.NVarChar, '%' + k.replace(/[!%_[]/g, '!$&') + '%'));
    const txt = `(CAST(cl.CalllogDesc AS NVARCHAR(MAX)) + N' ' + ISNULL(CAST(cl.Solution AS NVARCHAR(MAX)), N'') + N' ' + ISNULL(cl.Subject, N''))`;
    (await r.query(`SELECT cl.RegistrationId AS rid, CONVERT(char(10), MIN(cl.ReceiveDate), 23) AS d, MIN(cl.CalllogId) AS cid
      FROM Calllog cl WHERE cl.Active=1 AND cl.RegistrationId IS NOT NULL AND cl.ReceiveDate >= CAST(@since AS DATE)
        AND (${AI_INSTALL_KEYWORDS.map((_, i) => `${txt} LIKE @k${i} ESCAPE '!'`).join(' OR ')})
      GROUP BY cl.RegistrationId`)).recordset.forEach(x => map.set(x.rid, { d: x.d, src: 'case', cid: x.cid }));
  }
  (await req().query(`SELECT rid, CONVERT(char(10), install_day, 23) AS d FROM ai_impact_manual`)).recordset
    .forEach(x => map.set(x.rid, { d: x.d, src: 'manual', cid: map.get(x.rid)?.cid || null }));
  (await req().query('SELECT rid FROM ai_impact_excludes')).recordset.forEach(x => map.delete(x.rid));
  _aiInstCache = { at: Date.now(), map };
  return map;
}

// GET /api/ai-impact/installed — { rid: วันติดตั้ง } ทั้งหมด (ไว้ติดป้ายตอนค้นหาร้าน)
app.get('/api/ai-impact/installed', authRequired, async (request, res) => {
  try {
    const map = await aiInstalledMap();
    res.json({ stores: Object.fromEntries([...map].map(([rid, v]) => [rid, v.d])) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// รายงานตามพนักงานเริ่มนับวันนี้ — ก่อนหน้านี้ยังไม่มีขั้นตอนให้น้องติดตั้งตอนรับเคส (ตั้งเองได้ด้วย AI_REPORT_START)
const AI_REPORT_START = /^\d{4}-\d{2}-\d{2}$/.test(process.env.AI_REPORT_START || '') ? process.env.AI_REPORT_START : '2026-10-06';
// เป้าติดตั้ง AI คนละกี่ร้านต่อวัน — หน้าเว็บนับร้านที่น้องรับเคสในวันเดียวกับที่ร้านติดตั้ง
const AI_INSTALL_TARGET = Math.max(1, +process.env.AI_INSTALL_TARGET || 10);
// GET /api/ai-impact/agent-report?from=&to= — แต่ละวัน น้องแต่ละคนรับเคสของร้านกี่ร้าน แยกตามสถานะติดตั้ง AI ของร้าน ณ วันนั้น
//   installed = ติดตั้งก่อนวันที่รับเคส · today = ติดตั้งในวันเดียวกับที่รับเคส · missing = ยังไม่ได้ติดตั้ง (ณ วันนั้น)
app.get('/api/ai-impact/agent-report', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const today = bangkokToday();
    const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
    let from = day(request.query.from) || today, to = day(request.query.to) || from;
    if (from > to) [from, to] = [to, from];
    if (from < AI_REPORT_START) from = AI_REPORT_START;
    if (to < from) return res.json({ from, to, start: AI_REPORT_START, target: AI_INSTALL_TARGET, installs: {}, added: {}, total_installed: 0, rows: [], reported: [] });
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) return res.status(400).json({ error: 'เลือกได้ไม่เกิน 62 วัน' });
    const inst = await aiInstalledMap();
    const rows = (await extReq().input('f', sql.NVarChar, from).input('t', sql.NVarChar, to).query(`
      SELECT CONVERT(char(10), cl.ReceiveDate, 23) AS d, cl.RegistrationId AS rid, u.UserName AS agent,
             cr.CompanyName AS company, CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cg.GroupName END AS grp,
             COUNT(*) AS cases, MIN(cl.CalllogId) AS cid
      FROM Calllog cl
      LEFT JOIN Users                u  ON u.UserId          = cl.SupportId
      LEFT JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
      LEFT JOIN CustomerGroup        cg ON cg.GroupId        = cr.GroupId
      WHERE cl.Active=1 AND cl.RegistrationId IS NOT NULL
        AND cl.ReceiveDate >= CAST(@f AS DATE) AND cl.ReceiveDate < DATEADD(day, 1, CAST(@t AS DATE))
      GROUP BY CONVERT(char(10), cl.ReceiveDate, 23), cl.RegistrationId, u.UserName, cr.CompanyName,
               CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cg.GroupName END`)).recordset;
    const out = rows.map(x => {
      const i = inst.get(x.rid);
      const status = !i || i.d > x.d ? 'missing' : i.d === x.d ? 'today' : 'installed';
      return { d: x.d, agent: x.agent || '(ไม่ระบุ)', rid: x.rid, company: x.company, grp: x.grp, cases: x.cases, cid: x.cid,
        status, install_day: i?.d || null };
    });
    const installs = {};   // วัน → จำนวนร้านที่ติดตั้งวันนั้น (ทุกแหล่ง)
    for (const v of inst.values()) if (v.d >= from && v.d <= to) installs[v.d] = (installs[v.d] || 0) + 1;

    // ── การแจ้งติดตั้งจริง (ใช้นับ "ลงไปแล้ว" ของแต่ละคน)
    //    1) เคสติดตั้งที่ยืนยันแล้ว (กด "ยืนยันติดตั้งจริง" จากรายการรอยืนยัน) → คนที่ลงเคส
    //    2) ร้านที่น้องกด "เพิ่มร้านที่ติดตั้ง" เอง → คนที่กด เฉพาะเมื่อคนนั้นรับเคสของร้านนั้นในวันนั้นด้วย
    //       (หัวหน้ากดเพิ่มแทนไม่นับเป็นของหัวหน้า) · ร้านที่นำเข้าจากไฟล์ไม่นับให้ใคร
    const reported = new Map();   // `${d}|${agent}|${rid}` → แถว
    const excluded = new Set((await req().query('SELECT rid FROM ai_impact_excludes')).recordset.map(x => x.rid));
    if (await aiImpactAutoDetect()) {
      const r = extReq().input('f', sql.NVarChar, from).input('t', sql.NVarChar, to);
      AI_INSTALL_KEYWORDS.forEach((k, i) => r.input('k' + i, sql.NVarChar, '%' + k.replace(/[!%_[]/g, '!$&') + '%'));
      const txt = `(CAST(cl.CalllogDesc AS NVARCHAR(MAX)) + N' ' + ISNULL(CAST(cl.Solution AS NVARCHAR(MAX)), N'') + N' ' + ISNULL(cl.Subject, N''))`;
      (await r.query(`
        SELECT CONVERT(char(10), cl.ReceiveDate, 23) AS d, cl.RegistrationId AS rid, u.UserName AS agent, cl.CalllogId AS cid,
               cr.CompanyName AS company, CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cg.GroupName END AS grp
        FROM Calllog cl
        LEFT JOIN Users                u  ON u.UserId          = cl.SupportId
        LEFT JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
        LEFT JOIN CustomerGroup        cg ON cg.GroupId        = cr.GroupId
        WHERE cl.Active=1 AND cl.RegistrationId IS NOT NULL
          AND cl.ReceiveDate >= CAST(@f AS DATE) AND cl.ReceiveDate < DATEADD(day, 1, CAST(@t AS DATE))
          AND (${AI_INSTALL_KEYWORDS.map((_, i) => `${txt} LIKE @k${i} ESCAPE '!'`).join(' OR ')})
        ORDER BY cl.CalllogId`)).recordset.forEach(x => {
          if (excluded.has(x.rid)) return;
          const key = `${x.d}|${x.agent || '(ไม่ระบุ)'}|${x.rid}`;
          if (!reported.has(key)) reported.set(key, { d: x.d, agent: x.agent || '(ไม่ระบุ)', rid: x.rid, company: x.company, grp: x.grp, src: 'case', cid: x.cid });
        });
    }
    const manAll = (await req().input('f', sql.NVarChar, from).input('t', sql.NVarChar, to).query(`
      SELECT m.rid, CONVERT(char(10), m.install_day, 23) AS d, m.created_by, m.case_id, m.installer, au.ext_username
      FROM ai_impact_manual m LEFT JOIN app_users au ON au.username = m.created_by
      WHERE m.install_day BETWEEN CAST(@f AS DATE) AND CAST(@t AS DATE) AND ISNULL(m.created_by, '') NOT LIKE 'import:%'`)).recordset
      .filter(x => !excluded.has(x.rid));
    // ติดตั้งใหม่รายวัน = ร้านที่กด "เพิ่มร้านที่ติดตั้ง" / ยืนยันจากรายการรอยืนยัน (ไม่นับที่นำเข้าจากไฟล์)
    const added = {};
    manAll.forEach(x => { added[x.d] = (added[x.d] || 0) + 1; });
    const confirmedCase = manAll.filter(x => x.case_id && x.installer);
    const man = manAll.filter(x => !(x.case_id && x.installer) && x.ext_username);
    // ชื่อพนักงานในเคส (ตัวพิมพ์ตาม Calllog) ของคนที่รับเคสร้านนั้นในวันนั้น
    const handled = new Map(out.map(x => [`${x.d}|${String(x.agent).toLowerCase()}|${x.rid}`, x.agent]));
    const nameOf = new Map(out.map(x => [x.rid, x]));
    for (const x of confirmedCase) {
      const key = `${x.d}|${x.installer}|${x.rid}`;
      if (!reported.has(key)) reported.set(key, { d: x.d, agent: x.installer, rid: x.rid, company: nameOf.get(x.rid)?.company || `#${x.rid}`,
        grp: nameOf.get(x.rid)?.grp || null, src: 'case', cid: x.case_id });
    }
    if (man.length) {
      const info = new Map((await extReq().query(`
        SELECT cr.RegistrationId AS rid, cr.CompanyName AS company, CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cg.GroupName END AS grp
        FROM CustomerRegistration cr LEFT JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
        WHERE cr.RegistrationId IN (${[...new Set(man.map(x => +x.rid))].join(',')})`)).recordset.map(x => [x.rid, x]));
      for (const x of man) {
        const agent = handled.get(`${x.d}|${String(x.ext_username).toLowerCase()}|${x.rid}`);
        if (!agent) continue;
        const key = `${x.d}|${agent}|${x.rid}`;
        if (!reported.has(key)) reported.set(key, { d: x.d, agent, rid: x.rid, company: info.get(x.rid)?.company || `#${x.rid}`,
          grp: info.get(x.rid)?.grp || null, src: 'manual', cid: null });
      }
    }
    res.json({ from, to, start: AI_REPORT_START, target: AI_INSTALL_TARGET, installs, added, total_installed: inst.size, rows: out,
      reported: [...reported.values()] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ai-impact?mode=bug|all&pre=30
app.get('/api/ai-impact', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const mode = request.query.mode === 'all' ? 'all' : 'bug';
    const pre = AI_PRE_DAYS.includes(+request.query.pre) ? +request.query.pre : 30;
    const today = (await extReq().query(`SELECT CONVERT(char(10), GETDATE(), 23) AS d`)).recordset[0].d;
    const dayAdd = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

    // ── ร้านที่ติดตั้ง AI (เคสแรกที่เจอคำค้น = วันติดตั้ง) — ปิดการหาจากเคสได้ (ใช้เฉพาะร้านที่เพิ่มเอง/นำเข้า)
    const autoDetect = await aiImpactAutoDetect();
    const r = extReq().input('since', sql.NVarChar, AI_INSTALL_SINCE);
    AI_INSTALL_KEYWORDS.forEach((k, i) => r.input('k' + i, sql.NVarChar, '%' + k.replace(/[!%_[]/g, '!$&') + '%'));
    const txt = `(CAST(cl.CalllogDesc AS NVARCHAR(MAX)) + N' ' + ISNULL(CAST(cl.Solution AS NVARCHAR(MAX)), N'') + N' ' + ISNULL(cl.Subject, N''))`;
    const inst = !autoDetect ? [] : (await r.query(`
      SELECT cl.CalllogId AS id, cl.RegistrationId AS rid, CONVERT(char(10), cl.ReceiveDate, 23) AS d,
             cr.CompanyName AS company, CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cg.GroupName END AS grp,
             LEFT(CAST(cl.CalllogDesc AS NVARCHAR(MAX)), 120) AS descr
      FROM Calllog cl
      LEFT JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
      LEFT JOIN CustomerGroup        cg ON cg.GroupId        = cr.GroupId
      WHERE cl.Active=1 AND cl.RegistrationId IS NOT NULL AND cl.ReceiveDate >= CAST(@since AS DATE)
        AND (${AI_INSTALL_KEYWORDS.map((_, i) => `${txt} LIKE @k${i} ESCAPE '!'`).join(' OR ')})
      ORDER BY cl.ReceiveDate`)).recordset;
    const excluded = new Set((await req().query('SELECT rid FROM ai_impact_excludes')).recordset.map(x => x.rid));
    const installIds = new Set(inst.map(x => x.id));
    const stores = new Map();
    for (const x of inst) {
      const s = stores.get(x.rid);
      if (s) { s.install_cases++; continue; }
      stores.set(x.rid, { rid: x.rid, company: x.company, grp: x.grp, install_day: x.d, install_case: x.id, install_desc: x.descr,
        install_cases: 1, excluded: excluded.has(x.rid) });
    }
    // ร้านที่เพิ่มเอง: ใช้วันติดตั้งที่ระบุ (ถ้าระบบหาเจอด้วย = แก้วันติดตั้ง)
    const manual = (await req().query(`SELECT rid, CONVERT(char(10), install_day, 23) AS d, note, created_by, case_id, installer FROM ai_impact_manual`)).recordset;
    const newRids = manual.map(m => +m.rid).filter(x => Number.isInteger(x) && !stores.has(x));
    const info = new Map(newRids.length ? (await extReq().query(`
      SELECT cr.RegistrationId AS rid, cr.CompanyName AS company, CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cg.GroupName END AS grp
      FROM CustomerRegistration cr LEFT JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
      WHERE cr.RegistrationId IN (${newRids.join(',')})`)).recordset.map(x => [x.rid, x]) : []);
    for (const m of manual) {
      const s = stores.get(m.rid) || stores.set(m.rid, { rid: m.rid, company: info.get(m.rid)?.company || `#${m.rid}`, grp: info.get(m.rid)?.grp || null,
        install_case: null, install_desc: null, install_cases: 0, excluded: excluded.has(m.rid) }).get(m.rid);
      if (s.install_day && s.install_day !== m.d) s.detected_day = s.install_day;
      s.install_day = m.d; s.manual = true; s.manual_note = m.note || null; s.manual_by = m.created_by || null;
      if (m.case_id) { s.install_case = m.case_id; s.install_cases = Math.max(1, s.install_cases || 0); s.confirmed = true; s.installer = m.installer || null; }
    }
    const ai = [...stores.values()].filter(s => !s.excluded);
    const base = { mode, pre, today, keywords: AI_INSTALL_KEYWORDS, since: AI_INSTALL_SINCE, auto_detect: autoDetect, target: AI_INSTALL_TARGET };
    if (!ai.length) return res.json({ ...base, stores: [...stores.values()], labels: [], empty: true });

    // ── เคสของร้านที่ติดตั้ง: Bug โปรแกรม (เคสที่ติด Tag กลุ่ม Bug) หรือทุกเคส · Tag ของเคสไว้แยกเส้นในกราฟ
    const firstInstall = ai.reduce((m, s) => s.install_day < m ? s.install_day : m, today);
    let from = dayAdd(firstInstall, -pre), dataStart = null;
    const tagOf = new Map();   // calllog_id → { title, group }
    (await req().query(`SELECT c.calllog_id, t.id, t.title, t.tag_group FROM monitor_tag_cases c
      JOIN monitor_tags t ON t.id = c.tag_id WHERE t.status='active' ORDER BY c.id`)).recordset
      .forEach(l => { if (!tagOf.has(l.calllog_id) || (mode === 'bug' && l.tag_group === 'problem' && tagOf.get(l.calllog_id).group !== 'problem'))
        tagOf.set(l.calllog_id, { id: l.id, title: l.title, group: l.tag_group === 'service' ? 'service' : 'problem' }); });
    const tagIdOf = new Map([...tagOf.values()].map(t => [t.title, t.id]));
    if (mode === 'bug') {
      dataStart = await mtDataStart([...tagOf.keys()].map(Number).filter(Number.isInteger));   // ก่อนวันนี้ยังไม่มีข้อมูล Tag — ห้ามนับเป็นศูนย์
      if (dataStart && dataStart > from) from = dataStart;
    }
    const aiRids = ai.map(s => +s.rid).filter(Number.isInteger);
    const cases = (await extReq().input('f', sql.NVarChar, from).query(`
      SELECT CalllogId AS id, RegistrationId AS rid, CONVERT(char(10), ReceiveDate, 23) AS d FROM Calllog
      WHERE Active=1 AND ReceiveDate >= CAST(@f AS DATE) AND RegistrationId IN (${aiRids.join(',')})`)).recordset
      .filter(c => !installIds.has(c.id) && (mode === 'all' || tagOf.get(c.id)?.group === 'problem'));

    // ── ตัวเลขรายวัน (ถึงเมื่อวาน) ทั้งหมด และแยกตาม Tag
    const labels = []; for (let d = from; d < today; d = dayAdd(d, 1)) labels.push(d);
    const idx = new Map(labels.map((d, i) => [d, i]));
    const aiDaily = new Array(labels.length).fill(0);
    const tagDaily = new Map();   // title → { group, daily }
    const perStore = new Map(ai.map(s => [s.rid, []]));
    for (const c of cases) {
      if (!idx.has(c.d)) continue;
      const i = idx.get(c.d), t = tagOf.get(c.id) || { title: 'ไม่ติด Tag', group: null };
      aiDaily[i]++;
      if (!tagDaily.has(t.title)) tagDaily.set(t.title, { group: t.group, daily: new Array(labels.length).fill(0) });
      tagDaily.get(t.title).daily[i]++;
      perStore.get(c.rid).push({ d: c.d, tag: t.title });
    }

    // ── ต่อร้าน: ก่อน [ติดตั้ง − N วัน, วันติดตั้ง) · หลัง (วันติดตั้ง, วันนี้)
    const tagAgg = new Map();   // title → { pre, post }
    const T = tag => tagAgg.get(tag) || tagAgg.set(tag, { pre: 0, post: 0 }).get(tag);
    let aPre = 0, aPost = 0, preDays = 0, postDays = 0, counted = 0;
    for (const s of stores.values()) {
      const p0 = s.install_day > from ? (dayAdd(s.install_day, -pre) > from ? dayAdd(s.install_day, -pre) : from) : null;
      const q0 = dayAdd(s.install_day, 1);
      s.pre_days = p0 ? Math.round((Date.parse(s.install_day) - Date.parse(p0)) / 86400000) : 0;
      s.post_days = Math.max(0, Math.round((Date.parse(today) - Date.parse(q0)) / 86400000));
      const xs = perStore.get(s.rid) || [];
      s.pre = p0 ? xs.filter(x => x.d >= p0 && x.d < s.install_day).length : 0;
      s.post = xs.filter(x => x.d >= q0).length;
      s.counted = !s.excluded && s.pre_days > 0 && s.post_days > 0;
      s.pre_from = p0;
      s.tags = {};   // title → [ก่อน, หลัง] — ไว้ drill-down ว่า Tag นี้เกิดที่ร้านไหน
      if (s.counted) for (const x of xs) {
        const i = x.d >= p0 && x.d < s.install_day ? 0 : x.d >= q0 ? 1 : -1;
        if (i >= 0) (s.tags[x.tag] = s.tags[x.tag] || [0, 0])[i]++;
      }
      if (!s.counted) continue;
      counted++;
      aPre += s.pre; aPost += s.post; preDays += s.pre_days; postDays += s.post_days;
      for (const x of xs) { if (x.d >= p0 && x.d < s.install_day) T(x.tag).pre++; else if (x.d >= q0) T(x.tag).post++; }
    }
    const rate = (n, d) => d ? n / d : null;
    const days = [...stores.values()].filter(s => s.counted).map(s => s.install_day).sort();
    res.json({
      ...base, from, to: dayAdd(today, -1), data_start: dataStart, labels, ai_daily: aiDaily, n_ai: aiRids.length,
      tag_daily: [...tagDaily.entries()].map(([title, v]) => ({ title, group: v.group, daily: v.daily, total: v.daily.reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.total - a.total),
      median_install: days[Math.floor(days.length / 2)] || null,
      summary: { stores: counted, pre_days: preDays, post_days: postDays, ai_pre_n: aPre, ai_post_n: aPost,
        ai_pre: rate(aPre, preDays), ai_post: rate(aPost, postDays) },
      by_tag: [...tagAgg.entries()].map(([title, v]) => ({ title, id: tagIdOf.get(title) || null, group: tagDaily.get(title)?.group || null,
        ai_pre: rate(v.pre, preDays), ai_post: rate(v.post, postDays), ai_pre_n: v.pre, ai_post_n: v.post })),
      stores: [...stores.values()].sort((a, b) => a.install_day.localeCompare(b.install_day) || (a.company || '').localeCompare(b.company || '', 'th'))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai-impact/import {rows:[{rid?, store, day, note}], commit}
// จับคู่ร้าน: รหัสร้าน (RegistrationId) หรือชื่อร้านตรงตัว → ไม่เจอค่อยหาชื่อที่มีคำนี้ (เจอร้านเดียว = ใช้ได้, หลายร้าน = ให้เลือก)
// commit=false = ตรวจอย่างเดียว · commit=true = บันทึกแถวที่จับคู่ได้ลง ai_impact_manual
app.post('/api/ai-impact/import', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const input = Array.isArray(request.body?.rows) ? request.body.rows.slice(0, 1000) : [];
    if (!input.length) return res.status(400).json({ error: 'ไม่มีข้อมูลให้นำเข้า' });
    const today = bangkokToday();
    const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    const rows = input.map((r, i) => ({ line: +r.line || i + 1, store: clean(r.store).slice(0, 200), day: clean(r.day),
      note: clean(r.note).slice(0, 300) || null, rid: Number.isInteger(+r.rid) && +r.rid > 0 ? +r.rid : (/^\d+$/.test(clean(r.store)) ? +clean(r.store) : null) }));

    // รหัสร้าน
    const ids = [...new Set(rows.filter(r => r.rid).map(r => r.rid))];
    const byId = new Map();
    for (let i = 0; i < ids.length; i += 1000) (await extReq().query(`SELECT RegistrationId AS rid, CompanyName AS company FROM CustomerRegistration
      WHERE RegistrationId IN (${ids.slice(i, i + 1000).join(',')})`)).recordset.forEach(x => byId.set(x.rid, x));
    // ชื่อร้านตรงตัว (ไม่สนตัวพิมพ์ / ช่องว่างหัวท้าย)
    const names = [...new Set(rows.filter(r => !r.rid && r.store).map(r => r.store.toLowerCase()))];
    const byName = new Map();
    for (let i = 0; i < names.length; i += 500) {
      const q = extReq(), chunk = names.slice(i, i + 500);
      chunk.forEach((n, j) => q.input('n' + j, sql.NVarChar, n));
      (await q.query(`SELECT RegistrationId AS rid, CompanyName AS company FROM CustomerRegistration
        WHERE (Hide=0 OR Hide IS NULL) AND LOWER(LTRIM(RTRIM(CompanyName))) IN (${chunk.map((_, j) => '@n' + j).join(',')})`)).recordset
        .forEach(x => { const k = clean(x.company).toLowerCase(); (byName.get(k) || byName.set(k, []).get(k)).push(x); });
    }
    const parseDay = v => {
      let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v) || null, y, mo, d;
      if (m) [, y, mo, d] = m.map(Number);
      else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(v))) { [, d, mo, y] = m.map(Number); if (y < 100) y += 2000; }
      else return null;
      if (y > 2400) y -= 543;   // ปี พ.ศ.
      const s = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const t = new Date(s + 'T00:00:00Z');
      return isNaN(t) || t.toISOString().slice(0, 10) !== s ? null : s;
    };
    const out = [];
    for (const r of rows) {
      const o = { line: r.line, store: r.store, day: parseDay(r.day), day_raw: r.day, note: r.note, rid: null, company: null, status: 'ok', candidates: [] };
      if (!o.day) o.status = 'baddate';
      else if (o.day > today) o.status = 'future';
      if (r.rid) {
        const x = byId.get(r.rid);
        if (x) { o.rid = x.rid; o.company = x.company; } else if (o.status === 'ok') o.status = 'notfound';
      } else if (!r.store) { if (o.status === 'ok') o.status = 'notfound'; }
      else {
        const hit = byName.get(r.store.toLowerCase()) || [];
        if (hit.length === 1) { o.rid = hit[0].rid; o.company = hit[0].company; }
        else if (hit.length > 1) { o.candidates = hit.slice(0, 10); if (o.status === 'ok') o.status = 'ambiguous'; }
        else {
          const like = (await extReq().input('q', sql.NVarChar, '%' + r.store.replace(/[!%_[]/g, '!$&') + '%').query(`
            SELECT TOP 6 RegistrationId AS rid, CompanyName AS company FROM CustomerRegistration
            WHERE (Hide=0 OR Hide IS NULL) AND CompanyName LIKE @q ESCAPE '!' ORDER BY LEN(CompanyName)`)).recordset;
          if (like.length === 1) { o.rid = like[0].rid; o.company = like[0].company; if (o.status === 'ok') o.status = 'partial'; }
          else if (like.length > 1) { o.candidates = like.slice(0, 5); if (o.status === 'ok') o.status = 'ambiguous'; }
          else if (o.status === 'ok') o.status = 'notfound';
        }
      }
      out.push(o);
    }
    const ready = out.filter(o => o.rid && ['ok', 'partial'].includes(o.status));
    let saved = 0;
    if (request.body?.commit && ready.length) {
      const by = request.user?.username || null;
      for (const o of ready) {
        await req().input('rid', sql.Int, o.rid).input('d', sql.NVarChar, o.day).input('nt', sql.NVarChar, o.note).input('by', sql.NVarChar, by)
          .query(`IF EXISTS (SELECT 1 FROM ai_impact_manual WHERE rid=@rid)
                    UPDATE ai_impact_manual SET install_day=CAST(@d AS DATE), note=@nt, created_by=@by, created_at=GETDATE() WHERE rid=@rid
                  ELSE INSERT INTO ai_impact_manual (rid, install_day, note, created_by) VALUES (@rid, CAST(@d AS DATE), @nt, @by);
                  DELETE FROM ai_impact_excludes WHERE rid=@rid;`);
        saved++;
      }
    }
    res.json({ rows: out, ready: ready.length, saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ai-impact/cases?rid=&tag=&from=YYYY-MM-DD — เคสของร้านนี้ที่ติด Tag นี้ ตั้งแต่ from ถึงเมื่อวาน
app.get('/api/ai-impact/cases', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const rid = +request.query.rid, tag = +request.query.tag, from = String(request.query.from || '');
    if (!Number.isInteger(rid) || !Number.isInteger(tag) || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
    const ids = (await req().input('t', sql.Int, tag).query('SELECT calllog_id FROM monitor_tag_cases WHERE tag_id=@t')).recordset
      .map(x => +x.calllog_id).filter(Number.isInteger);
    if (!ids.length) return res.json({ rows: [] });
    const rows = [];
    for (let i = 0; i < ids.length; i += 2000) {
      rows.push(...(await extReq().input('rid', sql.Int, rid).input('f', sql.NVarChar, from).query(`
        SELECT cl.CalllogId AS id, cl.ReceiveDate AS opened_at, CONVERT(char(10), cl.ReceiveDate, 23) AS d,
               cs.StatusName AS status, u.UserName AS agent,
               LEFT(cl.CalllogDesc, 400) AS description, LEFT(cl.Solution, 600) AS solution
        FROM Calllog cl
        LEFT JOIN CallStatus cs ON cs.StatusId = cl.StatusId
        LEFT JOIN Users      u  ON u.UserId    = cl.SupportId
        WHERE cl.Active=1 AND cl.RegistrationId=@rid AND cl.ReceiveDate >= CAST(@f AS DATE)
          AND cl.ReceiveDate < CAST(GETDATE() AS DATE) AND cl.CalllogId IN (${ids.slice(i, i + 2000).join(',')})`)).recordset);
    }
    rows.sort((a, b) => (b.opened_at > a.opened_at ? 1 : -1));
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ai-impact/pending — เคสที่มีคำค้นติดตั้ง AI ของร้านที่ยังไม่ได้ยืนยัน (1 แถวต่อร้าน = เคสแรก)
app.get('/api/ai-impact/pending', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const confirmed = new Set((await req().query('SELECT rid FROM ai_impact_manual')).recordset.map(x => x.rid));
    const excluded = new Set((await req().query('SELECT rid FROM ai_impact_excludes')).recordset.map(x => x.rid));
    const rejected = new Set((await req().query('SELECT cid FROM ai_impact_rejects')).recordset.map(x => x.cid));
    const r = extReq().input('since', sql.NVarChar, AI_INSTALL_SINCE);
    AI_INSTALL_KEYWORDS.forEach((k, i) => r.input('k' + i, sql.NVarChar, '%' + k.replace(/[!%_[]/g, '!$&') + '%'));
    const txt = `(CAST(cl.CalllogDesc AS NVARCHAR(MAX)) + N' ' + ISNULL(CAST(cl.Solution AS NVARCHAR(MAX)), N'') + N' ' + ISNULL(cl.Subject, N''))`;
    const rows = (await r.query(`
      SELECT cl.CalllogId AS cid, CONVERT(char(10), cl.ReceiveDate, 23) AS d, cl.ReceiveDate AS at, cl.RegistrationId AS rid,
             u.UserName AS agent, cr.CompanyName AS company, CASE WHEN cr.GroupId IS NOT NULL AND cr.GroupId <> 1 THEN cg.GroupName END AS grp,
             LEFT(CAST(cl.CalllogDesc AS NVARCHAR(MAX)), 200) AS descr, LEFT(CAST(cl.Solution AS NVARCHAR(MAX)), 200) AS solution
      FROM Calllog cl
      LEFT JOIN Users                u  ON u.UserId          = cl.SupportId
      LEFT JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
      LEFT JOIN CustomerGroup        cg ON cg.GroupId        = cr.GroupId
      WHERE cl.Active=1 AND cl.RegistrationId IS NOT NULL AND cl.ReceiveDate >= CAST(@since AS DATE)
        AND (${AI_INSTALL_KEYWORDS.map((_, i) => `${txt} LIKE @k${i} ESCAPE '!'`).join(' OR ')})
      ORDER BY cl.ReceiveDate`)).recordset;
    const byStore = new Map();
    for (const x of rows) {
      if (confirmed.has(x.rid) || excluded.has(x.rid) || rejected.has(x.cid)) continue;
      const s = byStore.get(x.rid);
      if (s) { s.cases++; s.cids.push(x.cid); continue; }
      byStore.set(x.rid, { ...x, cases: 1, cids: [x.cid] });
    }
    res.json({ keywords: AI_INSTALL_KEYWORDS, since: AI_INSTALL_SINCE,
      rows: [...byStore.values()].sort((a, b) => b.d.localeCompare(a.d) || a.cid - b.cid) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai-impact/pending/decide {cids:[...], action:'confirm'|'reject'}
//   confirm = ยืนยันติดตั้งจริง → บันทึกร้าน (วันติดตั้ง = วันของเคส, ผู้ติดตั้ง = คนลงเคส)
//   reject  = ไม่ใช่การติดตั้ง → เคสคำค้นทั้งหมดของร้านนั้นไม่ขึ้นในรายการรอยืนยันอีก
app.post('/api/ai-impact/pending/decide', authRequired, async (request, res) => {
  try {
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    const cids = (Array.isArray(request.body?.cids) ? request.body.cids : []).map(Number).filter(Number.isInteger).slice(0, 500);
    const action = request.body?.action === 'reject' ? 'reject' : 'confirm';
    if (!cids.length) return res.status(400).json({ error: 'ยังไม่ได้เลือกรายการ' });
    const cases = (await extReq().query(`
      SELECT cl.CalllogId AS cid, cl.RegistrationId AS rid, CONVERT(char(10), cl.ReceiveDate, 23) AS d, u.UserName AS agent
      FROM Calllog cl LEFT JOIN Users u ON u.UserId = cl.SupportId
      WHERE cl.CalllogId IN (${cids.join(',')}) AND cl.RegistrationId IS NOT NULL`)).recordset;
    const by = request.user?.username || null;
    let done = 0;
    for (const c of cases) {
      const q = req().input('rid', sql.Int, c.rid).input('cid', sql.Int, c.cid).input('d', sql.NVarChar, c.d)
        .input('ag', sql.NVarChar, c.agent || null).input('by', sql.NVarChar, by)
        .input('nt', sql.NVarChar, `ยืนยันจากเคส #${c.cid}${c.agent ? ' · ลงโดย ' + c.agent : ''}`);
      if (action === 'confirm') {
        await q.query(`
          IF NOT EXISTS (SELECT 1 FROM ai_impact_manual WHERE rid=@rid)
            INSERT INTO ai_impact_manual (rid, install_day, note, created_by, case_id, installer) VALUES (@rid, CAST(@d AS DATE), @nt, @by, @cid, @ag);
          DELETE FROM ai_impact_excludes WHERE rid=@rid;`);
      } else {
        await q.query(`IF NOT EXISTS (SELECT 1 FROM ai_impact_rejects WHERE cid=@cid) INSERT INTO ai_impact_rejects (cid, created_by) VALUES (@cid, @by);`);
      }
      done++;
    }
    res.json({ ok: true, done, action });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai-impact/clear — ล้างร้านที่เพิ่มเอง/นำเข้า + รายการ "ไม่นับ" และปิดการหาร้านจากเคส (เริ่มนำเข้าใหม่)
app.post('/api/ai-impact/clear', authRequired, async (request, res) => {
  try {
    const out = await req().input('by', sql.NVarChar, request.user?.username || null).query(`
      DECLARE @n INT = (SELECT COUNT(*) FROM ai_impact_manual);
      DELETE FROM ai_impact_manual;
      DELETE FROM ai_impact_excludes;
      IF EXISTS (SELECT 1 FROM ai_impact_settings WHERE k='auto_detect')
        UPDATE ai_impact_settings SET v='off', updated_by=@by, updated_at=GETDATE() WHERE k='auto_detect'
      ELSE INSERT INTO ai_impact_settings (k, v, updated_by) VALUES ('auto_detect', 'off', @by);
      SELECT @n AS n;`);
    console.log(`[ai-impact] cleared ${out.recordset[0]?.n || 0} manual stores by ${request.user?.username || '?'}`);
    res.json({ ok: true, removed: out.recordset[0]?.n || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ai-impact/auto-detect {on} — เปิด/ปิดการหาร้านจากเคสคำค้น
app.put('/api/ai-impact/auto-detect', authRequired, async (request, res) => {
  try {
    const v = request.body?.on ? 'on' : 'off';
    await req().input('v', sql.NVarChar, v).input('by', sql.NVarChar, request.user?.username || null).query(`
      IF EXISTS (SELECT 1 FROM ai_impact_settings WHERE k='auto_detect')
        UPDATE ai_impact_settings SET v=@v, updated_by=@by, updated_at=GETDATE() WHERE k='auto_detect'
      ELSE INSERT INTO ai_impact_settings (k, v, updated_by) VALUES ('auto_detect', @v, @by);`);
    res.json({ ok: true, auto_detect: v === 'on' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai-impact/stores {rid, install_day, note} — เพิ่มร้านที่ติดตั้ง AI เอง (หรือแก้วันติดตั้ง)
app.post('/api/ai-impact/stores', authRequired, async (request, res) => {
  try {
    const b = request.body || {};
    const rid = +b.rid, day = String(b.install_day || '');
    if (!Number.isInteger(rid) || rid <= 0) return res.status(400).json({ error: 'กรุณาเลือกร้าน' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day))) return res.status(400).json({ error: 'วันที่ติดตั้งไม่ถูกต้อง' });
    if (day > bangkokToday()) return res.status(400).json({ error: 'วันที่ติดตั้งต้องไม่เกินวันนี้' });
    if (getExtPool()) {
      const ok = (await extReq().input('rid', sql.Int, rid).query('SELECT TOP 1 RegistrationId FROM CustomerRegistration WHERE RegistrationId=@rid')).recordset[0];
      if (!ok) return res.status(404).json({ error: 'ไม่พบร้านนี้' });
    }
    await req().input('rid', sql.Int, rid).input('d', sql.NVarChar, day)
      .input('nt', sql.NVarChar, String(b.note || '').trim().slice(0, 300) || null).input('by', sql.NVarChar, request.user?.username || null)
      .query(`IF EXISTS (SELECT 1 FROM ai_impact_manual WHERE rid=@rid)
                UPDATE ai_impact_manual SET install_day=CAST(@d AS DATE), note=@nt, created_by=@by, created_at=GETDATE() WHERE rid=@rid
              ELSE INSERT INTO ai_impact_manual (rid, install_day, note, created_by) VALUES (@rid, CAST(@d AS DATE), @nt, @by);
              DELETE FROM ai_impact_excludes WHERE rid=@rid;`);
    res.json({ ok: true, rid, install_day: day });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ai-impact/stores/:rid — ลบร้านที่เพิ่มเอง (ร้านที่ระบบหาเจอจะกลับไปใช้วันจากเคส)
app.delete('/api/ai-impact/stores/:rid', authRequired, async (request, res) => {
  try {
    await req().input('rid', sql.Int, +request.params.rid).query('DELETE FROM ai_impact_manual WHERE rid=@rid');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ai-impact/exclude {rid, exclude} — ตัดร้านที่คำค้นจับผิดออก (หรือนับกลับ)
app.post('/api/ai-impact/exclude', authRequired, async (request, res) => {
  try {
    const rid = +request.body?.rid;
    if (!Number.isInteger(rid) || rid <= 0) return res.status(400).json({ error: 'rid ไม่ถูกต้อง' });
    const q = req().input('rid', sql.Int, rid).input('by', sql.NVarChar, request.user?.username || null);
    await q.query(request.body?.exclude
      ? `IF NOT EXISTS (SELECT 1 FROM ai_impact_excludes WHERE rid=@rid) INSERT INTO ai_impact_excludes (rid, created_by) VALUES (@rid, @by)`
      : `DELETE FROM ai_impact_excludes WHERE rid=@rid`);
    res.json({ ok: true, rid, excluded: !!request.body?.exclude });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/monitor-tags/:id/analysis — เคสของ tag แยกตามร้าน / แบรนด์ / หัวข้อ (ก่อน vs หลังตั้ง tag)
// ช่วงเวลาเดียวกับสถิติ: ตัวกรองวันที่ด้านบน หรือ 30 วันก่อนเริ่ม → วันนี้
app.get('/api/monitor-tags/:id/analysis', authRequired, async (request, res) => {
  try {
    const tag = (await req().input('id', sql.Int, +request.params.id)
      .query('SELECT * FROM monitor_tags WHERE id=@id')).recordset[0];
    if (!tag) return res.status(404).json({ error: 'ไม่พบ Monitor Tag' });
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    tag.linked_ids = (await monitorLinkedIds([tag.id]))[tag.id] || [];
    const { dateFrom, dateTo } = request.query;
    const skew = await monitorClockSkew();
    const r = extReq()
      .input('c',  sql.DateTime, monitorStartExt(tag, skew))
      .input('en', sql.DateTime, tag.status === 'resolved' ? monitorToExt(tag.resolved_at, skew) : null)
      .input('bd', sql.Int, tag.baseline_days)
      .input('fs', sql.DateTime, dateFrom && dateTo ? new Date(dateFrom) : null)
      .input('fe', sql.DateTime, dateFrom && dateTo ? new Date(new Date(dateTo).setHours(23, 59, 59, 999)) : null);
    const m = monitorMatch(r, tag);
    const rows = (await r.query(`
      DECLARE @s DATETIME = ISNULL(@fs, DATEADD(day, -@bd, @c));
      DECLARE @e DATETIME = ISNULL(@fe, GETDATE());
      IF @e > GETDATE() SET @e = GETDATE();
      IF @en IS NOT NULL AND @e > @en SET @e = @en;
      SELECT xr.CompanyName AS company,
             CASE WHEN xr.GroupId IS NOT NULL AND xr.GroupId <> 1 THEN xg.GroupName END AS grp,
             ISNULL(NULLIF(LTRIM(cl.Subject), ''), '(ไม่ระบุหัวข้อ)') AS subject,
             SUM(CASE WHEN cl.ReceiveDate <  @c THEN 1 ELSE 0 END) AS pre,
             SUM(CASE WHEN cl.ReceiveDate >= @c THEN 1 ELSE 0 END) AS post
      FROM Calllog cl ${m.join}
      LEFT JOIN CustomerRegistration xr ON xr.RegistrationId = cl.RegistrationId
      LEFT JOIN CustomerGroup        xg ON xg.GroupId        = xr.GroupId
      WHERE cl.Active=1 AND ${m.where} AND cl.ReceiveDate >= @s AND cl.ReceiveDate <= @e
      GROUP BY xr.CompanyName, CASE WHEN xr.GroupId IS NOT NULL AND xr.GroupId <> 1 THEN xg.GroupName END,
               ISNULL(NULLIF(LTRIM(cl.Subject), ''), '(ไม่ระบุหัวข้อ)')`)).recordset;
    const roll = (key, extra) => {
      const mp = new Map();
      for (const x of rows) {
        const k = key(x) || '(ไม่ระบุ)';
        const a = mp.get(k) || { name: k, pre: 0, post: 0, ...(extra ? extra(x) : {}) };
        a.pre += x.pre; a.post += x.post; mp.set(k, a);
      }
      return [...mp.values()].sort((a, b) => (b.post - a.post) || (b.pre - a.pre));
    };
    res.json({
      stores:   roll(x => x.company, x => ({ grp: x.grp || null })),
      groups:   roll(x => x.grp || 'สาขาเดี่ยว / INF Group'),
      subjects: roll(x => x.subject),
      total: rows.reduce((a, x) => ({ pre: a.pre + x.pre, post: a.post + x.post }), { pre: 0, post: 0 })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══ AI แนะนำ Tag ให้เคสรายวัน ══════════════════════════════
// เคสของวันนั้นที่ยังไม่ได้ติด Tag → ให้ AI จับคู่กับ Tag กลางที่เปิดอยู่ → คนกดยืนยัน/ปฏิเสธ
// ประหยัด token: ส่งครั้งละ 40 เคส, ให้ AI ตอบเฉพาะเคสที่ตรง, เคสที่ประเมินแล้วไม่ส่งซ้ำ
// (ยกเว้นมี Tag ใหม่เพิ่มเข้ามาหลังประเมิน — เคสที่เคย "ไม่ตรง" จะถูกประเมินใหม่ได้)
const MT_SUGGEST_BATCH = 80;   // ชุดใหญ่ = ส่งรายชื่อ Tag ซ้ำน้อยลง (ประหยัด token)
const MT_SUGGEST_AUTO  = (process.env.MONITOR_SUGGEST_AUTO || 'on').toLowerCase() !== 'off';
// ใช้รุ่นถูกเสมอ (แยกจาก GEMINI_MODEL ของฟีเจอร์อื่น) · Gemini ล่ม = ข้ามรอบนี้ ไม่สลับไปรุ่นแพง
const MT_SUGGEST_MODEL = process.env.MONITOR_SUGGEST_MODEL || 'gemini-flash-lite-latest';
// AI ติด Tag ให้เลยเมื่อ "มั่นใจสูง" หรือ "น่าจะใช่" — เหลือรอคนดูเฉพาะ "ไม่แน่ใจ" (off = ทุกเคสรอยืนยัน)
const MT_SUGGEST_AUTO_ACCEPT = (process.env.MONITOR_SUGGEST_AUTO_ACCEPT || 'on').toLowerCase() !== 'off';
const MT_AUTO_LEVELS = ['high', 'medium'];
// รายการที่ค้างรอยืนยันในระดับที่ติดอัตโนมัติได้ → ติด Tag ให้เลย (ช่วง from–to หรือทั้งหมด)
async function mtAcceptPending(from, to) {
  if (!MT_SUGGEST_AUTO_ACCEPT) return 0;
  const r = req().input('f', sql.Date, from ? new Date(from + 'T00:00:00Z') : null).input('t', sql.Date, to ? new Date(to + 'T00:00:00Z') : null);
  const out = await r.query(`
    DECLARE @n INT;
    INSERT INTO monitor_tag_cases (tag_id, calllog_id, linked_by)
    SELECT DISTINCT s.tag_id, s.calllog_id, 'AI' FROM monitor_tag_suggestions s
    JOIN monitor_tags t ON t.id = s.tag_id AND t.status = 'active'
    WHERE s.status = 'pending' AND s.confidence IN ('high', 'medium')
      AND (@f IS NULL OR s.case_day >= @f) AND (@t IS NULL OR s.case_day <= @t)
      AND NOT EXISTS (SELECT 1 FROM monitor_tag_cases c WHERE c.tag_id = s.tag_id AND c.calllog_id = s.calllog_id);
    UPDATE s SET status = 'accepted', decided_by = 'AI', decided_at = GETDATE()
    FROM monitor_tag_suggestions s JOIN monitor_tags t ON t.id = s.tag_id AND t.status = 'active'
    WHERE s.status = 'pending' AND s.confidence IN ('high', 'medium')
      AND (@f IS NULL OR s.case_day >= @f) AND (@t IS NULL OR s.case_day <= @t);
    SET @n = @@ROWCOUNT;
    SELECT @n AS n;`);
  return out.recordset?.[0]?.n || 0;
}
const MT_SUGGEST_TIME  = /^\d{2}:\d{2}$/.test(process.env.MONITOR_SUGGEST_TIME || '') ? process.env.MONITOR_SUGGEST_TIME : '00:00';
let _mtSuggestRunning = false;

// opts.autoAccept — รอบอัตโนมัติ: เคสที่ AI มั่นใจสูง ติด Tag ให้เลย ที่เหลือรอคนยืนยันใน "เคสแนะนำ"
async function suggestMonitorTags(day, opts = {}) {
  if (_mtSuggestRunning) return { busy: true };
  if (!getExtPool()) return { error: 'External DB not connected' };
  if (!process.env.GEMINI_API_KEY) return { error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY' };
  _mtSuggestRunning = true;
  try {
    const tags = (await req().query(`SELECT id, title, note, tag_type, tag_group FROM monitor_tags
      WHERE status='active' AND match_mode='manual' ORDER BY id`)).recordset;
    if (!tags.length) return { evaluated: 0, suggested: 0, note: 'ยังไม่มี Tag ให้จับคู่' };
    const tagSet = tags.map(t => t.id).join(',');
    const linked = await monitorLinkedIds(tags.map(t => t.id));

    // ตัวอย่างเคสจริงของแต่ละ Tag (ไม่เกิน 2) ช่วยให้ AI แยกอาการได้แม่นขึ้น
    const exIds = [...new Set(tags.flatMap(t => (linked[t.id] || []).slice(-2)))];
    const exText = {};
    if (exIds.length) (await extReq().query(`SELECT CalllogId, LEFT(CalllogDesc, 140) AS d FROM Calllog
      WHERE CalllogId IN (${exIds.map(Number).join(',')})`)).recordset.forEach(r => { exText[r.CalllogId] = r.d; });

    // เคสของวันนั้น (ปฏิทิน LicenseDB)
    const cases = (await extReq().input('d', sql.NVarChar, day).query(`
      SELECT cl.CalllogId AS id, cl.Subject AS subject, LEFT(cl.CalllogDesc, 350) AS descr, LEFT(cl.Solution, 160) AS sol
      FROM Calllog cl
      WHERE cl.Active=1 AND cl.ReceiveDate >= CAST(@d AS DATE) AND cl.ReceiveDate < DATEADD(day, 1, CAST(@d AS DATE))
        AND LEN(LTRIM(ISNULL(CAST(cl.CalllogDesc AS NVARCHAR(MAX)), ''))) > 0`)).recordset;
    const linkedSet = new Set(Object.values(linked).flat());
    const prev = (await req().input('d', sql.Date, new Date(day + 'T00:00:00Z')).query(
      `SELECT calllog_id, status, tag_set FROM monitor_tag_suggestions WHERE case_day=@d`)).recordset;
    const skip = new Set(prev.filter(r => r.status !== 'none' || r.tag_set === tagSet).map(r => r.calllog_id));
    const todo = cases.filter(c => !linkedSet.has(c.id) && !skip.has(c.id));
    if (!todo.length) return { evaluated: 0, suggested: 0, cases: cases.length };

    const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
    const tagList = tags.map(t => {
      const ex = (linked[t.id] || []).slice(-2).map(id => exText[id]).filter(Boolean).map(clean);
      return `[T${t.id}] ${t.tag_group === 'service' ? '(IT Service) ' : '(Bug โปรแกรม) '}${clean(t.title)}${t.note ? ' — ' + clean(t.note).slice(0, 120) : ''}${ex.length ? '\n   ตัวอย่างเคส: ' + ex.join(' / ') : ''}`;
    }).join('\n');
    const geminiConfig = { generationConfig: { responseMimeType: 'application/json', responseSchema: {
      type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: {
        i: { type: SchemaType.NUMBER }, tag_id: { type: SchemaType.NUMBER },
        confidence: { type: SchemaType.STRING }, reason: { type: SchemaType.STRING } },
        required: ['i', 'tag_id', 'confidence', 'reason'] } } } };
    const tagIds = new Set(tags.map(t => t.id));
    let suggested = 0, evaluated = 0, accepted = 0, usedModel = null;

    for (let b = 0; b < todo.length; b += MT_SUGGEST_BATCH) {
      const batch = todo.slice(b, b + MT_SUGGEST_BATCH);
      const caseList = batch.map((c, i) =>
        `[${i}] หัวข้อ: ${clean(c.subject) || '-'} | อาการ: ${clean(c.descr)}${c.sol ? ' | วิธีแก้: ' + clean(c.sol) : ''}`).join('\n');
      const prompt = `คุณช่วยทีม Support ของโปรแกรม POS ร้านอาหาร/ร้านค้า จัดเคสเข้า Tag ว่าเป็น "Bug โปรแกรม" หรือ "IT Service"
- Bug โปรแกรม = ระบบทำงานผิดพลาด error ค้าง ข้อมูลผิด ที่ร้านไม่ได้ตั้งใจขอ
- IT Service = งานที่ร้านขอให้ทำ / ตั้งค่า / ติดตั้ง / สอน / แก้ข้อมูลให้ — เป็นงานบริการที่เสนอขายได้
Tag ที่มี:
${tagList}

เคสของวันนี้:
${caseList}

ตอบเป็น JSON array: แต่ละเคสเลือก Tag ที่ตรงที่สุด 1 Tag ถ้าเป็นแค่การสอบถามทั่วไปหรือข้อมูลไม่พอ ไม่ต้องใส่เคสนั้น
แต่ละ object: i (เลขเคส), tag_id (ตัวเลขหลัง T), confidence ("high" ตรงชัดเจน | "medium" น่าจะใช่ | "low" ไม่แน่ใจ), reason (เหตุผลสั้นๆ ภาษาไทย)
ดูที่อาการ/คำขอจริงเป็นหลัก หัวข้อ (Subject) อาจถูกเลือกผิดได้`;
      let arr;
      try {
        const model = genAI.getGenerativeModel({ model: MT_SUGGEST_MODEL, ...geminiConfig });
        const mtRes = await model.generateContent(prompt);
        geminiUsage('monitor_tag', MT_SUGGEST_MODEL, mtRes);
        arr = parseJsonArrayReply(mtRes.response.text());
        usedModel = MT_SUGGEST_MODEL;
      } catch (e) { console.error('[monitor-suggest] AI failed:', e.message); return { evaluated, suggested, error: 'AI ไม่สำเร็จ: ' + e.message }; }
      const hits = new Map();
      (Array.isArray(arr) ? arr : []).forEach(o => {
        const i = Number(o?.i), tid = Number(o?.tag_id);
        if (Number.isInteger(i) && batch[i] && tagIds.has(tid) && !hits.has(i)) hits.set(i, { tid,
          conf: ['high', 'medium', 'low'].includes(o.confidence) ? o.confidence : 'low', reason: clean(o.reason).slice(0, 480) });
      });
      for (let i = 0; i < batch.length; i++) {
        const h = hits.get(i), r = req()
          .input('cid', sql.Int, batch[i].id).input('d', sql.Date, new Date(day + 'T00:00:00Z'))
          .input('ts', sql.NVarChar, tagSet).input('m', sql.NVarChar, usedModel);
        try {
          if (h) {
            const auto = opts.autoAccept && MT_AUTO_LEVELS.includes(h.conf);
            await r.input('tid', sql.Int, h.tid).input('cf', sql.NVarChar, h.conf).input('rs', sql.NVarChar, h.reason).query(`
              DELETE FROM monitor_tag_suggestions WHERE calllog_id=@cid AND status='none';
              IF NOT EXISTS (SELECT 1 FROM monitor_tag_suggestions WHERE calllog_id=@cid AND tag_id=@tid)
                INSERT INTO monitor_tag_suggestions (calllog_id, tag_id, case_day, confidence, reason, status, tag_set, ai_model, decided_by, decided_at)
                VALUES (@cid, @tid, @d, @cf, @rs, '${auto ? 'accepted' : 'pending'}', @ts, @m, ${auto ? "'AI', GETDATE()" : 'NULL, NULL'});
              ${auto ? `IF NOT EXISTS (SELECT 1 FROM monitor_tag_cases WHERE tag_id=@tid AND calllog_id=@cid)
                INSERT INTO monitor_tag_cases (tag_id, calllog_id, linked_by) VALUES (@tid, @cid, 'AI');` : ''}`);
            suggested++;
            if (auto) accepted++;
          } else {
            await r.query(`
              DELETE FROM monitor_tag_suggestions WHERE calllog_id=@cid AND status='none';
              INSERT INTO monitor_tag_suggestions (calllog_id, tag_id, case_day, status, tag_set, ai_model)
              VALUES (@cid, NULL, @d, 'none', @ts, @m)`);
          }
          evaluated++;
        } catch (e) { console.error('[monitor-suggest] save failed for case', batch[i].id, e.message); }
      }
    }
    console.log(`🏷️ monitor-suggest ${day}: ประเมิน ${evaluated} เคส · แนะนำ ${suggested}${opts.autoAccept ? ` · ติด Tag อัตโนมัติ ${accepted}` : ''}`);
    return { evaluated, suggested, accepted, cases: cases.length, model: usedModel };
  } finally { _mtSuggestRunning = false; }
}

// ตั้งเวลารันวันละครั้ง (MONITOR_SUGGEST_TIME, ค่าเริ่มต้น 00:00) · ปิดได้ด้วย MONITOR_SUGGEST_AUTO=off
// รันก่อน 06:00 = จัดเคสของ "เมื่อวาน" (วันที่เพิ่งจบ) + เก็บตกวันก่อนหน้าอีกวัน
// (นาฬิกา LicenseDB ไม่ตรงกับเครื่องนี้ เคสช่วงท้ายวันอาจเข้ามาหลังรอบเที่ยงคืน — เคสที่ประเมินแล้วไม่ส่งซ้ำ จึงแทบไม่เสีย token)
let _mtSuggestLastDay = null;
setInterval(async () => {
  if (!MT_SUGGEST_AUTO) return;
  const hhmm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' });
  const today = bangkokToday();
  if (hhmm !== MT_SUGGEST_TIME || _mtSuggestLastDay === today) return;
  _mtSuggestLastDay = today;
  const back = n => new Date(Date.parse(today + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  const days = MT_SUGGEST_TIME < '06:00' ? [back(2), back(1)] : [today];
  for (const d of days) {
    try { await suggestMonitorTags(d, { autoAccept: MT_SUGGEST_AUTO_ACCEPT }); } catch (e) { console.error('[monitor-suggest] auto error:', e.message); }
  }
  await mtAcceptPending(days[0], days[days.length - 1]).catch(e => console.error('[monitor-suggest] accept pending:', e.message));
}, 30 * 1000);

// รอบรายชั่วโมง (MONITOR_SUGGEST_HOURLY=off เพื่อปิด) — แนะนำ/ติด Tag ให้เคส "วันนี้" ระหว่างวัน
// ประหยัด token: suggestMonitorTags ข้ามเคสที่ประเมินไปแล้ว (ชุด Tag เดิม) → รอบนี้ส่ง AI เฉพาะเคสใหม่ในชั่วโมงนั้น
// ไม่มีเคสใหม่ = ไม่เรียก AI เลย · ทำเฉพาะช่วงเวลาทำงาน (MONITOR_SUGGEST_HOURS, ค่าเริ่มต้น 8-23) · รอบเที่ยงคืนยังเก็บตกทั้งวันเหมือนเดิม
const MT_SUGGEST_HOURLY = (process.env.MONITOR_SUGGEST_HOURLY || 'on').toLowerCase() !== 'off';
const [MT_SG_H_FROM, MT_SG_H_TO] = (/^(\d{1,2})-(\d{1,2})$/.exec(process.env.MONITOR_SUGGEST_HOURS || '') || [0, 8, 23]).slice(1).map(Number);
let _mtSuggestLastHour = null;
setInterval(async () => {
  if (!MT_SUGGEST_AUTO || !MT_SUGGEST_HOURLY) return;
  const now = new Date();
  const hh = +now.toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' }).slice(0, 2);
  const mm = +now.toLocaleTimeString('en-GB', { minute: '2-digit', timeZone: 'Asia/Bangkok' }).slice(-2);
  const today = bangkokToday(), key = `${today} ${hh}`;
  if (mm < 5 || hh < MT_SG_H_FROM || hh > MT_SG_H_TO || _mtSuggestLastHour === key) return;   // ทุกต้นชั่วโมง (:05)
  _mtSuggestLastHour = key;
  try {
    const r = await suggestMonitorTags(today, { autoAccept: MT_SUGGEST_AUTO_ACCEPT });
    if (r?.busy) _mtSuggestLastHour = null;   // รอบอื่นกำลังทำอยู่ — ลองใหม่ในนาทีถัดไป
    await mtAcceptPending(today, today);
  } catch (e) { console.error('[monitor-suggest] hourly error:', e.message); }
}, 60 * 1000);

// รหัสผ่านของหน้า "เคสแนะนำ" (MONITOR_SUGGEST_PASSWORD ใน .env) — ไม่ตั้ง = ไม่ต้องใส่รหัส
// หน้าเว็บส่งมาใน header X-Suggest-Password ทุกครั้ง · ผิด = 403 (หน่วงเวลากันเดารหัส)
const MT_SUGGEST_PASSWORD = process.env.MONITOR_SUGGEST_PASSWORD || '';
async function mtSuggestPw(request, res, next) {
  if (!MT_SUGGEST_PASSWORD) return next();
  const h = v => crypto.createHash('sha256').update(String(v)).digest();
  if (crypto.timingSafeEqual(h(request.get('X-Suggest-Password') || ''), h(MT_SUGGEST_PASSWORD))) return next();
  await new Promise(ok => setTimeout(ok, 800));
  res.status(403).json({ error: 'รหัสผ่านไม่ถูกต้อง', need_password: true });
}
// POST /api/monitor-tags/suggestions/unlock — ตรวจรหัสผ่านก่อนเปิดหน้า
app.post('/api/monitor-tags/suggestions/unlock', authRequired, mtSuggestPw, (request, res) => res.json({ ok: true }));

const mtDayParam = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : bangkokToday();

// ช่วงวันที่ให้ AI หาเคส: from–to (YYYY-MM-DD) ไม่เกิน 31 วัน ไม่เกินวันนี้ · ส่ง date มาแบบเดิม = วันเดียว
const MT_SUGGEST_MAX_DAYS = 31;
function mtDayRange(q) {
  const today = bangkokToday();
  let from = mtDayParam(q.from || q.date), to = mtDayParam(q.to || q.date || from);
  if (to > today) to = today;
  if (from > to) [from, to] = [to, from];
  const days = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  return { from, to, days, tooLong: days.length > MT_SUGGEST_MAX_DAYS };
}

// GET /api/monitor-tags/suggestions?from=&to= (หรือ ?date=) — คำแนะนำที่รอยืนยันในช่วงนั้น
app.get('/api/monitor-tags/suggestions', authRequired, async (request, res, next) => {
  // ?badge=1 — จำนวนรอยืนยันไว้โชว์บนปุ่ม (ไม่ต้องใช้รหัส ไม่มีรายละเอียดเคส)
  if (request.query.badge !== '1') return mtSuggestPw(request, res, next);
  try {
    const rg = mtDayRange(request.query);
    if (rg.tooLong) return res.status(400).json({ error: `เลือกได้ไม่เกิน ${MT_SUGGEST_MAX_DAYS} วัน` });
    const n = (await req().input('f', sql.Date, new Date(rg.from + 'T00:00:00Z')).input('t', sql.Date, new Date(rg.to + 'T00:00:00Z')).query(`
      SELECT COUNT(*) AS n FROM monitor_tag_suggestions s JOIN monitor_tags t ON t.id = s.tag_id
      WHERE s.case_day BETWEEN @f AND @t AND s.status='pending'`)).recordset[0].n;
    res.json({ badge: true, from: rg.from, to: rg.to, counts: { pending: n } });
  } catch (e) { res.status(500).json({ error: e.message }); }
}, async (request, res) => {
  try {
    const rg = mtDayRange(request.query);
    if (rg.tooLong) return res.status(400).json({ error: `เลือกได้ไม่เกิน ${MT_SUGGEST_MAX_DAYS} วัน` });
    const day = rg.from;
    const all = (await req().input('f', sql.Date, new Date(rg.from + 'T00:00:00Z')).input('t', sql.Date, new Date(rg.to + 'T00:00:00Z')).query(`
      SELECT s.id, s.calllog_id, s.tag_id, s.case_day, s.confidence, s.reason, s.status, s.created_at, s.decided_by,
             t.title AS tag_title, t.tag_type, t.tag_group
      FROM monitor_tag_suggestions s LEFT JOIN monitor_tags t ON t.id = s.tag_id
      WHERE s.case_day BETWEEN @f AND @t ORDER BY s.case_day DESC, s.id`)).recordset;
    const pendingAll = all.filter(r => r.status === 'pending' && r.tag_title);
    const pending = pendingAll.slice(0, 600);   // แสดงไม่เกิน 600 รายการต่อครั้ง
    const info = {};
    if (pending.length && getExtPool()) (await extReq().query(`
      SELECT cl.CalllogId AS id, cl.ReceiveDate AS opened_at, cl.Subject AS subject, LEFT(cl.CalllogDesc, 300) AS descr,
             cr.CompanyName AS company, cs.StatusName AS case_status
      FROM Calllog cl
      LEFT JOIN CustomerRegistration cr ON cr.RegistrationId = cl.RegistrationId
      LEFT JOIN CallStatus cs ON cs.StatusId = cl.StatusId
      WHERE cl.CalllogId IN (${[...new Set(pending.map(r => r.calllog_id))].map(Number).join(',')})`)).recordset
      .forEach(r => { info[r.id] = r; });
    const lastRun = all.reduce((m, r) => (!m || r.created_at > m ? r.created_at : m), null);
    res.json({
      date: day, from: rg.from, to: rg.to, running: _mtSuggestRunning, auto: MT_SUGGEST_AUTO, autoTime: MT_SUGGEST_TIME,
      autoAccept: MT_SUGGEST_AUTO_ACCEPT, job: _mtJob,
      evaluated: new Set(all.map(r => r.calllog_id)).size, last_run: lastRun,
      counts: { pending: pendingAll.length, accepted: all.filter(r => r.status === 'accepted').length,
        auto_accepted: all.filter(r => r.status === 'accepted' && r.decided_by === 'AI').length,
        rejected: all.filter(r => r.status === 'rejected').length },
      items: pending.map(r => ({ ...r, case: info[r.calllog_id] || null }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// งานให้ AI หาเคสตามช่วงวันที่ — รันเบื้องหลังทีละวัน (หลายวันใช้เวลาหลายนาที) หน้าเว็บดึงความคืบหน้าจาก /job
let _mtJob = null;
async function mtRunSuggestJob(job) {
  for (const d of job.days) {
    job.day = d;
    let r = { busy: true };
    for (let i = 0; i < 60 && r.busy; i++) {   // รอบเที่ยงคืนกำลังรันอยู่ — รอได้ถึง ~10 นาที
      r = await suggestMonitorTags(d, { autoAccept: job.auto_accept }).catch(e => ({ error: e.message }));
      if (r.busy) await new Promise(ok => setTimeout(ok, 10000));
    }
    job.evaluated += r.evaluated || 0; job.suggested += r.suggested || 0; job.accepted += r.accepted || 0;
    if (r.busy || (r.error && !r.evaluated)) { job.error = r.busy ? 'มีงานวิเคราะห์อื่นค้างอยู่' : r.error; break; }
    job.done++;
  }
  if (job.auto_accept) job.accepted += await mtAcceptPending(job.from, job.to).catch(() => 0);   // ที่ค้างจากรอบก่อน
  job.running = false; job.day = null; job.finished_at = new Date();
  console.log(`🏷️ monitor-suggest job ${job.from}…${job.to}: ${job.done}/${job.days.length} วัน · ประเมิน ${job.evaluated} · แนะนำ ${job.suggested} · ติด Tag ${job.accepted}${job.error ? ' · ' + job.error : ''}`);
}

// POST /api/monitor-tags/suggestions/run {from, to} (หรือ {date}) — ให้ AI หาเคสในช่วงนั้น (ไม่ประเมินเคสเดิมซ้ำ)
// มั่นใจสูง / น่าจะใช่ ติด Tag ให้เลย · ไม่แน่ใจ รอยืนยัน
app.post('/api/monitor-tags/suggestions/run', authRequired, mtSuggestPw, async (request, res) => {
  try {
    if (_mtJob?.running || _mtSuggestRunning) return res.status(409).json({ error: 'กำลังวิเคราะห์อยู่ ลองใหม่อีกสักครู่', job: _mtJob });
    if (!getExtPool()) return res.status(503).json({ error: 'External DB not connected' });
    if (!process.env.GEMINI_API_KEY) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า GEMINI_API_KEY' });
    const rg = mtDayRange(request.body || {});
    if (rg.tooLong) return res.status(400).json({ error: `เลือกได้ไม่เกิน ${MT_SUGGEST_MAX_DAYS} วัน` });
    _mtJob = { from: rg.from, to: rg.to, days: rg.days, done: 0, day: null, evaluated: 0, suggested: 0, accepted: 0,
      auto_accept: MT_SUGGEST_AUTO_ACCEPT, running: true, error: null,
      by: request.user?.username || null, started_at: new Date(), finished_at: null };
    mtRunSuggestJob(_mtJob).catch(e => { _mtJob.running = false; _mtJob.error = e.message; });
    res.json({ started: true, job: _mtJob });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/monitor-tags/suggestions/job — ความคืบหน้างานล่าสุด
app.get('/api/monitor-tags/suggestions/job', authRequired, mtSuggestPw, (request, res) => res.json({ job: _mtJob, running: _mtSuggestRunning }));

// POST /api/monitor-tags/suggestions/decide {ids:[...], action:'accept'|'reject'} — ยืนยัน = ติด Tag ให้เคส
app.post('/api/monitor-tags/suggestions/decide', authRequired, mtSuggestPw, async (request, res) => {
  try {
    const ids = (Array.isArray(request.body?.ids) ? request.body.ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
    const accept = request.body?.action === 'accept';
    if (!ids.length) return res.status(400).json({ error: 'ไม่มีรายการ' });
    const by = request.user?.username || null;
    const rows = (await req().query(`SELECT s.id, s.calllog_id, s.tag_id, t.status AS tag_status
      FROM monitor_tag_suggestions s JOIN monitor_tags t ON t.id = s.tag_id
      WHERE s.status='pending' AND s.id IN (${ids.join(',')})`)).recordset;
    let done = 0;
    for (const r of rows) {
      if (accept && r.tag_status !== 'active') continue;   // Tag ถูกปิดไปแล้ว
      const q = req().input('sid', sql.Int, r.id).input('by', sql.NVarChar, by)
        .input('tid', sql.Int, r.tag_id).input('cid', sql.Int, r.calllog_id);
      await q.query(`${accept ? `IF NOT EXISTS (SELECT 1 FROM monitor_tag_cases WHERE tag_id=@tid AND calllog_id=@cid)
          INSERT INTO monitor_tag_cases (tag_id, calllog_id, linked_by) VALUES (@tid, @cid, @by);` : ''}
        UPDATE monitor_tag_suggestions SET status='${accept ? 'accepted' : 'rejected'}', decided_by=@by, decided_at=GETDATE() WHERE id=@sid`);
      done++;
    }
    res.json({ ok: true, done });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/monitor-tags/:id/cases {calllog_id} — ผูกเคสเข้ากับ tag ที่มีอยู่
app.post('/api/monitor-tags/:id/cases', authRequired, async (request, res) => {
  try {
    const id = +request.params.id, cid = parseInt(request.body?.calllog_id);
    if (!Number.isInteger(cid) || cid <= 0) return res.status(400).json({ error: 'calllog_id ไม่ถูกต้อง' });
    const tag = (await req().input('id', sql.Int, id).query(`SELECT id, status FROM monitor_tags WHERE id=@id`)).recordset[0];
    if (!tag) return res.status(404).json({ error: 'ไม่พบ Monitor Tag' });
    if (tag.status !== 'active') return res.status(400).json({ error: 'Tag นี้ปิดแล้ว' });
    await req().input('id', sql.Int, id).input('cid', sql.Int, cid).input('by', sql.NVarChar, request.user?.username || null)
      .query(`IF NOT EXISTS (SELECT 1 FROM monitor_tag_cases WHERE tag_id=@id AND calllog_id=@cid)
              INSERT INTO monitor_tag_cases (tag_id, calllog_id, linked_by) VALUES (@id, @cid, @by)`);
    res.json({ ok: true, tag_id: id, calllog_id: cid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/monitor-tags/:id/cases/:cid — เอาเคสที่ผูกเองออก
app.delete('/api/monitor-tags/:id/cases/:cid', authRequired, async (request, res) => {
  try {
    await req().input('id', sql.Int, +request.params.id).input('cid', sql.Int, +request.params.cid)
      .query(`DELETE FROM monitor_tag_cases WHERE tag_id=@id AND calllog_id=@cid`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/monitor-tags
app.post('/api/monitor-tags', authRequired, async (request, res) => {
  try {
    const b = request.body || {};
    const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
    const store = str(b.store_name, 200), subject = str(b.subject, 400);
    const title = str(b.title, 300) || subject;
    const customer = str(b.customer_name, 200) || store;
    const baseline = MONITOR_BASELINE_OPTIONS.includes(+b.baseline_days) ? +b.baseline_days : 30;
    const rid = Number.isInteger(+b.registration_id) && +b.registration_id > 0 ? +b.registration_id : null;
    const manual = b.match_mode === 'manual';
    if (!store) return res.status(400).json({ error: 'ต้องมีชื่อสาขา' });
    if (!manual && !subject) return res.status(400).json({ error: 'ต้องมีหัวข้อปัญหา' });
    if (manual && !str(b.title, 300)) return res.status(400).json({ error: 'กรุณาตั้งชื่อ Tag' });
    const startAt = b.start_at ? String(b.start_at).trim() : null;
    if (startAt) { const err = await monitorCheckStart(startAt); if (err) return res.status(400).json({ error: err }); }

    // สาขาที่อยู่ใน License Group (แบรนด์) → ดูระดับกลุ่ม
    // สาขาเดี่ยว (ไม่มีกลุ่ม) หรือกลุ่ม INF Group (GroupId 1) → ดูระดับสาขา
    let scope = manual ? 'global' : 'store', gid = null, groupName = null;
    if (!manual && rid && getExtPool()) {
      const g = (await extReq().input('rid', sql.Int, rid).query(`
        SELECT cr.GroupId, cg.GroupName FROM CustomerRegistration cr
        LEFT JOIN CustomerGroup cg ON cg.GroupId = cr.GroupId
        WHERE cr.RegistrationId=@rid AND cr.GroupId IS NOT NULL AND cr.GroupId <> 1`)).recordset[0];
      if (g) { scope = 'group'; gid = g.GroupId; groupName = g.GroupName || customer; }
    }

    const kwList = monitorKeywords(b.keywords);
    const kwStr = kwList.join(', ') || null;
    const anySub = !!b.any_subject && kwList.length > 0;   // ไม่จำกัดหัวข้อได้เมื่อมีคำค้นเท่านั้น
    if (b.any_subject && !kwList.length) return res.status(400).json({ error: 'ไม่จำกัดหัวข้อ ต้องระบุคำค้นอย่างน้อย 1 คำ' });

    const dup = (await req()
      .input('rid', sql.Int, rid).input('store', sql.NVarChar, store).input('sub', sql.NVarChar, subject)
      .input('gid', sql.Int, gid).input('kw', sql.NVarChar, kwStr || '').input('any', sql.Bit, anySub ? 1 : 0)
      .input('man', sql.Bit, manual ? 1 : 0).input('ttl', sql.NVarChar, title)
      .query(`SELECT TOP 1 id, title FROM monitor_tags
              WHERE status='active' AND (
                (@man=1 AND scope='global' AND title=@ttl) OR
                (@man=0 AND ISNULL(match_mode,'subject')<>'manual' AND ISNULL(keywords,'')=@kw AND ISNULL(any_subject,0)=@any
                 AND (@any=1 OR subject=@sub) AND (
                  (@gid IS NOT NULL AND scope='group' AND group_id=@gid) OR
                  (@gid IS NULL AND ISNULL(scope,'store')='store' AND
                    ((@rid IS NOT NULL AND registration_id=@rid) OR (@rid IS NULL AND store_name=@store))))))`)).recordset[0];
    if (dup) return res.status(409).json({
      error: manual ? `มี Tag “${dup.title}” อยู่แล้ว — เลือก Tag เดิมแทนได้`
        : `${gid ? 'กลุ่มนี้' : 'สาขานี้'}มี Monitor Tag ${kwStr ? 'คำค้นนี้' : 'หัวข้อนี้'}อยู่แล้ว (“${dup.title}”)`, id: dup.id });

    const row = (await req()
      .input('cn',  sql.NVarChar, manual ? 'ทุก License' : groupName || customer)
      .input('sn',  sql.NVarChar, manual ? 'ทุก License' : gid ? (groupName || customer) : store)
      .input('rid', sql.Int, manual || gid ? null : rid)
      .input('scp', sql.NVarChar, scope)
      .input('gid', sql.Int, gid)
      .input('sub', sql.NVarChar, subject)
      .input('cat', sql.NVarChar, str(b.category, 200) || null)
      .input('ttl', sql.NVarChar, title)
      .input('nt',  sql.NVarChar, str(b.note, 4000) || null)
      .input('bd',  sql.Int, baseline)
      .input('src', sql.Int, Number.isInteger(+b.source_ticket_id) ? +b.source_ticket_id : null)
      .input('sta', sql.NVarChar, startAt ? startAt + ':00' : null)
      .input('kws', sql.NVarChar, kwStr)
      .input('any', sql.Bit, anySub ? 1 : 0)
      .input('mm',  sql.NVarChar, manual ? 'manual' : null)
      .input('tt',  sql.NVarChar, b.tag_group !== 'service' && MONITOR_TAG_TYPES.includes(b.tag_type) ? b.tag_type : null)
      .input('tg',  sql.NVarChar, MONITOR_TAG_GROUPS.includes(b.tag_group) ? b.tag_group : 'problem')
      .input('by',  sql.NVarChar, request.user?.username || null)
      .input('cs',  sql.NVarChar, str(b.check_script, 200000) || null)
      .input('fs',  sql.NVarChar, str(b.fix_script, 200000) || null)
      .query(`INSERT INTO monitor_tags
                (customer_name, store_name, registration_id, scope, group_id, subject, category, title, note, baseline_days, source_ticket_id, created_by,
                 check_script, fix_script, scripts_updated_by, scripts_updated_at, start_at, keywords, any_subject, match_mode, tag_type, tag_group)
              OUTPUT INSERTED.*
              VALUES (@cn, @sn, @rid, @scp, @gid, @sub, @cat, @ttl, @nt, @bd, @src, @by,
                 @cs, @fs, CASE WHEN @cs IS NULL AND @fs IS NULL THEN NULL ELSE @by END,
                 CASE WHEN @cs IS NULL AND @fs IS NULL THEN NULL ELSE GETDATE() END,
                 TRY_CONVERT(datetime, @sta, 126), @kws, @any, @mm, @tt, @tg)`)).recordset[0];
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/monitor-tags/:id/rule — แก้คำค้นในรายละเอียด / ไม่จำกัดหัวข้อ
app.put('/api/monitor-tags/:id/rule', authRequired, async (request, res) => {
  try {
    const kwList = monitorKeywords(request.body?.keywords);
    const anySub = !!request.body?.any_subject;
    if (anySub && !kwList.length) return res.status(400).json({ error: 'ไม่จำกัดหัวข้อ ต้องระบุคำค้นอย่างน้อย 1 คำ' });
    const out = await req().input('id', sql.Int, +request.params.id)
      .input('kw', sql.NVarChar, kwList.join(', ') || null).input('any', sql.Bit, anySub ? 1 : 0)
      .query(`UPDATE monitor_tags SET keywords=@kw, any_subject=@any OUTPUT INSERTED.keywords, INSERTED.any_subject WHERE id=@id`);
    if (!out.recordset.length) return res.status(404).json({ error: 'ไม่พบ Monitor Tag' });
    res.json(out.recordset[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/monitor-tags/:id/start — แก้วันที่เริ่ม monitor (กรณีทำรายการย้อนหลัง)
app.put('/api/monitor-tags/:id/start', authRequired, async (request, res) => {
  try {
    const v = String(request.body?.start_at || '').trim();
    const err = await monitorCheckStart(v);
    if (err) return res.status(400).json({ error: err });
    const out = await req().input('id', sql.Int, +request.params.id).input('st', sql.NVarChar, v + ':00')
      .query(`UPDATE monitor_tags SET start_at=TRY_CONVERT(datetime, @st, 126) OUTPUT INSERTED.start_at WHERE id=@id`);
    if (!out.recordset.length) return res.status(404).json({ error: 'ไม่พบ Monitor Tag' });
    res.json(out.recordset[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ประเภทของ Tag: command = แก้ด้วยคำสั่ง/Script ที่รันเอง · cron = แก้ด้วยงานตั้งเวลา (scheduled job)
const MONITOR_TAG_TYPES = ['command', 'cron'];
// กลุ่มของ Tag: problem = ปัญหาที่ติดตามว่าลดลงไหม · service = งาน IT Service ที่ร้านแจ้งเข้ามา (ดูโอกาสขายบริการ)
const MONITOR_TAG_GROUPS = ['problem', 'service'];

// PUT /api/monitor-tags/:id — จัดการ Tag: เปลี่ยนชื่อ / ประเภท
app.put('/api/monitor-tags/:id', authRequired, async (request, res) => {
  try {
    const id = +request.params.id, b = request.body || {};
    const tag = (await req().input('id', sql.Int, id).query('SELECT id, title, scope, status FROM monitor_tags WHERE id=@id')).recordset[0];
    if (!tag) return res.status(404).json({ error: 'ไม่พบ Monitor Tag' });
    const sets = [];
    const r = req().input('id', sql.Int, id);
    if ('title' in b) {
      const title = String(b.title || '').trim().slice(0, 300);
      if (!title) return res.status(400).json({ error: 'กรุณาตั้งชื่อ Tag' });
      // Tag กลางใช้ร่วมกันทุก License — ชื่อห้ามซ้ำกับ Tag กลางอื่นที่ยังเปิดอยู่
      if (tag.scope === 'global') {
        const dup = (await req().input('id', sql.Int, id).input('t', sql.NVarChar, title).query(
          `SELECT TOP 1 id FROM monitor_tags WHERE status='active' AND scope='global' AND title=@t AND id<>@id`)).recordset[0];
        if (dup) return res.status(409).json({ error: `มี Tag “${title}” อยู่แล้ว` });
      }
      r.input('t', sql.NVarChar, title); sets.push('title=@t');
    }
    if ('tag_type' in b) {
      const tt = b.tag_type || null;
      if (tt && !MONITOR_TAG_TYPES.includes(tt)) return res.status(400).json({ error: 'ประเภท Tag ไม่ถูกต้อง' });
      r.input('tt', sql.NVarChar, tt); sets.push('tag_type=@tt');
    }
    if ('tag_group' in b) {
      if (!MONITOR_TAG_GROUPS.includes(b.tag_group)) return res.status(400).json({ error: 'กลุ่ม Tag ไม่ถูกต้อง' });
      r.input('tg', sql.NVarChar, b.tag_group); sets.push('tag_group=@tg');
      if (b.tag_group === 'service' && !('tag_type' in b)) sets.push('tag_type=NULL');   // Command/Cron ใช้กับ Tag ปัญหาเท่านั้น
    }
    if (!sets.length) return res.status(400).json({ error: 'ไม่มีอะไรให้แก้' });
    const out = await r.query(`UPDATE monitor_tags SET ${sets.join(', ')} OUTPUT INSERTED.id, INSERTED.title, INSERTED.tag_type, INSERTED.tag_group WHERE id=@id`);
    res.json(out.recordset[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/monitor-tags/:id/scripts — Script ตรวจสอบ (check) / Script แก้ไข (fix) ของ tag
app.put('/api/monitor-tags/:id/scripts', authRequired, async (request, res) => {
  try {
    const b = request.body || {};
    const val = v => (v == null ? '' : String(v)).replace(/\s+$/, '').slice(0, 200000) || null;
    const out = await req()
      .input('id', sql.Int, +request.params.id)
      .input('cs', sql.NVarChar, val(b.check_script))
      .input('fs', sql.NVarChar, val(b.fix_script))
      .input('by', sql.NVarChar, request.user?.username || null)
      .query(`UPDATE monitor_tags SET check_script=@cs, fix_script=@fs, scripts_updated_by=@by, scripts_updated_at=GETDATE()
              OUTPUT INSERTED.check_script, INSERTED.fix_script, INSERTED.scripts_updated_by, INSERTED.scripts_updated_at
              WHERE id=@id`);
    if (!out.recordset.length) return res.status(404).json({ error: 'ไม่พบ Monitor Tag' });
    res.json(out.recordset[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/monitor-tags/:id/files?kind=check|fix — แนบไฟล์ script
app.post('/api/monitor-tags/:id/files', authRequired, mtUpload.array('files', 10), async (request, res) => {
  const files = request.files || [];
  try {
    const id = parseInt(request.params.id);
    const kind = request.query.kind === 'fix' ? 'fix' : 'check';
    const tag = (await req().input('id', sql.Int, id).query('SELECT id FROM monitor_tags WHERE id=@id')).recordset[0];
    if (!tag) { files.forEach(f => fs.unlink(f.path, () => {})); return res.status(404).json({ error: 'ไม่พบ Monitor Tag' }); }
    if (!files.length) return res.status(400).json({ error: `ไม่พบไฟล์ หรือชนิดไฟล์ไม่รองรับ (${[...MT_SCRIPT_EXT].join(' ')})` });
    const inserted = [];
    for (const f of files) {
      const r = await req()
        .input('tid', sql.Int, id).input('k', sql.NVarChar, kind)
        .input('fn', sql.NVarChar, f.filename).input('on', sql.NVarChar, fixUploadName(f.originalname))
        .input('fz', sql.Int, f.size).input('by', sql.NVarChar, request.user?.username || null)
        .query(`INSERT INTO monitor_tag_files (tag_id, kind, filename, original_name, file_size, created_by)
                OUTPUT INSERTED.id, INSERTED.tag_id, INSERTED.kind, INSERTED.original_name, INSERTED.file_size, INSERTED.created_by, INSERTED.created_at
                VALUES (@tid, @k, @fn, @on, @fz, @by)`);
      inserted.push(r.recordset[0]);
    }
    res.json({ ok: true, files: inserted });
  } catch (e) {
    files.forEach(f => fs.unlink(f.path, () => {}));
    res.status(500).json({ error: e.message });
  }
});

// GET /api/monitor-tags/files/:fid — ดาวน์โหลดไฟล์ script (ต้อง login)
app.get('/api/monitor-tags/files/:fid', authRequired, async (request, res) => {
  try {
    const f = (await req().input('id', sql.Int, +request.params.fid)
      .query('SELECT * FROM monitor_tag_files WHERE id=@id')).recordset[0];
    if (!f) return res.status(404).json({ error: 'ไม่พบไฟล์' });
    const fp = path.join(UPLOAD_DIR, 'monitor', String(f.tag_id), path.basename(f.filename));
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'ไฟล์หายจาก server' });
    res.setHeader('Content-Type', 'application/octet-stream');   // ไม่ให้ browser รันหรือเปิด inline
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/monitor-tags/files/:fid
app.delete('/api/monitor-tags/files/:fid', authRequired, async (request, res) => {
  try {
    const f = (await req().input('id', sql.Int, +request.params.fid)
      .query('SELECT * FROM monitor_tag_files WHERE id=@id')).recordset[0];
    if (!f) return res.status(404).json({ error: 'ไม่พบไฟล์' });
    fs.unlink(path.join(UPLOAD_DIR, 'monitor', String(f.tag_id), path.basename(f.filename)), () => {});
    await req().input('id', sql.Int, f.id).query('DELETE FROM monitor_tag_files WHERE id=@id');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/monitor-tags/:id/resolve — ปลด tag เมื่อแก้ปัญหาจบแล้ว (ตัวเลขจะหยุดนับที่วันปิด)
app.put('/api/monitor-tags/:id/resolve', authRequired, async (request, res) => {
  try {
    const out = await req()
      .input('id', sql.Int, +request.params.id)
      .input('by', sql.NVarChar, request.user?.username || null)
      .input('nt', sql.NVarChar, String(request.body?.note || '').trim().slice(0, 4000) || null)
      .query(`UPDATE monitor_tags SET status='resolved', resolved_by=@by, resolved_at=GETDATE(), resolve_note=@nt
              WHERE id=@id AND status='active'`);
    if (!out.rowsAffected[0]) return res.status(404).json({ error: 'ไม่พบ Tag ที่ยังเปิดอยู่' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    // Multi-bot list (mask tokens)
    let bots = [];
    try {
      bots = (await req().query(`SELECT id, name, channel_token, active FROM line_bots ORDER BY id`)).recordset
        .map(b => {
          const tk = b.channel_token || '';
          return { id: b.id, name: b.name, active: !!b.active, has_token: !!tk,
                   token: tk.length >= 8 ? tk.slice(0,4)+'****'+tk.slice(-4) : (tk ? '****' : null) };
        });
    } catch { /* table not ready */ }
    res.json({ token: maskedToken, has_token: !!rawToken, targets, bots });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LINE Bots (multiple LINE OA tokens) ───────────────────
// GET /api/settings/line/bots
app.get('/api/settings/line/bots', authRequired, async (_, res) => {
  try {
    const bots = (await req().query(`SELECT id, name, channel_token, active FROM line_bots ORDER BY id`)).recordset
      .map(b => {
        const tk = b.channel_token || '';
        return { id: b.id, name: b.name, active: !!b.active, has_token: !!tk,
                 token: tk.length >= 8 ? tk.slice(0,4)+'****'+tk.slice(-4) : (tk ? '****' : null) };
      });
    res.json(bots);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/settings/line/bots  { name, channel_token }
app.post('/api/settings/line/bots', authRequired, managerRequired, async (request, res) => {
  try {
    const { name, channel_token } = request.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อบอท' });
    const r = await req()
      .input('nm', sql.NVarChar, name.trim())
      .input('tk', sql.NVarChar, channel_token?.trim() || null)
      .query(`INSERT INTO line_bots (name, channel_token) OUTPUT INSERTED.id VALUES (@nm, @tk)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/settings/line/bots/:id  { name?, channel_token?, active? }
// channel_token only updated when a non-empty value is provided (keeps existing otherwise)
app.put('/api/settings/line/bots/:id', authRequired, managerRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const { name, channel_token, active } = request.body || {};
    let r = req().input('id', sql.Int, id);
    const sets = [];
    if (name !== undefined)   { r = r.input('nm', sql.NVarChar, name?.trim() || null); sets.push('name=@nm'); }
    if (channel_token)        { r = r.input('tk', sql.NVarChar, channel_token.trim()); sets.push('channel_token=@tk'); }
    if (active !== undefined) { r = r.input('act', sql.Bit, active ? 1 : 0); sets.push('active=@act'); }
    if (!sets.length) return res.json({ ok: true });
    await r.query(`UPDATE line_bots SET ${sets.join(',')} WHERE id=@id`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/settings/line/bots/:id  (targets pointing here fall back to default bot)
app.delete('/api/settings/line/bots/:id', authRequired, managerRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    await req().input('id', sql.Int, id).query(`UPDATE line_notify_targets SET bot_id=NULL WHERE bot_id=@id`);
    await req().input('id', sql.Int, id).query(`DELETE FROM line_bots WHERE id=@id`);
    res.json({ ok: true });
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
    const { name, group_id, events, serve_types, project_ids, bot_id, pod_ids } = request.body;
    if (!name?.trim()) return res.status(400).json({ error: 'กรุณาระบุชื่อกลุ่ม' });
    if (!group_id?.trim()) return res.status(400).json({ error: 'กรุณาระบุ Group ID' });
    const eventsStr    = Array.isArray(events)      ? events.join(',')      : (events      || null);
    const serveTypeStr = Array.isArray(serve_types) ? serve_types.join(',') : (serve_types || null);
    const projIdsStr   = Array.isArray(project_ids) ? project_ids.join(',') : (project_ids || null);
    const podIdsStr    = parsePodIds(Array.isArray(pod_ids) ? pod_ids.join(',') : pod_ids).join(',') || null;
    const minWaitVal   = Math.max(0, parseInt(request.body?.min_wait_min) || 0) || null;
    const r = await req()
      .input('nm',  sql.NVarChar, name.trim())
      .input('gid', sql.NVarChar, group_id.trim())
      .input('ev',  sql.NVarChar, eventsStr || null)
      .input('st',  sql.NVarChar, serveTypeStr || null)
      .input('pi',  sql.NVarChar, projIdsStr || null)
      .input('bid', sql.Int,      bot_id ? parseInt(bot_id) : null)
      .input('pod', sql.NVarChar, podIdsStr)
      .input('mw',  sql.Int,      minWaitVal)
      .query(`INSERT INTO line_notify_targets (name, group_id, events, serve_types, project_ids, bot_id, pod_ids, min_wait_min)
              OUTPUT INSERTED.id VALUES (@nm, @gid, @ev, @st, @pi, @bid, @pod, @mw)`);
    res.json({ id: r.recordset[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/settings/line/targets/:id
app.put('/api/settings/line/targets/:id', authRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    const { name, group_id, events, serve_types, project_ids, active, bot_id, pod_ids } = request.body;
    const eventsStr    = Array.isArray(events)      ? events.join(',')      : (events      ?? null);
    const serveTypeStr = Array.isArray(serve_types) ? serve_types.join(',') : (serve_types ?? null);
    const projIdsStr   = Array.isArray(project_ids) ? project_ids.join(',') : (project_ids ?? null);
    const podIdsStr    = parsePodIds(Array.isArray(pod_ids) ? pod_ids.join(',') : pod_ids).join(',') || null;
    const minWaitVal   = Math.max(0, parseInt(request.body?.min_wait_min) || 0) || null;
    await req()
      .input('id',  sql.Int,      id)
      .input('nm',  sql.NVarChar, name?.trim() || null)
      .input('gid', sql.NVarChar, group_id?.trim() || null)
      .input('ev',  sql.NVarChar, eventsStr)
      .input('st',  sql.NVarChar, serveTypeStr)
      .input('pi',  sql.NVarChar, projIdsStr)
      .input('act', sql.Bit,      active !== undefined ? (active ? 1 : 0) : 1)
      .input('bid', sql.Int,      bot_id ? parseInt(bot_id) : null)
      .input('pod', sql.NVarChar, podIdsStr)
      .input('mw',  sql.Int,      minWaitVal)
      .query(`UPDATE line_notify_targets SET name=COALESCE(@nm,name), group_id=COALESCE(@gid,group_id),
              events=@ev, serve_types=@st, project_ids=@pi, active=@act, bot_id=@bid,
              pod_ids=@pod, min_wait_min=@mw
              WHERE id=@id`);
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
    const token = await resolveTargetToken(target);
    if (!token) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Channel Access Token' });

    // If this group is subscribed to the employee-schedule summary, the test
    // sweeps today's real calendar data and sends the actual summary.
    const evs = (target.events || '').split(',').map(s => s.trim());
    let msg;
    if (evs.includes('empcal_summary')) {
      const today = bangkokToday();
      const { data, stale } = await empcalDataForSend(today);   // refresh ก่อนส่งเช่นเดียวกับ auto-send
      msg = data.eventCount ? formatEmpcalLine(data, { stale }) : `🗓️ ตารางงานพนักงาน ${today}\n(ไม่มีข้อมูลงานวันนี้)`;
    } else if (evs.includes('triage_alert')) {
      // ทดสอบด้วยข้อความจริง — ถ้ากลุ่มนี้ผูก Pod ไว้ ให้เห็นเฉพาะของ Pod ตัวเอง
      const a = await buildTriageAlert();
      const ids  = parsePodIds(target.pod_ids);
      const minW = targetMinWait(target);
      if (ids.length) {
        const sub = triageAlertForPods(a, ids, target.name, minW);
        const names = ids.map(id => podLabel(a, id));
        msg = sub ? sub.text : `✅ [${names.join(' · ')}] ไม่มี ticket ค้างที่ต้องรีบ`;
      } else if (minW > 0) {
        const sub = formatTriageAlert(a.items || [], null, false, minW);
        msg = sub.hasAny ? sub.text : `✅ ไม่มี ticket ค้างเกิน ${minW} นาที`;
      } else {
        msg = a.text;
      }
    } else {
      msg = `🔔 ทดสอบการแจ้งเตือน\nCS Team App — ส่งถึง: ${target.name}\n${new Date().toLocaleString('th-TH')}`;
    }
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
// Only these 2 statuses are tracked in the digest — grouped by status, then by assignee
const FU_DIGEST_STATUSES = [
  { key: 'pending',     label: 'รอดำเนินการ' },
  { key: 'in_progress', label: 'กำลังตรวจสอบ' },
];

function fmtDigestPlanDate(d) {
  if (!d) return 'ยังไม่มีแผน Release';
  const dt = new Date(String(d).replace('Z',''));
  return `${dt.getDate()}.${dt.getMonth()+1}.${dt.getFullYear()}`;
}

function fmtDigestOverdue(d) {
  if (!d) return '';
  const due = new Date(String(d).replace('Z','')); due.setHours(0,0,0,0);
  const now = new Date(); now.setHours(0,0,0,0);
  const days = Math.floor((now - due) / 86400000);
  return days > 0 ? ` เลยกำหนดมาแล้ว ${days} วัน` : '';
}

async function sendFollowUpDigest() {
  try {
    const rows = (await req().query(`
      SELECT i.id, COALESCE(i.golive_date, i.release_date) AS plan_date, i.status,
             ISNULL(e.nickname, e.name) AS assigned_to_name
      FROM fu_issues i
      LEFT JOIN app_users au ON au.id = i.assigned_to
      LEFT JOIN employees e  ON e.id  = au.employee_id
      WHERE i.status IN ('pending','in_progress')
      ORDER BY plan_date ASC`)).recordset;

    if (!rows.length) return; // ไม่มีอะไร ไม่ส่ง

    const dateStr = new Date().toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric'});
    let msg = `📋 Follow Up สรุปรายวัน — ${dateStr}\n`;

    for (const st of FU_DIGEST_STATUSES) {
      const items = rows.filter(r => r.status === st.key);
      if (!items.length) continue;

      msg += `\n${st.label}\n`;
      const byAssignee = {};
      items.forEach(r => {
        const name = r.assigned_to_name || 'ยังไม่มอบหมาย';
        (byAssignee[name] = byAssignee[name] || []).push(r);
      });
      Object.keys(byAssignee).sort().forEach(name => {
        msg += `${name}\n`;
        msg += byAssignee[name]
          .map(r => `#${r.id} , ${fmtDigestPlanDate(r.plan_date)}${fmtDigestOverdue(r.plan_date)}`)
          .join('\n') + '\n';
      });
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
  // Add announce column — controls whether the post auto-pops as an announcement
  await getPool().request().query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('news_posts') AND name='announce')
      ALTER TABLE news_posts ADD announce BIT NOT NULL DEFAULT 1`);
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
      SELECT id, title, body, category, author_id, author_name, pinned, announce, links,
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
                     INSERTED.author_id,INSERTED.author_name,INSERTED.pinned,INSERTED.announce,
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

// Toggle announce — stop/resume the auto-popup announcement for a post
app.put('/api/news/:id/announce', authRequired, leadRequired, async (request, res) => {
  try {
    const id = parseInt(request.params.id);
    await req().input('id', sql.Int, id)
      .query('UPDATE news_posts SET announce=CASE WHEN announce=1 THEN 0 ELSE 1 END WHERE id=@id');
    const row = (await req().input('id', sql.Int, id)
      .query('SELECT announce FROM news_posts WHERE id=@id')).recordset[0];
    res.json({ announce: row?.announce ?? 1 });
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
  await ensureMonitorTagTables();
  await ensureApiTables();
  await ensureAiImpactTables();
  mtAcceptPending().then(n => { if (n) console.log(`🏷️ monitor-suggest: ติด Tag ให้รายการที่ค้างรอยืนยัน ${n} รายการ`); })
    .catch(e => console.error('[monitor-suggest] accept pending:', e.message));
  await ensureFollowupTable();
  await ensureFollowupV2Tables();
  await ensureShopInfoTables();
  await ensureShopEntriesTable();
  await ensureShopKnowledgeTable();
  await ensureLineNotifyTable();
  await ensureEmpcalLogTable();
  await ensureServiceRequestsTable();
  await ensureServiceProjectsTable();
  await ensureServiceAttachmentsTable();
  await ensureCaseAttachmentsTable();
  await ensureSwUpdateTable();
  await ensureImplRequestTables();
  await ensureUatTables();
  await ensureTriageScreenTable();
  await ensureTriageSettingsTable();
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
