const state = {
  creditBalance: 0,
  creditCapacity: 0,
  creditsError: false,
  creditsLoaded: false,
  attachedFile: null,
  model: 'deepseek/deepseek-v4.1-flash',
  isTyping: false,
  messages: [],
  currentChatId: null,
  persona: localStorage.getItem('deepchat_persona') || "",
  user: null,
  authReady: false,
  authError: false,
  loggingIn: false,
  uid: undefined,
  run: 0,
};

// DAFTAR SEMUA MODEL (Sesuai Screenshot Kamu)
const MODELS = [
  { id: 'deepseek-lite',                name: 'DeepSeek Lite',       limit: 'Kuota Gratis: 20/hari', color: '#22c55e', free: true },
  { id: 'deepseek/deepseek-v4-flash',   name: 'DeepSeek V4 Flash',   limit: 'Murah & Cepat', color: '#4d6bfe' },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', limit: 'Paling Cerdas', color: '#4d6bfe' },
  { id: 'deepseek/deepseek-v4-pro',     name: 'DeepSeek V4 Pro',     limit: 'Logika Kuat', color: '#4d6bfe' },
  { id: 'gpt/gpt-6-luna',               name: 'GPT-6 Luna',          limit: 'Premium OpenAI', color: '#10a37f' },
  { id: 'glm/glm-5.3-flash',            name: 'GLM-5.3 Flash',       limit: 'Alternatif Cerdas', color: '#f08c1a' },
];
const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4.1-flash';
const modelById = (id) => MODELS.find(m => m.id === id) || MODELS.find(m => m.id === DEFAULT_MODEL_ID);
const ARCH_LOGO = '<img src="logo.png" width="18" height="18" alt="" style="display:block;object-fit:contain">';

// ==========================================
// 0. AUTHENTIKASI & FETCH
// ==========================================
let currentUserToken = null;

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

  // Tombol Login (hanya tampil kalau belum login)
  loginBtn.hidden = !!u;
  loginBtn.disabled = !state.authReady || state.loggingIn;
  $('loginBtnLabel').textContent = state.authError ? 'Login tidak tersedia' : state.loggingIn ? 'Membuka Google…' : state.authReady ? 'Login dengan Google' : 'Memeriksa login…';

  const errEl = $('authError');
  if (errEl) {
    errEl.hidden = !state.authError;
    errEl.textContent = state.authError ? 'Layanan login gagal dimuat.' : '';
  }

  // Kartu Profil Mini di Bawah
  const userCard = $('userCard');
  if (userCard) userCard.hidden = !u;

  if (u) {
    const name = u.displayName || u.email || 'Pengguna';
    const nameEl = $('userName');
    if (nameEl) nameEl.textContent = name;
    
    const av = $('userAvatar');
    if (av) {
      av.textContent = '';
      const initial = name.trim().charAt(0).toUpperCase() || '?';
      if (u.photoURL) {
        const img = new Image();
        img.alt = ''; img.referrerPolicy = 'no-referrer';
        img.onerror = () => { av.textContent = initial; };
        img.src = u.photoURL; av.appendChild(img);
      } else {
        av.textContent = initial;
      }
    }
  }

  // Notice Login di atas Chat
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
    case 'auth/popup-blocked': return 'Popup login diblokir browser.';
    case 'auth/unauthorized-domain': return 'Domain ini belum didaftarkan di Firebase.';
    default: return `Login gagal. Coba lagi.`;
  }
}

async function loginWithGoogle() {
  const sdk = window.firebaseSDK;
  if (!sdk || !window.firebaseAuth) { alert('Login belum siap.'); return; }
  if (state.loggingIn) return;
  state.loggingIn = true; renderAuthUI();
  try { await sdk.signInWithPopup(window.firebaseAuth, new sdk.GoogleAuthProvider()); }
  catch (err) {
    if (err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request')) return;
    alert(authErrorMessage(err));
  } finally { state.loggingIn = false; renderAuthUI(); }
}

async function logout() {
  try { await window.firebaseSDK.signOut(window.firebaseAuth); }
  catch (err) { alert('Logout gagal.'); }
}

function initAuth() {
  let started = false;
  const start = () => {
    if (started) return; started = true; clearTimeout(timer);
    window.firebaseSDK.onAuthStateChanged(window.firebaseAuth, async (user) => {
      handleAccountChange(user);
      try { currentUserToken = user ? await user.getIdToken() : null; } catch (e) { currentUserToken = null; }
      state.authReady = true; state.authError = false;
      state.creditBalance = 0; state.creditCapacity = 0; state.creditsError = false; state.creditsLoaded = false;
      renderAuthUI(); updateCreditUI();
      if (user) fetchCredits();
    });
  };
  const fail = () => { if (started) return; state.authError = true; renderAuthUI(); updateCreditUI(); };
  const timer = setTimeout(fail, 8000);
  window.addEventListener('firebase-ready', start);
  window.addEventListener('firebase-error', fail);
  if (window.firebaseAuth && window.firebaseSDK) start();

  document.getElementById('loginBtn')?.addEventListener('click', loginWithGoogle);
  document.getElementById('loginNoticeBtn')?.addEventListener('click', loginWithGoogle);
  document.getElementById('logoutBtn')?.addEventListener('click', logout);
}

// ==========================================
// 1. MANAJEMEN SALDO & MODEL
// ==========================================
const fmtCredit = (n) => Math.floor(Number(n) || 0).toLocaleString('id-ID');
const fmtCost = (n) => (Number(n) || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });

