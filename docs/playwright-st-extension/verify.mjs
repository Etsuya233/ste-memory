// ST 扩展加载验证模板（headless chromium 真实加载 ST 页面）
//
// 用法：
//   node verify.mjs                        # 默认验证 STE Memory 插件
//   ST_URL=... INIT_LOG=... CHROME=... node verify.mjs
// 退出码 0 = 通过（抓到初始化日志）；1 = 未通过。
//
// 依赖：playwright-core（无需下载浏览器，直接用 Playwright 缓存里的 chromium）
//   本目录执行：pnpm install --ignore-workspace
/* global $, document */ // page.evaluate 回调运行在浏览器上下文（ST 页面有全局 jQuery）
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const ST_URL = process.env.ST_URL ?? "http://127.0.0.1:8000";
const INIT_LOG = process.env.INIT_LOG ?? "[STE Memory] v0.1.0 已加载";

/** 自动发现 Playwright 浏览器缓存里的 chromium（取最新版本目录） */
function findChromium() {
  const cache = path.join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) {
    return undefined;
  }
  for (const dir of readdirSync(cache).sort().reverse()) {
    if (!dir.startsWith("chromium-")) {
      continue;
    }
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const candidate = path.join(cache, dir, sub);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const CHROME = process.env.CHROME ?? findChromium();
if (!CHROME) {
  console.error("未找到 chromium：请用 CHROME 环境变量指定路径，或先运行 `npx playwright install chromium`");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  // 关键：若本机配置了系统代理（clash 等），headless chrome 会继承并走代理连
  // 127.0.0.1 → ERR_TIMED_OUT。必须同时做两件事：--no-proxy-server 参数 +
  // 清空代理环境变量（光设 proxy: direct 不够）。
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
const failedRequests = [];

page.on("console", (msg) => consoleLines.push(`[console.${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => pageErrors.push(String(err)));
page.on("requestfailed", (req) =>
  failedRequests.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText}`),
);

console.log(`加载 ${ST_URL} ...`);
await page.goto(ST_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

// 等待初始化日志：扩展以 module script 异步加载，轮询比 networkidle 稳
const deadline = Date.now() + 60000;
while (Date.now() < deadline && !consoleLines.some((l) => l.includes(INIT_LOG))) {
  await page.waitForTimeout(1000);
}

console.log("\n===== 验证 1：插件初始化日志 =====");
const logFound = consoleLines.find((l) => l.includes("STE Memory"));
if (logFound) {
  console.log(`✅ ${logFound}`);
} else {
  console.log("❌ 未找到初始化日志");
  consoleLines
    .filter((l) => l.includes("STE") || l.includes("extension") || l.includes("error"))
    .slice(-20)
    .forEach((l) => console.log(l));
}

console.log("\n===== 验证 2：扩展管理器识别 =====");
try {
  // 扩展管理器弹层由 jQuery 事件打开；#extensions_details 藏在隐藏菜单里，
  // Playwright 的 click 等 actionability 会超时，直接 trigger 事件即可
  await page.evaluate(() => {
    $("#extensions_details").trigger("click");
  });
  await page.waitForSelector(".extensions_info", { timeout: 15000 });
  await page.waitForSelector(".extensions_info .extension_block", { timeout: 20000 });
  const info = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll(".extensions_info .extension_block"));
    return {
      total: blocks.length,
      hasTarget: document
        .querySelector(".extensions_info")
        ?.textContent?.includes("STE Memory"),
    };
  });
  console.log(`第三方扩展总数: ${info.total}`);
  console.log(`列表中包含 "STE Memory": ${info.hasTarget ? "✅ 是" : "❌ 否"}`);
} catch (e) {
  console.log(`❌ 扩展管理器检查失败: ${String(e).slice(0, 200)}`);
}

console.log("\n===== 页面错误 / 失败请求 =====");
console.log(`pageerror: ${pageErrors.length ? pageErrors.join("\n") : "无"}`);
const extFailures = failedRequests.filter((r) => r.includes("ste-memory"));
console.log(`ste-memory 相关失败请求: ${extFailures.length ? extFailures.join("\n") : "无"}`);

const screenshotPath = path.join(tmpdir(), "ste-verify.png");
await page.screenshot({ path: screenshotPath, fullPage: false });
console.log(`\n截图: ${screenshotPath}`);

await browser.close();
process.exit(logFound ? 0 : 1);
