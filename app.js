/* =========================================================
   三国模拟人生 — 前端逻辑（三存档位版）
   基于原版 V1.4.0 改造，保留原 UI / 滚动 / 锁定逻辑
   ========================================================= */


/* =========================================================
   常量与全局状态
   ========================================================= */

const SLOTS_KEY = "sanguo_slots";
const OLD_KEY = "sanguo_save";
const SLOT_IDS = ["1", "2", "3"];

let slotsData = null;        // 三存档位数据
let currentModel = "deepseek-flash";
let userApiKey = "";
let isGenerating = false;
let chatWindow = null;
let userInput = null;

let pendingConfirm = null;   // 确认弹窗的回调
let pendingRename = null;    // 改名弹窗的回调


/* =========================================================
   存档管理
   ========================================================= */

function loadSlots() {
  const raw = localStorage.getItem(SLOTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.slots && typeof parsed.slots === "object") {
        slotsData = parsed;
        return;
      }
    } catch (error) {
      // 忽略，走迁移/重建
    }
  }

  // 迁移旧单存档
  let migrated = null;
  const oldRaw = localStorage.getItem(OLD_KEY);
  if (oldRaw) {
    try {
      const p = JSON.parse(oldRaw);
      if (Array.isArray(p)) {
        migrated = p;
      } else if (p && Array.isArray(p.messages)) {
        migrated = p.messages;
      }
    } catch (error) {
      // 忽略
    }
  }

  // 旧存档若缺 system 提示词，补上
  if (migrated && !migrated.some(m => m && m.role === "system")) {
    migrated.unshift({ role: "system", content: SYSTEM_PROMPT });
  }

  const now = new Date().toISOString();
  slotsData = {
    version: 2,
    activeSlot: "1",
    slots: {
      "1": migrated ? { name: "迁移存档", createdAt: now, updatedAt: now, messages: migrated } : null,
      "2": null,
      "3": null
    }
  };
  if (migrated) {
    localStorage.removeItem(OLD_KEY);
  }
  saveSlots();
}

function saveSlots() {
  localStorage.setItem(SLOTS_KEY, JSON.stringify(slotsData));
}

function getSlot(id) {
  return slotsData.slots[id || slotsData.activeSlot] || null;
}

// 判定槽位是否「有效为空」：没有数据，或只有 system 消息
function isSlotEmpty(slot) {
  if (!slot || !Array.isArray(slot.messages)) {
    return true;
  }
  return slot.messages.every(m => m.role === "system");
}

function hasAnyGame() {
  return SLOT_IDS.some(id => !isSlotEmpty(slotsData.slots[id]));
}

function autoSave() {
  const slot = getSlot();
  if (!slot) {
    return;
  }
  slot.updatedAt = new Date().toISOString();
  saveSlots();
}


/* =========================================================
   存档操作
   ========================================================= */

function switchSlot(id) {
  if (isGenerating) {
    return;
  }
  if (slotsData.activeSlot === id) {
    hideSettingsPanel();
    return;
  }
  autoSave();
  slotsData.activeSlot = id;
  saveSlots();
  renderMessages();
  renderSlotList();
  clearInput();
  hideSettingsPanel();
}

async function newGame() {
  if (isGenerating) {
    return;
  }
  const emptyId = SLOT_IDS.find(id => isSlotEmpty(slotsData.slots[id]));
  if (emptyId) {
    await newGameIn(emptyId);
    return;
  }

  // 槽满：挤占删除存档位1（二次确认）
  const first = slotsData.slots["1"];
  const name1 = first ? (first.name || "未命名存档") : "未命名存档";
  confirmModal(
    "存档位已满",
    "三个存档位都已使用。新开一局将自动删除第一个存档「" + name1 + "」，此操作不可恢复。确定继续吗？",
    "删除并新开",
    async function () {
      slotsData.slots["1"] = null;
      saveSlots();
      await newGameIn("1");
    }
  );
}