async function fetchCredits() {
  if (!state.user) return;
  try {
    const res = await authFetch('/api/billing/me');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Gagal ambil saldo`);
    state.creditBalance = Number(data.balance) || 0;
    state.creditCapacity = Number(data.capacity) || 0;
    state.audioCost = Number(data.audio_cost) || 0;
    state.creditsError = false; state.creditsLoaded = true;
    updateCreditUI();
  } catch (err) { state.creditsError = true; updateCreditUI(); }
}

const LOW_CREDIT_RATIO = 0.15;
const METER_PREFIX = 'deepchat_credit_meter_';

function readMeterStore(uid) { try { const v = JSON.parse(localStorage.getItem(METER_PREFIX + uid) || 'null'); return v && typeof v === 'object' ? v : null; } catch (e) { return null; } }
function writeMeterStore(uid, v) { try { localStorage.setItem(METER_PREFIX + uid, JSON.stringify(v)); } catch (e) {} }

function computeCreditMeter() {
  const bal = Math.max(0, Number(state.creditBalance) || 0);
  const uid = state.user && state.user.uid;
  const saved = uid ? readMeterStore(uid) : null;
  const last = saved && typeof saved.last === 'number' ? saved.last : null;
  let cap;
  if (state.creditCapacity > 0) { cap = state.creditCapacity; } 
  else {
    cap = saved && typeof saved.cap === 'number' ? saved.cap : bal;
    if (last !== null) {
      if (last <= 0 && bal > 0) cap = bal;
      else if (bal > last) cap += bal - last;
    }
  }
  cap = Math.max(cap, bal);
  if (uid && !(saved && saved.cap === cap && saved.last === bal)) writeMeterStore(uid, { cap, last: bal });
  return { bal, cap, ratio: cap > 0 ? bal / cap : 0 };
}

function renderCreditMeters() {
  const meters = document.querySelectorAll('[data-credit-meter]');
  if (!meters.length) return;
  let pct = 0, low = false, note;
  if (!state.user) note = 'Login untuk melihat saldo.';
  else if (state.creditsError) { note = 'Saldo gagal dimuat.'; }
  else if (!state.creditsLoaded) note = 'Memuat saldo…';
  else {
    const m = computeCreditMeter();
    if (m.bal <= 0) { low = true; note = m.cap > 0 ? 'Saldo habis. Top Up untuk lanjut.' : 'Belum ada saldo. Top Up untuk mulai.'; } 
    else { pct = Math.max(1, Math.min(100, Math.round(m.ratio * 100))); low = m.ratio <= LOW_CREDIT_RATIO; note = `${pct}% tersisa${low ? '. Hampir habis.' : ''}`; }
  }
  meters.forEach(el => {
    el.dataset.level = low ? 'low' : '';
    const track = el.querySelector('.credit-meter-track');
    const fill = el.querySelector('.credit-meter-fill');
    const noteEl = el.querySelector('.credit-meter-note');
    if (fill) fill.style.width = pct + '%';
    if (noteEl) noteEl.textContent = note;
    if (track) { track.setAttribute('aria-valuenow', String(pct)); track.setAttribute('aria-valuetext', note); }
  });
}

function updateCreditUI() {
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const fileInput = document.getElementById('fileUpload');
  const cur = modelById(state.model);
  const loggedIn = !!state.user;
  const lockedHint = (state.authReady || state.authError) ? 'Login dulu untuk mulai chat.' : 'Memeriksa status login...';

  const setComposer = (enabled, placeholder) => {
    input.disabled = !enabled; sendBtn.disabled = !enabled;
    if (fileInput) fileInput.disabled = !loggedIn;
    input.placeholder = placeholder;
  };

  const amountText = loggedIn && state.creditsLoaded ? fmtCredit(state.creditBalance) : '–';
  document.querySelectorAll('#creditBadge, [data-credit-amount]').forEach(el => { el.textContent = amountText; });
  renderCreditMeters();

  if (!loggedIn) { setComposer(false, lockedHint); return; }
  if (!cur.free && state.creditsLoaded && state.creditBalance <= 0) { setComposer(false, 'Saldo habis. Silakan Top Up.'); return; }
  setComposer(true, 'Ketik pesan...');
}

const CHEV = '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const TICK = '<svg class="tick" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
const picker = document.getElementById('modelPicker');

function modelRow(m, extra) {
  return `<span class="model-mark" style="--model-color:${m.color}">${ARCH_LOGO}</span>
    <span class="model-text"><span class="model-name">${m.name}</span><span class="model-sub">${m.limit}</span></span>${extra}`;
}

function renderModelPicker() {
  if (!picker) return;
  const cur = modelById(state.model);
  picker.innerHTML = `
    <button type="button" class="model-btn" id="modelBtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Pilih model">
      ${modelRow(cur, CHEV)}
    </button>
    <div class="model-menu" id="modelMenu" role="listbox" hidden>
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
  document.getElementById('headerModelName').textContent = m.name;
  if (persist) { try { localStorage.setItem('deepchat_model', m.id); } catch (e) {} }
  renderModelPicker();
  updateCreditUI();
  if (!state.creditsLoaded) fetchCredits();
}

if (picker) {
  picker.addEventListener('click', (e) => {
    const opt = e.target.closest('.model-option');
    if (opt) { selectModel(opt.dataset.id); document.getElementById('modelBtn').focus(); return; }
    if (e.target.closest('#modelBtn')) setMenu(document.getElementById('modelMenu').hidden);
  });
  document.addEventListener('click', (e) => { if (!picker.contains(e.target)) setMenu(false); });
}

// ==========================================
// 2. MODAL SETTINGS & PERSONA
// ==========================================
const personaModal = document.getElementById('personaModal');
const personaInput = document.getElementById('personaInput');
const settingsBtn = document.getElementById('settingsBtn');
const settingsMenu = document.getElementById('settingsMenu');

if (personaInput) personaInput.value = state.persona;

function setSettingsMenu(open) {
  if (!settingsMenu || !settingsBtn) return;
  settingsMenu.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) settingsMenu.querySelector('.settings-item')?.focus();
}
settingsBtn?.addEventListener('click', (e) => { e.stopPropagation(); setSettingsMenu(settingsMenu.hidden); });
document.addEventListener('click', (e) => { if (settingsMenu && !settingsMenu.hidden && !settingsMenu.contains(e.target)) setSettingsMenu(false); });

