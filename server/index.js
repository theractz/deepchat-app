require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // Railway ada di belakang proxy

// ==========================================
// 0. FIREBASE ADMIN (verifikasi token login)
// ==========================================
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT bukan JSON yang valid. Tempel ulang isi file .json secara utuh.');
    }
  }
  try {
    return require('./serviceAccountKey.json');
  } catch (e) {
    throw new Error('Service account tidak ditemukan. Isi variabel FIREBASE_SERVICE_ACCOUNT atau taruh serviceAccountKey.json di folder ini.');
  }
}

admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });

// Middleware: wajib login. Hasil verifikasi (uid, email, dll) ada di req.user
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Akses ditolak. Silakan login.' });
  }
  try {
    req.user = await admin.auth().verifyIdToken(authHeader.slice(7));
    next();
  } catch (error) {
    console.error('Token Error:', error.code || error.message);
    res.status(401).json({ error: 'Sesi login tidak valid. Silakan login ulang.' });
  }
}

// ==========================================
// 1. DATABASE (PAKAI UID FIREBASE)
// ==========================================
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite')
  : path.join(__dirname, 'database.sqlite');

console.log(`Menggunakan database di: ${dbPath}`);
const db = new Database(dbPath);

// MIGRASI: tabel versi lama (kolom `ip`) diganti nama supaya tabel baru (kolom `uid`) bisa dibuat.
// "CREATE TABLE IF NOT EXISTS" saja tidak cukup karena tidak mengubah tabel yang sudah ada.
// Data lama tidak dihapus, hanya dipindah ke tabel cadangan.
function migrateIpTablesToUid() {
  const tableExists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const hasColumn = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((col) => col.name === c);

  for (const t of ['users', 'lite_usage']) {
    if (tableExists(t) && !hasColumn(t, 'uid')) {
      const backup = `${t}_old_ip_${Date.now()}`;
      db.exec(`ALTER TABLE ${t} RENAME TO ${backup}`);
      console.log(`Migrasi: tabel ${t} lama (berbasis IP) diganti nama menjadi ${backup}`);
    }
  }
}
migrateIpTablesToUid();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, email TEXT, deepseek_limit INTEGER DEFAULT 5, gpt_limit INTEGER DEFAULT 0, glm_limit INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS redeem_codes (code TEXT PRIMARY KEY, deepseek_amount INTEGER DEFAULT 0, gpt_amount INTEGER DEFAULT 0, glm_amount INTEGER DEFAULT 0, is_used BOOLEAN DEFAULT 0);
  CREATE TABLE IF NOT EXISTS lite_usage (uid TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, day));
