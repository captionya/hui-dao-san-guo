const ALLOWED_MODELS = {
  "deepseek-flash": "deepseek-flash",
  "deepseek-v4-pro": "deepseek-v4-pro"
};

const MAX_TOKENS_LIMIT = 4096;

function jsonError(message, status) {
  return new Response(
    JSON.stringify({ error: message }),
    { status: status, headers: { "Content-Type": "application/json" } }
  );
}

export async function onRequestPost({ request, env }) {

  try {

    const body = await request.json();

    // ==============================
    // 检查请求
    // ==============================

    if (!body || !Array.isArray(body.messages)) {
      return jsonError("请求格式错误：缺少 messages", 400);
    }

    // ==============================
    // 模型选择
    // ==============================

    const requestedModel = body.model || "deepseek-flash";
    const model = ALLOWED_MODELS[requestedModel];

    if (!model) {
      return jsonError("不支持的模型，只允许 deepseek-flash 或 deepseek-v4-pro", 400);
    }

    // ==============================
    // 读取用户 API Key
    // ==============================

    const userApiKey = request.headers.get("X-User-API-Key");

    if (!userApiKey || !userApiKey.startsWith("sk-")) {
      return jsonError("缺少有效的 API Key，请点击右上角 ⚙ 填写你的 DeepSeek API Key", 400);
    }

    // ==============================
    // 请求参数
    //   options.max_tokens   判定器用小的，叙述用大的
    //   options.temperature  判定器用 0
    //   options.thinking     判定器关掉思考，省时省钱
    //   stream: false        判定器直接要 JSON
    // ==============================

    const options = (body && typeof body.options === "object" && body.options) || {};

    let maxTokens = Number(options.max_tokens);
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = 3500;
    maxTokens = Math.max(64, Math.min(MAX_TOKENS_LIMIT, Math.floor(maxTokens)));

    const useThinking = options.thinking !== false;
    const stream = body.stream !== false;

    const payload = {
      model: model,
      messages: body.messages,
      max_tokens: maxTokens,
      stream: stream
    };

    if (useThinking) {
      payload.thinking = { type: "enabled" };
      payload.reasoning_effort = "high";
    } else {
      // 显式关闭：不写这一行时，服务端可能默认开思考，
      // 小 max_tokens 会被推理过程吃光，content 返回空字符串。
      payload.thinking = { type: "disabled" };
    }

    if (Number.isFinite(Number(options.temperature))) {
      payload.temperature = Math.max(0, Math.min(1.5, Number(options.temperature)));
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
          "Authorization": `Bearer ${userApiKey}`
        },
        body: JSON.stringify(payload)
      }
    );

    // ==============================
    // DeepSeek 错误
    // ==============================

    if (!dsResponse.ok || !dsResponse.body) {

      const errText = await dsResponse.text();
      let errorMessage = errText;

      try {
        const parsed = JSON.parse(errText);
        if (parsed && parsed.error && parsed.error.message) {
          errorMessage = parsed.error.message;
        }
      } catch (e) {
        // 不是 JSON，就用原文
      }

      return jsonError(errorMessage, dsResponse.status || 500);
    }

    // ==============================
    // 非流式：原样返回 JSON
    // ==============================

    if (!stream) {
      const text = await dsResponse.text();
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // ==============================
    // 流式：原样透传
    // ==============================

    return new Response(dsResponse.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive"
      }
    });

  } catch (error) {

    console.error("Chat API Error:", error);

    return jsonError(
      error instanceof Error ? error.message : String(error),
      500
    );

  }

}
