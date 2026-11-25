/* =========================================================
   三国模拟人生 — 前端逻辑（v2 · 死亡架构）
   改动要点：
   1. 每轮先判定（judge 请求）→ 引擎掷骰 → 再叙述（narrate 请求）
   2. 每个存档带一份 state：体力 / 伤势 / 生死 / 回合 / 年龄
   3. 死亡即终局：锁档、结局面板、传承接续
   4. 历史消息按窗口裁剪，不再无限增长
   ========================================================= */

/* ========================= 常量 ========================= */

const SLOTS_KEY = "sanguo_slots";
const OLD_KEY = "sanguo_save";
const SLOT_IDS = ["1", "2", "3"];
const HISTORY_WINDOW = 24;   // 送进模型的历史消息条数上限
const JUDGE_MODEL = "deepseek-flash";

let slotsData = null;
let currentModel = "deepseek-flash";
let userApiKey = "";
let isGenerating = false;
let chatWindow = null;
let userInput = null;
let pendingConfirm = null;
let pendingRename = null;

/* ========================= 存档 ========================= */

function loadSlots() {
  const raw = localStorage.getItem(SLOTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.slots && typeof parsed.slots === "object") {
        slotsData = parsed;
        migrateSlots();
        return;
      }
    } catch (error) { /* 走重建 */ }
  }

  let migrated = null;
  const oldRaw = localStorage.getItem(OLD_KEY);
  if (oldRaw) {
    try {
      const p = JSON.parse(oldRaw);
      if (Array.isArray(p)) migrated = p;
      else if (p && Array.isArray(p.messages)) migrated = p.messages;
    } catch (error) { /* 忽略 */ }
  }

  const now = new Date().toISOString();
  slotsData = {
    version: 3,
    activeSlot: "1",
    slots: {
      "1": migrated
        ? {
            name: "迁移存档",
            createdAt: now,
            updatedAt: now,
            messages: migrated.filter(function (m) { return m && m.role !== "system"; }),
            state: SGEngine.createState({}),
            generation: 1
          }
        : null,
      "2": null,
      "3": null
    }
  };
  if (migrated) localStorage.removeItem(OLD_KEY);
  saveSlots();
}

/* 老存档补 state、去 system 消息 */
function migrateSlots() {
  let changed = false;
  SLOT_IDS.forEach(function (id) {
    const slot = slotsData.slots[id];
    if (!slot) return;
    if (!Array.isArray(slot.messages)) { slot.messages = []; changed = true; }
    const filtered = slot.messages.filter(function (m) { return m && m.role !== "system"; });
    if (filtered.length !== slot.messages.length) { slot.messages = filtered; changed = true; }
    if (!slot.state) { slot.state = SGEngine.createState({}); changed = true; }
    if (!slot.generation) { slot.generation = 1; changed = true; }
  });
  if (changed) saveSlots();
}

function saveSlots() {
  localStorage.setItem(SLOTS_KEY, JSON.stringify(slotsData));
}

function getSlot(id) {
  return slotsData.slots[id || slotsData.activeSlot] || null;
}

function isSlotEmpty(slot) {
  if (!slot) return true;
  if (Array.isArray(slot.messages) && slot.messages.length > 0) return false;
  return !slot.state || slot.state.turn === 0;
}

function hasAnyGame() {
  return SLOT_IDS.some(function (id) { return !isSlotEmpty(slotsData.slots[id]); });
}

function autoSave() {
  const slot = getSlot();
  if (!slot) return;
  slot.updatedAt = new Date().toISOString();
  saveSlots();
}

/* ========================= 存档操作 ========================= */

function switchSlot(id) {
  if (isGenerating) return;
  if (slotsData.activeSlot === id) { hideSettingsPanel(); return; }
  autoSave();
  slotsData.activeSlot = id;
  saveSlots();
  renderAll();
  clearInput();
  hideSettingsPanel();
}

async function newGame() {
  if (isGenerating) return;
  const emptyId = SLOT_IDS.find(function (id) { return isSlotEmpty(slotsData.slots[id]); });
  if (emptyId) { await newGameIn(emptyId); return; }

  const first = slotsData.slots["1"];
  const name1 = first ? (first.name || "未命名存档") : "未命名存档";
  confirmModal(
    "存档位已满",
    "三个存档位都已使用。新开一局将删除第一个存档「" + name1 + "」，此操作不可恢复。确定继续吗？",
    "删除并新开",
    async function () {
      slotsData.slots["1"] = null;
      saveSlots();
      await newGameIn("1");
    }
  );
}

