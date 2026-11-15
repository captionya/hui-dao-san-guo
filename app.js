'use strict';

// ═══════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════
const SLOTS_KEY   = 'sanguo_slots';
const OLD_KEY     = 'sanguo_save';
const API_KEY_KEY = 'userApiKey';
const MODEL_KEY   = 'sanguo_model';
const THEME_KEY   = 'sanguo_theme';
const SLOT_IDS    = ['1', '2', '3'];
const API_URL     = '/api/chat';

// ═══════════════════════════════════════════════════
// 全局状态
// ═══════════════════════════════════════════════════
let slotsData    = null;
let isGenerating = false;

// ═══════════════════════════════════════════════════
// 存档管理
// ═══════════════════════════════════════════════════

function loadSlots() {
  const raw = localStorage.getItem(SLOTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.slots && typeof parsed.slots === 'object') {
        slotsData = parsed;
        return;
      }
    } catch (_) {}
  }

  // 迁移旧存档
  let migrated = null;
  const oldRaw = localStorage.getItem(OLD_KEY);
  if (oldRaw) {
    try {
      const p = JSON.parse(oldRaw);
      migrated = Array.isArray(p) ? p
               : Array.isArray(p?.messages) ? p.messages
               : null;
    } catch (_) {}
  }

  const now = new Date().toISOString();
  slotsData = {
    version: 2,
    activeSlot: '1',
    slots: {
      '1': migrated ? { name: '迁移存档', createdAt: now, updatedAt: now, messages: migrated } : null,
      '2': null,
      '3': null
    }
  };
  if (migrated) localStorage.removeItem(OLD_KEY);
  saveSlots();
}

function saveSlots() {
  localStorage.setItem(SLOTS_KEY, JSON.stringify(slotsData));
}

function getSlot(id) {
  return slotsData.slots[id ?? slotsData.activeSlot] ?? null;
}

// 判定槽位是否「有效为空」：没有数据，或只有 system 消息（尚未真正开始）
function isSlotEmpty(slot) {
  if (!slot || !Array.isArray(slot.messages)) return true;
  return slot.messages.every(m => m.role === 'system');
}

function autoSave() {
  const slot = getSlot();
  if (!slot) return;
  slot.updatedAt = new Date().toISOString();
  saveSlots();
}

// ─── 切换 ───
function switchSlot(id) {
  if (isGenerating) return;
  if (slotsData.activeSlot === id) { closeSettings(); return; }
  autoSave();
  slotsData.activeSlot = id;
  saveSlots();
  renderMessages();
  renderSlotList();
  clearInput();
  closeSettings();
}

// ─── 新开一局 ───
async function newGame() {
  if (isGenerating) return;

  const emptyId = SLOT_IDS.find(id => isSlotEmpty(slotsData.slots[id]));
  if (emptyId) {
    // A. 有空槽，直接新开
    autoSave();
    _initSlot(emptyId);
    closeSettings();
    await triggerOpening();
  } else {
    // B. 槽满，确认删除存档位1
    const name1 = slotsData.slots['1']?.name || '未命名存档';
    confirmModal(
      '存档位已满',
      `三个存档位都已使用。新开一局将自动删除第一个存档「${name1}」，此操作不可恢复。确定继续吗？`,
      '删除并新开',
      async () => {
        autoSave();
        slotsData.slots['1'] = null;
        _initSlot('1');
        closeSettings();
        await triggerOpening();
      }
    );
  }
}

function _initSlot(id) {
  const now = new Date().toISOString();
  slotsData.slots[id] = {
    name: '', createdAt: now, updatedAt: now,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }]
  };
  slotsData.activeSlot = id;
  saveSlots();
  renderMessages();
  renderSlotList();
  clearInput();
}

// ─── 删除 ───
function deleteSlot(id) {
  if (isGenerating) return;
  const name = slotsData.slots[id]?.name || '未命名存档';
  confirmModal(
    '删除存档',
    `确定要删除「${name}」吗？此操作不可恢复。`,
    '删除',
    () => {
      slotsData.slots[id] = null;
      if (slotsData.activeSlot === id) {
        slotsData.activeSlot = SLOT_IDS.find(i => !isSlotEmpty(slotsData.slots[i])) || '1';
      }
      saveSlots();
      renderMessages();
      renderSlotList();
    }
  );
}

