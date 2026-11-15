/* =========================================================
   三国模拟人生 V1.2.1 — 前端逻辑
   ========================================================= */


/* =========================================================
   全局状态
   ========================================================= */

let messages = [];

let chatWindow = null;

let userInput = null;

let isGenerating = false;

let currentModel = "deepseek-flash";


/* =========================================================
   创建新存档
   ========================================================= */

function createNewMessages() {

  return [
    {
      role: "system",
      content: SYSTEM_PROMPT
    }
  ];

}


/* =========================================================
   读取创建时间
   ========================================================= */

function getCreatedAt() {

  const raw =
    localStorage.getItem("sanguo_save");

  if (!raw) {
    return new Date().toISOString();
  }

  try {

    const data =
      JSON.parse(raw);

    if (
      data &&
      !Array.isArray(data) &&
      data.createdAt
    ) {
      return data.createdAt;
    }

  } catch (error) {
    // 使用新的时间
  }

  return new Date().toISOString();

}


/* =========================================================
   保存存档
   ========================================================= */

function saveState() {

  const saveData = {

    version: 1,

    createdAt:
      getCreatedAt(),

    updatedAt:
      new Date().toISOString(),

    gameState: {},

    messages:
      messages

  };


  try {

    localStorage.setItem(
      "sanguo_save",
      JSON.stringify(saveData)
    );

  } catch (error) {

    console.error(
      "保存存档失败:",
      error
    );

  }

}


/* =========================================================
   加载存档
   ========================================================= */

function loadState() {

  const raw =
    localStorage.getItem(
      "sanguo_save"
    );


  if (!raw) {

    messages =
      createNewMessages();

    return;

  }


  try {

    const data =
      JSON.parse(raw);


    /*
      兼容最早版本：
      旧版本直接保存 messages 数组。
    */

    if (Array.isArray(data)) {

      messages = data;

    }

    else if (
      data &&
      Array.isArray(data.messages)
    ) {

      messages =
        data.messages;

    }

    else {

      messages =
        createNewMessages();

    }


    /*
      确保系统提示词存在。
    */

    const hasSystem =
      messages.some(
        message =>
          message &&
          message.role === "system"
      );


    if (!hasSystem) {

      messages.unshift({
        role: "system",
        content: SYSTEM_PROMPT
      });

    }


  } catch (error) {

    console.error(
      "读取存档失败:",
      error
    );


    messages =
      createNewMessages();

  }

}


/* =========================================================
   判断是否完全没有开始过游戏
   ========================================================= */

function isEmptyGame() {

  return (
    messages.filter(
      message =>
        message.role !== "system"
    ).length === 0
  );

}


/* =========================================================
   主题
   ========================================================= */

function loadTheme() {

  const theme =
    localStorage.getItem(
      "sanguo_theme"
    );


  /*
    兼容 V1.1 的 scroll。
  */

  if (
    theme === "day" ||
    theme === "scroll"
  ) {

    document.body.classList.add(
      "theme-day"
    );

  }


  updateThemeButton();

}


function updateThemeButton() {

  const button =
    document.getElementById(
      "themeBtn"
    );


  if (!button) {
    return;
  }


  const isDay =
    document.body.classList.contains(
      "theme-day"
    );


  button.textContent =
    isDay
      ? "暗色模式"
      : "日间模式";

}


function toggleTheme() {

  const isDay =
    document.body.classList.toggle(
      "theme-day"
    );


  localStorage.setItem(
    "sanguo_theme",
    isDay
      ? "day"
      : "dark"
  );


  updateThemeButton();

}


/* =========================================================
   模型
   ========================================================= */

function loadModel() {

  const saved =
    localStorage.getItem(
      "sanguo_model"
    );


  if (
    saved === "deepseek-flash" ||
    saved === "deepseek-v4-pro"
  ) {

    currentModel =
      saved;

  }


  const select =
    document.getElementById(
      "modelSelect"
    );


  if (select) {

    select.value =
      currentModel;

  }

}


function changeModel() {

  const select =
    document.getElementById(
      "modelSelect"
    );


  if (!select) {
    return;
  }


  currentModel =
    select.value;


  localStorage.setItem(
    "sanguo_model",
    currentModel
  );

}


/* =========================================================
   创建消息DOM
   ========================================================= */

function createMessageElement(message) {

  const div =
    document.createElement("div");


  div.className =
    "msg " + message.role;


  /*
    使用 textContent。

    AI返回的内容只作为普通文字显示，
    不当作HTML执行。
  */

  if (message.role === "user") {

    div.textContent =
      "你: " + message.content;

  }

  else {

    div.textContent =
      message.content;

  }


  return div;

}


/* =========================================================
   添加消息
   ========================================================= */

function appendMessage(message) {

  const div =
    createMessageElement(
      message
    );


  chatWindow.appendChild(div);


  return div;

}