async function newGameIn(id) {
  if (isGenerating) return;
  if (!isSlotEmpty(slotsData.slots[id])) return;

  autoSave();
  const difficulty = getDefaultDifficulty();
  slotsData.slots[id] = {
    name: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    state: SGEngine.createState({ difficulty: difficulty }),
    generation: 1
  };
  slotsData.activeSlot = id;
  saveSlots();
  renderAll();
  clearInput();
  hideSettingsPanel();

  await requestOpening(OPENING_PROMPT);
}

function deleteSlot(id) {
  if (isGenerating) return;
  const slot = slotsData.slots[id];
  const name = slot ? (slot.name || "未命名存档") : "未命名存档";
  confirmModal("删除存档", "确定要删除「" + name + "」吗？此操作不可恢复。", "删除", function () {
    slotsData.slots[id] = null;
    if (slotsData.activeSlot === id) {
      slotsData.activeSlot = SLOT_IDS.find(function (i) { return !isSlotEmpty(slotsData.slots[i]); }) || "1";
    }
    saveSlots();
    renderAll();
  });
}

function renameSlot(id) {
  if (isGenerating) return;
  const slot = slotsData.slots[id];
  if (!slot) return;
  showRenameModal(slot.name || "", function (name) {
    slot.name = name.trim().slice(0, 20);
    saveSlots();
    renderSlotList();
  });
}

function exportSlot() {
  const slot = getSlot();
  if (isSlotEmpty(slot)) { alert("当前没有存档"); return; }
  const exportData = {
    version: 3,
    exportedAt: new Date().toISOString(),
    name: slot.name || "未命名存档",
    model: currentModel,
    generation: slot.generation || 1,
    state: slot.state,
    messages: slot.messages
  };
  const text = JSON.stringify(exportData, null, 2);
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    navigator.clipboard.writeText(text)
      .then(function () { alert("存档已复制到剪贴板"); })
      .catch(function () { window.prompt("请手动复制以下存档内容：", text); });
  } else {
    window.prompt("请手动复制以下存档内容：", text);
  }
}

function importSlot() {
  const area = document.getElementById("importArea");
  const text = area.value.trim();
  if (!text) { alert("请先粘贴存档 JSON"); return; }
  const emptyId = SLOT_IDS.find(function (id) { return isSlotEmpty(slotsData.slots[id]); });
  if (!emptyId) { alert("存档位已满，请先删除一个存档"); return; }

  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { alert("JSON 格式错误，请检查后重试"); return; }
  if (!parsed || !Array.isArray(parsed.messages)) { alert("存档格式无效，缺少 messages 字段"); return; }
  if (!parsed.messages.every(function (m) { return m && m.role && typeof m.content === "string"; })) {
    alert("消息格式有误，导入失败"); return;
  }

  const now = new Date().toISOString();
  slotsData.slots[emptyId] = {
    name: parsed.name || "导入存档",
    createdAt: parsed.exportedAt || now,
    updatedAt: now,
    messages: parsed.messages.filter(function (m) { return m.role !== "system"; }),
    state: parsed.state || SGEngine.createState({}),
    generation: parsed.generation || 1
  };
  saveSlots();
  renderAll();
  area.value = "";
  alert("已导入到存档位 " + emptyId);
}

/* ========================= 存档列表 ========================= */

