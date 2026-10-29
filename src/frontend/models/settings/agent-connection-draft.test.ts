import { describe, expect, it } from "vitest";
import { createConnectionDraft, connectionFromDraft } from "./agent-connection-draft.ts";

const connection = {
  id: "c1",
  name: "连接",
  baseUrl: "https://example.com/v1",
  apiKey: "key",
  model: "m",
  customHeaders: { "X-Tenant": "a" },
};

describe("聊天连接请求头草稿", () => {
  it("转换前后保持连接配置，行 ID 不进入保存或测试请求", () => {
    const draft = createConnectionDraft(connection, () => "row-1");
    expect(connectionFromDraft(draft)).toEqual(connection);
    expect(connectionFromDraft(draft)).not.toHaveProperty("headerRows");
  });

  it("同名同值的重复行保留在草稿中，退出时可识别未保存修改", () => {
    const draft = createConnectionDraft(connection, () => "row-1");
    const changed = {
      ...draft,
      headerRows: [...draft.headerRows, { id: "row-2", name: "X-Tenant", value: "a" }],
    };
    expect(JSON.stringify(changed)).not.toBe(JSON.stringify(draft));
    expect(() => connectionFromDraft(changed)).toThrow("重复");
    expect(connectionFromDraft({ ...changed, headerRows: changed.headerRows.slice(0, 1) })).toEqual(
      connection,
    );
  });

  it("未完成的行阻止保存和测试，空值可以提交", () => {
    const draft = createConnectionDraft(connection, () => "row-1");
    expect(() =>
      connectionFromDraft({ ...draft, headerRows: [{ id: "row", name: "", value: "" }] }),
    ).toThrow("名称不合法");
    expect(
      connectionFromDraft({ ...draft, headerRows: [{ id: "row", name: "X-Empty", value: "" }] })
        .customHeaders,
    ).toEqual({ "X-Empty": "" });
  });
});
