require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const admin = require('firebase-admin');

for (const k of ['VIKEY_BASE_URL', 'VIKEY_API_KEY', 'ADMIN_USER', 'ADMIN_PASS']) {
  if (!process.env[k]) console.warn(`[config] ${k} belum diisi.`);
}
const MAX_MESSAGE_CHARS = 12000;
const AUDIO_COST = Math.max(1, parseInt(process.env.AUDIO_CREDIT_COST || '10', 10) || 10);
const AUDIO_EXTS = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm']);
const inFlight = new Set(); // 1 request chat per user: cegah saldo dipakai paralel

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// ==========================================
// 0. FIREBASE ADMIN
// ==========================================
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try { return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT bukan JSON valid.'); }
  }
  try { return require('./serviceAccountKey.json'); } catch (e) { throw new Error('Service account tidak ditemukan.'); }
}
admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });

async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Akses ditolak. Silakan login.' });
  try {
    req.user = await admin.auth().verifyIdToken(authHeader.slice(7));
    next();
  } catch (error) {
    res.status(401).json({ error: 'Sesi login tidak valid. Silakan login ulang.' });
  }
}

// ==========================================
// 1. DATABASE (SQLITE)
// ==========================================
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
  : path.join(__dirname, 'database.sqlite');

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    uid TEXT PRIMARY KEY, 
    email TEXT, 
    credit_balance INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS redeem_codes (
    code TEXT PRIMARY KEY, 
    credit_amount INTEGER NOT NULL DEFAULT 0, 
    is_used BOOLEAN DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, model_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    credit_deducted INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_credit_tx_uid ON credit_transactions (uid, id DESC);
  CREATE TABLE IF NOT EXISTS lite_usage (uid TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, day));
`);

const SIGNUP_CREDITS = Math.max(0, parseInt(process.env.SIGNUP_CREDITS || '0', 10) || 0);


function getOrCreateUser(uid, email) {
  db.prepare(`INSERT INTO users (uid, email, credit_balance) VALUES (?, ?, ?)
              ON CONFLICT(uid) DO UPDATE SET email = COALESCE(excluded.email, users.email)`).run(uid, email || null, SIGNUP_CREDITS);
  return db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
}

// ==========================================
// 2. DAFTAR MODEL & HARGA (SESUAI VIKEY)
// ==========================================
const MAX_SKILLS = 3;
const MAX_SKILL_CHARS = 100000;
const MAX_SKILL_TOTAL = 120000;
const MAX_FILE_CONTEXT_CHARS = 40000; 
const MAX_PERSONA_CHARS = 1000;
const MAX_HISTORY_MESSAGES = 6;

function buildSkillsPrompt(skills) {
  if (!Array.isArray(skills)) return '';
  let total = 0;
  const parts = [];
  for (const s of skills.slice(0, MAX_SKILLS)) {
    if (!s || typeof s.instructions !== 'string') continue;
    const body = s.instructions.trim().slice(0, MAX_SKILL_CHARS);
    if (!body || total + body.length > MAX_SKILL_TOTAL) continue;
    total += body.length;
    parts.push(`### Skill: ${String(s.name || 'Skill').slice(0, 60)}\n${s.description ? `Kapan dipakai: ${String(s.description).slice(0, 200)}\n` : ''}${body}`);
  }
  return parts.length ? `SKILL AKTIF:\nGunakan skill di bawah hanya jika relevan dengan permintaan user.\n\n${parts.join('\n\n')}` : '';
}

const MODEL_PRICING = {
  // DeepSeek (Murah)
  'deepseek/deepseek-v4-flash':   { in: 5,  out: 10 }, 
  'deepseek/deepseek-v4.1-flash': { in: 5,  out: 25 }, 
  'deepseek/deepseek-v4-pro':     { in: 8,  out: 20 }, 
  // GLM-5.3 (Vikey: 1.350 / 4.500)
  'glm/glm-5.3-flash':            { in: 8,  out: 25 }, 
  // GPT-6 Luna (Vikey: 720 / 3.600)
  'gpt/gpt-6-luna':               { in: 5,  out: 20 }, 
};