function renderSlotList() {
  const container = document.getElementById("slotList");
  if (!container) return;
  container.innerHTML = "";

  SLOT_IDS.forEach(function (id) {
    const slot = slotsData.slots[id];
    const isActive = slotsData.activeSlot === id;
    const isEmpty = isSlotEmpty(slot);

    const card = document.createElement("div");
    card.className = "slot-card" + (isActive ? " active" : "") + (isEmpty ? " empty" : "");

    if (isEmpty) {
      const label = document.createElement("div");
      label.className = "slot-id-label";
      label.textContent = "存档位 " + id;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slot-empty-action";
      btn.textContent = "＋ 新开一局";
      btn.dataset.action = "new";
      btn.dataset.id = id;

      card.appendChild(label);
      card.appendChild(btn);
    } else {
      const st = slot.state || SGEngine.createState({});
      const name = slot.name || st.name || "未命名存档";
      const dead = SGEngine.isDead(st);
      const timeStr = relTime(slot.updatedAt);

      card.innerHTML =
        '<div class="slot-id-label">存档位 ' + id + '</div>' +
        '<div class="slot-title"><span class="slot-name"></span>' +
        (isActive ? '<span class="slot-badge">当前</span>' : '') +
        (dead ? '<span class="slot-badge dead">已终</span>' : '') +
        '</div>' +
        '<div class="slot-meta"></div>' +
        '<div class="slot-summary"></div>' +
        '<div class="slot-actions"></div>';

      card.querySelector(".slot-name").textContent = name;
      card.querySelector(".slot-meta").textContent =
        (st.turn || 0) + " 回合 · " + (dead ? "第" + (slot.generation || 1) + "代" : SGEngine.injuryLabel(st.injury)) + " · " + timeStr;

      const lastAst = slot.messages.filter(function (m) { return m.role === "assistant"; }).pop();
      card.querySelector(".slot-summary").textContent = lastAst
        ? (lastAst.content.replace(/\n/g, " ").slice(0, 20) + (lastAst.content.length > 20 ? "…" : ""))
        : "—";

      const actions = card.querySelector(".slot-actions");
      if (!isActive) {
        const sw = document.createElement("button");
        sw.type = "button"; sw.textContent = "切换";
        sw.dataset.action = "switch"; sw.dataset.id = id;
        actions.appendChild(sw);
      }
      const rn = document.createElement("button");
      rn.type = "button"; rn.textContent = "改名";
      rn.dataset.action = "rename"; rn.dataset.id = id;
      actions.appendChild(rn);
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "删除"; del.className = "danger";
      del.dataset.action = "delete"; del.dataset.id = id;
      actions.appendChild(del);
    }

    container.appendChild(card);
  });
}

function relTime(iso) {
  if (!iso) return "";
  try {
    const diff = (Date.now() - new Date(iso)) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + " 天前";
    return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  } catch (e) { return ""; }
}

/* ========================= 弹窗 ========================= */

function confirmModal(title, body, confirmText, onConfirm) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmBody").textContent = body;
  document.getElementById("confirmOkBtn").textContent = confirmText;
  document.getElementById("confirmModal").classList.remove("hidden");
  pendingConfirm = onConfirm;
}

function hideConfirmModal() {
  document.getElementById("confirmModal").classList.add("hidden");
  pendingConfirm = null;
}

function showRenameModal(value, onConfirm) {
  document.getElementById("renameInput").value = value || "";
  document.getElementById("renameModal").classList.remove("hidden");
  pendingRename = onConfirm;
  document.getElementById("renameInput").focus();
}

function hideRenameModal() {
  document.getElementById("renameModal").classList.add("hidden");
  pendingRename = null;
}

/* ========================= 主题 ========================= */

function loadTheme() {
  const theme = localStorage.getItem("sanguo_theme");
  if (theme === "day" || theme === "scroll") document.body.classList.add("theme-day");
  updateThemeButton();
}

function updateThemeButton() {
  const button = document.getElementById("themeBtn");
  if (!button) return;
  const isDay = document.body.classList.contains("theme-day");
  button.textContent = isDay ? "暗色模式" : "日间模式";
}

function toggleTheme() {
  const isDay = document.body.classList.toggle("theme-day");
  localStorage.setItem("sanguo_theme", isDay ? "day" : "dark");
  updateThemeButton();
}

/* ========================= 模型与难度 ========================= */

function loadModel() {
  const saved = localStorage.getItem("sanguo_model");
  if (saved === "deepseek-flash" || saved === "deepseek-v4-pro") currentModel = saved;
  const select = document.getElementById("modelSelect");
  if (select) select.value = currentModel;
}

function changeModel() {
  const select = document.getElementById("modelSelect");
  if (!select) return;
  currentModel = select.value;
  localStorage.setItem("sanguo_model", currentModel);
}

function getDefaultDifficulty() {
  const saved = localStorage.getItem("sanguo_difficulty");
  return SGEngine.DIFFICULTIES[saved] ? saved : SGEngine.DEFAULT_DIFFICULTY;
}

function loadDifficulty() {
  const select = document.getElementById("difficultySelect");
  if (!select) return;
  select.value = getDefaultDifficulty();
}

