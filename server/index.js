const express = require('express');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const admin = require('firebase-admin');
require('dotenv').config();

// ==========================================
// 0. SETUP FIREBASE ADMIN
// ==========================================
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Middleware Verifikasi Token (Wajib buat endpoint yang butuh login)
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Akses ditolak. Silakan login.' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Dapet uid, email, dll
    next();
  } catch (error) {
    console.error('Token Error:', error);
    res.status(401).json({ error: 'Sesi login tidak valid. Silakan login ulang.' });
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. SETUP DATABASE (PAKAI UID, BUKAN IP)
// ==========================================
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite') 
  : path.join(__dirname, 'database.sqlite');

console.log(`Menggunakan database di: ${dbPath}`);
const db = new Database(dbPath);

// HAPUS tabel lama kalau ada (karena struktur berubah dari ip ke uid)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, email TEXT, deepseek_limit INTEGER DEFAULT 5, gpt_limit INTEGER DEFAULT 0, glm_limit INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS redeem_codes (code TEXT PRIMARY KEY, deepseek_amount INTEGER DEFAULT 0, gpt_amount INTEGER DEFAULT 0, glm_amount INTEGER DEFAULT 0, is_used BOOLEAN DEFAULT 0);
`);

// Kuota gratis harian per UID
db.exec(`CREATE TABLE IF NOT EXISTS lite_usage (uid TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, day));`);
const LITE_DAILY_QUOTA = 20;
const todayWIB = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function reserveLite(uid) {
  const day = todayWIB();
  db.prepare('INSERT OR IGNORE INTO lite_usage (uid, day, count) VALUES (?, ?, 0)').run(uid, day);
  const r = db.prepare('UPDATE lite_usage SET count = count + 1 WHERE uid = ? AND day = ? AND count < ?').run(uid, day, LITE_DAILY_QUOTA);
  return r.changes > 0 ? day : null;
}
function refundLite(uid, day) {
  db.prepare('UPDATE lite_usage SET count = MAX(count - 1, 0) WHERE uid = ? AND day = ?').run(uid, day);
}

// (Kode default redeem_codes tetap sama)
const checkCodes = db.prepare('SELECT COUNT(*) as count FROM redeem_codes').get();
if (checkCodes.count === 0) {
  const insertCode = db.prepare('INSERT INTO redeem_codes (code, deepseek_amount, gpt_amount, glm_amount) VALUES (?, ?, ?, ?)');
  insertCode.run('DEEPCHAT-10', 10, 0, 0);
  insertCode.run('COMBO-SULTAN', 50, 10, 10);
}

// ==========================================
// 2. DAFTAR MODEL & SKILL HELPER
// ==========================================
const MAX_SKILLS = 3;
const MAX_SKILL_CHARS = 6000;
const MAX_SKILL_TOTAL = 12000;

function buildSkillsPrompt(skills) {
  if (!Array.isArray(skills)) return '';
  let total = 0;
  const parts = [];
  for (const s of skills.slice(0, MAX_SKILLS)) {
    if (!s || typeof s.instructions !== 'string') continue;
    const body = s.instructions.trim().slice(0, MAX_SKILL_CHARS);
    if (!body || total + body.length > MAX_SKILL_TOTAL) continue;
    total += body.length;
    const name = String(s.name || 'Skill').slice(0, 60);
    const desc = String(s.description || '').slice(0, 200);
    parts.push(`### Skill: ${name}\n${desc ? `Kapan dipakai: ${desc}\n` : ''}${body}`);
  }
  if (parts.length === 0) return '';
  return `SKILL AKTIF:\nGunakan skill di bawah hanya jika relevan dengan permintaan user.\n\n${parts.join('\n\n')}`;
}

const ALLOWED_MODELS = {
  'deepseek-lite':                { type: 'lite',     cost: 0, provider: 'groq', upstreamModel: 'openai/gpt-oss-120b' },
  'deepseek/deepseek-v4-flash':   { type: 'deepseek', cost: 1 },
  'deepseek/deepseek-v4-pro':     { type: 'deepseek', cost: 1 },
  'deepseek/deepseek-v4.1-flash': { type: 'deepseek', cost: 1 },
  'gpt/gpt-6-luna':               { type: 'gpt',      cost: 1 },
  'glm/glm-5.3-flash':            { type: 'glm',      cost: 1 },
};

// ==========================================
// 3. MIDDLEWARE & ROUTING
// ==========================================
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/admin-login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

const isAdmin = (req, res, next) => {
  if (req.cookies.admin_session === process.env.ADMIN_PASS) next(); 
  else res.redirect('/admin-login.html');
};

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    res.cookie('admin_session', process.env.ADMIN_PASS, { maxAge: 86400000, httpOnly: true });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Username atau Password salah!' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.json({ success: true });
});

app.get('/panel-rahasia', isAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin/generate', isAdmin, (req, res) => {
  try {
    const { code, model, amount } = req.body;
    if (!code || !model || !amount) return res.status(400).json({ error: 'Data tidak lengkap.' });
    let ds = 0, gpt = 0, glm = 0;
    if (model === 'deepseek') ds = amount;
    else if (model === 'gpt') gpt = amount;
    else if (model === 'glm') glm = amount;
    db.prepare('INSERT INTO redeem_codes (code, deepseek_amount, gpt_amount, glm_amount) VALUES (?, ?, ?, ?)').run(code, ds, gpt, glm);
    res.json({ message: 'Kode berhasil dibuat!', code });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return res.status(400).json({ error: 'Kode sudah ada.' });
    res.status(500).json({ error: 'Gagal membuat kode.' });
  }
});

// ==========================================
// 4. CHAT AI (WAJIB LOGIN - PAKAI UID)
// ==========================================
const guestLimiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 50, message: { error: 'Terlalu banyak request.' } });

