import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  isR2Configured,
  mergeSettings,
  type PluginSettings,
} from "./plugin-settings.ts";

function r2(overrides: Partial<PluginSettings["r2"]> = {}): PluginSettings["r2"] {
  return { accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "", ...overrides };
}

describe("mergeSettings（旧数据/损坏数据补齐默认值，向前兼容）", () => {
  it("空值与未知形状：整体回退默认值", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("oops")).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings([])).toEqual(DEFAULT_SETTINGS);
  });

  it("部分键缺失：只补缺失的键，已存在的键保留", () => {
    const merged = mergeSettings({ enabled: false });
    expect(merged.enabled).toBe(false);
    expect(merged.macroName).toBe(DEFAULT_SETTINGS.macroName);
    expect(merged.r2).toEqual(DEFAULT_SETTINGS.r2);
  });

  it("嵌套 r2 部分缺失：按字段补默认，不整体覆盖", () => {
    const merged = mergeSettings({ r2: { accountId: "abc", bucket: "mem" } });
    expect(merged.r2.accountId).toBe("abc");
    expect(merged.r2.bucket).toBe("mem");
    expect(merged.r2.accessKeyId).toBe("");
    expect(merged.r2.secretAccessKey).toBe("");
  });

  it("类型不符的键：回退默认值（损坏数据不崩）", () => {
    const merged = mergeSettings({ enabled: "yes", macroName: 7, r2: "nope" });
    expect(merged).toEqual(DEFAULT_SETTINGS);
  });

  it("r2 不是对象时整体回退，其余键保留", () => {
    const merged = mergeSettings({ enabled: true, macroName: "{{m}}", r2: ["x"] });
    expect(merged.enabled).toBe(true);
    expect(merged.macroName).toBe("{{m}}");
    expect(merged.r2).toEqual(DEFAULT_SETTINGS.r2);
  });

  it("未知键被丢弃（读取只取已知形状）", () => {
    const merged = mergeSettings({ enabled: true, evil: "x", r2: { hacker: 1 } });
    expect("evil" in merged).toBe(false);
    expect("hacker" in merged.r2).toBe(false);
  });

  it("完整合法数据：原样保留", () => {
    const settings: PluginSettings = {
      enabled: false,
      r2: r2({ accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" }),
      macroName: "{{ctx}}",
    };
    expect(mergeSettings(settings)).toEqual(settings);
  });
});

describe("isR2Configured（同步状态占位判定）", () => {
  it("全空与部分填写：未配置", () => {
    expect(isR2Configured({ ...DEFAULT_SETTINGS })).toBe(false);
    expect(isR2Configured({ ...DEFAULT_SETTINGS, r2: r2({ accountId: "a" }) })).toBe(false);
  });

  it("四项全填：已配置", () => {
    expect(
      isR2Configured({
        ...DEFAULT_SETTINGS,
        r2: r2({ accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" }),
      }),
    ).toBe(true);
  });
});