function changeDifficulty() {
  const select = document.getElementById("difficultySelect");
  if (!select) return;
  const id = select.value;
  if (!SGEngine.DIFFICULTIES[id]) return;
  localStorage.setItem("sanguo_difficulty", id);
  const slot = getSlot();
  if (slot && slot.state && !SGEngine.isDead(slot.state)) {
    slot.state.difficulty = id;
    saveSlots();
    renderStatusBar();
  }
}

/* ========================= 消息渲染 ========================= */

function metaBadge(meta) {
  const badge = document.createElement("div");
  badge.className = "msg-meta" + (meta.tier === "dead" ? " lethal" : "");
  badge.textContent = meta.text || "";
  return badge;
}

function createMessageElement(message) {
  const div = document.createElement("div");
  div.className = "msg " + message.role;
  if (message.role === "user") {
    div.textContent = "你: " + message.content;
  } else {
    div.textContent = message.content;
  }
  if (message.meta) div.appendChild(metaBadge(message.meta));
  return div;
}

function appendMessage(message) {
  const div = createMessageElement(message);
  chatWindow.appendChild(div);
  return div;
}

function renderMessages() {
  chatWindow.innerHTML = "";

  const slot = getSlot();
  if (isSlotEmpty(slot)) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "尚无进行中的游戏\n点击「新开一局」开始冒险";
    chatWindow.appendChild(empty);
    return;
  }

  slot.messages.forEach(function (message) {
    if (!message || message.role === "system") return;
    appendMessage(message);
  });

  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function placeNewReplyForReading(assistantDiv) {
  requestAnimationFrame(function () {
    if (!assistantDiv) return;
    const top = assistantDiv.offsetTop;
    chatWindow.scrollTop = Math.max(0, top - 12);
  });
}

function clearInput() {
  userInput.value = "";
  resizeInput();
}

/* ========================= 状态条 ========================= */

function renderStatusBar() {
  const bar = document.getElementById("statusBar");
  if (!bar) return;
  const slot = getSlot();

  if (isSlotEmpty(slot)) {
    bar.classList.add("hidden");
    return;
  }

  const st = slot.state || SGEngine.createState({});
  bar.classList.remove("hidden");

  const dead = SGEngine.isDead(st);
  const hp = SGEngine.clamp(st.hp, 0, 100);
  const injuryText = dead ? "已死" : SGEngine.injuryLabel(st.injury);
  const diff = SGEngine.DIFFICULTIES[st.difficulty] || SGEngine.DIFFICULTIES[SGEngine.DEFAULT_DIFFICULTY];

  bar.innerHTML =
    '<span class="st-name"></span>' +
    '<span class="st-sep">·</span>' +
    '<span class="st-meta"></span>' +
    '<span class="st-hp"><i style="width:' + hp + '%"></i></span>' +
    '<span class="st-injury ' + (dead ? "dead" : "lv" + SGEngine.clamp(st.injury, 0, 3)) + '"></span>' +
    '<span class="st-diff"></span>';

  bar.querySelector(".st-name").textContent = st.name || "无名";
  bar.querySelector(".st-meta").textContent =
    (st.age ? st.age + "岁 · " : "") + "第" + (st.turn || 0) + "回合";
  bar.querySelector(".st-injury").textContent = injuryText;
  bar.querySelector(".st-diff").textContent = diff.label;
}

function renderAll() {
  renderMessages();
  renderSlotList();
  renderStatusBar();
  updateInputLock();
}

/* 死亡后锁输入 */
function updateInputLock() {
  const slot = getSlot();
  const st = slot && slot.state;
  const dead = st && SGEngine.isDead(st);
  const sendBtn = document.getElementById("sendBtn");
  if (!userInput || !sendBtn) return;

  if (dead) {
    userInput.disabled = true;
    sendBtn.disabled = true;
    userInput.placeholder = "此局已终。可「传承接续」，或新开一局。";
  } else {
    userInput.disabled = false;
    sendBtn.disabled = false;
    userInput.placeholder = "输入你的行动或对话，留空直接发送可让剧情自动推进";
  }
}

function setGeneratingState(generating) {
  isGenerating = generating;
  const ids = ["sendBtn", "themeBtn", "newGameBtn", "settingsBtn", "exportBtn", "importBtn",
    "modelSelect", "difficultySelect", "changeKeyBtn", "keySubmitBtn"];
  ids.forEach(function (id) {
    const element = document.getElementById(id);
    if (element) element.disabled = generating;
  });
  if (!generating) updateInputLock();
}