const ALLOWED_MODELS = {
  'deepseek-lite':                { type: 'lite',     provider: 'groq', upstreamModel: 'openai/gpt-oss-120b', label: 'DeepSeek Lite' },
  'deepseek/deepseek-v4-flash':   { type: 'deepseek', label: 'DeepSeek V4 Flash' },
  'deepseek/deepseek-v4.1-flash': { type: 'deepseek', label: 'DeepSeek V4.1 Flash' },
  'deepseek/deepseek-v4-pro':     { type: 'deepseek', label: 'DeepSeek V4 Pro' },
  'glm/glm-5.3-flash':            { type: 'glm',      label: 'GLM-5.3 Flash' },
  'gpt/gpt-6-luna':               { type: 'gpt',      label: 'GPT-6 Luna' },
};

const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);

function computeCost(modelId, inTok, outTok) {
  const price = MODEL_PRICING[modelId];
  if (!price) return 0;
  return Math.max(1, Math.ceil((inTok * price.in + outTok * price.out) / 1000));
}

const chargeUser = db.transaction((uid, modelId, inTok, outTok, cost) => {
  const row = db.prepare('SELECT credit_balance FROM users WHERE uid = ?').get(uid);
  if (!row) return { deducted: 0, balance: 0 };
  const deducted = Math.min(cost, row.credit_balance);
  db.prepare('UPDATE users SET credit_balance = credit_balance - ? WHERE uid = ?').run(deducted, uid);
  db.prepare(`INSERT INTO credit_transactions (uid, model_id, input_tokens, output_tokens, credit_deducted, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(uid, modelId, inTok, outTok, deducted, new Date().toISOString());
  return { deducted, balance: row.credit_balance - deducted };
});

// LITE (GROQ) HELPER
const LITE_DAILY_QUOTA = 20;
const todayWIB = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
function reserveLite(uid) {
  const day = todayWIB();
  db.prepare('INSERT OR IGNORE INTO lite_usage (uid, day, count) VALUES (?, ?, 0)').run(uid, day);
  const r = db.prepare('UPDATE lite_usage SET count = count + 1 WHERE uid = ? AND day = ? AND count < ?').run(uid, day, LITE_DAILY_QUOTA);
  return r.changes > 0 ? day : null;
}
function refundLite(uid, day) { db.prepare('UPDATE lite_usage SET count = MAX(count - 1, 0) WHERE uid = ? AND day = ?').run(uid, day); }


// ==========================================
// 3. MIDDLEWARE & ADMIN
// ==========================================
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.get('/admin.html', (req, res) => res.redirect('/panel-rahasia'));
app.use(express.static(path.join(__dirname, 'public')));

const safeEqual = (a, b) => {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const adminSessionToken = () => crypto.createHmac('sha256', String(process.env.ADMIN_PASS || '')).update('deepchat-admin-session').digest('hex');

const isAdmin = (req, res, next) => {
  const ok = process.env.ADMIN_PASS && safeEqual(req.cookies.admin_session || '', adminSessionToken());
  if (ok) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Sesi admin habis.' });
  res.redirect('/admin-login.html');
};

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.' } });
const redeemLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 15, keyGenerator: (req) => req.user?.uid || req.ip, message: { error: 'Terlalu banyak percobaan kode. Coba lagi nanti.' } });

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (process.env.ADMIN_USER && process.env.ADMIN_PASS && safeEqual(username, process.env.ADMIN_USER) && safeEqual(password, process.env.ADMIN_PASS)) {
    res.cookie('admin_session', adminSessionToken(), { maxAge: 86400000, httpOnly: true, sameSite: 'lax', secure: req.secure });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Username atau Password salah!' });
  }
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('admin_session'); res.json({ success: true }); });
app.get('/panel-rahasia', isAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin/generate', isAdmin, (req, res) => {
  try {
    const prefix = String(req.body?.prefix || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24);
    const qty = Number(req.body?.amount);
    if (req.body?.code && !req.body?.prefix) return res.status(400).json({ error: 'admin.html versi lama. Ganti dengan admin.html terbaru, lalu refresh (Ctrl+F5).' });
    if (!prefix || !Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'Data tidak lengkap.' });
    const code = `${prefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    db.prepare('INSERT INTO redeem_codes (code, credit_amount) VALUES (?, ?)').run(code, qty);
    res.json({ message: 'Kode berhasil dibuat!', code });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return res.status(400).json({ error: 'Kode sudah ada.' });
    res.status(500).json({ error: 'Gagal membuat kode.' });
  }
});

// ==========================================
// 4. CHAT AI (CORE LOGIC)
// ==========================================
const userLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100, 
  keyGenerator: (req) => req.user.uid,
  message: { error: 'Terlalu banyak request. Coba lagi besok.' }
});

