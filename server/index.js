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
// Batas skill yang dikirim dari browser (jaga biaya token & mencegah prompt raksasa)
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
  return `SKILL AKTIF:
Gunakan skill di bawah hanya jika relevan dengan permintaan user. Jika instruksi skill meminta format atau panjang jawaban tertentu, ikuti skill meskipun berbeda dari aturan gaya singkat di atas.

${parts.join('\n\n')}`;
}

const ALLOWED_MODELS = {
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
app.use(express.json({ limit: '10mb' })); // Limit dinaikkan buat file upload
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1); // Biar IP kebaca bener di Railway

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
// 6. RATE LIMIT & CHAT AI (PERSONA + FILE + ANTI NGELANTUR)
// ==========================================
const guestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, 
  max: 50, 
  message: { error: 'Terlalu banyak request. Coba lagi besok.' }
});

app.post('/api/chat', guestLimiter, async (req, res) => {
  try {
    const { messages, model, persona, fileContext, skills } = req.body; 
    const ip = req.ip;

    const modelConfig = ALLOWED_MODELS[model];
    if (!modelConfig) {
      return res.status(400).json({ error: 'Model tidak tersedia.' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Pesan kosong.' });
    }
    const modelType = modelConfig.type;
    const cost = modelConfig.cost;

    let user = db.prepare('SELECT * FROM users WHERE ip = ?').get(ip);
    if (!user) {
      db.prepare('INSERT INTO users (ip) VALUES (?)').run(ip);
      user = db.prepare('SELECT * FROM users WHERE ip = ?').get(ip);
    }

    const currentLimit = user[`${modelType}_limit`];
    if (currentLimit < cost) {
      return res.status(403).json({ error: `Limit ${modelType.toUpperCase()} habis. Silakan tukar kode.` });
    }

    // SUSUN PESAN UNTUK AI
    let finalMessages = [];
    
    // 1. Persona dari user
    if (persona && persona.trim() !== "") {
      finalMessages.push({ 
        role: "system", 
        content: `Kamu adalah AI dengan persona: ${persona}.` 
      });
    }

        // 2. ATURAN KEPRIBADIAN & GAYA BAHASA (RAMAH & EMOSIONAL)
    finalMessages.push({
      role: "system",
      content: `ATURAN MENJAWAB:
      1. Kamu adalah teman ngobrol yang asik, ramah, dan empatik. Gunakan bahasa yang santai dan natural (seperti pakai 'gw/lu' atau 'aku/kamu').
      2. Jawablah dengan SINGKAT, PADAT, dan TO THE POINT. Jangan bertele-tele.
      3. Gunakan emoji yang relevan jika pertanyaan atau suasana obrolan terasa ceria, lucu, atau santai. TAPI jangan pakai emoji jika user sedang bertanya serius (seperti coding atau masalah teknis).
      4. Jika user hanya menyapa atau bertanya hal simpel, jawab maksimal 2-3 kalimat dengan nada bersahabat.
      5. Jika user meminta kodingan, berikan kodenya saja tanpa perlu menjelaskan panjang lebar (kecuali diminta).
      6. Gunakan format bullet points jika memberikan daftar. Jangan pernah mengulang pertanyaan user di awal jawaban.`
    });

    // 2b. Skill yang dipasang user
    const skillsPrompt = buildSkillsPrompt(skills);
    if (skillsPrompt) {
      finalMessages.push({ role: "system", content: skillsPrompt });
    }

    // 3. Konteks File
    if (fileContext && fileContext.trim() !== "") {
      finalMessages.push({ 
        role: "system", 
        content: `Berikut adalah isi file/dokumen yang diupload user:\n\n---\n${fileContext}\n---` 
      });
    }

    // 4. Riwayat Chat
    finalMessages = finalMessages.concat(messages);

    // Tembak API Vikey
    const vikeyResponse = await fetch(`${process.env.VIKEY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${process.env.VIKEY_API_KEY}` 
      },
      body: JSON.stringify({ 
        model: model, 
        messages: finalMessages, 
        max_tokens: 6000, // Dinaikkan biar AI gak kepotong pas mikir
        temperature: 0.7 
      })
    });

    const data = await vikeyResponse.json();
    
    if (!vikeyResponse.ok) {
      throw new Error(data.error?.message || 'Gagal memanggil API Vikey');
    }

    // Potong limit kalau sukses
    db.prepare(`UPDATE users SET ${modelType}_limit = ${modelType}_limit - ? WHERE ip = ?`).run(cost, ip);
    
    res.json({ reply: data.choices[0].message.content });

  } catch (error) {
    console.error('Chat Error:', error);
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
      // Tandai terpakai dulu; kalau 0 baris berubah berarti kode salah / sudah dipakai
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