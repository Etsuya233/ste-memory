import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

/** Compile the portable component stylesheet without a global Tailwind preflight.
 * Keep compilation inside the shared build path so build, watch and sync cannot
 * accidentally publish raw @theme/@utility directives. No runtime CDN is used.
 */
export function compileLumaStyles(
  input = path.join(root, "src/frontend/primitives/theme.css"),
): string {
  const cli = path.join(
    path.dirname(require.resolve("@tailwindcss/cli/package.json")),
    "dist/index.mjs",
  );
  const font = readFileSync(
    require.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"),
  ).toString("base64");
  const fontFace = `@font-face{font-family:"Inter Variable";font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${font}) format("woff2")}\n`;
  const css = execFileSync(process.execPath, [cli, "--input", input, "--minify"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const notices = ["LICENSE.md", "LICENSE.Inter.txt"]
    .map(
      (name) =>
        `/*! ${readFileSync(path.join(root, "src/frontend/primitives", name), "utf8").replaceAll("*/", "* /")} */\n`,
    )
    .join("");
  return notices + fontFace + isolateLumaStyles(css);
}

/** Tailwind's utility prefix does not namespace its internal variables/keyframes.
 * Scope the generated fallback initializer too, so another embedded Tailwind UI
 * and the host's elements cannot acquire our baseline or animation definitions.
 */
export function isolateLumaStyles(css: string): string {
  let isolated = css
    .replaceAll("--tw-", "--ste-tw-")
    .replaceAll(":root,:host{", ".stm-luma{")
    .replaceAll(
      "*,:before,:after,::backdrop{",
      ".stm-luma,.stm-luma *,.stm-luma :before,.stm-luma :after,.stm-luma::backdrop{",
    );
  const names = new Set(
    [...isolated.matchAll(/@keyframes ([a-zA-Z][\w-]*)/g)].map((match) => match[1]!),
  );
  for (const name of names) {
    isolated = isolated.replace(new RegExp(`(?<![\\w-])${name}(?![\\w-])`, "g"), `ste-${name}`);
  }
  return isolated;
}
