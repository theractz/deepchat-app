const state = {
  credits: { deepseek: 0, gpt: 0, glm: 0 },
  creditsLoaded: false,
  attachedFile: null, // { name, size, text, truncated, announced }
  currentModelType: 'deepseek',
  model: 'deepseek/deepseek-v4-flash',
  isTyping: false,
  messages: [],
  currentChatId: null,
  persona: localStorage.getItem('deepchat_persona') || "",
  user: null,          // objek user Firebase (null = belum login)
  authReady: false,    // true setelah Firebase selesai memeriksa sesi
  authError: false,    // true kalau SDK Firebase gagal dimuat
  loggingIn: false,    // popup login sedang terbuka
};

// Daftar model: satu sumber untuk dropdown, label limit, dan warna avatar AI.
// Warna DeepSeek (biru) dan GPT (hijau) mengikuti warna identitas umum mereka;
// warna GLM dipilih sendiri. Ganti nilai `color` di sini kalau ingin menyesuaikan.
const MODELS = [
  // Model gratis (API Zro lewat backend). `free: true` = tidak pakai saldo limit Vikey.
  { id: 'deepseek-lite',                name: 'DeepSeek Lite',       type: 'lite',     limit: 'Kuota Gratis: 20/hari', color: '#22c55e', free: true },
  { id: 'deepseek/deepseek-v4-flash',   name: 'DeepSeek V4 Flash',   type: 'deepseek', limit: 'Limit DeepSeek', color: '#4d6bfe' },
  { id: 'deepseek/deepseek-v4-pro',     name: 'DeepSeek V4 Pro',     type: 'deepseek', limit: 'Limit DeepSeek', color: '#4d6bfe' },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', type: 'deepseek', limit: 'Limit DeepSeek', color: '#4d6bfe' },
  { id: 'gpt/gpt-6-luna',               name: 'GPT-6 Luna',          type: 'gpt',      limit: 'Limit GPT',      color: '#10a37f' },
  { id: 'glm/glm-5.3-flash',            name: 'GLM-5.3 Flash',       type: 'glm',      limit: 'Limit GLM',      color: '#f08c1a' },
];
const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-flash';
const modelById = (id) => MODELS.find(m => m.id === id) || MODELS.find(m => m.id === DEFAULT_MODEL_ID);
const ARCH_LOGO = '<img src="logo.png" width="18" height="18" alt="" style="display:block;object-fit:contain">';

// ==========================================
// 0. AUTENTIKASI (Firebase Auth)
// ==========================================
let currentUserToken = null; // ID token Firebase user yang sedang login

// Semua panggilan ke /api/* lewat sini supaya selalu membawa header Authorization.
// getIdToken() memakai cache dan memperbarui token otomatis kalau sudah hampir kedaluwarsa.
async function authFetch(url, options = {}) {
  if (state.user) {
    try { currentUserToken = await state.user.getIdToken(); }
    catch (e) { console.error('Gagal memperbarui token:', e); }
  }
  const headers = { ...(options.headers || {}) };
  if (currentUserToken) headers.Authorization = `Bearer ${currentUserToken}`;
  return fetch(url, { ...options, headers });
}

function renderAuthUI() {
  const $ = (id) => document.getElementById(id);
  const loginBtn = $('loginBtn');
  if (!loginBtn) return;
  const u = state.user;

  // Tombol login / kartu user
  loginBtn.hidden = !!u;
  $('userCard').hidden = !u;
  loginBtn.disabled = !state.authReady || state.loggingIn;
  $('loginBtnLabel').textContent = state.authError ? 'Login tidak tersedia'
    : state.loggingIn ? 'Membuka Google…'
    : state.authReady ? 'Login dengan Google'
    : 'Memeriksa login…';

  const errEl = $('authError');
  errEl.hidden = !state.authError;
  errEl.textContent = state.authError ? 'Layanan login gagal dimuat. Periksa koneksi lalu muat ulang halaman.' : '';

  if (u) {
    const name = u.displayName || u.email || 'Pengguna';
    $('userName').textContent = name;
    $('userEmail').textContent = u.email && u.email !== name ? u.email : '';
    const av = $('userAvatar');
    const initial = name.trim().charAt(0).toUpperCase() || '?';
    av.textContent = '';
    if (u.photoURL) {
      const img = new Image();
      img.alt = '';
      img.referrerPolicy = 'no-referrer'; // foto Google kadang gagal tampil tanpa ini
      img.onerror = () => { av.textContent = initial; };
      img.src = u.photoURL;
      av.appendChild(img);
    } else {
      av.textContent = initial;
    }
  }

  // Peringatan di atas kotak chat: tampil hanya saat sudah pasti belum login
  const notice = $('loginNotice');
  if (notice) {
    notice.hidden = !!u || !(state.authReady || state.authError);
    $('loginNoticeText').textContent = state.authError ? 'Login tidak tersedia saat ini.' : 'Login dulu untuk mulai chat.';
    $('loginNoticeBtn').hidden = state.authError;
    $('loginNoticeBtn').disabled = state.loggingIn;
  }
}

