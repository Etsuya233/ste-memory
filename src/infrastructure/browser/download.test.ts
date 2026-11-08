import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTextFile, saveTextFile } from "./download.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("downloadTextFile", () => {
  it("下载时保留中文文件名，并在浏览器处理下载期间保留文件地址", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export-id");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const anchor = {
      href: "",
      download: "",
      hidden: false,
      click: vi.fn(() => {
        expect(appendChild).toHaveBeenCalledWith(anchor);
        expect(anchor.download).toBe("table-preset-剧情记忆.json");
        expect(revokeObjectURL).not.toHaveBeenCalled();
      }),
      remove: vi.fn(),
    };
    const appendChild = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild },
    });

    downloadTextFile('{"名称":"剧情记忆"}', "table-preset-剧情记忆.json");

    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(anchor.href).toBe("blob:export-id");
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("application/json;charset=utf-8");
    expect(await blob.text()).toBe('{"名称":"剧情记忆"}');
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:export-id");
  });
});

describe("saveTextFile", () => {
  it("取得文件句柄后才生成内容，写入并关闭后返回 true", async () => {
    let chooseFile: (handle: unknown) => void = () => undefined;
    const picker = vi.fn(() => new Promise((resolve) => (chooseFile = resolve)));
    vi.stubGlobal("window", { showSaveFilePicker: picker });
    const createText = vi.fn(async () => "备份内容");
    const write = vi.fn(async () => undefined);
    let finishClose: () => void = () => undefined;
    const close = vi.fn(() => new Promise<void>((resolve) => (finishClose = resolve)));
    const abort = vi.fn(async () => undefined);
    const handle = { createWritable: vi.fn(async () => ({ write, close, abort })) };

    const result = saveTextFile(createText, "backup.json");
    expect(picker).toHaveBeenCalledWith({ suggestedName: "backup.json" });
    expect(createText).not.toHaveBeenCalled();
    chooseFile(handle);
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(write).toHaveBeenCalledWith("备份内容");
    expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");
    finishClose();
    expect(await result).toBe(true);
    expect(abort).not.toHaveBeenCalled();
  });

  it("用户取消时返回 false，且不生成内容", async () => {
    vi.stubGlobal("window", {
      showSaveFilePicker: vi.fn(async () => {
        throw new DOMException("cancelled", "AbortError");
      }),
    });
    const createText = vi.fn(async () => "unused");
    expect(await saveTextFile(createText, "backup.json")).toBe(false);
    expect(createText).not.toHaveBeenCalled();
  });

  it("浏览器不支持文件保存对话框时明确报错，且不生成内容", async () => {
    vi.stubGlobal("window", {});
    const createText = vi.fn(async () => "unused");
    await expect(saveTextFile(createText, "backup.json")).rejects.toThrow(/不支持文件保存对话框/);
    expect(createText).not.toHaveBeenCalled();
  });

  it("写入失败时尝试中止文件流并抛出原错误", async () => {
    const failure = new Error("write failed");
    const abort = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      showSaveFilePicker: vi.fn(async () => ({
        createWritable: vi.fn(async () => ({
          write: vi.fn(async () => {
            throw failure;
          }),
          close,
          abort,
        })),
      })),
    });
    await expect(saveTextFile(async () => "content", "backup.json")).rejects.toBe(failure);
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});