/* =========================================================
   渲染历史消息
   ========================================================= */

function renderMessages() {

  /*
    记录用户目前阅读的位置。

    渲染完成后恢复它，
    不自动滚到底部。
  */

  const oldScrollTop =
    chatWindow
      ? chatWindow.scrollTop
      : 0;


  chatWindow.innerHTML = "";


  messages.forEach(
    message => {

      if (
        !message ||
        message.role === "system"
      ) {
        return;
      }


      appendMessage(
        message
      );

    }
  );


  chatWindow.scrollTop =
    oldScrollTop;

}


/* =========================================================
   让最新AI回复进入阅读区域
   ========================================================= */

/*
  这里只执行一次。

  AI后面生成多少文字，都不会再次修改
  scrollTop。
*/

function placeNewReplyForReading(
  assistantDiv
) {

  requestAnimationFrame(() => {

    if (!assistantDiv) {
      return;
    }


    const top =
      assistantDiv.offsetTop;


    chatWindow.scrollTop =
      Math.max(
        0,
        top - 12
      );

  });

}


/* =========================================================
   生成状态
   ========================================================= */

function setGeneratingState(
  generating
) {

  isGenerating =
    generating;


  const ids = [
    "sendBtn",
    "resetBtn",
    "themeBtn",
    "exportBtn",
    "modelSelect"
  ];


  ids.forEach(id => {

    const element =
      document.getElementById(id);


    if (element) {

      element.disabled =
        generating;

    }

  });

}


/* =========================================================
   AI请求
   ========================================================= */

async function requestAssistant() {

  if (isGenerating) {
    return null;
  }


  setGeneratingState(true);


  /*
    创建一个正在生成中的AI消息。
  */

  const assistantDiv =
    document.createElement("div");


  assistantDiv.className =
    "msg assistant";


  const thinking =
    document.createElement("span");


  thinking.className =
    "thinking";


  thinking.textContent =
    "……思考中……";


  assistantDiv.appendChild(
    thinking
  );


  chatWindow.appendChild(
    assistantDiv
  );


  /*
    只定位一次。

    从这一刻开始，
    整个生成过程绝对不再自动滚动。
  */

  placeNewReplyForReading(
    assistantDiv
  );


  let fullText = "";


  try {

    const response =
      await fetch(
        "/api/chat",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            messages:
              messages,

            model:
              currentModel

          })

        }
      );


    if (
      !response.ok ||
      !response.body
    ) {

      let errorInfo = "";


      try {

        errorInfo =
          JSON.stringify(
            await response.json()
          );

      } catch (error) {
        // 忽略解析错误
      }


      const errorText =
        "出错了：" +
        (
          errorInfo ||
          "HTTP " +
          response.status
        );


      assistantDiv.textContent =
        errorText;


      return null;

    }


    const reader =
      response.body.getReader();


    const decoder =
      new TextDecoder(
        "utf-8"
      );


    let buffer = "";


    while (true) {

      const result =
        await reader.read();


      if (result.done) {
        break;
      }


      buffer +=
        decoder.decode(
          result.value,
          {
            stream: true
          }
        );


      const lines =
        buffer.split("\n");


      buffer =
        lines.pop();


      for (
        const line of lines
      ) {

        const trimmed =
          line.trim();


        if (
          !trimmed.startsWith(
            "data:"
          )
        ) {
          continue;
        }


        const payload =
          trimmed
            .slice(5)
            .trim();


        if (
          !payload ||
          payload === "[DONE]"
        ) {
          continue;
        }


        try {

          const json =
            JSON.parse(
              payload
            );


          const delta =
            json &&
            json.choices &&
            json.choices[0] &&
            json.choices[0].delta;


          const piece =
            delta &&
            delta.content;


          if (
            typeof piece ===
            "string" &&
            piece.length > 0
          ) {

            fullText +=
              piece;


            /*
              极其重要：

              这里只更新文字。

              没有：
              scrollTop
              scrollIntoView
              scrollTo

              所以不会把用户拖到下面。
            */

            assistantDiv.textContent =
              fullText;

          }

        } catch (error) {

          /*
            SSE可能把JSON拆成多个片段。
            当前片段解析失败时跳过，
            后续完整片段继续处理。
          */

        }

      }

    }


    if (!fullText) {

      fullText =
        "（未获取到有效回复，请稍后重试。）";


      assistantDiv.textContent =
        fullText;

    }


    /*
      AI回复完成后正式写入存档。
    */

    messages.push({

      role: "assistant",

      content:
        fullText

    });


    saveState();


    /*
      注意：
      这里故意没有任何滚动操作。
    */

    return fullText;


  } catch (error) {

    console.error(
      "AI请求失败:",
      error
    );


    assistantDiv.textContent =
      "网络错误：" +
      (
        error &&
        error.message
          ? error.message
          : "未知错误"
      );


    return null;


  } finally {

    setGeneratingState(
      false
    );

  }

}


