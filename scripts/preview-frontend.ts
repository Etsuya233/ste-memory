import { context } from "esbuild";
import { mkdirSync, writeFileSync, watch } from "node:fs";
import path from "node:path";
import { createEsbuildOptions, PACKAGE_ROOT } from "./build-lib.ts";
import { compileLumaStyles } from "./luma-styles.ts";

const output = path.join(PACKAGE_ROOT, "node_modules/.cache/frontend-preview");
mkdirSync(output, { recursive: true });
function styles() {
  writeFileSync(
    path.join(output, "style.css"),
    compileLumaStyles(path.join(PACKAGE_ROOT, "src/frontend/theme.css")),
  );
}
writeFileSync(
  path.join(output, "index.html"),
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>记忆工作台 · 前端预览</title><style>body{margin:0;background:#d4d4d8}button,input,select,textarea{font-family:serif;font-size:24px;background:pink;color:purple;border-radius:0}#host-control{position:fixed;left:8px;top:8px}</style><link rel="stylesheet" href="/style.css"><button id="host-control">Host</button><div id="root"></div><script type="module" src="/app.js"></script></html>`,
);
const build = await context({
  ...createEsbuildOptions(output, true),
  entryPoints: { app: path.join(PACKAGE_ROOT, "docs/ui/frontend-preview.tsx") },
  target: "es2022",
  plugins: [
    {
      name: "frontend-styles",
      setup(builder) {
        builder.onEnd((result) => {
          if (result.errors.length === 0) styles();
        });
      },
    },
  ],
});
await build.watch();
const server = await build.serve({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 18825),
  servedir: output,
});
const watchers = ["src/frontend/theme.css", "src/frontend/primitives/theme.css"].map((file) =>
  watch(path.join(PACKAGE_ROOT, file), styles),
);
console.log(`记忆工作台预览：http://127.0.0.1:${server.port}/ （?dark 暗色）`);
process.on("SIGINT", () => {
  for (const watcher of watchers) watcher.close();
  void build.dispose().then(() => process.exit(0));
});
