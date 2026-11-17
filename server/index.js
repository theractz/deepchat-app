const express = require('express');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. SETUP DATABASE (ANTI HILANG DI RAILWAY)
// ==========================================
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.sqlite') 
  : path.join(__dirname, 'database.sqlite');

console.log(`Menggunakan database di: ${dbPath}`);
const db = new Database(dbPath);

// Bikin tabel kalau belum ada
db.exec(`
  CREATE TABLE IF NOT EXISTS users (ip TEXT PRIMARY KEY, deepseek_limit INTEGER DEFAULT 5, gpt_limit INTEGER DEFAULT 0, glm_limit INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS redeem_codes (code TEXT PRIMARY KEY, deepseek_amount INTEGER DEFAULT 0, gpt_amount INTEGER DEFAULT 0, glm_amount INTEGER DEFAULT 0, is_used BOOLEAN DEFAULT 0);
`);

// Kuota gratis harian per IP untuk model DeepSeek Lite (sekarang pakai Groq)
db.exec(`CREATE TABLE IF NOT EXISTS lite_usage (ip TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ip, day));`);
const LITE_DAILY_QUOTA = 20;
// Reset tiap hari mengikuti WIB (UTC+7)
const todayWIB = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// Ambil 1 jatah kuota. Return string hari kalau berhasil, null kalau kuota habis.
function reserveLite(ip) {
  const day = todayWIB();
  db.prepare('INSERT OR IGNORE INTO lite_usage (ip, day, count) VALUES (?, ?, 0)').run(ip, day);
  const r = db.prepare('UPDATE lite_usage SET count = count + 1 WHERE ip = ? AND day = ? AND count < ?').run(ip, day, LITE_DAILY_QUOTA);
  return r.changes > 0 ? day : null;
}
// Kembalikan jatah kalau request ke Groq gagal
function refundLite(ip, day) {
  db.prepare('UPDATE lite_usage SET count = MAX(count - 1, 0) WHERE ip = ? AND day = ?').run(ip, day);
}

// Bikin kode default kalau database masih kosong
const checkCodes = db.prepare('SELECT COUNT(*) as count FROM redeem_codes').get();
if (checkCodes.count === 0) {
  const insertCode = db.prepare('INSERT INTO redeem_codes (code, deepseek_amount, gpt_amount, glm_amount) VALUES (?, ?, ?, ?)');
  insertCode.run('DEEPCHAT-10', 10, 0, 0);
  insertCode.run('COMBO-SULTAN', 50, 10, 10);
}

// ==========================================
// DAFTAR MODEL YANG BOLEH DIPAKAI (WHITELIST)
// type = jenis limit yang dipotong, cost = kredit per chat
// ==========================================
const MAX_SKILLS = 3;
const MAX_SKILL_CHARS = 6000;
const MAX_SKILL_TOTAL = 12000;
const MAX_FILE_CHARS = 40000; // batas isi file lampiran (samakan dengan app.js)

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
  return `SKILL AKTIF:
Gunakan skill di bawah hanya jika relevan dengan permintaan user. Jika instruksi skill meminta format atau panjang jawaban tertentu, ikuti skill meskipun berbeda dari aturan gaya singkat di atas.

${parts.join('\n\n')}`;
}

const ALLOWED_MODELS = {
  // Model gratis lewat API Groq: tidak memotong limit Vikey, pakai kuota harian sendiri
  'deepseek-lite':                { type: 'lite',     cost: 0, provider: 'groq', upstreamModel: 'openai/gpt-oss-120b' },
  'deepseek/deepseek-v4-flash':   { type: 'deepseek', cost: 1 },
  'deepseek/deepseek-v4-pro':     { type: 'deepseek', cost: 1 },
  'deepseek/deepseek-v4.1-flash': { type: 'deepseek', cost: 1 },
  'gpt/gpt-6-luna':               { type: 'gpt',      cost: 1 },
  'glm/glm-5.3-flash':            { type: 'glm',      cost: 1 },
};

// ==========================================
// 2. MIDDLEWARE & STATIC FILES
// ==========================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

// ==========================================
// 3. ROUTING HALAMAN
// ==========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/admin-login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// ==========================================
// 4. SISTEM LOGIN ADMIN
// ==========================================
const isAdmin = (req, res, next) => {
  if (req.cookies.admin_session === process.env.ADMIN_PASS) {
    next(); 
  } else {
    res.redirect('/admin-login.html');
  }
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

app.get('/panel-rahasia', isAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==========================================
// 5. ENDPOINT ADMIN (GENERATE TOKEN)
// ==========================================
app.post('/api/admin/generate', isAdmin, (req, res) => {
  try {
    const { code, model, amount } = req.body;
    if (!code || !model || !amount) return res.status(400).json({ error: 'Data tidak lengkap.' });

    let deepseek_amt = 0, gpt_amt = 0, glm_amt = 0;
    if (model === 'deepseek') deepseek_amt = amount;
    else if (model === 'gpt') gpt_amt = amount;
    else if (model === 'glm') glm_amt = amount;

    db.prepare('INSERT INTO redeem_codes (code, deepseek_amount, gpt_amount, glm_amount) VALUES (?, ?, ?, ?)')
      .run(code, deepseek_amt, gpt_amt, glm_amt);

    res.json({ message: 'Kode berhasil dibuat!', code: code });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(400).json({ error: 'Kode ini sudah ada. Coba nama lain.' });
    }
    res.status(500).json({ error: 'Gagal membuat kode.' });
  }
});

// ==========================================
// 6. RATE LIMIT & CHAT AI
// ==========================================
const guestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, 
  max: 50, 
  message: { error: 'Terlalu banyak request. Coba lagi besok.' }
});