// ─── 改名 ───
function renameSlot(id) {
  if (isGenerating) return;
  inputModal(
    '改名存档',
    '输入新名称（最多 20 字）：',
    slotsData.slots[id]?.name || '',
    name => {
      slotsData.slots[id].name = name.trim().slice(0, 20);
      saveSlots();
      renderSlotList();
    }
  );
}

// ─── 导出 ───
function exportSlot() {
  const slot = getSlot();
  if (isSlotEmpty(slot)) { showToast('当前没有存档'); return; }

  const payload = JSON.stringify({
    version:    2,
    exportedAt: new Date().toISOString(),
    name:       slot.name || '未命名存档',
    model:      localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL,
    messages:   slot.messages
      .filter(m => !m._hidden)
      .map(({ role, content }) => ({ role, content }))
  }, null, 2);

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(payload)
      .then(()  => showToast('存档已复制到剪贴板'))
      .catch(() => _fallbackCopy(payload));
  } else {
    _fallbackCopy(payload);
  }
}

function _fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  Object.assign(ta.style, { position: 'fixed', opacity: '0' });
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); showToast('存档已复制到剪贴板'); }
  catch (_) { showToast('复制失败，请手动选取'); }
  ta.remove();
}

// ─── 导入 ───
function importSlot() {
  const text = document.getElementById('importArea').value.trim();
  if (!text) { showToast('请先粘贴存档 JSON'); return; }

  const emptyId = SLOT_IDS.find(id => isSlotEmpty(slotsData.slots[id]));
  if (!emptyId) { showToast('存档位已满，请先删除一个存档'); return; }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { showToast('JSON 格式错误，请检查后重试'); return; }

  if (!Array.isArray(parsed?.messages) || !parsed.messages.length) {
    showToast('存档格式无效，缺少 messages 字段'); return;
  }
  if (!parsed.messages.every(m => m.role && typeof m.content === 'string')) {
    showToast('消息格式有误，导入失败'); return;
  }

  // 若缺少 system 提示词，自动补上，避免 AI 失去游戏规则
  if (!parsed.messages.some(m => m.role === 'system')) {
    parsed.messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
  }

  const now = new Date().toISOString();
  slotsData.slots[emptyId] = {
    name:      parsed.name   || '导入存档',
    createdAt: parsed.exportedAt || now,
    updatedAt: now,
    messages:  parsed.messages
  };
  saveSlots();
  renderSlotList();
  document.getElementById('importArea').value = '';
  showToast(`已导入到存档位 ${emptyId}`);
}

// ═══════════════════════════════════════════════════
// 通用 Modal
// ═══════════════════════════════════════════════════

function confirmModal(title, body, confirmText, onConfirm) {
  _showModal('cfmOverlay', 'cfmModal');
  document.getElementById('cfmTitle').textContent = title;
  document.getElementById('cfmBody').textContent  = body;
  document.getElementById('cfmOk').textContent    = confirmText;

  const cancel  = document.getElementById('cfmCancel');
  const ok      = document.getElementById('cfmOk');
  const overlay = document.getElementById('cfmOverlay');

  const close = () => {
    _hideModal('cfmOverlay', 'cfmModal');
    cancel.removeEventListener('click', close);
    ok.removeEventListener('click', go);
    overlay.removeEventListener('click', close);
  };
  const go = () => { close(); onConfirm(); };

  cancel.addEventListener('click', close);
  ok.addEventListener('click', go);
  overlay.addEventListener('click', close);
}

function inputModal(title, promptText, currentValue, onConfirm) {
  _showModal('inpOverlay', 'inpModal');
  document.getElementById('inpTitle').textContent = title;
  document.getElementById('inpBody').textContent  = promptText;
  const field = document.getElementById('inpField');
  field.value = currentValue || '';
  setTimeout(() => { field.focus(); field.select(); }, 80);

  const cancel  = document.getElementById('inpCancel');
  const ok      = document.getElementById('inpOk');
  const overlay = document.getElementById('inpOverlay');

  const close = () => {
    _hideModal('inpOverlay', 'inpModal');
    cancel.removeEventListener('click', close);
    ok.removeEventListener('click', go);
    overlay.removeEventListener('click', close);
    field.removeEventListener('keydown', onKey);
  };
  const go = () => { const v = field.value.trim(); if (!v) return; close(); onConfirm(v); };
  const onKey = e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') close(); };

  cancel.addEventListener('click', close);
  ok.addEventListener('click', go);
  overlay.addEventListener('click', close);
  field.addEventListener('keydown', onKey);
}