async function newGameIn(id) {
  if (isGenerating) {
    return;
  }
  if (!isSlotEmpty(slotsData.slots[id])) {
    return;
  }
  autoSave();
  _initSlot(id);
  hideSettingsPanel();
  await requestAssistant();
}

function _initSlot(id) {
  const now = new Date().toISOString();
  slotsData.slots[id] = {
    name: "",
    createdAt: now,
    updatedAt: now,
    messages: [{ role: "system", content: SYSTEM_PROMPT }]
  };
  slotsData.activeSlot = id;
  saveSlots();
  renderMessages();
  renderSlotList();
  clearInput();
}

function deleteSlot(id) {
  if (isGenerating) {
    return;
  }
  const slot = slotsData.slots[id];
  const name = slot ? (slot.name || "未命名存档") : "未命名存档";
  confirmModal(
    "删除存档",
    "确定要删除「" + name + "」吗？此操作不可恢复。",
    "删除",
    function () {
      slotsData.slots[id] = null;
      if (slotsData.activeSlot === id) {
        slotsData.activeSlot = SLOT_IDS.find(i => !isSlotEmpty(slotsData.slots[i])) || "1";
      }
      saveSlots();
      renderMessages();
      renderSlotList();
    }
  );
}

function renameSlot(id) {
  if (isGenerating) {
    return;
  }
  const slot = slotsData.slots[id];
  if (!slot) {
    return;
  }
  showRenameModal(slot.name || "", function (name) {
    slot.name = name.trim().slice(0, 20);
    saveSlots();
    renderSlotList();
  });
}

function exportSlot() {
  const slot = getSlot();
  if (isSlotEmpty(slot)) {
    alert("当前没有存档");
    return;
  }
  const exportData = {
    version: 2,
    exportedAt: new Date().toISOString(),
    name: slot.name || "未命名存档",
    model: currentModel,
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
  if (!text) {
    alert("请先粘贴存档 JSON");
    return;
  }
  const emptyId = SLOT_IDS.find(id => isSlotEmpty(slotsData.slots[id]));
  if (!emptyId) {
    alert("存档位已满，请先删除一个存档");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    alert("JSON 格式错误，请检查后重试");
    return;
  }
  if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    alert("存档格式无效，缺少 messages 字段");
    return;
  }
  if (!parsed.messages.every(m => m && m.role && typeof m.content === "string")) {
    alert("消息格式有误，导入失败");
    return;
  }
  if (!parsed.messages.some(m => m.role === "system")) {
    parsed.messages.unshift({ role: "system", content: SYSTEM_PROMPT });
  }
  const now = new Date().toISOString();
  slotsData.slots[emptyId] = {
    name: parsed.name || "导入存档",
    createdAt: parsed.exportedAt || now,
    updatedAt: now,
    messages: parsed.messages
  };
  saveSlots();
  renderSlotList();
  area.value = "";
  alert("已导入到存档位 " + emptyId);
}


/* =========================================================
   存档列表渲染
   ========================================================= */