/* ========================= API ========================= */

async function callJsonChat(messages, options) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-API-Key": userApiKey },
    body: JSON.stringify({ messages: messages, model: JUDGE_MODEL, stream: false, options: options || {} })
  });
  const data = await response.json().catch(function () { return null; });
  if (!response.ok) {
    throw new Error((data && data.error) || ("HTTP " + response.status));
  }
  const choice = data && data.choices && data.choices[0];
  return (choice && choice.message && choice.message.content) || "";
}

async function streamChat(messages, assistantDiv) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-API-Key": userApiKey },
    body: JSON.stringify({ messages: messages, model: currentModel })
  });

  if (!response.ok || !response.body) {
    let info = "";
    try { info = JSON.stringify(await response.json()); } catch (error) { /* ignore */ }
    throw new Error(info || ("HTTP " + response.status));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
        const piece = delta && delta.content;
        if (typeof piece === "string" && piece.length > 0) {
          fullText += piece;
          assistantDiv.textContent = fullText;
        }
      } catch (error) { /* 跳过坏片段 */ }
    }
  }
  return fullText;
}

/* ========================= 判定 ========================= */

function recentBrief(slot, count) {
  const msgs = slot.messages.filter(function (m) { return m.role === "assistant" || m.role === "user"; });
  const tail = msgs.slice(-count * 2);
  return tail.map(function (m) {
    const who = m.role === "user" ? "玩家" : "GM";
    return who + "：" + String(m.content).replace(/\s+/g, " ").slice(0, 220);
  }).join("\n");
}

function parseJudge(raw) {
  const fallback = { risk: 1, kind: "other", reason: "判定解析失败，按有风险处理", lethal_hint: "" };
  if (!raw) return fallback;
  const text = String(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const risk = SGEngine.clamp(Math.round(Number(obj.risk)), 0, 3);
    return {
      risk: isNaN(risk) ? 1 : risk,
      kind: obj.kind || "other",
      reason: obj.reason || "",
      lethal_hint: obj.lethal_hint || ""
    };
  } catch (e) {
    return fallback;
  }
}

async function judgeAction(slot, actionText) {
  const st = slot.state;
  const messages = [
    { role: "system", content: JUDGE_PROMPT },
    {
      role: "user",
      content:
        "【角色状态】" + SGEngine.stateSummary(st) + "\n" +
        "【最近经历】\n" + recentBrief(slot, 2) + "\n" +
        "【玩家行动】" + actionText
    }
  ];
  const raw = await callJsonChat(messages, { max_tokens: 200, temperature: 0, thinking: false });
  return parseJudge(raw);
}

/* 墓志铭：叙述者没写就补一次小请求 */
async function ensureEpitaph(narration, state, judge) {
  const found = SGEngine.extractEpitaph(narration);
  if (found) return found;

  try {
    const raw = await callJsonChat([
      {
        role: "system",
        content: "你只输出一句中文墓志铭，不超过30个字。不要引号，不要解释，不要任何格式标记。"
      },
      {
        role: "user",
        content:
          "死者：" + (state.name || "无名者") +
          "；终年：" + (state.age || "不详") +
          "；死因：" + (judge.lethal_hint || judge.reason || "不详") +
          "\n生平片段：\n" + String(narration || "").slice(-600)
      }
    ], { max_tokens: 80, temperature: 0.7, thinking: false });

    const line = String(raw || "").trim().split("\n")[0].replace(/^["“」]|["”「]$/g, "").trim();
    if (line) return line.slice(0, 60);
  } catch (error) { /* 走下面的兜底 */ }

  return (state.name || "无名者") + "，卒于第" + (state.turn || 0) + "回合。";
}

function buildNarrationSystem(state, outcome, judge) {
  const directive = OUTCOME_DIRECTIVES[outcome.tier] || OUTCOME_DIRECTIVES.cost;
  const riskText = RISK_LABELS[outcome.risk] || "有风险";
  const lines = [
    SYSTEM_PROMPT,
    "",
    "【本轮结算】（系统裁定，不得更改）",
    "玩家行动：" + (judge.reason ? judge.reason : "见对话"),
    "风险等级：" + riskText,
    "结算结果：" + directive,
    "",
    "【结算后的角色状态】",
    SGEngine.stateSummary(state)
  ];
  const oldWounds = (state.wounds || []).slice(0, -1);
  if (oldWounds.length) {
    lines.push("此前旧伤（叙述时要体现尚未痊愈）：" + oldWounds.slice(-2).join("；"));
  }
  if (judge.lethal_hint) {
    lines.push("致死机制（若结果为死亡，按此写）：" + judge.lethal_hint);
  }
  return lines.join("\n");
}