function authErrorMessage(err) {
  switch (err && err.code) {
    case 'auth/popup-blocked': return 'Popup login diblokir browser. Izinkan popup untuk situs ini lalu coba lagi.';
    case 'auth/unauthorized-domain': return 'Domain ini belum didaftarkan di Firebase (Authentication > Settings > Authorized domains).';
    case 'auth/network-request-failed': return 'Koneksi bermasalah. Periksa internet lalu coba lagi.';
    default: return `Login gagal${err && err.code ? ` (${err.code})` : ''}. Coba lagi.`;
  }
}

async function loginWithGoogle() {
  const sdk = window.firebaseSDK;
  if (!sdk || !window.firebaseAuth) { alert('Login belum siap. Muat ulang halaman lalu coba lagi.'); return; }
  if (state.loggingIn) return;
  state.loggingIn = true; renderAuthUI();
  try {
    await sdk.signInWithPopup(window.firebaseAuth, new sdk.GoogleAuthProvider());
  } catch (err) {
    // User menutup popup sendiri: bukan error
    if (err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request')) return;
    console.error('Login gagal:', err);
    alert(authErrorMessage(err));
  } finally {
    state.loggingIn = false; renderAuthUI();
  }
}

async function logout() {
  try { await window.firebaseSDK.signOut(window.firebaseAuth); }
  catch (err) { console.error('Logout gagal:', err); alert('Logout gagal. Coba lagi.'); }
}

function initAuth() {
  let started = false;

  const start = () => {
    if (started) return;
    started = true;
    clearTimeout(timer);
    window.firebaseSDK.onAuthStateChanged(window.firebaseAuth, async (user) => {
      state.user = user;
      try { currentUserToken = user ? await user.getIdToken() : null; }
      catch (e) { currentUserToken = null; console.error('Gagal ambil token:', e); }
      state.authReady = true;
      state.authError = false;
      // Limit milik akun sebelumnya tidak boleh tersisa di layar
      state.credits = { deepseek: 0, gpt: 0, glm: 0 };
      state.creditsLoaded = false;
      renderAuthUI();
      updateCreditUI();
      if (user) fetchCredits();
    });
  };
  const fail = () => {
    if (started) return;
    state.authError = true;
    renderAuthUI();
    updateCreditUI();
  };

  // app.js jalan lebih dulu daripada <script type="module">, jadi tunggu sinyalnya
  const timer = setTimeout(fail, 8000);
  window.addEventListener('firebase-ready', start);
  window.addEventListener('firebase-error', fail);
  if (window.firebaseAuth && window.firebaseSDK) start();

  document.getElementById('loginBtn')?.addEventListener('click', loginWithGoogle);
  document.getElementById('loginNoticeBtn')?.addEventListener('click', loginWithGoogle);
  document.getElementById('logoutBtn')?.addEventListener('click', logout);
}


// ==========================================
// 1. MANAJEMEN LIMIT & MODEL
// ==========================================
async function fetchCredits() {
  // DeepSeek Lite tidak pakai saldo Vikey: jangan fetch. Ditandai belum dimuat,
  // nanti diambil saat user pindah ke model berbayar.
  if (modelById(state.model).free) { state.creditsLoaded = false; return; }
  if (!state.user) return; // endpoint butuh token login
  try {
    const res = await authFetch('/api/credits');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal ambil limit');
    state.credits = data;
    state.creditsLoaded = true;
    updateCreditUI();
  } catch (err) { console.error('Gagal ambil limit:', err); }
}

function updateCreditUI() {
  const badgeEl = document.getElementById('creditBadge');
  const hintEl = document.querySelector('.credits-hint');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const fileInput = document.getElementById('fileUpload');
  const cur = modelById(state.model);
  const loggedIn = !!state.user;
  const lockedHint = (state.authReady || state.authError) ? 'Login dulu untuk mulai chat.' : 'Memeriksa status login...';

  // Satu pintu untuk status kolom chat: belum login selalu terkunci
  const setComposer = (enabled, placeholder) => {
    input.disabled = !enabled;
    sendBtn.disabled = !enabled;
    if (fileInput) fileInput.disabled = !loggedIn;
    input.placeholder = placeholder;
  };

  // Model gratis: tampilkan teks kuota, sembunyikan angka limit
  if (cur.free) {
    document.getElementById('creditLabel').textContent = cur.limit;
    badgeEl.style.display = 'none';
    if (hintEl) hintEl.textContent = 'Tidak memakai kredit.';
    if (loggedIn) setComposer(true, 'Ketik pesan...'); else setComposer(false, lockedHint);
    return;
  }
  badgeEl.style.display = '';
  if (hintEl) hintEl.textContent = '1 chat = 1 kredit';

  let label = 'Limit DeepSeek';
  if (state.currentModelType === 'gpt') label = 'Limit GPT';
  if (state.currentModelType === 'glm') label = 'Limit GLM';

  const currentLimit = state.credits[state.currentModelType];
  document.getElementById('creditLabel').textContent = label;
  badgeEl.textContent = loggedIn ? currentLimit : '–';

  if (!loggedIn) setComposer(false, lockedHint);
  else if (currentLimit <= 0) setComposer(false, `${label} habis. Tukar kode atau beli paket lewat ikon keranjang.`);
  else setComposer(true, 'Ketik pesan...');
}

const CHEV = '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const TICK = '<svg class="tick" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
const picker = document.getElementById('modelPicker');
const legacySelect = document.getElementById('modelSelect'); // cadangan kalau HTML masih versi lama

function modelRow(m, extra) {
  return `<span class="model-mark" style="--model-color:${m.color}">${ARCH_LOGO}</span>
    <span class="model-text"><span class="model-name">${m.name}</span><span class="model-sub">${m.limit}</span></span>${extra}`;
}

function renderModelPicker() {
  if (!picker) return;
  const cur = modelById(state.model);
  picker.innerHTML = `
    <button type="button" class="model-btn" id="modelBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Pilih model, sekarang ${cur.name}">
      ${modelRow(cur, CHEV)}
    </button>
    <div class="model-menu" id="modelMenu" role="listbox" aria-label="Pilih model" hidden>
      ${MODELS.map(m => `<button type="button" role="option" class="model-option" data-id="${m.id}" aria-selected="${m.id === cur.id}">${modelRow(m, m.id === cur.id ? TICK : '')}</button>`).join('')}
    </div>`;
}

function setMenu(open) {
  const btn = document.getElementById('modelBtn');
  const menu = document.getElementById('modelMenu');
  if (!btn || !menu) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild).focus();
}