function renderSlotList() {
  const container = document.getElementById("slotList");
  if (!container) {
    return;
  }
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
      const name = slot.name || "未命名存档";
      const turns = slot.messages.filter(m => m.role === "assistant").length;
      const timeStr = relTime(slot.updatedAt);
      const lastAst = slot.messages.filter(m => m.role === "assistant").pop();
      const preview = lastAst
        ? (lastAst.content.replace(/\n/g, " ").slice(0, 20) + (lastAst.content.length > 20 ? "…" : ""))
        : "—";

      card.innerHTML =
        '<div class="slot-id-label">存档位 ' + id + '</div>' +
        '<div class="slot-title"><span class="slot-name"></span>' +
        (isActive ? '<span class="slot-badge">当前</span>' : '') +
        '</div>' +
        '<div class="slot-meta"></div>' +
        '<div class="slot-summary"></div>' +
        '<div class="slot-actions"></div>';

      card.querySelector(".slot-name").textContent = name;
      card.querySelector(".slot-meta").textContent = turns + " 轮 · " + timeStr;
      card.querySelector(".slot-summary").textContent = preview;

      const actions = card.querySelector(".slot-actions");

      if (!isActive) {
        const sw = document.createElement("button");
        sw.type = "button";
        sw.textContent = "切换";
        sw.dataset.action = "switch";
        sw.dataset.id = id;
        actions.appendChild(sw);
      }

      const rn = document.createElement("button");
      rn.type = "button";
      rn.textContent = "改名";
      rn.dataset.action = "rename";
      rn.dataset.id = id;
      actions.appendChild(rn);

      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "删除";
      del.className = "danger";
      del.dataset.action = "delete";
      del.dataset.id = id;
      actions.appendChild(del);
    }

    container.appendChild(card);
  });
}

function relTime(iso) {
  if (!iso) {
    return "";
  }
  try {
    const diff = (Date.now() - new Date(iso)) / 1000;
    if (diff < 60) {
      return "刚刚";
    }
    if (diff < 3600) {
      return Math.floor(diff / 60) + " 分钟前";
    }
    if (diff < 86400) {
      return Math.floor(diff / 3600) + " 小时前";
    }
    if (diff < 86400 * 30) {
      return Math.floor(diff / 86400) + " 天前";
    }
    return new Date(iso).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  } catch (e) {
    return "";
  }
}


/* =========================================================
   通用弹窗
   ========================================================= */

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


/* =========================================================
   主题
   ========================================================= */

function loadTheme() {
  const theme = localStorage.getItem("sanguo_theme");
  if (theme === "day" || theme === "scroll") {
    document.body.classList.add("theme-day");
  }
  updateThemeButton();
}

function updateThemeButton() {
  const button = document.getElementById("themeBtn");
  if (!button) {
    return;
  }
  const isDay = document.body.classList.contains("theme-day");
  button.textContent = isDay ? "暗色模式" : "日间模式";
}

function toggleTheme() {
  const isDay = document.body.classList.toggle("theme-day");
  localStorage.setItem("sanguo_theme", isDay ? "day" : "dark");
  updateThemeButton();
}


/* =========================================================
   模型
   ========================================================= */

function loadModel() {
  const saved = localStorage.getItem("sanguo_model");
  if (saved === "deepseek-flash" || saved === "deepseek-v4-pro") {
    currentModel = saved;
  }
  const select = document.getElementById("modelSelect");
  if (select) {
    select.value = currentModel;
  }
}

function changeModel() {
  const select = document.getElementById("modelSelect");
  if (!select) {
    return;
  }
  currentModel = select.value;
  localStorage.setItem("sanguo_model", currentModel);
}


/* =========================================================
   消息渲染
   ========================================================= */

function createMessageElement(message) {
  const div = document.createElement("div");
  div.className = "msg " + message.role;
  if (message.role === "user") {
    div.textContent = "你: " + message.content;
  } else {
    div.textContent = message.content;
  }
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
    if (!message || message.role === "system") {
      return;
    }
    appendMessage(message);
  });

  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function placeNewReplyForReading(assistantDiv) {
  requestAnimationFrame(function () {
    if (!assistantDiv) {
      return;
    }
    const top = assistantDiv.offsetTop;
    chatWindow.scrollTop = Math.max(0, top - 12);
  });
}

function clearInput() {
  userInput.value = "";
  resizeInput();
}


/* =========================================================
   生成状态
   ========================================================= */

function setGeneratingState(generating) {
  isGenerating = generating;
  const ids = [
    "sendBtn",
    "themeBtn",
    "newGameBtn",
    "settingsBtn",
    "exportBtn",
    "importBtn",
    "modelSelect",
    "changeKeyBtn",
    "keySubmitBtn"
  ];
  ids.forEach(function (id) {
    const element = document.getElementById(id);
    if (element) {
      element.disabled = generating;
    }
  });
}