/* ========================= 一轮 ========================= */

async function requestOpening(promptText) {
  if (isGenerating) return null;
  setGeneratingState(true);

  const slot = getSlot();
  const assistantDiv = document.createElement("div");
  assistantDiv.className = "msg assistant";
  const thinking = document.createElement("span");
  thinking.className = "thinking";
  thinking.textContent = "……正在铺开这一世……";
  assistantDiv.appendChild(thinking);

  const emptyState = chatWindow.querySelector(".empty-state");
  if (emptyState) chatWindow.innerHTML = "";

  chatWindow.appendChild(assistantDiv);
  placeNewReplyForReading(assistantDiv);

  try {
    const st = slot.state;
    const msgs = [
      { role: "system", content: SYSTEM_PROMPT + "\n\n" + promptText + "\n\n【角色状态】" + SGEngine.stateSummary(st) },
      { role: "user", content: "(开始)" }
    ];
    const text = await streamChat(msgs, assistantDiv);
    if (!text) {
      assistantDiv.textContent = "（没有拿到回复，请检查 API Key 或稍后重试。）";
      return null;
    }

    const meta = SGEngine.extractIdentity(text);
    if (meta.name && !st.name) st.name = meta.name;
    if (meta.age && !st.age) st.age = meta.age;

    slot.messages.push({ role: "assistant", content: text });
    autoSave();
    renderAll();
    return text;
  } catch (error) {
    assistantDiv.textContent = "出错了：" + (error && error.message ? error.message : "未知错误");
    return null;
  } finally {
    setGeneratingState(false);
  }
}

async function runTurn(actionText) {
  const slot = getSlot();
  const st = slot.state;

  if (SGEngine.isDead(st)) {
    alert("此局已终。请选择「传承接续」或新开一局。");
    return;
  }

  slot.messages.push({ role: "user", content: actionText });
  appendMessage({ role: "user", content: actionText });
  autoSave();

  setGeneratingState(true);
  const assistantDiv = document.createElement("div");
  assistantDiv.className = "msg assistant";
  const thinking = document.createElement("span");
  thinking.className = "thinking";
  thinking.textContent = "……";
  assistantDiv.appendChild(thinking);
  chatWindow.appendChild(assistantDiv);
  placeNewReplyForReading(assistantDiv);

  try {
    /* 1. 判定 */
    let judge;
    try {
      judge = await judgeAction(slot, actionText);
    } catch (error) {
      judge = { risk: 1, kind: "other", reason: "判定失败，按有风险处理", lethal_hint: "" };
    }

    /* 2. 掷骰（在本地，模型不参与） */
    const outcome = SGEngine.resolve({ risk: judge.risk, state: st, difficulty: st.difficulty });
    const nextState = SGEngine.applyOutcome(st, outcome, st.difficulty);

    /* 3. 叙述（把结算后的状态一起给模型，避免"满血却写重伤"的自相矛盾） */
    const system = buildNarrationSystem(nextState, outcome, judge);
    const history = slot.messages
      .filter(function (m) { return m.role === "user" || m.role === "assistant"; })
      .slice(0, -1)              // 去掉刚推进的这句，下面单独用
      .slice(-HISTORY_WINDOW);
    const msgs = [{ role: "system", content: system }]
      .concat(history)
      .concat([{ role: "user", content: actionText }]);

    const text = await streamChat(msgs, assistantDiv);
    const finalText = text || "（没有拿到回复，请稍后重试。）";

    /* 4. 落状态 */
    slot.state = nextState;
    if (!nextState.alive) {
      nextState.causeOfDeath = judge.lethal_hint || judge.reason || "力尽而亡";
      nextState.epitaph = await ensureEpitaph(finalText, nextState, judge);
    }

    const tierLabel = {
      success: "成功", cost: "受挫", light: "轻伤", serious: "重伤", dying: "濒死", dead: "死亡"
    }[outcome.tier] || outcome.tier;

    const meta = {
      tier: outcome.tier,
      text: "〔判定：" + (RISK_LABELS[outcome.risk] || "有风险") + " · " + tierLabel + "〕" +
        (nextState.alive ? "　体力 " + nextState.hp + "／100 · " + SGEngine.injuryLabel(nextState.injury) : "")
    };

    slot.messages.push({ role: "assistant", content: finalText, meta: meta });
    assistantDiv.appendChild(metaBadge(meta));
    autoSave();
    renderAll();

    if (!nextState.alive) showEnding();
    return finalText;
  } catch (error) {
    assistantDiv.textContent = "出错了：" + (error && error.message ? error.message : "未知错误");
    return null;
  } finally {
    setGeneratingState(false);
  }
}