function selectModel(id, persist = true) {
  const m = modelById(id);
  state.model = m.id;
  state.currentModelType = m.type;
  document.getElementById('headerModelName').textContent = m.name;
  if (persist) { try { localStorage.setItem('deepchat_model', m.id); } catch (e) {} }
  renderModelPicker();
  if (legacySelect) legacySelect.value = m.id;
  updateCreditUI();
  if (!m.free && !state.creditsLoaded) fetchCredits();
}

if (picker) {
  picker.addEventListener('click', (e) => {
    const opt = e.target.closest('.model-option');
    if (opt) { selectModel(opt.dataset.id); document.getElementById('modelBtn').focus(); return; }
    if (e.target.closest('#modelBtn')) setMenu(document.getElementById('modelMenu').hidden);
  });
  picker.addEventListener('keydown', (e) => {
    const menu = document.getElementById('modelMenu');
    if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); setMenu(false); document.getElementById('modelBtn').focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (menu.hidden) { setMenu(true); return; }
      const items = [...menu.querySelectorAll('.model-option')];
      const i = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next].focus();
    }
  });
  document.addEventListener('click', (e) => { if (!picker.contains(e.target)) setMenu(false); });
} else if (legacySelect) {
  legacySelect.addEventListener('change', (e) => selectModel(e.target.value));
}

// ==========================================
// 2. MODAL SETTINGS & PERSONA
// ==========================================
const personaModal = document.getElementById('personaModal');
const personaInput = document.getElementById('personaInput');
const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');

if (personaInput) personaInput.value = state.persona;