/* =========================================================
   AI 请求
   ========================================================= */

async function requestAssistant() {
  if (isGenerating) {
    return null;
  }

  setGeneratingState(true);

  const assistantDiv = document.createElement("div");
  assistantDiv.className = "msg assistant";

  const thinking = document.createElement("span");
  thinking.className = "thinking";
  thinking.textContent = "……思考中……";
  assistantDiv.appendChild(thinking);

  // 若当前显示空状态，先清掉，让开场叙述从顶部开始
  const emptyState = chatWindow.querySelector(".empty-state");
  if (emptyState) {
    chatWindow.innerHTML = "";
  }

  chatWindow.appendChild(assistantDiv);
  placeNewReplyForReading(assistantDiv);

  let fullText = "";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-User-API-Key": userApiKey
      },
      body: JSON.stringify({
        messages: getSlot().messages,
        model: currentModel
      })
    });

    if (!response.ok || !response.body) {
      let errorInfo = "";
      try {
        errorInfo = JSON.stringify(await response.json());
      } catch (error) {
        // 忽略解析错误
      }
      assistantDiv.textContent = "出错了：" + (errorInfo || "HTTP " + response.status);
      return null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
          const piece = delta && delta.content;
          if (typeof piece === "string" && piece.length > 0) {
            fullText += piece;
            assistantDiv.textContent = fullText;
          }
        } catch (error) {
          // SSE 片段解析失败，跳过
        }
      }
    }

    if (!fullText) {
      fullText = "（未获取到有效回复，请稍后重试。）";
      assistantDiv.textContent = fullText;
    }

    const slot = getSlot();
    slot.messages.push({ role: "assistant", content: fullText });
    autoSave();
    renderSlotList();

    return fullText;
  } catch (error) {
    console.error("AI请求失败:", error);
    assistantDiv.textContent = "网络错误：" + (error && error.message ? error.message : "未知错误");
    return null;
  } finally {
    setGeneratingState(false);
  }
}


/* =========================================================
   玩家发送消息
   ========================================================= */

async function sendMessage(text) {
  if (isGenerating) {
    return;
  }

  const content = text.trim().length > 0 ? text.trim() : "(继续推进剧情)";

  if (isSlotEmpty(getSlot())) {
    alert("请先「新开一局」再开始");
    return;
  }

  if (!userApiKey) {
    showKeyModal(false);
    return;
  }

  const userMessage = { role: "user", content: content };
  getSlot().messages.push(userMessage);
  appendMessage(userMessage);
  autoSave();

  await requestAssistant();
}


/* =========================================================
   输入框自动高度
   ========================================================= */

function resizeInput() {
  if (!userInput) {
    return;
  }
  userInput.style.height = "auto";
  const nextHeight = Math.min(userInput.scrollHeight, 130);
  userInput.style.height = nextHeight + "px";
}


/* =========================================================
   设置面板
   ========================================================= */

function showSettingsPanel() {
  renderSlotList();
  document.getElementById("settingsModal").classList.remove("hidden");
}

function hideSettingsPanel() {
  document.getElementById("settingsModal").classList.add("hidden");
}


/* =========================================================
   BYOK — API Key 管理
   ========================================================= */

function loadApiKey() {
  const saved = localStorage.getItem("userApiKey");
  if (saved) {
    userApiKey = saved;
  } else {
    showKeyModal(false);
  }
}

