const express = require('express');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser'); // Wajib ada
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database('database.sqlite');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (ip TEXT PRIMARY KEY, deepseek_limit INTEGER DEFAULT 2, gpt_limit INTEGER DEFAULT 0, glm_limit INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS redeem_codes (code TEXT PRIMARY KEY, deepseek_amount INTEGER DEFAULT 0, gpt_amount INTEGER DEFAULT 0, glm_amount INTEGER DEFAULT 0, is_used BOOLEAN DEFAULT 0);
`);

const checkCodes = db.prepare('SELECT COUNT(*) as count FROM redeem_codes').get();
if (checkCodes.count === 0) {
  const insertCode = db.prepare('INSERT INTO redeem_codes (code, deepseek_amount, gpt_amount, glm_amount) VALUES (?, ?, ?, ?)');
  insertCode.run('DEEPCHAT-10', 10, 0, 0);
  insertCode.run('COMBO-SULTAN', 50, 10, 10);
}

app.use(cors());
app.use(express.json());
app.use(cookieParser()); // Harus dipanggil sebelum routing
app.use(express.static(path.join(__dirname, '../public')));
app.set('trust proxy', 1);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/landing.html'));
});

// ==========================================
// SISTEM AUTH ADMIN
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
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// ==========================================
// ENDPOINT ADMIN GENERATE TOKEN
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
// CHAT & REDEEM (BIASA)
// ==========================================
const guestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, 
  max: 50, 
  message: { error: 'Terlalu banyak request. Coba lagi besok.' }
});

app.post('/api/chat', guestLimiter, async (req, res) => {
  try {
    const { messages, model } = req.body;
    const ip = req.ip;

    let modelType = 'deepseek';
    if (model.includes('gpt')) modelType = 'gpt';
    if (model.includes('glm')) modelType = 'glm';

    let user = db.prepare('SELECT * FROM users WHERE ip = ?').get(ip);
    if (!user) {
      db.prepare('INSERT INTO users (ip) VALUES (?)').run(ip);
      user = db.prepare('SELECT * FROM users WHERE ip = ?').get(ip);
    }

    const currentLimit = user[`${modelType}_limit`];
    if (currentLimit <= 0) {
      return res.status(403).json({ error: `Limit ${modelType.toUpperCase()} habis. Silakan tukar kode.` });
    }

    const vikeyResponse = await fetch(`${process.env.VIKEY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${process.env.VIKEY_API_KEY}` 
      },
      body: JSON.stringify({ 
        model: model, 
        messages: messages, // Pastikan variabel ini berisi array yang bersih
        max_tokens: 2500, 
        temperature: 0.7 
      })
    });

    const data = await vikeyResponse.json();
    if (!vikeyResponse.ok) throw new Error(data.error?.message || 'Gagal memanggil Vikey');

    db.prepare(`UPDATE users SET ${modelType}_limit = ${modelType}_limit - 1 WHERE ip = ?`).run(ip);
    res.json({ reply: data.choices[0].message.content });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

    const upperCode = code.toUpperCase();
    const voucher = db.prepare('SELECT * FROM redeem_codes WHERE code = ? AND is_used = 0').get(upperCode);
    if (!voucher) return res.status(400).json({ error: 'Kode tidak valid atau sudah dipakai.' });

    db.prepare(`UPDATE users SET deepseek_limit = deepseek_limit + ?, gpt_limit = gpt_limit + ?, glm_limit = glm_limit + ? WHERE ip = ?`)
      .run(voucher.deepseek_amount, voucher.gpt_amount, voucher.glm_amount, ip);

    db.prepare('UPDATE redeem_codes SET is_used = 1 WHERE code = ?').run(upperCode);
    res.json({ message: 'Kode berhasil!', added: { deepseek: voucher.deepseek_amount, gpt: voucher.gpt_amount, glm: voucher.glm_amount } });
  } catch (error) {
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server jalan di http://localhost:${PORT}`);
});