document.getElementById('openPersonaBtn')?.addEventListener('click', () => {
  setSettingsMenu(false); personaInput.value = state.persona; personaModal.classList.add('active');
});
document.getElementById('closePersonaBtn')?.addEventListener('click', () => personaModal.classList.remove('active'));
document.getElementById('savePersonaBtn')?.addEventListener('click', () => {
  state.persona = personaInput.value.trim();
  try { localStorage.setItem('deepchat_persona', state.persona); } catch (e) {}
  alert('Persona berhasil disimpan!'); personaModal.classList.remove('active');
});

// ==========================================
// 3. USAGE & BILLING
// ==========================================
function setBillingTab(tab) {
  document.querySelectorAll('.billing-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const topupTab = document.getElementById('billingTabTopup');
  const historyTab = document.getElementById('billingTabHistory');
  if(topupTab) topupTab.hidden = tab !== 'topup';
  if(historyTab) historyTab.hidden = tab !== 'history';
}

function openBilling(tab = 'topup') {
  const modal = document.getElementById('billingModal');
  if (!modal) return;
  if (!state.user) { alert('Login dulu untuk membuka Usage & Billing.'); return; }
  setBillingTab(tab); 
  modal.classList.add('active');
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
  fetchUsageHistory();
}

async function fetchUsageHistory() {
  const el = document.getElementById('usageHistoryList');
  if (!el) return;
  el.innerHTML = '<p class="history-empty">Memuat riwayat...</p>';
  try {
    const res = await authFetch('/api/billing/transactions?limit=50');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Gagal memuat riwayat`);
    const rows = data.transactions || [];
    if (!rows.length) { el.innerHTML = '<p class="history-empty">Belum ada riwayat pemakaian.</p>'; return; }
    const num = (n) => (Number(n) || 0).toLocaleString('id-ID');
    el.innerHTML = `<div style="overflow-x:auto"><table class="usage-table"><thead><tr><th>Tanggal</th><th>Model</th><th>Token (In/Out)</th><th>Potongan</th></tr></thead><tbody>
      ${rows.map(t => `<tr>
        <td>${new Date(t.created_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${escHtml((t.model_id || '-').split('/').pop())}</td>
        <td>${num(t.input_tokens)} / ${num(t.output_tokens)}</td>
        <td class="text-red">-${fmtCost(t.credit_deducted)}</td>
      </tr>`).join('')}
    </tbody></table></div>`;
  } catch (e) { el.innerHTML = `<p class="history-empty">${escHtml(e.message)}</p>`; }
}

document.getElementById('openBillingBtn')?.addEventListener('click', (e) => { e.preventDefault(); openBilling('topup'); });
document.getElementById('topupBtn')?.addEventListener('click', (e) => { e.preventDefault(); openBilling('topup'); });
document.getElementById('closeBillingBtn')?.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('billingModal').classList.remove('active'); });

document.querySelectorAll('.billing-tab').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    setBillingTab(btn.dataset.tab);
    if (btn.dataset.tab === 'history') fetchUsageHistory();
  });
});

document.getElementById('openRedeemBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('billingModal').classList.remove('active');
  document.getElementById('redeemModal').classList.add('active');
});

document.getElementById('cancelRedeem')?.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('redeemModal').classList.remove('active'); });
document.getElementById('confirmRedeem')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const code = document.getElementById('redeemInput').value.trim();
  if (!code) return;
  const btn = document.getElementById('confirmRedeem');
  btn.textContent = 'Memproses...'; btn.disabled = true;
  try {
    const res = await authFetch('/api/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    alert('Berhasil! Saldo ditambahkan.');
    document.getElementById('redeemModal').classList.remove('active');
    document.getElementById('redeemInput').value = '';
    fetchCredits(); 
  } catch (err) { alert(err.message); } finally { btn.textContent = 'Tukar'; btn.disabled = false; }
});

async function beliPaket(nama, harga) {
  window.location.href = '/topup'; 
}
window.beliPaket = beliPaket;

// ==========================================
// 4. FITUR UPLOAD FILE
// ==========================================
const MAX_FILE_CHARS = 40000;
let fileReadToken = 0;
const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FILE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>';

function formatBytes(n) { if (n < 1024) return `${n} B`; if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`; return `${(n / 1024 / 1024).toFixed(1)} MB`; }

function renderFileChip() {
  const chip = document.getElementById('fileChip');
  if (!chip) return;
  const f = state.attachedFile;
  if (!f) { chip.hidden = true; chip.innerHTML = ''; return; }
  const kind = f.kind && f.kind !== 'txt' ? `${String(f.kind).toUpperCase()} · ` : '';
  const meta = f.loading ? (f.status || 'Membaca file…') : `${kind}${formatBytes(f.size)}${f.truncated ? ` · Terpotong` : ''}`;
  chip.hidden = false;
  chip.innerHTML = `${FILE_ICON}<div class="file-chip-info"><span class="file-chip-name">${escHtml(f.name)}</span><span class="file-chip-meta">${escHtml(meta)}</span></div><button type="button" class="icon-btn" id="removeFileBtn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
  document.getElementById('removeFileBtn').addEventListener('click', clearAttachedFile);
}

function clearAttachedFile() { fileReadToken++; state.attachedFile = null; renderFileChip(); }

async function transcribeAudio(f) {
  if (!confirm(`Transkrip audio memotong ${state.audioCost || 'beberapa'} kredit. Lanjutkan?`)) {
    const err = new DeepFileReader.FileReadError('Dibatalkan.'); err.silent = true; throw err;
  }
  const res = await authFetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) }, body: f });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new DeepFileReader.FileReadError(data.error || 'Transkrip gagal.');
  if (data.remaining_balance !== undefined) { state.creditBalance = Number(data.remaining_balance) || 0; state.creditsLoaded = true; updateCreditUI(); }
  return data.text;
}

window.handleFileUpload = async function(event) {
  const input = event.target; const file = input.files[0]; input.value = ''; 
  if (!file || !window.DeepFileReader) return;
  const token = ++fileReadToken;
  state.attachedFile = { name: file.name, size: file.size, text: '', loading: true, status: 'Membaca file…', announced: false };
  renderFileChip();
  try {
    const r = await DeepFileReader.read(file, { maxChars: MAX_FILE_CHARS, transcribe: transcribeAudio, onProgress: (msg) => {
        if (token !== fileReadToken || !state.attachedFile) return; state.attachedFile.status = msg; renderFileChip();
    }});
    if (token !== fileReadToken) return;
    state.attachedFile = { name: file.name, size: file.size, text: r.text, truncated: r.truncated, kind: r.kind, announced: false };
  } catch (e) { if (token !== fileReadToken) return; state.attachedFile = null; if (!e.silent) alert(e.message || 'Gagal membaca file.'); }
  renderFileChip();
  document.getElementById('input')?.focus();
};

// ==========================================
// 5. SYNTAX HIGHLIGHTING & FORMAT
// ==========================================
function highlightCode(code, lang) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const hashComment = /^(python|py|bash|sh|shell|yaml|yml|ruby|rb|toml|dockerfile)$/.test(lang || '');
  const KEYWORDS = 'function|const|let|var|if|else|return|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|try|catch|finally|throw|async|await|this|typeof|instanceof|in|of|null|undefined|true|false|def|elif|lambda|None|True|False|pass|with|as|print|public|private|static|void|int|string|bool|echo|fi|then';
  const re = new RegExp('(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' + (hashComment ? '|#[^\\n]*' : '') + ')|("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)|\\b(' + KEYWORDS + ')\\b|\\b(\\d+(?:\\.\\d+)?)\\b|([A-Za-z_$][\\w$]*)(?=\\()|(===|!==|==|=>|\\+\\+|--|[+\\-*/=<>!&|]+)','g');
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
      return `<div class="code-wrapper"><button class="copy-code-btn" data-code="${escapedAttr}">Copy</button><pre><code>${highlighted}</code></pre></div>`;
    } else {
      let txt = part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      txt = txt.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
      return txt.replace(/^\n+|\n+$/g, '').replace(/\n/g, '<br>');
    }
  }).join('');
}

function addMessage(role, content, saveToHistory = true, modelId = null, fileName = null) {
  const welcome = document.getElementById('welcome'); if (welcome) welcome.style.display = 'none';
  const msgDiv = document.createElement('div'); msgDiv.className = `message ${role}`;
  const archLogo = ARCH_LOGO;
  const userLogo = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
  msgDiv.innerHTML = `<div class="msg-avatar" style="${role === 'ai' ? `--model-color:${modelById(modelId || state.model).color}` : ''}">${role === 'user' ? userLogo : archLogo}</div><div class="msg-content">${role === 'ai' ? formatMessage(content) : (fileName ? `<div class="msg-file">${FILE_ICON}<span>${escHtml(fileName)}</span></div><br>` : '') + escHtml(content).replace(/\n/g, '<br>')}</div>`;
  if (role === 'ai') {
    msgDiv.querySelectorAll('.copy-code-btn').forEach(btn => {
      btn.addEventListener('click', () => { navigator.clipboard?.writeText(btn.getAttribute('data-code')).catch(() => {}); btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); });
    });
  }
  document.getElementById('messages').appendChild(msgDiv);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
  state.messages.push(role === 'ai' ? { role, content, model: modelId || state.model } : (fileName ? { role, content, file: fileName } : { role, content }));
  if (saveToHistory) saveChatToLocal();
}

const HISTORY_PREFIX = 'deepchat_history_';
function historyKey(uid) { const id = uid || (state.user && state.user.uid); return id ? HISTORY_PREFIX + id : null; }
function readHistory() { const key = historyKey(); if (!key) return {}; try { const v = JSON.parse(localStorage.getItem(key) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
function writeHistory(all) { const key = historyKey(); if (!key) return false; try { localStorage.setItem(key, JSON.stringify(all)); return true; } catch (e) { return false; } }
function wipeLocalUserData(uid) { try { if (uid) { localStorage.removeItem(HISTORY_PREFIX + uid); localStorage.removeItem(METER_PREFIX + uid); } localStorage.removeItem('deepchat_persona'); localStorage.removeItem('deepchat_skills'); } catch (e) {} state.persona = ''; if (typeof personaInput !== 'undefined' && personaInput) personaInput.value = ''; state.skills = []; renderSkills(); }

const STARTERS = '<div class="starters">' + ['Rangkum file yang gue upload', 'Bantu cari bug di kode gue', 'Rapikan paragraf ini', 'Jelasin konsep ini pakai contoh'].map(t => `<button type="button" class="starter">${t}</button>`).join('') + '</div>';
function welcomeHTML() { return `<div class="welcome" id="welcome"><div class="welcome-icon glass"><img src="logo.png" width="38" height="38" alt="DeepChat" style="object-fit:contain"></div><h2>Selamat datang di DeepChat</h2><p>Pilih model di sidebar, upload file, atau atur persona di setting.</p>${STARTERS}</div>`; }
function detachView() { state.run++; state.isTyping = false; }
function resetChatView() { detachView(); state.currentChatId = null; state.messages = []; clearAttachedFile(); document.getElementById('messages').innerHTML = welcomeHTML(); }

function handleAccountChange(user) {
  const prevUid = state.uid; const newUid = user ? user.uid : null; state.user = user;
  if (prevUid !== undefined && prevUid !== newUid) {
    if (prevUid) wipeLocalUserData(prevUid);
    resetChatView(); document.getElementById('billingModal')?.classList.remove('active');
    const input = document.getElementById('input'); if (input) { input.value = ''; input.style.height = 'auto'; }
  }
  state.uid = newUid; renderHistory();
}

function persistChat(chatId, messages, onlyIfExists = false) {
  const all = readHistory(); if (onlyIfExists && !all[chatId]) return;
  const first = messages.find(m => m.role === 'user');
  const title = first ? (first.content.length > 30 ? first.content.substring(0, 30) + '...' : first.content) : 'Chat Baru';
  all[chatId] = { id: chatId, title, messages }; writeHistory(all); renderHistory();
}
function saveChatToLocal() { if (!state.user) return; if (!state.currentChatId) state.currentChatId = Date.now().toString(); persistChat(state.currentChatId, state.messages); }

const TRASH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';

function renderHistory() {
  const list = document.getElementById('chatHistoryList'); if (!list) return; list.innerHTML = '';
  const chats = Object.values(readHistory()).sort((a, b) => b.id - a.id);
  const clearBtn = document.getElementById('clearHistoryBtn'); if (clearBtn) clearBtn.hidden = chats.length === 0;
  if (chats.length === 0) { const p = document.createElement('p'); p.className = 'history-empty'; p.textContent = state.user ? 'Belum ada riwayat chat.' : 'Login untuk melihat riwayat chat.'; list.appendChild(p); return; }
  chats.forEach(chat => {
    const row = document.createElement('div'); row.className = 'history-row' + (chat.id === state.currentChatId ? ' active' : '');
    const open = document.createElement('button'); open.type = 'button'; open.className = 'history-item'; open.textContent = chat.title;
    open.addEventListener('click', () => loadChat(chat.id));
    const del = document.createElement('button'); del.type = 'button'; del.className = 'history-del'; del.title = 'Hapus obrolan'; del.innerHTML = TRASH_ICON;
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(chat.id); });
    row.append(open, del); list.appendChild(row);
  });
}

function deleteChat(id) { const all = readHistory(); const chat = all[id]; if (!chat) return; if (!confirm(`Hapus obrolan "${chat.title}"?`)) return; delete all[id]; writeHistory(all); if (state.currentChatId === id) resetChatView(); renderHistory(); }
function clearAllHistory() { if (Object.keys(readHistory()).length === 0) return; if (!confirm('Hapus semua riwayat chat?')) return; writeHistory({}); resetChatView(); renderHistory(); }
function loadChat(id) {
  const chat = readHistory()[id]; if (!chat) return;
  detachView(); state.currentChatId = id; state.messages = []; document.getElementById('messages').innerHTML = ''; clearAttachedFile();
  chat.messages.forEach(msg => addMessage(msg.role, msg.content, false, msg.model, msg.file));
  renderHistory(); document.getElementById('sidebar').classList.remove('open'); document.getElementById('overlay').classList.remove('active');
}

async function sendMessage() {
  const input = document.getElementById('input'); const text = input.value.trim();
  const isFree = modelById(state.model).free;
  if (!state.user || (state.attachedFile && state.attachedFile.loading) || !text || state.isTyping || (!isFree && state.creditBalance <= 0)) return;

  const af = state.attachedFile; const announceName = af && !af.announced ? af.name : null; if (af) af.announced = true;
  addMessage('user', text, true, null, announceName);
  input.value = ''; input.style.height = 'auto';

  const run = ++state.run; const ctx = { uid: state.user.uid, chatId: state.currentChatId, messages: state.messages };
  const stillHere = () => state.run === run; state.isTyping = true;

  const box = document.getElementById('messages'); box.scrollTop = box.scrollHeight;
  const usedModel = state.model; const msgDiv = document.createElement('div'); msgDiv.className = 'message ai';
  msgDiv.innerHTML = `<div class="msg-avatar" style="--model-color:${modelById(usedModel).color}">${ARCH_LOGO}</div><div class="msg-content"><span class="typing-dots" role="status"><i></i><i></i><i></i></span></div>`;
  box.appendChild(msgDiv); const bubbleEl = msgDiv.querySelector('.msg-content');

  let fullText = '', streamDone = false, billing = null, streamError = null;
  const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  let shown = 0, lastN = -1, lastTs = 0, timer = null, finishTyping = null;

  const render = (final) => {
    let n = Math.floor(shown); if (n > 0 && n < fullText.length) { const c = fullText.charCodeAt(n - 1); if (c >= 0xD800 && c <= 0xDBFF) n++; }
    if (n === 0) return; if (n === lastN && !final) return; lastN = n;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const part = fullText.slice(0, n); const open = (part.match(/```/g) || []).length % 2 === 1;
    bubbleEl.innerHTML = formatMessage(open ? part + '\n```' : part) + (final ? '' : '<span class="type-caret"></span>');
    if (nearBottom) box.scrollTop = box.scrollHeight;
  };

  const tick = () => {
    timer = null; if (!stillHere()) { if (finishTyping) finishTyping(); return; }
    const now = performance.now(); const dt = lastTs ? now - lastTs : 16; lastTs = now;
    const len = fullText.length;
    if (shown < len) { const rate = reduceMotion ? 1e9 : Math.max(90, len / 4); shown = Math.min(len, shown + rate * dt / 1000); }
    if (streamDone && shown >= len) { render(true); if (finishTyping) finishTyping(); return; }
    render(false); timer = setTimeout(tick, 16);
  };
  const startTyping = () => { if (!timer) timer = setTimeout(tick, 16); };

  try {
    let cleanMessages = state.messages.filter(msg => !msg.content.startsWith('Error:')).map(msg => ({ role: msg.role === 'ai' ? 'assistant' : 'user', content: msg.content }));
    if (cleanMessages.length > 0 && cleanMessages[0].role === 'assistant') cleanMessages.shift();

    const res = await authFetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: cleanMessages, modelId: usedModel, persona: state.persona, fileContext: af ? af.text : '', fileName: af ? af.name : '', skills: typeof activeSkills === 'function' ? activeSkills() : [] })
    });

    if (!res.ok) { let msg = 'Gagal menghubungi server'; try { msg = (await res.json()).error || msg; } catch (e) {} throw new Error(msg); }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json(); fullText = data.reply || '';
      if (data.remaining_balance !== undefined) billing = { cost: data.cost || 0, remaining_balance: data.remaining_balance };
    } else {
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
      const handleLine = (line) => {
        line = line.trim(); if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim(); if (!payload || payload === '[DONE]') return;
        let data; try { data = JSON.parse(payload); } catch (e) { return; }
        if (data.remaining_balance !== undefined) billing = { cost: data.cost || 0, remaining_balance: data.remaining_balance };
        if (data.error) streamError = data.error; else if (data.delta) { fullText += data.delta; startTyping(); }
      };
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; buf += decoder.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(handleLine); }
        buf += decoder.decode(); if (buf) handleLine(buf);
      } catch (e) { streamError = streamError || 'Koneksi terputus.'; }
    }

    if (billing) { state.creditBalance = Number(billing.remaining_balance) || 0; state.creditsLoaded = true; updateCreditUI(); }
    streamDone = true; if (!fullText) throw new Error(streamError || 'Balasan kosong dari server.');

    ctx.messages.push({ role: 'ai', content: fullText, model: usedModel });
    if (state.user && state.user.uid === ctx.uid) persistChat(ctx.chatId, ctx.messages, true);
    if (stillHere()) { await new Promise((resolve) => { finishTyping = resolve; startTyping(); }); }

    if (stillHere()) {
      if (billing) bubbleEl.insertAdjacentHTML('beforeend', `<div class="msg-cost">Potong ${fmtCost(billing.cost)} Kredit. Sisa: ${fmtCredit(billing.remaining_balance)} Kredit.</div>`);
      msgDiv.querySelectorAll('.copy-code-btn').forEach(btn => { btn.addEventListener('click', () => { navigator.clipboard?.writeText(btn.getAttribute('data-code')).catch(() => {}); btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); }); });
    }
    if (!billing) await fetchCredits();
  } catch (err) {
    if (timer) { clearTimeout(timer); timer = null; }
    fetchCredits(); msgDiv.remove(); if (stillHere()) addMessage('ai', `Error: ${err.message}`);
  } finally { if (state.run === run) state.isTyping = false; }
}