app.post('/api/chat', guestLimiter, async (req, res) => {
  const ip = req.ip;
  let liteDay = null;     // jatah kuota Lite yang sudah diambil (untuk refund kalau gagal)
  let charge = null;      // { modelType, cost } untuk model berbayar, dipotong setelah ada jawaban
  let gotContent = false; // sudah ada teks jawaban yang terkirim ke user
  let clientGone = false; // user menutup koneksi sebelum selesai

  // Finalisasi biaya: potong limit Vikey (kalau berbayar) dan anggap kuota Lite terpakai
  const commit = () => {
    if (charge) {
      db.prepare(`UPDATE users SET ${charge.modelType}_limit = ${charge.modelType}_limit - ? WHERE ip = ?`).run(charge.cost, ip);
      charge = null;
    }
    liteDay = null;
  };

  try {
    const { messages, model, persona, fileContext, fileName, skills } = req.body; 

    const modelConfig = ALLOWED_MODELS[model];
    if (!modelConfig) {
      return res.status(400).json({ error: 'Model tidak tersedia.' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Pesan kosong.' });
    }
    const modelType = modelConfig.type;
    const cost = modelConfig.cost;
    const isGroq = modelConfig.provider === 'groq';

    // --- CEK LIMIT / KUOTA ---
    if (isGroq) {
      if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: 'DeepSeek Lite belum dikonfigurasi di server (Groq API Key missing).' });
      }
      liteDay = reserveLite(ip);
      if (!liteDay) {
        return res.status(403).json({ error: `Kuota gratis DeepSeek Lite hari ini habis (${LITE_DAILY_QUOTA}/hari). Coba lagi besok atau pakai model lain.` });
      }
    } else {
      let user = db.prepare('SELECT * FROM users WHERE ip = ?').get(ip);
      if (!user) {
        db.prepare('INSERT INTO users (ip) VALUES (?)').run(ip);
        user = db.prepare('SELECT * FROM users WHERE ip = ?').get(ip);
      }
      const currentLimit = user[`${modelType}_limit`];
      if (currentLimit < cost) {
        return res.status(403).json({ error: `Limit ${modelType.toUpperCase()} habis. Silakan tukar kode.` });
      }
    }

    // --- SUSUN PESAN UNTUK AI ---
    let finalMessages = [];
    
    // Tentukan Nama Model
    let modelName = "DeepSeek V4.1 Flash"; 
    if (model === 'deepseek-lite') modelName = "DeepSeek Lite (Gratis)";
    else if (model.includes('v4-flash')) modelName = "DeepSeek V4 Flash";
    else if (model.includes('v4-pro')) modelName = "DeepSeek V4 Pro";
    else if (model.includes('gpt')) modelName = "GPT-6 Luna";
    else if (model.includes('glm')) modelName = "GLM-5.3 Flash";

    // 1. Persona
    if (typeof persona === 'string' && persona.trim() !== "") {
      finalMessages.push({ role: "system", content: `Kamu adalah AI dengan persona: ${persona}.` });
    }

    // 2. ATURAN KEPRIBADIAN
    finalMessages.push({
      role: "system",
      content: `ATURAN MENJAWAB (WAJIB DIPATUHI):
      1. IDENTITAS: Kamu adalah **${modelName}**, model AI yang sangat canggih dan pintar. Kamu bangga dengan kemampuanmu!
      2. TRANSPARANSI: Jika user bertanya "Kamu model apa?", jawablah dengan bangga dan jujur bahwa kamu adalah ${modelName}. Jangan mengaku sebagai model lain.
      3. GAYA BAHASA: Santai, asik, natural (gw/lu atau aku/kamu).
      4. EMOJI: Pakai jika suasananya santai, jangan pakai jika serius.
      5. ATURAN MENJAWAB: Singkat, padat, to the point. Tanpa basa-basi.
      6. Kodingan: Langsung kasih blok kodenya.
      7. Jangan ulangi pertanyaan user.`
    });

    // 2b. Skill
    const skillsPrompt = buildSkillsPrompt(skills);
    if (skillsPrompt) finalMessages.push({ role: "system", content: skillsPrompt });

    // 3. Konteks File
    if (typeof fileContext === 'string' && fileContext.trim() !== "") {
      const fname = String(fileName || 'file').slice(0, 100);
      finalMessages.push({
        role: "system",
        content: `User melampirkan file "${fname}". Isinya:\n---\n${fileContext.slice(0, MAX_FILE_CHARS)}\n---\nJawab pertanyaan user berdasarkan isi file ini kalau relevan.`
      });
    }

    // 4. Riwayat Chat
    finalMessages = finalMessages.concat(messages);

    // --- TEMBAK API (STREAMING) ---
    const upstream = isGroq
      ? { url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY, model: modelConfig.upstreamModel, name: 'Groq' }
      : { url: `${process.env.VIKEY_BASE_URL}/chat/completions`, key: process.env.VIKEY_API_KEY, model: model, name: 'Vikey' };
    if (!isGroq) charge = { modelType, cost };

    // Kalau user menutup tab / menekan stop, hentikan juga request ke provider supaya token tidak terbuang
    const abortCtl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) { clientGone = true; abortCtl.abort(); }
    });

    const apiResponse = await fetch(upstream.url, {
      method: 'POST',
      signal: abortCtl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${upstream.key}`
      },
      body: JSON.stringify({
        model: upstream.model,
        messages: finalMessages,
        max_tokens: 6000,
        temperature: 0.7,
        stream: true
      })
    });

    if (!apiResponse.ok) {
      let errData = {};
      try { errData = await apiResponse.json(); } catch (e) {}
      throw new Error(errData.error?.message || `Gagal memanggil API ${upstream.name}`);
    }

    // Cadangan: kalau provider ternyata membalas JSON biasa (tidak streaming), kirim utuh
    const upstreamType = apiResponse.headers.get('content-type') || '';
    if (!upstreamType.includes('text/event-stream')) {
      const data = await apiResponse.json();
      const reply = data.choices?.[0]?.message?.content;
      if (typeof reply !== 'string') throw new Error(`Balasan dari API ${upstream.name} tidak valid.`);
      gotContent = true;
      commit();
      return res.json({ reply });
    }

    // Header SSE ke browser
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // jangan di-buffer oleh proxy
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const decoder = new TextDecoder();
    let buf = '';

    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let json;
      try { json = JSON.parse(payload); } catch (e) { return; }
      if (json.error) throw new Error(json.error.message || `Error dari API ${upstream.name}`);
      // Hanya teks jawaban; proses "berpikir" (reasoning) tidak diteruskan
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        gotContent = true;
        send({ delta });
      }
    };

    for await (const chunk of apiResponse.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(handleLine);
    }
    if (buf) handleLine(buf);

    if (!gotContent) throw new Error(`Balasan dari API ${upstream.name} kosong.`);

    commit();
    send({ done: true });
    res.end();

  } catch (error) {
    // User sudah pergi: tagih hanya kalau sempat ada jawaban, selain itu kembalikan jatah
    if (clientGone) {
      if (gotContent) commit(); else if (liteDay) refundLite(ip, liteDay);
      return;
    }

    console.error('Chat Error:', error);
    if (gotContent) commit();                       // jawaban sebagian sudah diterima user
    else if (liteDay) refundLite(ip, liteDay);      // tidak ada jawaban, balikin jatah kuota

    if (res.headersSent) {
      // Sudah terlanjur streaming: kabari lewat SSE lalu tutup
      try { res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`); } catch (e) {}
      return res.end();
    }
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 7. ENDPOINT CEK LIMIT & REDEEM
// ==========================================
app.get('/api/credits', (req, res) => {
  const ip = req.ip;
  let user = db.prepare('SELECT * FROM users WHERE ip = ?').get(ip);
  if (!user) {
    db.prepare('INSERT INTO users (ip) VALUES (?)').run(ip);
    user = db.prepare('SELECT * FROM users WHERE ip = ?').get(ip);
  }
  res.json({ deepseek: user.deepseek_limit, gpt: user.gpt_limit, glm: user.glm_limit });
});