// Floating card: satu tombol gear, isinya Persona dan Skill (masing-masing halaman/modal sendiri)
function setSettingsMenu(open) {
  if (!settingsMenu || !settingsBtn) return;
  settingsMenu.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) settingsMenu.querySelector('.settings-item')?.focus();
}
settingsBtn?.addEventListener('click', (e) => { e.stopPropagation(); setSettingsMenu(settingsMenu.hidden); });
document.addEventListener('click', (e) => {
  if (settingsMenu && !settingsMenu.hidden && !settingsMenu.contains(e.target)) setSettingsMenu(false);
});

document.getElementById('openPersonaBtn')?.addEventListener('click', () => {
  setSettingsMenu(false);
  personaInput.value = state.persona;
  personaModal.classList.add('active');
});
document.getElementById('closePersonaBtn')?.addEventListener('click', () => personaModal.classList.remove('active'));
document.getElementById('savePersonaBtn')?.addEventListener('click', () => {
  state.persona = personaInput.value.trim();
  try { localStorage.setItem('deepchat_persona', state.persona); } catch (e) {}
  alert('Persona berhasil disimpan!');
  personaModal.classList.remove('active');
});

// ==========================================
// 3. REDEEM KODE
// ==========================================
document.getElementById('redeemBtn').addEventListener('click', () => {
  if (!state.user) { alert('Login dulu untuk menukar kode.'); return; }
  document.getElementById('redeemModal').classList.add('active');
});
document.getElementById('cancelRedeem').addEventListener('click', () => document.getElementById('redeemModal').classList.remove('active'));

document.getElementById('confirmRedeem').addEventListener('click', async () => {
  const code = document.getElementById('redeemInput').value.trim();
  if (!code) return;
  const btn = document.getElementById('confirmRedeem');
  btn.textContent = 'Memproses...'; btn.disabled = true;
  try {
    const res = await authFetch('/api/redeem', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert('Berhasil! Limit ditambahkan.');
    document.getElementById('redeemModal').classList.remove('active');
    document.getElementById('redeemInput').value = '';
    fetchCredits(); 
  } catch (err) { alert(err.message); } 
  finally { btn.textContent = 'Tukar'; btn.disabled = false; }
});

// ==========================================
// 4. FITUR UPLOAD FILE
// ==========================================
const MAX_FILE_CHARS = 40000; // batas isi yang dikirim ke AI (samakan dengan server)
let fileReadToken = 0;       // membatalkan pembacaan file yang sudah tidak relevan

const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FILE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>';

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Chip "file terlampir" di atas kotak chat. File tetap terlampir sampai dihapus / chat baru.
function renderFileChip() {
  const chip = document.getElementById('fileChip');
  if (!chip) return;
  const f = state.attachedFile;
  if (!f) { chip.hidden = true; chip.innerHTML = ''; return; }
  const kind = f.kind && f.kind !== 'txt' ? `${String(f.kind).toUpperCase()} · ` : '';
  const meta = f.loading
    ? (f.status || 'Membaca file…')
    : `${kind}${formatBytes(f.size)}${f.truncated ? ` · hanya ${MAX_FILE_CHARS.toLocaleString('id-ID')} karakter pertama yang dibaca AI` : ''}`;
  chip.hidden = false;
  chip.innerHTML = `${FILE_ICON}
    <div class="file-chip-info"><span class="file-chip-name">${escHtml(f.name)}</span><span class="file-chip-meta">${escHtml(meta)}</span></div>
    <button type="button" class="icon-btn" id="removeFileBtn" aria-label="${f.loading ? 'Batalkan' : 'Hapus file terlampir'}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>`;
  document.getElementById('removeFileBtn').addEventListener('click', clearAttachedFile);
}

function clearAttachedFile() {
  fileReadToken++; // batalkan pembacaan yang masih berjalan
  state.attachedFile = null;
  renderFileChip();
}

// Pembacaan file ditangani library filereader.js (PDF, Word, Excel, PowerPoint, ODF, RTF, teks/kode)
window.handleFileUpload = async function(event) {
  const input = event.target;
  const file = input.files[0];
  input.value = ''; // supaya file yang sama bisa dipilih ulang
  if (!file) return;
  if (!window.DeepFileReader) { alert('Pembaca file belum termuat. Muat ulang halaman lalu coba lagi.'); return; }

  const token = ++fileReadToken;
  state.attachedFile = { name: file.name, size: file.size, text: '', loading: true, status: 'Membaca file…', announced: false };
  renderFileChip();

  try {
    const r = await DeepFileReader.read(file, {
      maxChars: MAX_FILE_CHARS,
      onProgress: (msg) => {
        if (token !== fileReadToken || !state.attachedFile) return;
        state.attachedFile.status = msg;
        renderFileChip();
      }
    });
    if (token !== fileReadToken) return; // user sudah menghapus / mengganti file
    state.attachedFile = { name: file.name, size: file.size, text: r.text, truncated: r.truncated, kind: r.kind, announced: false };
  } catch (e) {
    if (token !== fileReadToken) return;
    state.attachedFile = null;
    alert(e && e.message ? e.message : 'Gagal membaca file.');
  }
  renderFileChip();
  document.getElementById('input')?.focus();
};

// ==========================================
// 5. SYNTAX HIGHLIGHTING
// ==========================================
function highlightCode(code, lang) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const hashComment = /^(python|py|bash|sh|shell|yaml|yml|ruby|rb|toml|dockerfile)$/.test(lang || '');

  const KEYWORDS = 'function|const|let|var|if|else|return|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|try|catch|finally|throw|async|await|this|typeof|instanceof|in|of|null|undefined|true|false|def|elif|lambda|None|True|False|pass|with|as|print|public|private|static|void|int|string|bool|echo|fi|then';

  const re = new RegExp(
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' + (hashComment ? '|#[^\\n]*' : '') + ')' +   // 1 komentar
    '|("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)' +        // 2 string
    '|\\b(' + KEYWORDS + ')\\b' +                                                            // 3 keyword
    '|\\b(\\d+(?:\\.\\d+)?)\\b' +                                                            // 4 angka
    '|([A-Za-z_$][\\w$]*)(?=\\()' +                                                          // 5 nama fungsi
    '|(===|!==|==|=>|\\+\\+|--|[+\\-*/=<>!&|]+)',                                            // 6 operator
    'g'
  );

  let out = '', last = 0, m;
  while ((m = re.exec(code)) !== null) {
    out += esc(code.slice(last, m.index));
    const cls = m[1] ? 'comment' : m[2] ? 'string' : m[3] ? 'keyword' : m[4] ? 'number' : m[5] ? 'function' : 'operator';
    out += `<span class="token-${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  return out + esc(code.slice(last));
}

function formatMessage(text) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map(part => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const match = part.match(/```(\w*)\n?([\s\S]*?)```/);
      const lang = match ? match[1].toLowerCase() : 'text';
      const rawCode = match ? match[2].trim() : part.replace(/```/g, '').trim();
      const highlighted = highlightCode(rawCode, lang);
      const escapedAttr = rawCode.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      
      return `<div class="code-wrapper">
        <button class="copy-code-btn" data-code="${escapedAttr}">Copy</button>
        <pre><code>${highlighted}</code></pre>
      </div>`;
    } else {
      let txt = part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      txt = txt.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      txt = txt.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
      return txt.replace(/^\n+|\n+$/g, '').replace(/\n/g, '<br>');
    }
  }).join('');
}

