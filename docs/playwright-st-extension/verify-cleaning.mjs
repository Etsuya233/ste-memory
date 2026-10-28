import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(10000);
const action = (name) => page.locator(`[data-action="${name}"]:visible`).first();
const button = (name) => page.getByRole("button", { name, exact: true });
const label = (name) => page.getByLabel(name, { exact: true });
const check = (name, value) => {
  assert.ok(value, name);
  console.log(`PASS ${name}`);
};
const settings = () => page.evaluate(() => window.frontendPreview.settingsSnapshot());
async function switchChat(key) {
  await label("预览对话").selectOption(key);
  await page.waitForFunction(
    (key) =>
      window.frontendPreview.workspace
        .getSnapshot()
        .context?.chatKey.includes(key === "a" ? "bookshop" : "harbour"),
    key,
  );
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("nav-settings").click();
  await button("清洗规则").click();
  await action("create-cleaning-rule").click();
  await label("规则名称").fill("预览清洗");
  await button("添加排除标签").click();
  await label("排除标签 1 开始").fill("<think>");
  await label("排除标签 1 结束").fill("</think>");
  await label("测试文本").fill("<think>隐藏思考</think>保留正文");
  await button("运行测试").click();
  await page.getByText("保留正文", { exact: true }).waitFor();
  check("draft cleaning test excludes tagged content", true);
  check("draft test never saves settings", (await settings()).cleaningRules.length === 0);
  await button("添加保留标签").click();
  await label("保留标签 1 开始").fill("<body>");
  await label("保留标签 1 结束").fill("</body>");
  await label("测试文本").fill("<think><body>思考内正文</body></think><body>真实正文</body>其他");
  await button("运行测试").click();
  await page.getByText("真实正文", { exact: true }).waitFor();
  check("draft test excludes before keeping tagged content", true);
  await action("nav-records").click();
  await button("保留编辑").click();
  check(
    "dirty global rule protects bottom navigation",
    (await label("规则名称").inputValue()) === "预览清洗",
  );
  await switchChat("b");
  check(
    "global rule draft survives chat switch",
    (await label("规则名称").inputValue()) === "预览清洗",
  );
  await action("save-changes").click();
  await action("create-cleaning-rule").waitFor();
  const rule = (await settings()).cleaningRules[0];
  check(
    "rule saves normalized tags",
    rule.name === "预览清洗" &&
      rule.excludeTags[0].pre === "<think>" &&
      rule.keepTags[0].pre === "<body>",
  );
  await label("当前对话使用的规则").selectOption(rule.id);
  check(
    "current chat rule selection persists",
    (await label("当前对话使用的规则").inputValue()) === rule.id,
  );
  await switchChat("a");
  await page.waitForFunction(() => document.querySelector("#cleaning-selection").value === "");
  check("other chat has independent rule selection", true);
  await switchChat("b");
  await page.waitForFunction(
    (id) => document.querySelector("#cleaning-selection").value === id,
    rule.id,
  );
  check("return restores original chat rule", true);
  await action("edit-cleaning-rule").click();
  await button("移除保留标签 1").click();
  await button("载入当前对话").click();
  await button("运行测试").click();
  await page.getByText(/· AI 清洗/).waitFor();
  await page.getByText(/· 保持原文/).waitFor();
  check("loaded messages distinguish AI cleaning and unchanged user input", true);
  await page.getByRole("switch", { name: "启用此规则", exact: true }).click();
  await label("测试文本").fill("<think>停用后保留</think>正文");
  await button("运行测试").click();
  await page.getByText("<think>停用后保留</think>正文", { exact: true }).last().waitFor();
  check("disabled rule test preserves source text", true);
  await action("save-changes").click();
  await action("edit-cleaning-rule").waitFor();
  check("rule edit persists disabled state", (await settings()).cleaningRules[0].enabled === false);
  await action("edit-cleaning-rule").click();
  await button("删除规则").click();
  await button("取消").click();
  check("cancel rule deletion preserves config", (await settings()).cleaningRules.length === 1);
  await button("删除规则").click();
  await button("确认删除").click();
  await action("create-cleaning-rule").waitFor();
  check(
    "rule deletion clears current chat selection",
    (await settings()).cleaningRules.length === 0 &&
      (await label("当前对话使用的规则").inputValue()) === "",
  );
  check(
    "320px cleaning page has no horizontal overflow",
    await page
      .locator("#ste-memory-app")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  );
  const directory =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/settings-cleaning-320.png` });
  check("no cleaning browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
