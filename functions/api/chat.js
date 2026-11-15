const ALLOWED_MODELS = {
  "deepseek-flash": "deepseek-flash",
  "deepseek-v4-pro": "deepseek-v4-pro"
};

export async function onRequestPost({ request, env }) {

  try {

    const body = await request.json();

    // ==============================
    // 检查请求
    // ==============================

    if (!body || !Array.isArray(body.messages)) {

      return new Response(
        JSON.stringify({
          error: "请求格式错误：缺少 messages"
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

    }


    // ==============================
    // 模型选择
    // ==============================

    const requestedModel =
      body.model || "deepseek-flash";

    const model =
      ALLOWED_MODELS[requestedModel];

    if (!model) {

      return new Response(
        JSON.stringify({
          error:
            "不支持的模型，只允许 deepseek-flash 或 deepseek-v4-pro"
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

    }


    // ==============================
    // 读取用户 API Key
    // ==============================

    const userApiKey =
      request.headers.get("X-User-API-Key");

    if (
      !userApiKey ||
      !userApiKey.startsWith("sk-")
    ) {

      return new Response(
        JSON.stringify({
          error:
            "缺少有效的 API Key，请点击右上角 ⚙ 填写你的 DeepSeek API Key"
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

    }


    // ==============================
    // 调用 DeepSeek
    // ==============================

    const dsResponse = await fetch(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",

          "Authorization":
            `Bearer ${userApiKey}`
        },

        body: JSON.stringify({

          model: model,

          messages: body.messages,

          thinking: {
            type: "enabled"
          },

          reasoning_effort: "high",

          max_tokens: 3500,

          stream: true

        })
      }
    );


    // ==============================
    // DeepSeek错误
    // ==============================

    if (
      !dsResponse.ok ||
      !dsResponse.body
    ) {

      const errText =
        await dsResponse.text();

      let errorMessage = errText;

      try {

        const parsed =
          JSON.parse(errText);

        if (
          parsed &&
          parsed.error &&
          parsed.error.message
        ) {

          errorMessage =
            parsed.error.message;

        }

      } catch (e) {
        // 如果不是JSON，就直接使用原文本
      }


      return new Response(
        JSON.stringify({
          error: errorMessage
        }),
        {
          status:
            dsResponse.status || 500,

          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );

    }


    // ==============================
    // 原样透传流式响应
    // ==============================

    return new Response(
      dsResponse.body,
      {
        status: 200,

        headers: {

          "Content-Type":
            "text/event-stream",

          "Cache-Control":
            "no-cache, no-transform",

          "Connection":
            "keep-alive"

        }
      }
    );

  } catch (error) {

    console.error(
      "Chat API Error:",
      error
    );

    return new Response(

      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : String(error)
      }),

      {
        status: 500,

        headers: {
          "Content-Type":
            "application/json"
        }
      }

    );

  }

}