// ==========================================
// 6. CHAT LOGIC & HISTORY
// ==========================================
function addMessage(role, content, saveToHistory = true, modelId = null, fileName = null) {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';

  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;
  
  // Avatar SVG
  const archLogo = ARCH_LOGO;
  const userLogo = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

  msgDiv.innerHTML = `
    <div class="msg-avatar" style="${role === 'ai' ? `--model-color:${modelById(modelId || state.model).color}` : ''}">
      ${role === 'user' ? userLogo : archLogo}
    </div>
    <div class="msg-content">${role === 'ai' ? formatMessage(content) : (fileName ? `<div class="msg-file">${FILE_ICON}<span>${escHtml(fileName)}</span></div><br>` : '') + content}</div>
  `;
  
  if (role === 'ai') {
    msgDiv.querySelectorAll('.copy-code-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.getAttribute('data-code'));
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });
    });
  }
  
  document.getElementById('messages').appendChild(msgDiv);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  state.messages.push(role === 'ai' ? { role, content, model: modelId || state.model } : (fileName ? { role, content, file: fileName } : { role, content }));

  if (saveToHistory) saveChatToLocal();
}

function saveChatToLocal() {
  if (!state.currentChatId) state.currentChatId = Date.now().toString();
  let allChats = JSON.parse(localStorage.getItem('deepchat_history') || '{}');
  const firstUserMsg = state.messages.find(m => m.role === 'user');
  const title = firstUserMsg ? firstUserMsg.content.substring(0, 30) + '...' : 'Chat Baru';

  allChats[state.currentChatId] = { id: state.currentChatId, title: title, messages: state.messages };
  localStorage.setItem('deepchat_history', JSON.stringify(allChats));
  renderHistory();
}