function showKeyModal(isSettings) {
  const modal = document.getElementById("keyModal");
  const title = document.getElementById("keyModalTitle");
  const submitBtn = document.getElementById("keySubmitBtn");
  const clearBtn = document.getElementById("keyClearBtn");
  const closeBtn = document.getElementById("keyCloseBtn");
  const errorEl = document.getElementById("keyError");
  const input = document.getElementById("keyInput");

  if (title) {
    title.textContent = isSettings ? "更换 API Key" : "填写你的 DeepSeek API Key";
  }
  if (submitBtn) {
    submitBtn.textContent = isSettings ? "保存" : "开始游戏";
  }
  if (clearBtn) {
    clearBtn.style.display = isSettings ? "block" : "none";
  }
  if (closeBtn) {
    closeBtn.style.display = isSettings ? "flex" : "none";
  }
  if (errorEl) {
    errorEl.textContent = "";
  }
  if (input) {
    input.value = "";
  }

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
    if (errorEl) {
      errorEl.textContent = "Key 格式不正确，应以 sk- 开头";
    }
    return;
  }

  const wasFirstTime = modal.dataset.settings !== "1";

  userApiKey = key;
  localStorage.setItem("userApiKey", key);
  hideKeyModal();

  if (wasFirstTime && !hasAnyGame()) {
    newGame();
  }
}

function clearApiKey() {
  userApiKey = "";
  localStorage.removeItem("userApiKey");
  showKeyModal(false);
}


/* =========================================================
   页面启动
   ========================================================= */

window.addEventListener("load", function () {
  chatWindow = document.getElementById("chatWindow");
  userInput = document.getElementById("userInput");

  loadTheme();
  loadModel();
  loadSlots();
  renderMessages();

  /* ---- 工具栏 ---- */
  document.getElementById("themeBtn").addEventListener("click", toggleTheme);
  document.getElementById("newGameBtn").addEventListener("click", newGame);
  document.getElementById("settingsBtn").addEventListener("click", showSettingsPanel);

  /* ---- 设置面板 ---- */
  document.getElementById("settingsCloseBtn").addEventListener("click", hideSettingsPanel);
  document.getElementById("modelSelect").addEventListener("change", changeModel);
  document.getElementById("exportBtn").addEventListener("click", exportSlot);
  document.getElementById("importBtn").addEventListener("click", importSlot);

  /* ---- 存档卡片事件委托 ---- */
  document.getElementById("slotList").addEventListener("click", function (e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) {
      return;
    }
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === "switch") {
      switchSlot(id);
    } else if (action === "rename") {
      renameSlot(id);
    } else if (action === "delete") {
      deleteSlot(id);
    } else if (action === "new") {
      newGameIn(id);
    }
  });

  /* ---- 确认弹窗 ---- */
  document.getElementById("confirmOkBtn").addEventListener("click", function () {
    const cb = pendingConfirm;
    hideConfirmModal();
    if (cb) {
      cb();
    }
  });
  document.getElementById("confirmCancelBtn").addEventListener("click", hideConfirmModal);
  document.getElementById("confirmCloseBtn").addEventListener("click", hideConfirmModal);

  /* ---- 改名弹窗 ---- */
  document.getElementById("renameOkBtn").addEventListener("click", function () {
    const v = document.getElementById("renameInput").value.trim();
    if (!v) {
      return;
    }
    const cb = pendingRename;
    hideRenameModal();
    if (cb) {
      cb(v);
    }
  });
  document.getElementById("renameCancelBtn").addEventListener("click", hideRenameModal);
  document.getElementById("renameCloseBtn").addEventListener("click", hideRenameModal);
  document.getElementById("renameInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      document.getElementById("renameOkBtn").click();
    }
  });

  /* ---- 发送 ---- */
  document.getElementById("sendBtn").addEventListener("click", async function () {
    if (isGenerating) {
      return;
    }
    const text = userInput.value;
    userInput.value = "";
    resizeInput();
    await sendMessage(text);
  });

  userInput.addEventListener("keydown", async function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (isGenerating) {
        return;
      }
      const text = userInput.value;
      userInput.value = "";
      resizeInput();
      await sendMessage(text);
    }
  });

  userInput.addEventListener("input", resizeInput);

  /* ---- API Key ---- */
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