// ticket 12 手动验收：真实 ST 中经插件 LLM 适配器（ST backends 同源代理）
// 调用一次生成成功——streamFn 端到端（CSRF 令牌 → generate 端点 → SSE → pi 事件）。
// /* global __STE_MEMORY_RUNTIME__, SillyTavern */
//
// 前置：
//   1. ST 跑在 127.0.0.1:8000（ST_URL 可覆盖），扩展已同步进 extensions/third-party/ste-memory/；
//   2. **ST 的 API 连接已配置可用的 Chat Completion 源**（模型 + 密钥在 ST 服务端，
//      插件复用 ST 当前配置，不接触 key）——未配置时脚本报前置失败并给出提示。
// 用法：node verify-llm-adapter.mjs（exit 0 = 通过；无副作用，不写库不建数据）
import { existsSync, readdirSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const ST_URL = process.env.ST_URL ?? "http://127.0.0.1:8000";

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const cache = path.join(osHomedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) throw new Error("未找到 playwright chromium 缓存");
  const dirs = readdirSync(cache).filter((d) => d.startsWith("chromium-"));
  if (dirs.length === 0) throw new Error("playwright chromium 缓存为空");
  const latest = dirs.sort().at(-1);
  const candidates = [
    path.join(cache, latest, "chrome-linux64/chrome"),
    path.join(cache, latest, "chrome-linux/chrome"),
    path.join(cache, latest, "chrome-linux/chrome-headless-shell"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`chromium 可执行文件缺失：${candidates.join(" / ")}`);
  return found;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--no-proxy-server"],
  env: {
    ...process.env,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    ALL_PROXY: "",
    all_proxy: "",
  },
});

const page = await browser.newPage();
const consoleLines = [];
const pageErrors = [];
page.on("console", (msg) => consoleLines.push(`[console.${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => pageErrors.push(String(err)));

try {
  console.log(`加载 ${ST_URL} ...`);
  await page.goto(ST_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  // 等待插件运行时就位（bootstrap 挂 __STE_MEMORY_RUNTIME__ 调试全局）
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !(await page.evaluate(() => Boolean(globalThis.__STE_MEMORY_RUNTIME__)))) {
    await page.waitForTimeout(1000);
  }
  check("插件运行时就位（__STE_MEMORY_RUNTIME__）", await page.evaluate(() => Boolean(globalThis.__STE_MEMORY_RUNTIME__)));

  // 前置：ST Chat Completion 配置（模型名 + 生成源）——密钥在 ST 服务端，插件永远不见 key
  const stConfig = await page.evaluate(() => {
    const ctx = SillyTavern.getContext();
    const settings = ctx.chatCompletionSettings ?? {};
    return {
      source: settings.chat_completion_source ?? "",
      model: typeof ctx.getChatCompletionModel === "function" ? ctx.getChatCompletionModel(settings) : "",
      hasMainApi: typeof ctx.mainApi === "string" ? ctx.mainApi : "",
    };
  });
  console.log(`ST 当前 Chat Completion 配置：source=${stConfig.source} model=${stConfig.model} mainApi=${stConfig.hasMainApi}`);
  check("ST 已配置 Chat Completion 源", Boolean(stConfig.source), stConfig.source || "未配置（请先在 ST 的 API 连接中配置）");
  check("ST 已选择模型", Boolean(stConfig.model), stConfig.model || "未选择模型");

  if (stConfig.source && stConfig.model) {
    // 端到端生成：经插件端口（createLlm → streamFn）请求一次，断言收到模型回复
    const result = await page.evaluate(async () => {
      const runtime = globalThis.__STE_MEMORY_RUNTIME__;
      const port = runtime.createLlm();
      const stream = await port.streamFn(port.model, {
        systemPrompt: "你是验收助手。",
        messages: [{ role: "user", content: "只回复两个字：收到", timestamp: Date.now() }],
      });
      const message = await stream.result();
      const text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      return {
        stopReason: message.stopReason,
        errorMessage: message.errorMessage ?? "",
        text,
        responseModel: message.responseModel ?? "",
        eventError: message.stopReason === "error" || message.stopReason === "aborted",
      };
    });
    check("生成成功（stopReason=stop）", result.stopReason === "stop", `stopReason=${result.stopReason}`);
    check("收到模型回复", result.text.trim().length > 0, JSON.stringify(result.text.slice(0, 40)));
    check("无错误信息", !result.eventError, result.errorMessage || "");
    if (result.responseModel) {
      console.log(`  实际响应模型：${result.responseModel}`);
    }
  }

  // 请求侧断言：页面网络层确实打到 ST 同源代理端点（Playwright 重开 page 记录不到已发生请求，
  // 这里从插件日志/浏览器日志佐证：生成失败会打 [STE Memory] LLM 生成失败）
  const failedLogs = consoleLines.filter((l) => l.includes("LLM 生成失败"));
  if (failedLogs.length > 0) {
    check("无 LLM 生成失败日志", false, failedLogs[0]);
  } else {
    check("无 LLM 生成失败日志", true);
  }
} catch (error) {
  check("脚本执行", false, String(error));
  console.log("\n--- 页面错误 ---");
  for (const err of pageErrors.slice(0, 5)) console.log(err);
  console.log("--- 最近控制台 ---");
  for (const line of consoleLines.slice(-15)) console.log(line);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);
