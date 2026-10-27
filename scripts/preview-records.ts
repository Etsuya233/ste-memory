/** Serve the real RecordsTab against a deterministic in-memory fixture. Run build first. */
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "node_modules/.cache/records-preview");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "docs/ui/records-preview.tsx")],
  outfile: path.join(output, "app.js"),
  bundle: true,
  jsx: "automatic",
  format: "esm",
  define: { "process.env.NODE_ENV": '"development"' },
});
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Records acceptance fixture</title><style>
/* Deliberate host defaults: isolated UI must not inherit these controls. */
button,input,select,textarea{font-family:serif;font-size:24px;background:pink;color:purple;border-radius:0} body{margin:0;background:#e4e4e7} #host-control{position:absolute;left:8px;top:8px} #stm-panel.preview-panel{position:relative!important;inset:auto!important;transform:none!important;margin:32px auto!important;width:min(920px,calc(100vw - 32px))!important;height:calc(100dvh - 64px)!important;max-height:none!important;display:flex!important;visibility:visible!important;opacity:1!important} @media(max-width:600px){#stm-panel.preview-panel{margin:0!important;width:100vw!important;height:100dvh!important}} </style><link rel="stylesheet" href="/style.css"><button id="host-control">Host</button><div id="root"></div><script type="module" src="/app.js"></script></html>`,
);
createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const asset =
    pathname === "/"
      ? [path.join(output, "index.html"), "text/html"]
      : pathname === "/app.js"
        ? [path.join(output, "app.js"), "text/javascript"]
        : pathname === "/style.css"
          ? [path.join(root, "dist/style.css"), "text/css"]
          : null;
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.setHeader("Content-Type", `${asset[1]}; charset=utf-8`);
    response.end(await readFile(asset[0]!));
  } catch {
    response.writeHead(500).end("Run pnpm build before previewing records.");
  }
}).listen(Number(process.env.PORT ?? 8802), "127.0.0.1", () =>
  console.log("Records preview: http://127.0.0.1:8802/"),
);
