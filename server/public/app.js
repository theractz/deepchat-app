const state = {
  credits: { deepseek: 0, gpt: 0, glm: 0 },
  currentModelType: 'deepseek',
  model: 'deepseek/deepseek-v4.1-flash',
  isTyping: false,
  messages: [],
  currentChatId: null,
  persona: localStorage.getItem('deepchat_persona') || "",
};

let uploadedFileContext = ""; 

// ==========================================
// 1. MANAJEMEN LIMIT & MODEL
// ==========================================
async function fetchCredits() {
  try {
    const res = await fetch('/api/credits');
    const data = await res.json();
    state.credits = data;
    updateCreditUI();
  } catch (err) { console.error('Gagal ambil limit:', err); }
}

function updateCreditUI() {
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
    input.placeholder = 'Limit habis. Tukar kode.';
  } else {
    input.disabled = false; sendBtn.disabled = false;
    input.placeholder = 'Ketik pesan...';
  }
}

document.getElementById('modelSelect').addEventListener('change', (e) => {
  state.model = e.target.value;
  document.getElementById('headerModelName').textContent = e.target.options[e.target.selectedIndex].text;
  if (state.model.includes('deepseek')) state.currentModelType = 'deepseek';
  else if (state.model.includes('gpt')) state.currentModelType = 'gpt';
  else if (state.model.includes('glm')) state.currentModelType = 'glm';
  updateCreditUI();
});

// ==========================================
// 2. MODAL SETTINGS & PERSONA
// ==========================================
const settingsModal = document.getElementById('settingsModal');
const personaInput = document.getElementById('personaInput');

personaInput.value = state.persona;

document.getElementById('settingsBtn').addEventListener('click', () => {
  personaInput.value = state.persona;
  settingsModal.classList.add('active');
});

document.getElementById('closeSettingsBtn').addEventListener('click', () => {
  settingsModal.classList.remove('active');
});

document.getElementById('saveSettingsBtn').addEventListener('click', () => {
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
// 5. SYNTAX HIGHLIGHTING UPGRADE
// ==========================================
function highlightCode(code, lang) {
  let h = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  h = h.replace(/(['"`])(?:(?!\1).)*\1/g, '<span class="token-string">$&</span>');
  h = h.replace(/(\/\/.*|\/\*[\s\S]*?\*\/|#.*)/g, '<span class="token-comment">$1</span>');
  
  const jsKeywords = /\b(function|const|let|var|if|else|return|for|while|switch|case|break|continue|new|class|extends|import|export|from|default|try|catch|finally|throw|async|await|this|typeof|instanceof|in|of|console|log|document|window)\b/g;
  h = h.replace(jsKeywords, '<span class="token-keyword">$1</span>');

  h = h.replace(/\b(\d+)\b/g, '<span class="token-number">$1</span>');
  h = h.replace(/(\+|\-|\*|\/|===|==|=>|=|\+\+|--)/g, '<span class="token-operator">$1</span>');

  return h;
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
      txt = txt.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;color:#fca5a5;">$1</code>');
      return txt.replace(/\n/g, '<br>');
    }
  }).join('');
}

// ==========================================
// 6. CHAT LOGIC & HISTORY
// ==========================================
function addMessage(role, content, saveToHistory = true) {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'none';

  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;
  
  const archLogo = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><defs><linearGradient id="aiGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6366f1" /><stop offset="100%" stop-color="#8b5cf6" /></linearGradient></defs><path d="M12 2L2 22H8C8 18 10 15 12 15C14 15 16 18 16 22H22L12 2Z" fill="url(#aiGrad)"/><path d="M6.5 16L9 10L7 8L4 14L6.5 16Z" fill="var(--bg-base)"/></svg>`;
  const userLogo = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

  msgDiv.innerHTML = `
    <div class="msg-avatar" style="${role === 'ai' ? 'background: transparent; border: none;' : ''}">
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
  state.messages.push({ role, content });

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
  list.innerHTML = '';
  let allChats = JSON.parse(localStorage.getItem('deepchat_history') || '{}');
  const sortedChats = Object.values(allChats).sort((a, b) => b.id - a.id);

  sortedChats.forEach(chat => {
    const div = document.createElement('div');
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
  chat.messages.forEach(msg => addMessage(msg.role, msg.content, false));
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('active');
}

async function sendMessage() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text || state.isTyping || state.credits[state.currentModelType] <= 0) return;

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

    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        messages: cleanMessages, 
        model: state.model,
        persona: persona,
        fileContext: uploadedFileContext
      })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    addMessage('ai', data.reply);
    await fetchCredits(); 
    
    uploadedFileContext = ""; 
  } catch (err) {
    addMessage('ai', `Error: ${err.message}`);
  } finally {
    state.isTyping = false;
    document.getElementById('typingIndicator').classList.remove('active');
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
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 22H8C8 18 10 15 12 15C14 15 16 18 16 22H22L12 2Z" fill="url(#logoGradient)"/><path d="M6.5 16L9 10L7 8L4 14L6.5 16Z" fill="var(--bg-base)"/></svg>
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

// INIT
fetchCredits();
renderHistory();
console.log('DeepChat Ready!');