app.post('/api/chat', verifyFirebaseToken, userLimiter, async (req, res) => {
  const { uid, email } = req.user;
  if (inFlight.has(uid)) return res.status(429).json({ error: 'Tunggu balasan sebelumnya selesai dulu.' });
  inFlight.add(uid);
  let refundAction = null;

  try {
    const user = getOrCreateUser(uid, email);
    const { modelId, persona, fileContext, fileName, skills } = req.body || {};
    const model = modelId || req.body?.model;
    const modelConfig = ALLOWED_MODELS[model];
    if (!modelConfig) return res.status(400).json({ error: 'Model tidak tersedia.' });

    let rawMessages = (Array.isArray(req.body.messages) ? req.body.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
    if (rawMessages.length > MAX_HISTORY_MESSAGES) rawMessages = rawMessages.slice(rawMessages.length - MAX_HISTORY_MESSAGES);
    const messages = rawMessages;
    if (messages.length === 0) return res.status(400).json({ error: 'Pesan kosong.' });

    const isGroq = modelConfig.provider === 'groq';

    // --- CEK SALDO / KUOTA LITE ---
    if (isGroq) {
      if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'DeepSeek Lite belum dikonfigurasi.' });
      const liteDay = reserveLite(uid);
      if (!liteDay) return res.status(403).json({ error: `Kuota gratis DeepSeek Lite hari ini habis (${LITE_DAILY_QUOTA}/hari).` });
      refundAction = () => refundLite(uid, liteDay);
    } else {
      if (user.credit_balance < 1) return res.status(403).json({ error: 'Saldo habis. Silakan Top Up.' });
    }

    // --- SUSUN PROMPT ---
    const finalMessages = [];
    if (persona?.trim()) finalMessages.push({ role: 'system', content: `Persona: ${persona.trim().slice(0, MAX_PERSONA_CHARS)}.` });
    finalMessages.push({
      role: 'system',
      content: `ATURAN: 1. Kamu adalah ${modelConfig.label}. 2. Gaya bahasa santai, natural. 3. Kodingan langsung blok kode. 4. Jangan ulangi pertanyaan user.`
    });
    const skillsPrompt = buildSkillsPrompt(skills);
    if (skillsPrompt) finalMessages.push({ role: 'system', content: skillsPrompt });
    if (fileContext?.trim()) finalMessages.push({ role: 'system', content: `File ${fileName ? `(${fileName})` : ''}:\n---\n${fileContext.slice(0, MAX_FILE_CONTEXT_CHARS)}\n---` });
    finalMessages.push(...messages);

    // --- TEMBAK API ---
    const upstream = isGroq
      ? { url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: modelConfig.upstreamModel, name: 'Groq' }
      : { url: `${process.env.VIKEY_BASE_URL}/chat/completions`, key: process.env.VIKEY_API_KEY, model: model, name: 'Vikey' };

    const apiResponse = await fetch(upstream.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${upstream.key}` },
      body: JSON.stringify({ model: upstream.model, messages: finalMessages, max_tokens: 10000, temperature: 0.7 }),
      signal: AbortSignal.timeout(120000)
    });

    const data = await apiResponse.json().catch(() => ({}));
    if (!apiResponse.ok) throw new Error(`Layanan AI sedang bermasalah (${apiResponse.status}). Coba lagi.`);

    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') throw new Error(`Balasan API ${upstream.name} tidak valid.`);

    refundAction = null;

    // --- HITUNG BIAYA & POTONG SALDO ---
    if (isGroq) {
      return res.json({ reply, cost: 0, remaining_balance: user.credit_balance });
    }

    const usage = data.usage || {};
    const inTok = Number(usage.prompt_tokens) || estimateTokens(JSON.stringify(finalMessages));
    const outTok = Number(usage.completion_tokens) || estimateTokens(reply);
    const cost = computeCost(model, inTok, outTok);
    
    const { deducted, balance } = chargeUser(uid, model, inTok, outTok, cost);
    res.json({ reply, cost: deducted, remaining_balance: balance });

  } catch (error) {
    console.error('Chat Error:', error);
    if (refundAction) { try { refundAction(); } catch (e) {} }
    res.status(500).json({ error: error.name === 'TimeoutError' ? 'AI terlalu lama menjawab.' : 'Terjadi kesalahan server. Coba lagi.' });
  } finally {
    inFlight.delete(uid);
  }
});

// TRANSKRIP AUDIO (Groq Whisper). Kredit dipotong hanya kalau berhasil.
const transcribeLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 20, keyGenerator: (req) => req.user.uid, message: { error: 'Batas transkrip harian tercapai. Coba lagi besok.' } });
app.post('/api/transcribe', verifyFirebaseToken, transcribeLimiter, express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const { uid, email } = req.user;
  try {
    if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Transkrip audio belum dikonfigurasi.' });
    const name = decodeURIComponent(String(req.get('x-file-name') || 'audio.mp3')).slice(-120);
    if (!AUDIO_EXTS.has(name.split('.').pop().toLowerCase())) return res.status(400).json({ error: 'Format audio tidak didukung.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'File kosong.' });
    const user = getOrCreateUser(uid, email);
    if (user.credit_balance < AUDIO_COST) return res.status(403).json({ error: `Saldo kurang. Transkrip audio butuh ${AUDIO_COST} kredit.` });

    const form = new FormData();
    form.append('file', new Blob([req.body]), name);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form, signal: AbortSignal.timeout(120000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || typeof data.text !== 'string') throw new Error(`Groq ${r.status}`);

    const { balance } = chargeUser(uid, 'whisper-large-v3-turbo', 0, 0, AUDIO_COST);
    res.json({ text: data.text, cost: AUDIO_COST, remaining_balance: balance });
  } catch (error) {
    console.error('Transcribe Error:', error);
    res.status(500).json({ error: error.name === 'TimeoutError' ? 'Transkrip terlalu lama.' : 'Transkrip gagal. Coba lagi.' });
  }
});

// ==========================================
// 5. ENDPOINT BILLING & REDEEM
// ==========================================
app.get('/api/billing/me', verifyFirebaseToken, (req, res) => {
  try {
    const user = getOrCreateUser(req.user.uid, req.user.email);
    res.json({ balance: user.credit_balance, audio_cost: AUDIO_COST });
  } catch (error) { res.status(500).json({ error: 'Gagal mengambil saldo.' }); }
});

app.get('/api/billing/transactions', verifyFirebaseToken, (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const transactions = db.prepare(`SELECT created_at, model_id, input_tokens, output_tokens, credit_deducted
                                     FROM credit_transactions WHERE uid = ? ORDER BY id DESC LIMIT ?`).all(req.user.uid, limit);
    res.json({ transactions });
  } catch (error) { res.status(500).json({ error: 'Gagal mengambil riwayat.' }); }
});

app.post('/api/redeem', verifyFirebaseToken, redeemLimiter, (req, res) => {
  try {
    const { uid, email } = req.user;
    const code = req.body?.code;
    if (!code) return res.status(400).json({ error: 'Kode wajib diisi.' });
    const upperCode = String(code).toUpperCase().trim();

    const redeemTx = db.transaction(() => {
      const mark = db.prepare('UPDATE redeem_codes SET is_used = 1 WHERE code = ? AND is_used = 0 AND credit_amount > 0').run(upperCode);
      if (mark.changes === 0) return null;
      const voucher = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(upperCode);
      getOrCreateUser(uid, email);
      db.prepare('UPDATE users SET credit_balance = credit_balance + ? WHERE uid = ?').run(voucher.credit_amount, uid);
      return voucher;
    });

    const voucher = redeemTx();
    if (!voucher) return res.status(400).json({ error: 'Kode tidak valid atau sudah dipakai.' });
    res.json({ message: 'Kode berhasil ditukar!', added: voucher.credit_amount });
  } catch (error) { res.status(500).json({ error: 'Terjadi kesalahan server.' }); }
});

// ==========================================
// 6. JALANKAN SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server jalan di port ${PORT}`);
});