function apiKeyModal(onSave) {
  _showModal('keyOverlay', 'keyModal');
  const field   = document.getElementById('keyField');
  field.value   = '';
  setTimeout(() => field.focus(), 80);

  const cancel  = document.getElementById('keyCancel');
  const ok      = document.getElementById('keyOk');
  const overlay = document.getElementById('keyOverlay');

  const close = () => {
    _hideModal('keyOverlay', 'keyModal');
    cancel.removeEventListener('click', close);
    ok.removeEventListener('click', save);
    overlay.removeEventListener('click', close);
    field.removeEventListener('keydown', onKey);
  };
  const save = () => {
    const v = field.value.trim();
    if (!v) return;
    localStorage.setItem(API_KEY_KEY, v);
    close();
    updateApiKeyStatus();
    if (onSave) onSave();
  };
  const onKey = e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); };

  cancel.addEventListener('click', close);
  ok.addEventListener('click', save);
  overlay.addEventListener('click', close);
  field.addEventListener('keydown', onKey);
}

function _showModal(ovId, modalId) {
  document.getElementById(ovId).classList.remove('hidden');
  document.getElementById(modalId).classList.remove('hidden');
}
function _hideModal(ovId, modalId) {
  document.getElementById(ovId).classList.add('hidden');
  document.getElementById(modalId).classList.add('hidden');
}

// ═══════════════════════════════════════════════════
// 渲染
// ═══════════════════════════════════════════════════

function renderMessages() {
  const container = document.getElementById('messages');
  container.innerHTML = '';

  const slot = getSlot();
  if (isSlotEmpty(slot)) {
    container.innerHTML = `
      <div class="empty-state">
        <p>尚无进行中的游戏</p>
        <p>点击「新开一局」开始冒险</p>
      </div>`;
    return;
  }

  slot.messages.forEach(msg => {
    if (msg.role === 'system') return;
    if (msg._hidden)           return;
    _appendMsgEl(msg.role, msg.content);
  });
  scrollBottom();
}