/* =========================================================
   玩家发送消息
   ========================================================= */

async function sendMessage(
  text
) {

  if (isGenerating) {
    return;
  }


  const content =
    text.trim().length > 0
      ? text.trim()
      : "(继续推进剧情)";


  const userMessage = {

    role: "user",

    content:
      content

  };


  messages.push(
    userMessage
  );


  appendMessage(
    userMessage
  );


  saveState();


  await requestAssistant();

}


/* =========================================================
   开始全新的游戏
   ========================================================= */

async function startNewGame() {

  if (isGenerating) {
    return;
  }


  /*
    新游戏只留下system prompt。

    不伪造玩家消息。
  */

  messages =
    createNewMessages();


  saveState();


  renderMessages();


  /*
    直接让GM开始。
  */

  await requestAssistant();

}


/* =========================================================
   重置
   ========================================================= */

async function resetGame() {

  if (isGenerating) {
    return;
  }


  const confirmed =
    window.confirm(
      "确定要开始全新的三国人生吗？\n\n当前剧情、人物关系和对话记录都会被清空，并立即开始新的剧情。"
    );


  if (!confirmed) {
    return;
  }


  /*
    先删除旧存档。
  */

  try {

    localStorage.removeItem(
      "sanguo_save"
    );

  } catch (error) {

    console.error(
      "删除旧存档失败:",
      error
    );

  }


  /*
    然后立即建立新游戏。
  */

  await startNewGame();

}


/* =========================================================
   导出
   ========================================================= */

function exportSave() {

  const exportData = {

    version: 1,

    exportedAt:
      new Date().toISOString(),

    model:
      currentModel,

    messages:
      messages

  };


  const text =
    JSON.stringify(
      exportData,
      null,
      2
    );


  /*
    优先使用剪贴板。
  */

  if (
    navigator.clipboard &&
    typeof navigator.clipboard.writeText ===
      "function"
  ) {

    navigator.clipboard
      .writeText(text)
      .then(() => {

        alert(
          "存档已复制到剪贴板"
        );

      })
      .catch(() => {

        window.prompt(
          "请手动复制以下存档内容：",
          text
        );

      });

  }

  else {

    window.prompt(
      "请手动复制以下存档内容：",
      text
    );

  }

}


/* =========================================================
   输入框自动高度
   ========================================================= */

function resizeInput() {

  if (!userInput) {
    return;
  }


  userInput.style.height =
    "auto";


  const nextHeight =
    Math.min(
      userInput.scrollHeight,
      130
    );


  userInput.style.height =
    nextHeight + "px";

}


/* =========================================================
   页面启动
   ========================================================= */

window.addEventListener(
  "load",
  async function() {

    /*
      找到DOM。
    */

    chatWindow =
      document.getElementById(
        "chatWindow"
      );


    userInput =
      document.getElementById(
        "userInput"
      );


    /*
      加载主题。
    */

    loadTheme();


    /*
      加载模型。
    */

    loadModel();


    /*
      加载存档。
    */

    loadState();


    /*
      渲染历史。
    */

    renderMessages();


    /* =====================================================
       发送按钮
       ===================================================== */

    document.getElementById(
      "sendBtn"
    ).addEventListener(
      "click",
      async function() {

        if (isGenerating) {
          return;
        }


        const text =
          userInput.value;


        userInput.value =
          "";


        resizeInput();


        await sendMessage(
          text
        );

      }
    );


    /* =====================================================
       Enter发送
       Shift + Enter换行
       ===================================================== */

    userInput.addEventListener(
      "keydown",
      async function(event) {

        if (
          event.key === "Enter" &&
          !event.shiftKey
        ) {

          event.preventDefault();


          if (isGenerating) {
            return;
          }


          const text =
            userInput.value;


          userInput.value =
            "";


          resizeInput();


          await sendMessage(
            text
          );

        }

      }
    );


    /* =====================================================
       输入框自动高度
       ===================================================== */

    userInput.addEventListener(
      "input",
      resizeInput
    );


    /* =====================================================
       日间模式
       ===================================================== */

    document.getElementById(
      "themeBtn"
    ).addEventListener(
      "click",
      toggleTheme
    );


    /* =====================================================
       模型
       ===================================================== */

    document.getElementById(
      "modelSelect"
    ).addEventListener(
      "change",
      changeModel
    );


    /* =====================================================
       重置
       ===================================================== */

    document.getElementById(
      "resetBtn"
    ).addEventListener(
      "click",
      resetGame
    );


    /* =====================================================
       导出
       ===================================================== */

    document.getElementById(
      "exportBtn"
    ).addEventListener(
      "click",
      exportSave
    );


    /* =====================================================
       第一次打开时自动开始
       ===================================================== */

    if (isEmptyGame()) {

      await startNewGame();

    }

  }
);