function renderHistory() {
  const list = document.getElementById('chatHistoryList');
  if (!list) return;
  list.innerHTML = '';
  let allChats = JSON.parse(localStorage.getItem('deepchat_history') || '{}');
  const sortedChats = Object.values(allChats).sort((a, b) => b.id - a.id);

  sortedChats.forEach(chat => {
    const div = document.createElement('button');
    div.type = 'button';
    div.className = 'history-item';
    div.textContent = chat.title;
    div.onclick = () => loadChat(chat.id);
    list.appendChild(div);
  });
}

function loadChat(id) {
  let allChats = JSON.parse(localStorage.getItem('deepchat_history') || '{}');
  const chat = allChats[id];
  if (!chat) return;

  state.currentChatId = id;
  state.messages = [];
  document.getElementById('messages').innerHTML = '';
  clearAttachedFile(); // jangan bawa file dari chat lain
  chat.messages.forEach(msg => addMessage(msg.role, msg.content, false, msg.model, msg.file));
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
}

async function sendMessage() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  const isFree = modelById(state.model).free;
  if (!state.user) return; // wajib login
  if (state.attachedFile && state.attachedFile.loading) return; // tunggu file selesai dibaca
  if (!text || state.isTyping || (!isFree && state.credits[state.currentModelType] <= 0)) return;

  const af = state.attachedFile;
  const announceName = af && !af.announced ? af.name : null; // tampilkan lampiran di bubble hanya pada pesan pertama
  if (af) af.announced = true;
  addMessage('user', text, true, null, announceName);
  input.value = ''; input.style.height = 'auto';

  state.isTyping = true;
  const box = document.getElementById('messages');
  box.scrollTop = box.scrollHeight;

  // Gelembung jawaban dibuat langsung (tanpa animasi loading) lalu diisi bertahap saat teks mengalir
  const usedModel = state.model;
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message ai';
  msgDiv.innerHTML = `
    <div class="msg-avatar" style="--model-color:${modelById(usedModel).color}">${ARCH_LOGO}</div>
    <div class="msg-content"></div>
  `;
  box.appendChild(msgDiv);
  const bubbleEl = msgDiv.querySelector('.msg-content');

  let fullText = '';
  let streamError = null;
  let raf = null;

  const paint = () => {
    raf = null;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    // blok kode yang belum ditutup ditutup sementara supaya tampil rapi saat streaming
    const open = (fullText.match(/```/g) || []).length % 2 === 1;
    bubbleEl.innerHTML = formatMessage(open ? fullText + '\n```' : fullText);
    if (nearBottom) box.scrollTop = box.scrollHeight;
  };
  const schedulePaint = () => { if (!raf) raf = requestAnimationFrame(paint); };

  try {
    let cleanMessages = state.messages
      .filter(msg => !msg.content.startsWith('Error:'))
      .map(msg => ({ role: msg.role === 'ai' ? 'assistant' : 'user', content: msg.content }));
    if (cleanMessages.length > 0 && cleanMessages[0].role === 'assistant') cleanMessages.shift();

    const res = await authFetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: cleanMessages,
        model: usedModel,
        persona: state.persona,
        fileContext: af ? af.text : '',
        fileName: af ? af.name : '',
        skills: activeSkills()
      })
    });

    if (!res.ok) {
      let msg = 'Gagal menghubungi server';
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      // Cadangan: server membalas JSON utuh { reply }
      fullText = (await res.json()).reply || '';
      paint();
    } else {
      // Streaming SSE: baris "data: {...}" berisi { delta } / { error } / { done }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const handleLine = (line) => {
        line = line.trim();
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        let data;
        try { data = JSON.parse(payload); } catch (e) { return; }
        if (data.error) streamError = data.error;
        else if (data.delta) { fullText += data.delta; schedulePaint(); }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(handleLine);
        }
        buf += decoder.decode();
        if (buf) handleLine(buf);
      } catch (e) {
        streamError = streamError || 'Koneksi terputus saat menerima jawaban.';
      }
    }

    if (raf) cancelAnimationFrame(raf);
    paint();

    if (!fullText) throw new Error(streamError || 'Balasan kosong dari server.');

    if (streamError) {
      bubbleEl.insertAdjacentHTML('beforeend', `<br><br><em>Jawaban terputus: ${escHtml(streamError)}</em>`);
    }

    state.messages.push({ role: 'ai', content: fullText, model: usedModel });
    saveChatToLocal();

    msgDiv.querySelectorAll('.copy-code-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.getAttribute('data-code'));
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });
    });

    await fetchCredits();

  } catch (err) {
    if (raf) cancelAnimationFrame(raf);
    msgDiv.remove();
    addMessage('ai', `Error: ${err.message}`);
  } finally {
    state.isTyping = false;
  }
}