async function sendMessage(text) {
  if (isGenerating) return;
  const slot = getSlot();
  if (isSlotEmpty(slot)) { alert("请先「新开一局」再开始"); return; }
  if (!userApiKey) { showKeyModal(false); return; }

  const content = text.trim().length > 0 ? text.trim() : "(继续推进剧情)";
  await runTurn(content);
}

/* ========================= 终局与传承 ========================= */

function showEnding() {
  const slot = getSlot();
  const st = slot.state;
  const modal = document.getElementById("endingModal");
  if (!modal) return;

  document.getElementById("endingName").textContent = st.name ? st.name + " 的一生" : "这一生";
  document.getElementById("endingCause").textContent = st.causeOfDeath || "力尽而亡";
  document.getElementById("endingYears").textContent =
    (st.age ? "享年 " + st.age + " 岁 · " : "") + "共 " + (st.turn || 0) + " 回合";
  document.getElementById("endingEpitaph").textContent = st.epitaph || "（无人为他立碑）";

  modal.classList.remove("hidden");
}

function hideEnding() {
  const modal = document.getElementById("endingModal");
  if (modal) modal.classList.add("hidden");
}

async function startLegacy() {
  const slot = getSlot();
  const st = slot.state;
  if (!st || !SGEngine.isDead(st)) return;

  hideEnding();

  const legacy = {
    name: st.name,
    age: st.age,
    turn: st.turn,
    cause: st.causeOfDeath,
    epitaph: st.epitaph,
    difficulty: st.difficulty
  };

  slot.messages.push({
    role: "assistant",
    content: "〔" + (st.name || "他") + "已死。此后的事，交到别人手里。〕"
  });

  slot.generation = (slot.generation || 1) + 1;
  slot.state = SGEngine.createState({ difficulty: st.difficulty, legacy: legacy });
  slot.name = "";
  autoSave();
  renderAll();

  await requestOpening(
    LEGACY_PROMPT +
    "\n\n上一世的记录：姓名 " + (legacy.name || "无名") +
    "；终年 " + (legacy.age || "不详") +
    "；共 " + (legacy.turn || 0) + " 回合" +
    "；死因 " + (legacy.cause || "不详") +
    "；墓志铭 " + (legacy.epitaph || "无")
  );
}

/* ========================= 输入框 ========================= */

function resizeInput() {
  if (!userInput) return;
  userInput.style.height = "auto";
  const nextHeight = Math.min(userInput.scrollHeight, 130);
  userInput.style.height = nextHeight + "px";
}

function showSettingsPanel() {
  renderSlotList();
  document.getElementById("settingsModal").classList.remove("hidden");
}

function hideSettingsPanel() {
  document.getElementById("settingsModal").classList.add("hidden");
}

/* ========================= BYOK ========================= */

function loadApiKey() {
  const saved = localStorage.getItem("userApiKey");
  if (saved) userApiKey = saved;
  else showKeyModal(false);
}

function showKeyModal(isSettings) {
  const modal = document.getElementById("keyModal");
  const title = document.getElementById("keyModalTitle");
  const submitBtn = document.getElementById("keySubmitBtn");
  const clearBtn = document.getElementById("keyClearBtn");
  const closeBtn = document.getElementById("keyCloseBtn");
  const errorEl = document.getElementById("keyError");
  const input = document.getElementById("keyInput");

  if (title) title.textContent = isSettings ? "更换 API Key" : "填写你的 DeepSeek API Key";
  if (submitBtn) submitBtn.textContent = isSettings ? "保存" : "开始游戏";
  if (clearBtn) clearBtn.style.display = isSettings ? "block" : "none";
  if (closeBtn) closeBtn.style.display = isSettings ? "flex" : "none";
  if (errorEl) errorEl.textContent = "";
  if (input) input.value = "";

  modal.dataset.settings = isSettings ? "1" : "0";
  modal.classList.remove("hidden");
}

