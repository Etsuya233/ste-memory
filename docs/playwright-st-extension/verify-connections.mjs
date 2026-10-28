import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.env.FRONTEND_URL ?? "http://127.0.0.1:18825";
const screenshots =
  process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const field = (name) => page.getByLabel(name, { exact: true });
const settings = () => page.evaluate(() => window.frontendPreview.settingsSnapshot());
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
async function back() {
  await action("page-back").click();
}
async function save() {
  await action("save-changes").click();
}

try {
  await page.goto(url);
  await action("nav-settings").click();
  await button("Agent 连接与模型").click();
  await action("create-connection").click();
  await field("连接名称").fill("独立测试连接");
  await field("API Base URL").fill("https://chat.example/v1/chat/completions/");
  await field("API Key").fill("private-key");
  check(
    "agent key is masked by default",
    (await field("API Key").getAttribute("type")) === "password",
  );
  await button("显示API Key").click();
  check(
    "agent key visibility is explicit",
    (await field("API Key").getAttribute("type")) === "text",
  );
  await button("隐藏API Key").click();
  await button("添加").click();
  await field("请求头 1 名称").fill("X-Route");
  await field("请求头 1 值").fill("private-route");
  check(
    "header value is masked by default",
    (await field("请求头 1 值").getAttribute("type")) === "password",
  );
  await action("test-connection").click();
  await field("可用模型").waitFor();
  await field("可用模型").selectOption("preview-chat");
  check(
    "test models populate editable model field",
    (await field("模型名称").inputValue()) === "preview-chat",
  );
  await field("API Base URL").fill("https://chat.example/v1");
  check("endpoint change invalidates test model list", (await field("可用模型").count()) === 0);
  await button("添加").click();
  await field("请求头 2 名称").fill("x-route");
  await field("请求头 2 值").fill("duplicate");
  await save();
  await page.getByText("请求头名称重复（不区分大小写）", { exact: true }).waitFor();
  check("duplicate request headers reject save", (await settings()).agentConnections.length === 0);
  await button("移除请求头 2").click();
  await action("nav-records").click();
  await button("保留编辑").click();
  check(
    "dirty connection navigation retains values",
    (await field("API Key").inputValue()) === "private-key",
  );
  await page.getByRole("combobox", { name: "预览对话", exact: true }).selectOption("b");
  check(
    "global connection draft survives chat switch",
    (await field("连接名称").inputValue()) === "独立测试连接",
  );
  await save();
  await action("edit-connection").waitFor();
  const connection = (await settings()).agentConnections.find(
    (item) => item.name === "独立测试连接",
  );
  check(
    "connection save retains URL key model and headers",
    connection.baseUrl === "https://chat.example/v1" &&
      connection.apiKey === "private-key" &&
      connection.model === "preview-chat" &&
      connection.customHeaders["X-Route"] === "private-route",
  );
  await field("表格填写 Agent").selectOption(connection.id);
  await page.waitForFunction(
    (id) => window.frontendPreview.settingsSnapshot().fillTaskConnectionId === id,
    connection.id,
  );
  await field("查询 Agent").selectOption(connection.id);
  await page.waitForFunction(
    (id) => window.frontendPreview.settingsSnapshot().queryChatConnectionId === id,
    connection.id,
  );
  check(
    "fill and query selections save independently",
    (await settings()).fillTaskConnectionId === connection.id &&
      (await settings()).queryChatConnectionId === connection.id,
  );
  await action("edit-connection").click();
  await button("删除连接").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "删除连接", exact: true })
    .click();
  await action("create-connection").waitFor();
  check(
    "deletion clears both selected references",
    (await settings()).agentConnections.length === 0 &&
      (await settings()).fillTaskConnectionId === undefined &&
      (await settings()).queryChatConnectionId === undefined,
  );
  await back();

  await button("Embedding 连接").click();
  await field("API Base URL").fill("https://embedding.example/v1");
  await field("API Key").fill("embedding-key");
  await field("Embedding 模型").fill("embed-preview");
  await field("单条输入字符上限").fill("6000");
  await field("向量维度（可留空）").fill("1024");
  await save();
  await page.getByText("向量连接已保存，新的索引请求会使用此配置。", { exact: true }).waitFor();
  check(
    "embedding save includes dimensions and limits",
    (await settings()).embeddingConnection.model === "embed-preview" &&
      (await settings()).embeddingConnection.dimensions === 1024 &&
      (await settings()).embeddingConnection.maxInputChars === 6000,
  );
  await button("移除向量连接").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "移除连接", exact: true })
    .click();
  await page.getByText("向量连接已移除。", { exact: true }).waitFor();
  check(
    "embedding removal retains other settings",
    (await settings()).embeddingConnection === undefined && (await settings()).macroName.length > 0,
  );
  await back();

  await button("重排设置").click();
  await field("完整重排端点").fill("https://rerank.example/v1/rerank");
  await field("API Key").fill("rerank-key");
  await field("Rerank 模型").fill("rerank-preview");
  await field("默认候选数").fill("30");
  await page.getByRole("switch", { name: "默认启用重排", exact: true }).click();
  await save();
  await page.getByText("重排设置已保存。", { exact: true }).waitFor();
  check(
    "rerank settings save connection and enabled state",
    (await settings()).rerank.enabled &&
      (await settings()).rerank.candidateLimit === 30 &&
      (await settings()).rerank.connection.model === "rerank-preview",
  );
  await page.setViewportSize({ width: 320, height: 720 });
  check(
    "320px connection form has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await page.screenshot({ path: `${screenshots}/settings-rerank-320.png` });
  await button("移除重排连接").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "移除连接", exact: true })
    .click();
  await page.getByText("重排连接已移除，默认重排已关闭。", { exact: true }).waitFor();
  check(
    "removing rerank connection disables default rerank",
    !(await settings()).rerank.enabled && (await settings()).rerank.connection === undefined,
  );
  await back();

  await button("自动填表").click();
  const originalInterval = (await settings()).autoFill.interval;
  await field("触发间隔（层）").fill(String(originalInterval + 3));
  await back();
  await button("保留编辑").click();
  check(
    "auto fill dirty back retains draft",
    (await field("触发间隔（层）").inputValue()) === String(originalInterval + 3),
  );
  await field("触发模式").selectOption("remind");
  await save();
  await page.getByText("自动填表设置已保存。", { exact: true }).waitFor();
  check(
    "auto fill globals persist without changing other settings",
    (await settings()).autoFill.interval === originalInterval + 3 &&
      (await settings()).autoFill.mode === "remind" &&
      (await settings()).rerank.candidateLimit === 30,
  );
  await field("触发间隔（层）").fill(String(originalInterval + 8));
  await back();
  await button("放弃修改并继续").click();
  await button("自动填表").click();
  check(
    "discarding auto fill restores persisted values",
    (await field("触发间隔（层）").inputValue()) === String(originalInterval + 3),
  );
  check(
    "320px auto fill form has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  await page.screenshot({ path: `${screenshots}/settings-auto-fill-320.png` });
  check("no browser exceptions", errors.length === 0);
} finally {
  await browser.close();
}