// ==========================================
// 7. EVENT LISTENERS
// ==========================================
document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById('input').addEventListener('input', () => {
  const input = document.getElementById('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});
document.getElementById('menuBtn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('overlay').classList.add('active');
});
document.getElementById('closeSidebar').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
});
document.getElementById('overlay').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
});

document.getElementById('newChatBtn').addEventListener('click', () => {
  state.currentChatId = null;
  state.messages = [];
  clearAttachedFile();
  document.getElementById('messages').innerHTML = `
    <div class="welcome" id="welcome">
      <div class="welcome-icon glass">
        <img src="logo.png" width="38" height="38" alt="DeepChat" style="object-fit:contain">
      </div>
      <h2>Selamat datang di DeepChat</h2>
      <p>Pilih model di sidebar, upload file, atau atur persona di setting.</p>
    </div>
  `;
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
});

document.getElementById('cartBtn').addEventListener('click', () => document.getElementById('cartModal').classList.add('active'));
document.getElementById('closeCartBtn').addEventListener('click', () => document.getElementById('cartModal').classList.remove('active'));

document.querySelectorAll('.pricing-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.pricing-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pricing-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.getAttribute('data-tab')}`).classList.add('active');
  });
});

const waNumber = '6282245114303';
window.beliPaket = function(namaPaket, harga) {
  const pesan = `Halo Admin DeepChat, saya mau beli paket *${namaPaket}* dengan harga Rp ${harga.toLocaleString('id-ID')}. Mohon info cara pembayarannya.`;
  window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(pesan)}`, '_blank');
};

// ==========================================
// 8. TEMA & MODAL
// ==========================================
const ICON_SUN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const ICON_MOON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const themeBtn = document.getElementById('themeBtn');

function applyTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  if (persist) { try { localStorage.setItem('deepchat_theme', theme); } catch (e) {} }
  if (themeBtn) {
    themeBtn.innerHTML = theme === 'dark' ? ICON_SUN : ICON_MOON;
    themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap');
  }
}
applyTheme(document.documentElement.dataset.theme || 'light', false);
themeBtn?.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
});

document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('active'); });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    if (settingsMenu && !settingsMenu.hidden) { setSettingsMenu(false); settingsBtn.focus(); }
  }
});

// ==========================================
// 9. SKILL (instruksi tambahan yang bisa dipasang pengguna)
// ==========================================
const MAX_ENABLED_SKILLS = 3;
const MAX_STORED_SKILLS = 10;
const MAX_SKILL_CHARS = 6000;
const skillsModal = document.getElementById('skillsModal');
const skillsEnabledHere = !!skillsModal; // hanya halaman yang punya menu Skill

function loadSkills() {
  try {
    const v = JSON.parse(localStorage.getItem('deepchat_skills') || '[]');
    return Array.isArray(v) ? v.filter(s => s && typeof s.id === 'string' && typeof s.instructions === 'string') : [];
  } catch (e) { return []; }
}
state.skills = loadSkills();

function persistSkills() {
  try { localStorage.setItem('deepchat_skills', JSON.stringify(state.skills)); }
  catch (e) { alert('Skill gagal disimpan: penyimpanan browser penuh.'); }
  renderSkills();
}

// Hanya skill aktif yang dikirim ke server (dan hanya di halaman yang punya menu Skill)
function activeSkills() {
  if (!skillsEnabledHere) return [];
  return state.skills
    .filter(s => s.enabled)
    .slice(0, MAX_ENABLED_SKILLS)
    .map(({ name, description, instructions }) => ({ name, description, instructions }));
}

// Membaca format SKILL.md: frontmatter "---" berisi name/description, lalu isi instruksi
function parseSkillText(text, fileName) {
  const out = { name: '', description: '', body: text.trim() };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^(name|description)\s*:\s*(.*)$/);
      if (!kv) continue;
      let val = kv[2].trim();
      if (/^[>|][-+]?$/.test(val)) {
        const parts = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
        val = parts.join(' ');
      }
      out[kv[1]] = val.replace(/^["']|["']$/g, '');
    }
    out.body = m[2].trim();
  }
  if (!out.name) {
    const h = out.body.match(/^#\s+(.+)$/m);
    out.name = h ? h[1].trim() : (fileName || '').replace(/\.[^.]+$/, '');
  }
  return out;
}

function renderSkills() {
  const list = document.getElementById('skillList');
  const enabledCount = state.skills.filter(s => s.enabled).length;
  document.querySelectorAll('[data-skill-badge]').forEach(b => { b.textContent = enabledCount; b.hidden = enabledCount === 0; });
  if (!list) return;

  list.innerHTML = '';
  if (state.skills.length === 0) {
    const p = document.createElement('p');
    p.className = 'skill-empty';
    p.textContent = 'Belum ada skill. Unggah file SKILL.md atau tulis instruksinya lewat "Tambah skill" di bawah.';
    list.appendChild(p);
    return;
  }

  state.skills.forEach(skill => {
    const row = document.createElement('div');
    row.className = 'skill-item';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', `Aktifkan skill ${skill.name}`);
    toggle.checked = !!skill.enabled;
    toggle.addEventListener('change', () => {
      if (toggle.checked && state.skills.filter(s => s.enabled).length >= MAX_ENABLED_SKILLS) {
        toggle.checked = false;
        alert(`Maksimal ${MAX_ENABLED_SKILLS} skill aktif sekaligus. Matikan salah satu dulu.`);
        return;
      }
      skill.enabled = toggle.checked;
      persistSkills();
    });

    const info = document.createElement('div');
    info.className = 'skill-info';
    const name = document.createElement('div');
    name.className = 'skill-name';
    name.textContent = skill.name;
    info.appendChild(name);
    if (skill.description) {
      const desc = document.createElement('p');
      desc.className = 'skill-desc';
      desc.textContent = skill.description;
      info.appendChild(desc);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.setAttribute('aria-label', `Hapus skill ${skill.name}`);
    del.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    del.addEventListener('click', () => {
      if (!confirm(`Hapus skill "${skill.name}"?`)) return;
      state.skills = state.skills.filter(s => s.id !== skill.id);
      persistSkills();
    });

    row.append(toggle, info, del);
    list.appendChild(row);
  });
}

if (skillsEnabledHere) {
  document.getElementById('openSkillsBtn')?.addEventListener('click', () => { setSettingsMenu(false); renderSkills(); skillsModal.classList.add('active'); });
  document.getElementById('closeSkillsBtn')?.addEventListener('click', () => skillsModal.classList.remove('active'));

  document.getElementById('skillFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 200 * 1024) { alert('File terlalu besar. Maksimal 200 KB.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseSkillText(String(reader.result), file.name);
      document.getElementById('skillName').value = parsed.name.slice(0, 60);
      document.getElementById('skillDesc').value = parsed.description.slice(0, 200);
      document.getElementById('skillBody').value = parsed.body;
    };
    reader.readAsText(file);
  });

  document.getElementById('saveSkillBtn').addEventListener('click', () => {
    const nameEl = document.getElementById('skillName');
    const descEl = document.getElementById('skillDesc');
    const bodyEl = document.getElementById('skillBody');
    const name = nameEl.value.trim();
    const body = bodyEl.value.trim();

    if (!name || !body) { alert('Nama dan instruksi skill wajib diisi.'); return; }
    if (body.length > MAX_SKILL_CHARS) {
      alert(`Instruksi terlalu panjang (${body.length} karakter). Maksimal ${MAX_SKILL_CHARS} karakter.`);
      return;
    }
    if (state.skills.length >= MAX_STORED_SKILLS) {
      alert(`Maksimal ${MAX_STORED_SKILLS} skill tersimpan. Hapus yang tidak dipakai dulu.`);
      return;
    }

    state.skills.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      description: descEl.value.trim(),
      instructions: body,
      enabled: state.skills.filter(s => s.enabled).length < MAX_ENABLED_SKILLS,
    });
    nameEl.value = ''; descEl.value = ''; bodyEl.value = '';
    document.getElementById('skillAdd').open = false;
    persistSkills();
  });
}
renderSkills();

// INIT
try {
  const saved = localStorage.getItem('deepchat_model');
  if (saved && MODELS.some(m => m.id === saved)) state.model = saved;
} catch (e) {}
selectModel(state.model, false); // fetchCredits() baru jalan setelah user login
renderAuthUI();
initAuth();
renderHistory();
console.log('DeepChat Ready!');