function _appendMsgEl(role, content) {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `message ${role}`;

  if (role === 'assistant') {
    const html = content
      .split(/\n{2,}/)
      .filter(p => p.trim())
      .map(p => `<p>${_esc(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
    div.innerHTML = html || `<p>${_esc(content)}</p>`;
  } else {
    div.innerHTML = `<p>${_esc(content)}</p>`;
  }

  container.appendChild(div);
  scrollBottom();
  return div;
}

function _esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scrollBottom() {
  const el = document.getElementById('chatArea');
  el.scrollTop = el.scrollHeight;
}

function clearInput() {
  const el = document.getElementById('userInput');
  if (el) { el.value = ''; el.style.height = 'auto'; }
}

function renderSlotList() {
  const container = document.getElementById('slotList');
  container.innerHTML = '';

  SLOT_IDS.forEach(id => {
    const slot     = slotsData.slots[id];
    const isActive = slotsData.activeSlot === id;
    const isEmpty  = isSlotEmpty(slot);
    const card     = document.createElement('div');
    card.className = `slot-card${isActive ? ' active' : ''}${isEmpty ? ' empty' : ''}`;

    if (isEmpty) {
      card.innerHTML = `
        <div class="slot-id-label">存档位 ${id}</div>
        <span class="slot-empty-label">空</span>`;
    } else {
      const name    = slot.name || '未命名存档';
      const turns   = slot.messages.filter(m => m.role === 'assistant').length;
      const timeStr = _relTime(slot.updatedAt);
      const lastAst = slot.messages.filter(m => m.role === 'assistant').at(-1);
      const preview = lastAst
        ? (lastAst.content.replace(/\n/g, ' ').slice(0, 20) + (lastAst.content.length > 20 ? '…' : ''))
        : '—';

      card.innerHTML = `
        <div class="slot-id-label">存档位 ${id}</div>
        <div class="slot-title">
          <span class="slot-name">${_esc(name)}</span>
          ${isActive ? '<span class="slot-badge">当前</span>' : ''}
        </div>
        <div class="slot-meta">${turns} 轮 · ${timeStr}</div>
        <div class="slot-summary">${_esc(preview)}</div>
        <div class="slot-actions">
          ${!isActive ? `<button class="btn-text" data-action="switch" data-id="${id}">切换</button>` : ''}
          <button class="btn-text" data-action="rename" data-id="${id}">改名</button>
          <button class="btn-text danger" data-action="delete" data-id="${id}">删除</button>
        </div>`;
    }
    container.appendChild(card);
  });
}

function _relTime(iso) {
  if (!iso) return '';
  try {
    const diff = (Date.now() - new Date(iso)) / 1000;
    if (diff < 60)       return '刚刚';
    if (diff < 3600)     return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400)    return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  } catch (_) { return ''; }
}

function updateApiKeyStatus() {
  const key = localStorage.getItem(API_KEY_KEY);
  const el  = document.getElementById('apiKeyStatus');
  if (!el) return;
  if (key) {
    el.textContent = `已保存（…${key.slice(-4)}）`;
    el.style.color = '';
  } else {
    el.textContent = '未设置';
    el.style.color = 'var(--danger)';
  }
}

function showToast(msg) {
  document.getElementById('toast')?.remove();
  const t = document.createElement('div');
  t.id = 'toast'; t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
}

// ═══════════════════════════════════════════════════
// 设置面板
// ═══════════════════════════════════════════════════

function openSettings() {
  renderSlotList();
  updateApiKeyStatus();
  const panel = document.getElementById('settingsPanel');
  panel.classList.remove('hidden');
  document.getElementById('settingsOverlay').classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('open')));
}

function closeSettings() {
  const panel = document.getElementById('settingsPanel');
  panel.classList.remove('open');
  document.getElementById('settingsOverlay').classList.add('hidden');
  setTimeout(() => panel.classList.add('hidden'), 320);
}

// ═══════════════════════════════════════════════════
// 主题
// ═══════════════════════════════════════════════════

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeBtn').textContent =
    theme === 'dark' ? '日间模式' : '暗色模式';
}

function toggleTheme() {
  const cur  = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

// ═══════════════════════════════════════════════════
// API & 对话
// ═══════════════════════════════════════════════════

function setGenerating(flag) {
  isGenerating = flag;
  ['themeBtn', 'newGameBtn', 'settingsBtn', 'sendBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = flag;
  });
  const inp = document.getElementById('userInput');
  if (inp) inp.disabled = flag;
}

async function sendMessage() {
  if (isGenerating) return;
  const inp  = document.getElementById('userInput');
  const text = inp.value.trim();
  const content = text.length > 0 ? text : '(继续推进剧情)';

  if (isSlotEmpty(getSlot())) { showToast('请先新开一局'); return; }

  const key = localStorage.getItem(API_KEY_KEY);
  if (!key) { apiKeyModal(() => sendMessage()); return; }

  const slot = getSlot();
  slot.messages.push({ role: 'user', content });
  autoSave();
  _appendMsgEl('user', content);
  inp.value = '';
  inp.style.height = 'auto';

  await _callAI();
}

async function triggerOpening() {
  if (!SYSTEM_PROMPT?.trim()) {
    showToast('请先在 config.js 中设置 SYSTEM_PROMPT');
    return;
  }
  const key = localStorage.getItem(API_KEY_KEY);
  if (!key) { apiKeyModal(triggerOpening); return; }

  const slot = getSlot();
  if (!slot) return;

  // 插入隐藏开场触发消息（不渲染到 UI）
  const hidden = { role: 'user', content: OPENING_PROMPT, _hidden: true };
  slot.messages.push(hidden);
  autoSave();

  await _callAI();

  // 开场生成后移除这条隐藏消息，避免后续每轮都带上
  const i = slot.messages.indexOf(hidden);
  if (i >= 0) slot.messages.splice(i, 1);
  saveSlots();
}

async function _callAI() {
  setGenerating(true);

  const key   = localStorage.getItem(API_KEY_KEY);
  const model = localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
  const slot  = getSlot();

  // 发给 API 的消息去除 _hidden 等额外属性
  const apiMsgs = slot.messages.map(({ role, content }) => ({ role, content }));

  const typingEl = _showTyping();

  try {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-User-API-Key': key
      },
      body: JSON.stringify({ model, messages: apiMsgs })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status}: ${errText}`);
    }

    const ct    = res.headers.get('content-type') || '';
    let   reply = '';

    if (ct.includes('text/event-stream')) {
      // ── 流式 SSE ──
      typingEl.remove();
      const msgEl  = _createStreamEl();
      const reader = res.body.getReader();
      const dec    = new TextDecoder();
      let   buf    = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6).trim();
          if (d === '[DONE]') continue;
          try {
            const delta = JSON.parse(d).choices?.[0]?.delta?.content ?? '';
            if (delta) { reply += delta; _updateStreamEl(msgEl, reply); }
          } catch (_) {}
        }
      }
    } else {
      // ── 非流式 JSON ──
      typingEl.remove();
      const data = await res.json();
      reply = data.choices?.[0]?.message?.content ?? data.content ?? '';
      _appendMsgEl('assistant', reply);
    }

    if (reply) {
      slot.messages.push({ role: 'assistant', content: reply });
      autoSave();
      renderSlotList(); // 刷新摘要/轮数
    }

  } catch (err) {
    typingEl.remove();
    _appendMsgEl('system-error', `请求失败：${err.message}`);
  } finally {
    setGenerating(false);
  }
}

