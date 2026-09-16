export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const dsResponse = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: body.messages,
        max_tokens: 3500,
        stream: true
      })
    });

    if (!dsResponse.ok || !dsResponse.body) {
      const errText = await dsResponse.text();
      return new Response(JSON.stringify({ error: errText }), {
        status: dsResponse.status || 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 直接把 DeepSeek 的流式响应体透传给前端,不在这里等它生成完
    return new Response(dsResponse.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}