`);
console.log('Kolom tabel users:', db.prepare('PRAGMA table_info(users)').all().map((c) => c.name).join(', '));

// Kode voucher awal (hanya kalau tabel masih kosong)
if (db.prepare('SELECT COUNT(*) AS count FROM redeem_codes').get().count === 0) {
  const insertCode = db.prepare('INSERT INTO redeem_codes (code, deepseek_amount, gpt_amount, glm_amount) VALUES (?, ?, ?, ?)');
  insertCode.run('DEEPCHAT-10', 10, 0, 0);
  insertCode.run('COMBO-SULTAN', 50, 10, 10);
}

// --- Helper user & kredit ---
const CREDIT_COLUMNS = { deepseek: 'deepseek_limit', gpt: 'gpt_limit', glm: 'glm_limit' }; // whitelist nama kolom

function getOrCreateUser(uid, email) {
  db.prepare(`INSERT INTO users (uid, email) VALUES (?, ?)
              ON CONFLICT(uid) DO UPDATE SET email = COALESCE(excluded.email, users.email)`).run(uid, email || null);
  return db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
}

// Kredit dipotong di AWAL secara atomik (hanya berhasil kalau saldo cukup), lalu dikembalikan kalau panggilan AI gagal.
// Ini mencegah dua chat bersamaan lolos dengan saldo tinggal 1.
function reserveCredit(uid, type, cost) {
  const col = CREDIT_COLUMNS[type];
  return db.prepare(`UPDATE users SET ${col} = ${col} - ? WHERE uid = ? AND ${col} >= ?`).run(cost, uid, cost).changes > 0;
}
function refundCredit(uid, type, cost) {
  const col = CREDIT_COLUMNS[type];
  db.prepare(`UPDATE users SET ${col} = ${col} + ? WHERE uid = ?`).run(cost, uid);
}

// --- Kuota gratis harian (DeepSeek Lite) ---
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

// ==========================================
// 2. DAFTAR MODEL & SKILL HELPER
// ==========================================
const MAX_SKILLS = 3;
const MAX_SKILL_CHARS = 6000;
const MAX_SKILL_TOTAL = 12000;
const MAX_FILE_CONTEXT_CHARS = 40000; // samakan dengan MAX_FILE_CHARS di app.js
const MAX_PERSONA_CHARS = 1000;

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
  'deepseek-lite':                { type: 'lite',     cost: 0, provider: 'groq', upstreamModel: 'openai/gpt-oss-120b', label: 'DeepSeek Lite' },
  'deepseek/deepseek-v4-flash':   { type: 'deepseek', cost: 1, label: 'DeepSeek V4 Flash' },
  'deepseek/deepseek-v4-pro':     { type: 'deepseek', cost: 1, label: 'DeepSeek V4 Pro' },
  'deepseek/deepseek-v4.1-flash': { type: 'deepseek', cost: 1, label: 'DeepSeek V4.1 Flash' },
  'gpt/gpt-6-luna':               { type: 'gpt',      cost: 1, label: 'GPT-6 Luna' },
  'glm/glm-5.3-flash':            { type: 'glm',      cost: 1, label: 'GLM-5.3 Flash' },
};

// ==========================================
// 3. MIDDLEWARE & ADMIN
// ==========================================
app.use(cors());
app.use(express.json({ limit: '20mb' })); // file upload dikirim sebagai teks di body
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/admin-login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));

// Cookie admin berisi token turunan (HMAC), bukan password mentah
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const adminSessionToken = () =>
  crypto.createHmac('sha256', String(process.env.ADMIN_PASS || '')).update('deepchat-admin-session').digest('hex');

const isAdmin = (req, res, next) => {
  const ok = process.env.ADMIN_PASS && safeEqual(req.cookies.admin_session || '', adminSessionToken());
  if (ok) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Sesi admin habis. Login ulang.' });
  res.redirect('/admin-login.html');
};

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const configured = process.env.ADMIN_USER && process.env.ADMIN_PASS;
  if (configured && safeEqual(username || '', process.env.ADMIN_USER) && safeEqual(password || '', process.env.ADMIN_PASS)) {
    res.cookie('admin_session', adminSessionToken(), {
      maxAge: 86400000, httpOnly: true, sameSite: 'lax', secure: req.secure
    });
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
    const { model, amount } = req.body || {};
    const code = String(req.body?.code || '').toUpperCase().trim();
    const qty = Number(amount);
    if (!code || !model || !Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: 'Data tidak lengkap atau jumlah tidak valid.' });

    const amounts = { deepseek: 0, gpt: 0, glm: 0 };
    if (!(model in amounts)) return res.status(400).json({ error: 'Model tidak dikenal.' });
    amounts[model] = qty;

    db.prepare('INSERT INTO redeem_codes (code, deepseek_amount, gpt_amount, glm_amount) VALUES (?, ?, ?, ?)')
      .run(code, amounts.deepseek, amounts.gpt, amounts.glm);
    res.json({ message: 'Kode berhasil dibuat!', code });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return res.status(400).json({ error: 'Kode ini sudah ada. Coba nama lain.' });
    console.error('Generate Error:', error);
    res.status(500).json({ error: 'Gagal membuat kode.' });
  }
});

// ==========================================
// 4. CHAT AI (WAJIB LOGIN)
// ==========================================
// Batas harian per akun (bukan per IP, supaya satu WiFi bersama tidak saling menghabiskan jatah)
const userLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 50,
  keyGenerator: (req) => req.user.uid,
  message: { error: 'Terlalu banyak request. Coba lagi besok.' }
});

app.post('/api/chat', verifyFirebaseToken, userLimiter, async (req, res) => {
  const { uid, email } = req.user;
  let refund = null; // diisi setelah kuota/kredit dipotong, dipanggil kalau panggilan AI gagal

  try {
    const { model, persona, fileContext, fileName, skills } = req.body || {};
    const modelConfig = ALLOWED_MODELS[model];
    if (!modelConfig) return res.status(400).json({ error: 'Model tidak tersedia.' });

    const messages = (Array.isArray(req.body.messages) ? req.body.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    if (messages.length === 0) return res.status(400).json({ error: 'Pesan kosong.' });

    const isGroq = modelConfig.provider === 'groq';
    getOrCreateUser(uid, email);

    // Potong kuota / kredit di awal
    if (isGroq) {
      if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'DeepSeek Lite belum dikonfigurasi di server.' });
      const liteDay = reserveLite(uid);
      if (!liteDay) return res.status(403).json({ error: `Kuota gratis DeepSeek Lite hari ini habis (${LITE_DAILY_QUOTA}/hari). Coba lagi besok.` });
      refund = () => refundLite(uid, liteDay);
    } else {
      if (!reserveCredit(uid, modelConfig.type, modelConfig.cost)) {
        return res.status(403).json({ error: `Limit ${modelConfig.type.toUpperCase()} habis. Silakan tukar kode.` });
      }
      refund = () => refundCredit(uid, modelConfig.type, modelConfig.cost);
    }

    // Susun prompt
    const finalMessages = [];
    if (typeof persona === 'string' && persona.trim()) {
      finalMessages.push({ role: 'system', content: `Kamu adalah AI dengan persona: ${persona.trim().slice(0, MAX_PERSONA_CHARS)}.` });
    }
    finalMessages.push({
      role: 'system',
      content: `ATURAN MENJAWAB (WAJIB DIPATUHI):
