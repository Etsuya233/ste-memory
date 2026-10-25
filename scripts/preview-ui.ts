import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".scratch/ui-kit-preview");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "docs/ui/kit-preview.tsx")],
  outdir: output,
  entryNames: "app",
  bundle: true,
  jsx: "automatic",
  format: "esm",
  sourcemap: true,
  define: { "process.env.NODE_ENV": '"development"' },
});
await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公共组件预览</title><link rel="stylesheet" href="app.css"><div id="root"></div><script type="module" src="app.js"></script></html>',
  "utf8",
);
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.js.map", ["app.js.map", "application/json"]],
  ["/app.css.map", ["app.css.map", "application/json"]],
]);
createServer(async (request, response) => {
  const asset = assets.get(request.url!);
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("Content-Type", asset[1]!);
  response.end(await readFile(path.join(output, asset[0]!)));
}).listen(8801, "127.0.0.1", () => console.log("UI kit preview: http://127.0.0.1:8801/"));
