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

// Kuota gratis harian per IP untuk model DeepSeek Lite (API Zro)
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
// Kembalikan jatah kalau request ke Zro gagal
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
  // Model gratis lewat API Zro: tidak memotong limit Vikey, pakai kuota harian sendiri
  'deepseek-lite':                { type: 'lite',     cost: 0, provider: 'zro', upstreamModel: 'deepseek-lite' },
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
  const ip = req.ip;
  let liteDay = null; // terisi kalau jatah kuota Lite sudah diambil (untuk refund kalau gagal)
  try {
    const { messages, model, persona, fileContext, skills } = req.body; 

    const modelConfig = ALLOWED_MODELS[model];
    if (!modelConfig) {
      return res.status(400).json({ error: 'Model tidak tersedia.' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Pesan kosong.' });
    }
    const modelType = modelConfig.type;
    const cost = modelConfig.cost;
    const isZro = modelConfig.provider === 'zro';

    if (isZro) {
      // DeepSeek Lite: jalur Zro, kuota gratis harian (tidak menyentuh limit Vikey)
      if (!process.env.ZRO_API_KEY) {
        return res.status(500).json({ error: 'DeepSeek Lite belum dikonfigurasi di server.' });
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

    // SUSUN PESAN UNTUK AI
    let finalMessages = [];
    
    // 1. Persona dari user
    if (persona && persona.trim() !== "") {
      finalMessages.push({ 
        role: "system", 
        content: `Kamu adalah AI dengan persona: ${persona}.` 
      });
    }

            // 2. ATURAN KEPRIBADIAN & GAYA BAHASA (ANTI HALUSINASI IDENTITAS)
    finalMessages.push({
      role: "system",
      content: `ATURAN MENJAWAB (WAJIB DIPATUHI):
      1. IDENTITAS: Kamu adalah "DeepChat", asisten AI pintar yang dikembangkan khusus untuk platform ini. 
      2. JANGAN PERNAH mengaku sebagai ChatGPT, OpenAI, Anthropic, Google, atau model AI lainnya. Jika ditanya tentang model apa kamu, jawablah dengan bangga bahwa kamu adalah DeepChat.
      3. GAYA BAHASA: Gunakan bahasa Indonesia yang santai, asik, dan natural (seperti teman ngobrol). Bebas pakai 'gw/lu' atau 'aku/kamu' tergantung konteks.
      4. EMOJI: Gunakan emoji yang relevan jika suasana obrolan terasa ceria atau santai. TAPI jangan pakai emoji jika user sedang bertanya hal serius (seperti coding atau masalah teknis).
      5. ATURAN MENJAWAB: Jawablah dengan SINGKAT, PADAT, dan TO THE POINT. Jangan bertele-tele atau pakai kalimat pembuka basa-basi seperti "Tentu", "Halo", atau "Berikut adalah".
      6. Jika user meminta kodingan, LANGSUNG berikan blok kodenya tanpa perlu menjelaskan panjang lebar (kecuali diminta).
      7. Gunakan format bullet points jika memberikan daftar. Jangan pernah mengulang pertanyaan user di awal jawaban.`
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

    // Pilih tujuan API: Zro untuk DeepSeek Lite, Vikey untuk model lainnya
    const upstream = isZro
      ? { url: `${process.env.ZRO_BASE_URL || 'https://zro.moonmath.ai/v1'}/chat/completions`, key: process.env.ZRO_API_KEY, model: modelConfig.upstreamModel, name: 'Zro' }
      : { url: `${process.env.VIKEY_BASE_URL}/chat/completions`, key: process.env.VIKEY_API_KEY, model: model, name: 'Vikey' };

    const apiResponse = await fetch(upstream.url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${upstream.key}` 
      },
      body: JSON.stringify({ 
        model: upstream.model, 
        messages: finalMessages, 
        max_tokens: 6000, // Dinaikkan biar AI gak kepotong pas mikir
        temperature: 0.7 
      })
    });

    const data = await apiResponse.json();
    
    if (!apiResponse.ok) {
      throw new Error(data.error?.message || `Gagal memanggil API ${upstream.name}`);
    }

    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') {
      throw new Error(`Balasan dari API ${upstream.name} tidak valid.`);
    }

    // Potong limit Vikey kalau sukses (DeepSeek Lite tidak memotong apa pun, kuotanya sudah diambil di atas)
    if (!isZro) {
      db.prepare(`UPDATE users SET ${modelType}_limit = ${modelType}_limit - ? WHERE ip = ?`).run(cost, ip);
    }
    liteDay = null; // sukses, jatah kuota terpakai
    
    res.json({ reply });

  } catch (error) {
    console.error('Chat Error:', error);
    if (liteDay) refundLite(ip, liteDay); // request gagal, balikin jatah kuota
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