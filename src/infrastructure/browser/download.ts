/**
 * 浏览器文件下载（导出备份/单空间导出共用）：Blob + 临时 object URL，
 * 触发后即释放；仅在浏览器环境可用（面板交互路径）。
 */
export function downloadTextFile(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

interface WritableTextFile {
  write(text: string): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface SaveTextFileHandle {
  createWritable(): Promise<WritableTextFile>;
}

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveTextFileHandle>;
}

/** 用户确认保存位置后生成内容；只有文件写入并关闭成功才返回 true。 */
export async function saveTextFile(
  createText: () => Promise<string>,
  filename: string,
): Promise<boolean> {
  const browserWindow = window as SaveFilePickerWindow;
  if (!browserWindow.showSaveFilePicker) {
    throw new Error("当前浏览器不支持文件保存对话框");
  }

  // 在任何 await 之前打开对话框，保留点击事件的用户激活状态。
  const handlePromise = browserWindow.showSaveFilePicker({ suggestedName: filename });
  let handle: SaveTextFileHandle;
  try {
    handle = await handlePromise;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return false;
    throw error;
  }

  const text = await createText();
  const stream = await handle.createWritable();
  try {
    await stream.write(text);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => undefined);
    throw error;
  }
  return true;
}
