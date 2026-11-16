const state = {
  credits: { deepseek: 0, gpt: 0, glm: 0 },
  creditsLoaded: false,
  currentModelType: 'deepseek',
  model: 'deepseek/deepseek-v4-flash',
  isTyping: false,
  messages: [],
  currentChatId: null,
  persona: localStorage.getItem('deepchat_persona') || "",
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
const ARCH_LOGO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 22H8C8 18 10 15 12 15C14 15 16 18 16 22H22L12 2Z" fill="currentColor"/><path d="M6.5 16L9 10L7 8L4 14L6.5 16Z" fill="var(--bg-base)"/></svg>';

let uploadedFileContext = "";

// ==========================================
// 1. MANAJEMEN LIMIT & MODEL
// ==========================================
async function fetchCredits() {
  // DeepSeek Lite tidak pakai saldo Vikey: jangan fetch. Ditandai belum dimuat,
  // nanti diambil saat user pindah ke model berbayar.
  if (modelById(state.model).free) { state.creditsLoaded = false; return; }
  try {
    const res = await fetch('/api/credits');
    const data = await res.json();
    state.credits = data;
    state.creditsLoaded = true;
    updateCreditUI();
  } catch (err) { console.error('Gagal ambil limit:', err); }
}

function updateCreditUI() {
  const badgeEl = document.getElementById('creditBadge');
  const hintEl = document.querySelector('.credits-hint');
  const cur = modelById(state.model);

  // Model gratis: tampilkan teks kuota, sembunyikan angka limit, input tidak pernah dikunci di sisi klien
  if (cur.free) {
    document.getElementById('creditLabel').textContent = cur.limit;
    badgeEl.style.display = 'none';
    if (hintEl) hintEl.textContent = 'Tidak memakai kredit.';
    const inputEl = document.getElementById('input');
    inputEl.disabled = false;
    document.getElementById('sendBtn').disabled = false;
    inputEl.placeholder = 'Ketik pesan...';
    return;
  }
  badgeEl.style.display = '';
  if (hintEl) hintEl.textContent = '1 chat = 1 kredit';

  let label = 'Limit DeepSeek';
  if (state.currentModelType === 'gpt') label = 'Limit GPT';
  if (state.currentModelType === 'glm') label = 'Limit GLM';
  
  const currentLimit = state.credits[state.currentModelType];
  document.getElementById('creditLabel').textContent = label;
  document.getElementById('creditBadge').textContent = currentLimit;
  
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  
  if (currentLimit <= 0) {
    input.disabled = true; sendBtn.disabled = true;
    input.placeholder = `${label} habis. Tukar kode atau beli paket lewat ikon keranjang.`;
  } else {
    input.disabled = false; sendBtn.disabled = false;
    input.placeholder = 'Ketik pesan...';
  }
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
const settingsModal = document.getElementById('settingsModal');
const personaInput = document.getElementById('personaInput');

if (personaInput) personaInput.value = state.persona;

document.getElementById('settingsBtn')?.addEventListener('click', () => {
  personaInput.value = state.persona;
  settingsModal.classList.add('active');
});

document.getElementById('closeSettingsBtn')?.addEventListener('click', () => {
  settingsModal.classList.remove('active');
});

document.getElementById('saveSettingsBtn')?.addEventListener('click', () => {
  state.persona = personaInput.value.trim();
  localStorage.setItem('deepchat_persona', state.persona);
  alert('Persona berhasil disimpan!');
  settingsModal.classList.remove('active');
});

// ==========================================
// 3. REDEEM KODE
// ==========================================
document.getElementById('redeemBtn').addEventListener('click', () => document.getElementById('redeemModal').classList.add('active'));
document.getElementById('cancelRedeem').addEventListener('click', () => document.getElementById('redeemModal').classList.remove('active'));

document.getElementById('confirmRedeem').addEventListener('click', async () => {
  const code = document.getElementById('redeemInput').value.trim();
  if (!code) return;
  const btn = document.getElementById('confirmRedeem');
  btn.textContent = 'Memproses...'; btn.disabled = true;
  try {
    const res = await fetch('/api/redeem', {
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
window.handleFileUpload = function(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (file.size > 2 * 1024 * 1024) {
    alert('File terlalu besar. Maksimal 2MB.');
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    uploadedFileContext = e.target.result; 
    const inputEl = document.getElementById('input');
    inputEl.placeholder = `File "${file.name}" siap ditanya...`;
    inputEl.style.color = '#22c55e'; 
    setTimeout(() => {
      inputEl.placeholder = 'Ketik pesan...';
      inputEl.style.color = 'var(--text-primary)';
    }, 3000);
  };
  
  reader.readAsText(file); 
  event.target.value = ''; 
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
function addMessage(role, content, saveToHistory = true, modelId = null) {
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
    <div class="msg-content">${role === 'ai' ? formatMessage(content) : content}</div>
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
  state.messages.push(role === 'ai' ? { role, content, model: modelId || state.model } : { role, content });

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
  chat.messages.forEach(msg => addMessage(msg.role, msg.content, false, msg.model));
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
}

async function sendMessage() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  const isFree = modelById(state.model).free;
  if (!text || state.isTyping || (!isFree && state.credits[state.currentModelType] <= 0)) return;

  addMessage('user', text);
  input.value = ''; input.style.height = 'auto';
  
  state.isTyping = true;
  document.getElementById('typingIndicator').classList.add('active');
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;

  try {
    let cleanMessages = state.messages
      .filter(msg => !msg.content.startsWith('Error:'))
      .map(msg => ({ role: msg.role === 'ai' ? 'assistant' : 'user', content: msg.content }));

    if (cleanMessages.length > 0 && cleanMessages[0].role === 'assistant') cleanMessages.shift();

    const persona = state.persona;
    const usedModel = state.model;

    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        messages: cleanMessages, 
        model: state.model,
        persona: persona,
        fileContext: uploadedFileContext,
        skills: activeSkills()
      })
    });
    
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Gagal menghubungi server');
    }

    // Streaming Reader
    document.getElementById('typingIndicator').classList.remove('active');
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.style.display = 'none';

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ai`;
    const bubbleId = 'stream-' + Date.now();
    
    const archLogo = ARCH_LOGO;
    
    msgDiv.innerHTML = `
      <div class="msg-avatar" style="--model-color:${modelById(usedModel).color}">${archLogo}</div>
      <div class="msg-content" id="${bubbleId}"></div>
    `;
    
    document.getElementById('messages').appendChild(msgDiv);
    const bubbleEl = document.getElementById(bubbleId);

    let fullText = "";
    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      // Server membalas JSON biasa: { reply: "..." }
      const data = await res.json();
      fullText = data.reply || '';
      bubbleEl.innerHTML = formatMessage(fullText);
    } else {
      // Cadangan kalau suatu saat server diubah jadi streaming (SSE)
      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.text) {
                fullText += data.text;
                bubbleEl.innerHTML = formatMessage(fullText);
              }
            } catch (e) {}
          }
        }
      }
    }
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;

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
    uploadedFileContext = ""; 

  } catch (err) {
    document.getElementById('typingIndicator').classList.remove('active');
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
  document.getElementById('messages').innerHTML = `
    <div class="welcome" id="welcome">
      <div class="welcome-icon glass">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 22H8C8 18 10 15 12 15C14 15 16 18 16 22H22L12 2Z" fill="currentColor"/><path d="M6.5 16L9 10L7 8L4 14L6.5 16Z" fill="var(--bg-base)"/></svg>
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
  if (e.key === 'Escape') document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
});

// ==========================================
// 9. SKILL (instruksi tambahan yang bisa dipasang pengguna)
// ==========================================
const MAX_ENABLED_SKILLS = 3;
const MAX_STORED_SKILLS = 10;
const MAX_SKILL_CHARS = 6000;
const skillsModal = document.getElementById('skillsModal');

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
  if (!skillsModal) return [];
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
  const badge = document.getElementById('skillsBadge');
  const enabledCount = state.skills.filter(s => s.enabled).length;
  if (badge) { badge.textContent = enabledCount; badge.hidden = enabledCount === 0; }
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

if (skillsModal) {
  document.getElementById('skillsBtn')?.addEventListener('click', () => { renderSkills(); skillsModal.classList.add('active'); });
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
selectModel(state.model, false); // otomatis fetchCredits() hanya kalau modelnya berbayar
renderHistory();
console.log('DeepChat Ready!');