// ==========================================
// 6. EVENT LISTENERS & INIT
// ==========================================
document.getElementById('sendBtn')?.addEventListener('click', sendMessage);
document.getElementById('input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
document.getElementById('input')?.addEventListener('input', () => { const input = document.getElementById('input'); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; });
document.getElementById('menuBtn')?.addEventListener('click', () => { document.getElementById('sidebar').classList.add('open'); document.getElementById('overlay').classList.add('active'); });
document.getElementById('closeSidebar')?.addEventListener('click', () => { document.getElementById('sidebar').classList.remove('open'); document.getElementById('overlay').classList.remove('active'); });
document.getElementById('overlay')?.addEventListener('click', () => { document.getElementById('sidebar').classList.remove('open'); document.getElementById('overlay').classList.remove('active'); });
document.getElementById('newChatBtn')?.addEventListener('click', () => { resetChatView(); renderHistory(); document.getElementById('sidebar').classList.remove('open'); document.getElementById('overlay').classList.remove('active'); });
document.getElementById('clearHistoryBtn')?.addEventListener('click', clearAllHistory);

const ICON_SUN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const ICON_MOON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const themeBtn = document.getElementById('themeBtn');

function applyTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  if (persist) { try { localStorage.setItem('deepchat_theme', theme); } catch (e) {} }
  if (themeBtn) { themeBtn.innerHTML = theme === 'dark' ? ICON_SUN : ICON_MOON; themeBtn.setAttribute('aria-label', theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'); }
}
applyTheme(document.documentElement.dataset.theme || 'light', false);
themeBtn?.addEventListener('click', () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true); });

