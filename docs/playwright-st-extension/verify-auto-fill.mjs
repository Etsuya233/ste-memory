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
const snapshot = () => page.evaluate(() => window.frontendPreview.autoFillSnapshot());
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
async function save() {
  await action("save-changes").click();
  await page.getByText("当前对话的自动填表设置已保存。", { exact: true }).waitFor();
}
try {
  await page.goto(process.env.FRONTEND_URL ?? "http://127.0.0.1:18825");
  await action("nav-tasks").click();
  await button("配置对话自动填表").click();
  await label("触发模式").waitFor();
  check(
    "conversation settings initially inherit globals",
    (await label("触发模式").inputValue()) === "" &&
      (await label("触发间隔（层）").inputValue()) === "" &&
      (await label("成功后自动隐藏楼层").inputValue()) === "" &&
      (await label("隐藏时保留最近楼层数").inputValue()) === "",
  );
  await label("触发模式").selectOption("auto");
  await label("触发间隔（层）").fill("5");
  await label("包含刚完成的 AI 楼层").selectOption("true");
  await label("成功后自动隐藏楼层").selectOption("true");
  await label("隐藏时保留最近楼层数").fill("0");
  await switchChat("b");
  await page.waitForFunction(() => document.querySelector("#chat-auto-fill-interval").value === "");
  check("other chat has independent override draft", (await label("触发模式").inputValue()) === "");
  await label("触发间隔（层）").fill("7");
  await label("成功后自动隐藏楼层").selectOption("false");
  await label("隐藏时保留最近楼层数").fill("3");
  await switchChat("a");
  await page.waitForFunction(
    () => document.querySelector("#chat-auto-fill-interval").value === "5",
  );
  check(
    "return restores previous chat override draft",
    (await label("触发模式").inputValue()) === "auto" &&
      (await label("成功后自动隐藏楼层").inputValue()) === "true" &&
      (await label("隐藏时保留最近楼层数").inputValue()) === "0",
  );
  await action("nav-records").click();
  await button("保留编辑").click();
  check(
    "override draft uses shared leave protection",
    (await label("触发间隔（层）").inputValue()) === "5",
  );
  await save();
  check(
    "saving overrides targets original chat",
    (await snapshot()).some(
      ([key, value]) =>
        key.includes("bookshop") &&
        value.interval === 5 &&
        value.mode === "auto" &&
        value.includeCurrent === true &&
        value.hideAfterSuccess === true &&
        value.keepRecentFloors === 0,
    ),
  );
  await switchChat("b");
  await page.waitForFunction(
    () => document.querySelector("#chat-auto-fill-interval").value === "7",
  );
  await save();
  check(
    "second chat saves independently",
    (await snapshot()).some(
      ([key, value]) =>
        key.includes("harbour") &&
        value.interval === 7 &&
        value.hideAfterSuccess === false &&
        value.keepRecentFloors === 3,
    ),
  );
  await label("触发间隔（层）").fill("9");
  await switchChat("a");
  await page.waitForFunction(
    () => document.querySelector("#chat-auto-fill-interval").value === "5",
  );
  check("save button reflects only current clean chat", await action("save-changes").isDisabled());
  await action("nav-records").click();
  await button("保留编辑").click();
  check(
    "hidden chat drafts still protect navigation",
    (await label("触发间隔（层）").inputValue()) === "5",
  );
  await switchChat("b");
  await action("page-back").click();
  await button("放弃修改并继续").click();
  await button("配置对话自动填表").waitFor();
  await button("配置对话自动填表").click();
  await page.waitForFunction(
    () => document.querySelector("#chat-auto-fill-interval")?.value === "7",
  );
  check("discard restores persisted conversation settings", true);
  await button("全部跟随全局").click();
  await save();
  check(
    "follow globals removes explicit overrides",
    (await snapshot()).some(
      ([key, value]) => key.includes("harbour") && Object.keys(value).length === 0,
    ),
  );
  await label("触发间隔（层）").fill("0");
  await action("save-changes").click();
  check(
    "invalid override does not persist",
    (await label("触发间隔（层）").evaluate((el) => !el.validity.valid)) &&
      (await snapshot()).some(
        ([key, value]) => key.includes("harbour") && Object.keys(value).length === 0,
      ),
  );
  await label("触发间隔（层）").fill("2");
  await label("隐藏时保留最近楼层数").fill("-1");
  await action("save-changes").click();
  check(
    "negative keep count fails native validation",
    await label("隐藏时保留最近楼层数").evaluate((el) => !el.validity.valid),
  );
  check(
    "negative keep count is rejected without saving",
    (await snapshot()).some(
      ([key, value]) => key.includes("harbour") && Object.keys(value).length === 0,
    ),
  );
  await label("隐藏时保留最近楼层数").fill("0.5");
  await action("save-changes").click();
  check(
    "fractional keep count is rejected",
    (await label("隐藏时保留最近楼层数").evaluate((el) => !el.validity.valid)) &&
      (await snapshot()).some(
        ([key, value]) => key.includes("harbour") && Object.keys(value).length === 0,
      ),
  );
  await label("隐藏时保留最近楼层数").fill("");
  await save();
  await action("nav-settings").click();
  await button("自动填表").click();
  await label("触发模式").selectOption("remind");
  await label("触发间隔（层）").fill("12");
  await label("每批楼层数").fill("11");
  await page.getByRole("switch", { name: "成功后自动隐藏楼层", exact: true }).click();
  await label("隐藏时保留最近楼层数").fill("0");
  await action("save-changes").click();
  await page.getByText("自动填表设置已保存。", { exact: true }).waitFor();
  check(
    "global shared fields retain global save behavior",
    (await settings()).autoFill.interval === 12 &&
      (await settings()).autoFill.blockSize === 11 &&
      (await settings()).autoFill.mode === "remind" &&
      (await settings()).autoFill.hideAfterSuccess === true &&
      (await settings()).autoFill.keepRecentFloors === 0,
  );
  await label("隐藏时保留最近楼层数").fill("-1");
  await action("save-changes").click();
  check(
    "global negative keep count fails native validation",
    await label("隐藏时保留最近楼层数").evaluate((el) => !el.validity.valid),
  );
  check(
    "global keep validation preserves persisted settings",
    (await settings()).autoFill.keepRecentFloors === 0,
  );
  await label("隐藏时保留最近楼层数").fill("0");
  await action("nav-tasks").click();
  await button("配置对话自动填表").click();
  await label("触发模式").waitFor();
  check(
    "conversation override survives global settings change",
    (await label("触发间隔（层）").inputValue()) === "2",
  );
  await button("全部跟随全局").click();
  await save();
  await page
    .getByText("已保存的实际配置：仅提醒 · 每 12 层触发 · 每批 11 层。", { exact: true })
    .waitFor();
  check("removed overrides use latest global defaults", true);
  await page.getByText("已保存的隐藏设置：开启，保留最近 0 层。", { exact: true }).waitFor();
  await label("成功后自动隐藏楼层").selectOption("false");
  check("hide-only edits enable save", await action("save-changes").isEnabled());
  await save();
  check(
    "explicit false overrides an enabled global setting",
    (await snapshot()).some(
      ([key, value]) => key.includes("harbour") && value.hideAfterSuccess === false,
    ),
  );
  await label("成功后自动隐藏楼层").selectOption("");
  await save();
  check(
    "selecting follow global removes the hide override",
    (await snapshot()).some(
      ([key, value]) => key.includes("harbour") && !("hideAfterSuccess" in value),
    ),
  );
  await label("隐藏时保留最近楼层数").fill("0");
  check(
    "keep-only edits enable save even when zero matches the global value",
    await action("save-changes").isEnabled(),
  );
  await save();
  await label("隐藏时保留最近楼层数").fill("");
  await save();
  check(
    "clearing the keep count restores global inheritance",
    (await snapshot()).some(
      ([key, value]) => key.includes("harbour") && !("keepRecentFloors" in value),
    ),
  );
  check(
    "320px auto fill has no horizontal overflow",
    await page.locator("#ste-memory-app").evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  const directory =
    process.env.FRONTEND_SCREENSHOTS ?? "../../node_modules/.cache/frontend-preview/screenshots";
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/tasks-auto-fill-320.png` });
  check("no auto fill browser exceptions", errors.length === 0);
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