function hideKeyModal() {
  document.getElementById("keyModal").classList.add("hidden");
}

function submitApiKey() {
  const input = document.getElementById("keyInput");
  const errorEl = document.getElementById("keyError");
  const modal = document.getElementById("keyModal");
  const key = input ? input.value.trim() : "";

  if (!key.startsWith("sk-")) {
    if (errorEl) errorEl.textContent = "Key 格式不正确，应以 sk- 开头";
    return;
  }

  const wasFirstTime = modal.dataset.settings !== "1";
  userApiKey = key;
  localStorage.setItem("userApiKey", key);
  hideKeyModal();

  if (wasFirstTime && !hasAnyGame()) newGame();
}

function clearApiKey() {
  userApiKey = "";
  localStorage.removeItem("userApiKey");
  showKeyModal(false);
}

/* ========================= 启动 ========================= */

window.addEventListener("load", function () {
  chatWindow = document.getElementById("chatWindow");
  userInput = document.getElementById("userInput");

  loadTheme();
  loadModel();
  loadDifficulty();
  loadSlots();
  renderAll();

  document.getElementById("themeBtn").addEventListener("click", toggleTheme);
  document.getElementById("newGameBtn").addEventListener("click", newGame);
  document.getElementById("settingsBtn").addEventListener("click", showSettingsPanel);

  document.getElementById("settingsCloseBtn").addEventListener("click", hideSettingsPanel);
  document.getElementById("modelSelect").addEventListener("change", changeModel);
  document.getElementById("difficultySelect").addEventListener("change", changeDifficulty);
  document.getElementById("exportBtn").addEventListener("click", exportSlot);
  document.getElementById("importBtn").addEventListener("click", importSlot);

  document.getElementById("slotList").addEventListener("click", function (e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === "switch") switchSlot(id);
    else if (action === "rename") renameSlot(id);
    else if (action === "delete") deleteSlot(id);
    else if (action === "new") newGameIn(id);
  });

  document.getElementById("confirmOkBtn").addEventListener("click", function () {
    const cb = pendingConfirm;
    hideConfirmModal();
    if (cb) cb();
  });
  document.getElementById("confirmCancelBtn").addEventListener("click", hideConfirmModal);
  document.getElementById("confirmCloseBtn").addEventListener("click", hideConfirmModal);

  document.getElementById("renameOkBtn").addEventListener("click", function () {
    const v = document.getElementById("renameInput").value.trim();
    if (!v) return;
    const cb = pendingRename;
    hideRenameModal();
    if (cb) cb(v);
  });
  document.getElementById("renameCancelBtn").addEventListener("click", hideRenameModal);
  document.getElementById("renameCloseBtn").addEventListener("click", hideRenameModal);
  document.getElementById("renameInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("renameOkBtn").click();
  });

  document.getElementById("sendBtn").addEventListener("click", async function () {
    if (isGenerating) return;
    const text = userInput.value;
    userInput.value = "";
    resizeInput();
    await sendMessage(text);
  });

  userInput.addEventListener("keydown", async function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (isGenerating) return;
      const text = userInput.value;
      userInput.value = "";
      resizeInput();
      await sendMessage(text);
    }
  });

  userInput.addEventListener("input", resizeInput);

  document.getElementById("endingLegacyBtn").addEventListener("click", startLegacy);
  document.getElementById("endingNewBtn").addEventListener("click", function () {
    const id = slotsData.activeSlot;
    hideEnding();
    confirmModal("新开一局", "当前这一局会被清除，确定吗？", "新开", function () {
      slotsData.slots[id] = null;
      saveSlots();
      newGame();
    });
  });
  document.getElementById("endingCloseBtn").addEventListener("click", hideEnding);

  document.getElementById("keySubmitBtn").addEventListener("click", submitApiKey);
  document.getElementById("keyCloseBtn").addEventListener("click", hideKeyModal);
  document.getElementById("keyInput").addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      submitApiKey();
    }
  });
  document.getElementById("keyClearBtn").addEventListener("click", clearApiKey);
  document.getElementById("changeKeyBtn").addEventListener("click", function () {
    hideSettingsPanel();
    showKeyModal(true);
  });

  loadApiKey();
});