document.querySelectorAll('.modal').forEach(m => { m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('active'); }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active')); if (settingsMenu && !settingsMenu.hidden) { setSettingsMenu(false); settingsBtn.focus(); } } });

// SKILLS
const MAX_ENABLED_SKILLS = 3;
const MAX_STORED_SKILLS = 10;
const MAX_SKILL_CHARS = 100000;
const skillsModal = document.getElementById('skillsModal');
const skillsEnabledHere = !!skillsModal;

function loadSkills() { try { const v = JSON.parse(localStorage.getItem('deepchat_skills') || '[]'); return Array.isArray(v) ? v.filter(s => s && typeof s.id === 'string' && typeof s.instructions === 'string') : []; } catch (e) { return []; } }
state.skills = loadSkills();

function persistSkills() { try { localStorage.setItem('deepchat_skills', JSON.stringify(state.skills)); } catch (e) { alert('Skill gagal disimpan: penyimpanan browser penuh.'); } renderSkills(); }
function activeSkills() { if (!skillsEnabledHere) return []; return state.skills.filter(s => s.enabled).slice(0, MAX_ENABLED_SKILLS).map(({ name, description, instructions }) => ({ name, description, instructions })); }

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
  if (!out.name) { const h = out.body.match(/^#\s+(.+)$/m); out.name = h ? h[1].trim() : (fileName || '').replace(/\.[^.]+$/, ''); }
  return out;
}

function renderSkills() {
  const list = document.getElementById('skillList');
  const enabledCount = state.skills.filter(s => s.enabled).length;
  document.querySelectorAll('[data-skill-badge]').forEach(b => { b.textContent = enabledCount; b.hidden = enabledCount === 0; });
  if (!list) return;

  list.innerHTML = '';
  if (state.skills.length === 0) {
    const p = document.createElement('p'); p.className = 'skill-empty'; p.textContent = 'Belum ada skill. Unggah file SKILL.md atau tulis instruksinya lewat "Tambah skill" di bawah.'; list.appendChild(p); return;
  }

  state.skills.forEach(skill => {
    const row = document.createElement('div'); row.className = 'skill-item';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.className = 'switch'; toggle.setAttribute('role', 'switch'); toggle.checked = !!skill.enabled;
    toggle.addEventListener('change', () => {
      if (toggle.checked && state.skills.filter(s => s.enabled).length >= MAX_ENABLED_SKILLS) { toggle.checked = false; alert(`Maksimal ${MAX_ENABLED_SKILLS} skill aktif.`); return; }
      skill.enabled = toggle.checked; persistSkills();
    });
    const info = document.createElement('div'); info.className = 'skill-info';
    const name = document.createElement('div'); name.className = 'skill-name'; name.textContent = skill.name; info.appendChild(name);
    if (skill.description) { const desc = document.createElement('p'); desc.className = 'skill-desc'; desc.textContent = skill.description; info.appendChild(desc); }
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn'; del.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    del.addEventListener('click', () => { if (!confirm(`Hapus skill "${skill.name}"?`)) return; state.skills = state.skills.filter(s => s.id !== skill.id); persistSkills(); });
    row.append(toggle, info, del); list.appendChild(row);
  });
}

if (skillsEnabledHere) {
  document.getElementById('openSkillsBtn')?.addEventListener('click', () => { setSettingsMenu(false); renderSkills(); skillsModal.classList.add('active'); });
  document.getElementById('closeSkillsBtn')?.addEventListener('click', () => skillsModal.classList.remove('active'));
  document.getElementById('skillFile').addEventListener('change', (e) => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    if (file.size > 400 * 1024) { alert('File terlalu besar. Maks 400 KB.'); return; }
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
    const nameEl = document.getElementById('skillName'); const descEl = document.getElementById('skillDesc'); const bodyEl = document.getElementById('skillBody');
    const name = nameEl.value.trim(); const body = bodyEl.value.trim();
    if (!name || !body) { alert('Nama dan instruksi wajib diisi.'); return; }
    if (body.length > MAX_SKILL_CHARS) { alert(`Instruksi terlalu panjang (maks ${MAX_SKILL_CHARS.toLocaleString('id-ID')} karakter).`); return; }
    if (state.skills.length >= MAX_STORED_SKILLS) { alert(`Maksimal ${MAX_STORED_SKILLS} skill tersimpan.`); return; }
    state.skills.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, description: descEl.value.trim(), instructions: body, enabled: state.skills.filter(s => s.enabled).length < MAX_ENABLED_SKILLS });
    nameEl.value = ''; descEl.value = ''; bodyEl.value = ''; document.getElementById('skillAdd').open = false; persistSkills();
  });
}
renderSkills();

document.getElementById('messages')?.addEventListener('click', (e) => { const b = e.target.closest('.starter'); const i = document.getElementById('input'); if (!b || i.disabled) return; i.value = b.textContent; i.dispatchEvent(new Event('input')); i.focus(); });
const w0 = document.getElementById('welcome'); if (w0) w0.outerHTML = welcomeHTML();

// INIT
const fileUploadEl = document.getElementById('fileUpload'); if (fileUploadEl && window.DeepFileReader) fileUploadEl.accept = DeepFileReader.accept;
try { const saved = localStorage.getItem('deepchat_model'); if (saved && MODELS.some(m => m.id === saved)) state.model = saved; } catch (e) {}
selectModel(state.model, false);
renderAuthUI(); initAuth(); renderHistory();
console.log('DeepChat Ready!');