/** 通过可见的根导航切换工作区，先离开手机上的表格详情。 */
export async function switchTab(page, tab) {
  const tableBack = page.locator('#stm-panel [data-action="back-to-table-list"]');
  if (await tableBack.isVisible()) await tableBack.click();
  const navigation = page.locator("#stm-navigation");
  // 大屏默认固定显示导航；移动端（或用户手动收起后）才需要点汉堡按钮。
  if (!(await navigation.isVisible())) {
    await page.locator('#stm-panel [data-action="open-navigation"]').click();
  }
  await page.locator(`#stm-navigation .stm-tab[data-tab="${tab}"]`).click();
  await page.locator(`#stm-panel .stm-tab-section[data-stm-section="${tab}"]:not([hidden])`).waitFor({ state: "visible" });
}

/** 设置一次只显示一组；进入另一组之前返回分类列表。 */
export async function openSettingsGroup(page, group) {
  const back = page.locator('#stm-panel [data-action="settings-back"]');
  if (await back.isVisible()) await back.click();
  await page.locator(`#stm-panel button[data-action="toggle-settings-group"][data-group="${group}"]`).click();
  await page.locator(`#stm-panel [data-settings-page="${group}"]`).waitFor({ state: "visible" });
}