app.post('/api/chat', verifyFirebaseToken, guestLimiter, async (req, res) => {
  const uid = req.user.uid;
  const email = req.user.email;
  let liteDay = null; 
  
  try {
    const { messages, model, persona, fileContext, fileName, skills } = req.body; 
    const modelConfig = ALLOWED_MODELS[model];
    if (!modelConfig) return res.status(400).json({ error: 'Model tidak tersedia.' });
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Pesan kosong.' });

    const modelType = modelConfig.type;
    const cost = modelConfig.cost;
    const isGroq = modelConfig.provider === 'groq';

    // Cek User berdasarkan UID
    let user = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
    if (!user) {
      db.prepare('INSERT INTO users (uid, email) VALUES (?, ?)').run(uid, email);
      user = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
    }

    if (isGroq) {
      if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Groq API Key missing.' });
      liteDay = reserveLite(uid);
      if (!liteDay) return res.status(403).json({ error: `Kuota gratis Lite habis.` });
    } else {
      const currentLimit = user[`${modelType}_limit`];
      if (currentLimit < cost) return res.status(403).json({ error: `Limit habis. Silakan tukar kode.` });
    }

    // Susun Prompt
    let finalMessages = [];
    let modelName = "DeepSeek V4.1 Flash"; 
    if (model === 'deepseek-lite') modelName = "DeepSeek Lite";
    else if (model.includes('v4-flash')) modelName = "DeepSeek V4 Flash";
    else if (model.includes('v4-pro')) modelName = "DeepSeek V4 Pro";
    else if (model.includes('gpt')) modelName = "GPT-6 Luna";
    else if (model.includes('glm')) modelName = "GLM-5.3 Flash";

    if (persona) finalMessages.push({ role: "system", content: `Persona: ${persona}` });
    finalMessages.push({ role: "system", content: `IDENTITAS: Kamu adalah ${modelName}. Gaya bahasa santai, to the point.` });

    const skillsPrompt = buildSkillsPrompt(skills);
    if (skillsPrompt) finalMessages.push({ role: "system", content: skillsPrompt });

    if (fileContext) {
      const fileLabel = fileName ? `File: ${fileName}\n` : '';
      finalMessages.push({ role: "system", content: `Konteks file:\n${fileLabel}---\n${fileContext}\n---` });
    }

    finalMessages = finalMessages.concat(messages);

    // Tembak API
    const upstream = isGroq
      ? { url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: modelConfig.upstreamModel, name: 'Groq' }
      : { url: `${process.env.VIKEY_BASE_URL}/chat/completions`, key: process.env.VIKEY_API_KEY, model: model, name: 'Vikey' };

    const apiResponse = await fetch(upstream.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${upstream.key}` },
      body: JSON.stringify({ model: upstream.model, messages: finalMessages, max_tokens: 6000, temperature: 0.7 })
    });

    const data = await apiResponse.json();
    if (!apiResponse.ok) throw new Error(data.error?.message || `Gagal memanggil ${upstream.name}`);

    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') throw new Error(`Balasan ${upstream.name} tidak valid.`);

    if (!isGroq) {
      // POTONG LIMIT BERDASARKAN UID
      db.prepare(`UPDATE users SET ${modelType}_limit = MAX(${modelType}_limit - ?, 0) WHERE uid = ?`).run(cost, uid);
    }
    liteDay = null; 
    
    res.json({ reply });

  } catch (error) {
    console.error('Chat Error:', error);
    if (liteDay) refundLite(uid, liteDay); 
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 5. CEK LIMIT & REDEEM (WAJIB LOGIN - PAKAI UID)
// ==========================================
app.get('/api/credits', verifyFirebaseToken, (req, res) => {
  const uid = req.user.uid;
  let user = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  if (!user) {
    db.prepare('INSERT INTO users (uid, email) VALUES (?, ?)').run(uid, req.user.email);
    user = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  }
  res.json({ deepseek: user.deepseek_limit, gpt: user.gpt_limit, glm: user.glm_limit });
});

app.post('/api/redeem', verifyFirebaseToken, (req, res) => {
  try {
    const { code } = req.body;
    const uid = req.user.uid;
    if (!code) return res.status(400).json({ error: 'Kode wajib diisi.' });

    const upperCode = String(code).toUpperCase();

    const redeemTx = db.transaction(() => {
      // Cek dulu kodenya ada & belum dipakai
      const voucher = db.prepare('SELECT * FROM redeem_codes WHERE code = ? AND is_used = 0').get(upperCode);
      if (!voucher) return null;

      // Tandai dipakai
      db.prepare('UPDATE redeem_codes SET is_used = 1 WHERE code = ?').run(upperCode);
      
      // Pastikan user ada
      db.prepare('INSERT OR IGNORE INTO users (uid, email) VALUES (?, ?)').run(uid, req.user.email);
      
      // TAMBAH LIMIT (PAKAI UID)
      db.prepare(`UPDATE users SET deepseek_limit = deepseek_limit + ?, gpt_limit = gpt_limit + ?, glm_limit = glm_limit + ? WHERE uid = ?`)
        .run(voucher.deepseek_amount, voucher.gpt_amount, voucher.glm_amount, uid);
      return voucher;
    });

    const voucher = redeemTx();
    if (!voucher) return res.status(400).json({ error: 'Kode tidak valid atau sudah dipakai.' });

    res.json({ message: 'Berhasil!', added: { deepseek: voucher.deepseek_amount, gpt: voucher.gpt_amount, glm: voucher.glm_amount } });
  } catch (error) {
    console.error('Redeem Error:', error);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// ==========================================
// 6. JALANKAN SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server jalan di port ${PORT}`);
  console.log(`🔐 Panel Admin: /admin-login.html`);
});