1. IDENTITAS: Kamu adalah ${modelConfig.label}. Jika ditanya "Kamu model apa?", jawab bahwa kamu adalah ${modelConfig.label}. Jangan mengaku sebagai model lain.
2. GAYA BAHASA: Santai, natural, to the point. Emoji boleh jika suasananya santai.
3. Kodingan: langsung berikan blok kodenya.
4. Jangan ulangi pertanyaan user.`
    });

    const skillsPrompt = buildSkillsPrompt(skills);
    if (skillsPrompt) finalMessages.push({ role: 'system', content: skillsPrompt });

    if (typeof fileContext === 'string' && fileContext.trim()) {
      const fileLabel = fileName ? `File: ${String(fileName).slice(0, 200)}\n` : '';
      finalMessages.push({
        role: 'system',
        content: `Berikut adalah isi file/dokumen yang diupload user:\n${fileLabel}---\n${fileContext.slice(0, MAX_FILE_CONTEXT_CHARS)}\n---`
      });
    }
    finalMessages.push(...messages);

    // Panggil AI
    const upstream = isGroq
      ? { url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: modelConfig.upstreamModel, name: 'Groq' }
      : { url: `${process.env.VIKEY_BASE_URL}/chat/completions`, key: process.env.VIKEY_API_KEY, model: model, name: 'Vikey' };

    const apiResponse = await fetch(upstream.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${upstream.key}` },
      body: JSON.stringify({ model: upstream.model, messages: finalMessages, max_tokens: 6000, temperature: 0.7 }),
      signal: AbortSignal.timeout(120000)
    });

    const data = await apiResponse.json();
    if (!apiResponse.ok) throw new Error(data.error?.message || `Gagal memanggil API ${upstream.name}`);

    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') throw new Error(`Balasan dari API ${upstream.name} tidak valid.`);

    refund = null; // sukses: potongan dipertahankan
    res.json({ reply });

  } catch (error) {
    console.error('Chat Error:', error);
    if (refund) {
      try { refund(); } catch (e) { console.error('Refund Error:', e); }
    }
    res.status(500).json({ error: error.name === 'TimeoutError' ? 'AI terlalu lama menjawab. Coba lagi.' : error.message });
  }
});

// ==========================================
// 5. CEK LIMIT & REDEEM (WAJIB LOGIN)
// ==========================================
app.get('/api/credits', verifyFirebaseToken, (req, res) => {
  try {
    const user = getOrCreateUser(req.user.uid, req.user.email);
    res.json({ deepseek: user.deepseek_limit, gpt: user.gpt_limit, glm: user.glm_limit });
  } catch (error) {
    console.error('Credits Error:', error);
    res.status(500).json({ error: 'Gagal mengambil limit.' });
  }
});

app.post('/api/redeem', verifyFirebaseToken, (req, res) => {
  try {
    const { uid, email } = req.user;
    const code = req.body?.code;
    if (!code) return res.status(400).json({ error: 'Kode wajib diisi.' });
    const upperCode = String(code).toUpperCase().trim();

    // Satu transaksi: kalau salah satu langkah gagal, semuanya dibatalkan (kode tidak hangus)
    const redeemTx = db.transaction(() => {
      const mark = db.prepare('UPDATE redeem_codes SET is_used = 1 WHERE code = ? AND is_used = 0').run(upperCode);
      if (mark.changes === 0) return null;

      const voucher = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(upperCode);
      getOrCreateUser(uid, email);
      db.prepare('UPDATE users SET deepseek_limit = deepseek_limit + ?, gpt_limit = gpt_limit + ?, glm_limit = glm_limit + ? WHERE uid = ?')
        .run(voucher.deepseek_amount, voucher.gpt_amount, voucher.glm_amount, uid);
      return voucher;
    });

    const voucher = redeemTx();
    if (!voucher) return res.status(400).json({ error: 'Kode tidak valid atau sudah dipakai.' });

    res.json({
      message: 'Kode berhasil!',
      added: { deepseek: voucher.deepseek_amount, gpt: voucher.gpt_amount, glm: voucher.glm_amount }
    });
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