/* =========================================================
   本地预览服务器（零依赖，只用 Node 自带模块）
   作用：把静态文件 + /api/chat 代理一起跑起来，
        效果和线上 Cloudflare Pages 一致，但不用装 wrangler。

   用法：
     node dev-server.mjs
     然后浏览器打开 http://localhost:8788

   想换端口：
     $env:PORT=9000; node dev-server.mjs
   ========================================================= */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 8788);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const ALLOWED_MODELS = { "deepseek-flash": "deepseek-flash", "deepseek-v4-pro": "deepseek-v4-pro" };

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, { error: "请求格式错误：不是合法 JSON" });
  }

  if (!body || !Array.isArray(body.messages)) {
    return json(res, 400, { error: "请求格式错误：缺少 messages" });
  }

  const model = ALLOWED_MODELS[body.model || "deepseek-flash"];
  if (!model) {
    return json(res, 400, { error: "不支持的模型，只允许 deepseek-flash 或 deepseek-v4-pro" });
  }

  /* 本地预览可以直接用环境变量里的 Key，省得每次手填 */
  const key = req.headers["x-user-api-key"] || process.env.SG_KEY || "";
  if (!key || !String(key).startsWith("sk-")) {
    return json(res, 400, { error: "缺少有效的 API Key" });
  }

  const options = body.options || {};
  const stream = body.stream !== false;

  let maxTokens = Number(options.max_tokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = 3500;
  maxTokens = Math.max(64, Math.min(4096, Math.floor(maxTokens)));

  const payload = { model, messages: body.messages, max_tokens: maxTokens, stream };

  if (options.thinking === false) {
    payload.thinking = { type: "disabled" };
  } else {
    payload.thinking = { type: "enabled" };
    payload.reasoning_effort = "high";
  }

  if (Number.isFinite(Number(options.temperature))) {
    payload.temperature = Math.max(0, Math.min(1.5, Number(options.temperature)));
  }

  const upstream = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify(payload)
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return json(res, upstream.status || 500, { error: text.slice(0, 500) });
  }

  if (!stream) {
    const text = await upstream.text();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(text);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });

  for await (const chunk of upstream.body) {
    res.write(chunk);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/chat")) {
      return await handleChat(req, res);
    }

    let path = decodeURIComponent(req.url.split("?")[0]);
    if (path === "/") path = "/index.html";

    const file = join(ROOT, normalize(path).replace(/^[\/\\]+/, ""));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const buf = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    } else {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(String(error));
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("三国模拟人生 · 本地预览");
  console.log("  http://localhost:" + PORT);
  console.log("");
  console.log("提示：如果不想每次手填 Key，先在终端设好环境变量：");
  console.log('  $env:SG_KEY="sk-..."');
  console.log("然后 Ctrl+C 停止服务。");
});