function _showTyping() {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message assistant typing';
  div.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  container.appendChild(div);
  scrollBottom();
  return div;
}

function _createStreamEl() {
  const container = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = '<p>…</p>';
  container.appendChild(div);
  scrollBottom();
  return div;
}

function _updateStreamEl(el, content) {
  const html = content
    .split(/\n{2,}/)
    .filter(p => p.trim())
    .map(p => `<p>${_esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  el.innerHTML = html || `<p>${_esc(content)}</p>`;
  scrollBottom();
}

// ═══════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════

function init() {
  loadSlots();

  // 若 activeSlot 指向空槽，修正到第一个有内容的槽
  if (isSlotEmpty(getSlot())) {
    const first = SLOT_IDS.find(id => !isSlotEmpty(slotsData.slots[id]));
    if (first) { slotsData.activeSlot = first; saveSlots(); }
  }

  // 主题 & 模型
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
  document.getElementById('modelSelect').value =
    localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;

  renderMessages();

  // ── 工具栏 ──
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);
  document.getElementById('newGameBtn').addEventListener('click', newGame);
  document.getElementById('settingsBtn').addEventListener('click', openSettings);

  // ── 设置面板 ──
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsOverlay').addEventListener('click', closeSettings);

  // 存档卡片事件委托（只绑一次）
  document.getElementById('slotList').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === 'switch') switchSlot(id);
    if (action === 'rename') renameSlot(id);
    if (action === 'delete') deleteSlot(id);
  });

  // ── 模型 ──
  document.getElementById('modelSelect').addEventListener('change', e => {
    localStorage.setItem(MODEL_KEY, e.target.value);
  });

  // ── 导出/导入 ──
  document.getElementById('exportBtn').addEventListener('click', exportSlot);
  document.getElementById('importBtn').addEventListener('click', importSlot);

  // ── API Key ──
  document.getElementById('changeKeyBtn').addEventListener('click', () => {
    closeSettings();
    apiKeyModal(() => openSettings());
  });
  document.getElementById('clearKeyBtn').addEventListener('click', () => {
    confirmModal(
      '清除 API Key',
      '确定要清除已保存的 DeepSeek API Key 吗？清除后需重新填写才能继续游戏。',
      '清除',
      () => {
        localStorage.removeItem(API_KEY_KEY);
        updateApiKeyStatus();
        showToast('API Key 已清除');
      }
    );
  });

  // ── 发送 ──
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  const inp = document.getElementById('userInput');
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inp.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });
}

document.addEventListener('DOMContentLoaded', init);