app.post('/api/redeem', (req, res) => {
  try {
    const { code } = req.body;
    const ip = req.ip;
    if (!code) return res.status(400).json({ error: 'Kode wajib diisi.' });

    const upperCode = String(code).toUpperCase();

    const redeemTx = db.transaction(() => {
      const mark = db.prepare('UPDATE redeem_codes SET is_used = 1 WHERE code = ? AND is_used = 0').run(upperCode);
      if (mark.changes === 0) return null;

      const voucher = db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(upperCode);
      db.prepare('INSERT OR IGNORE INTO users (ip) VALUES (?)').run(ip);
      db.prepare(`UPDATE users SET deepseek_limit = deepseek_limit + ?, gpt_limit = gpt_limit + ?, glm_limit = glm_limit + ? WHERE ip = ?`)
        .run(voucher.deepseek_amount, voucher.gpt_amount, voucher.glm_amount, ip);
      return voucher;
    });

    const voucher = redeemTx();
    if (!voucher) return res.status(400).json({ error: 'Kode tidak valid atau sudah dipakai.' });

    res.json({ message: 'Kode berhasil!', added: { deepseek: voucher.deepseek_amount, gpt: voucher.gpt_amount, glm: voucher.glm_amount } });
  } catch (error) {
    console.error('Redeem Error:', error);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

// ==========================================
// 8. JALANKAN SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server jalan di port ${PORT}`);
  console.log(`🔐 Panel Admin: /admin-login.html`);
});