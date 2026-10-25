import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormField, Input, Switch } from "./controls.tsx";
import { ListGroup, ListRow, NavigationRow } from "./list.tsx";
import { Theme } from "./theme.tsx";

describe("portable UI kit", () => {
  it("production sources depend only on React and kit-local modules", () => {
    const directory = fileURLToPath(new URL("./", import.meta.url));
    for (const name of readdirSync(directory).filter(
      (name) => /\.tsx?$/.test(name) && !name.endsWith(".test.tsx"),
    )) {
      const source = readFileSync(`${directory}/${name}`, "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]!);
      expect(
        imports.filter((specifier) => specifier !== "react" && !specifier.startsWith("./")),
        name,
      ).toEqual([]);
      expect(source, name).not.toMatch(/SillyTavern|localStorage|FontAwesome|fa-solid/);
    }
    for (const name of ["theme.css", "components.css"]) {
      expect(readFileSync(`${directory}/${name}`, "utf8"), name).not.toMatch(
        /stm-panel|--stm-|\.stm-/,
      );
    }
  });

  it("one theme root supplies appearance while rows keep native interaction semantics", () => {
    const html = renderToStaticMarkup(
      <Theme
        theme={{
          appearance: "glass",
          tone: "light",
          background: "#f2f2f7",
          accent: "#2563eb",
          accentForeground: "#fff",
        }}
      >
        <ListGroup as="ul">
          <li>
            <NavigationRow title="连接" description="独立连接" onClick={() => undefined} />
          </li>
          <li>
            <ListRow
              title="自动更新"
              trailing={<Switch label="自动更新" defaultChecked disabled />}
            />
          </li>
        </ListGroup>
      </Theme>,
    );
    expect(html.match(/data-style=/g)).toHaveLength(1);
    expect(html).toContain('data-style="glass"');
    expect(html).toContain("--ui-bg:#f2f2f7");
    expect(html).toContain("<ul");
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*type="checkbox"/);
    for (const button of html.match(/<button\b[\s\S]*?<\/button>/g)!)
      expect(button).not.toContain("<input");
  });

  it("field label and error description reference the actual input", () => {
    const html = renderToStaticMarkup(
      <FormField label="连接名称" hint="自定义名称" error="名称不能为空">
        {(attributes) => <Input {...attributes} required />}
      </FormField>,
    );
    const id = /<label for="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(`aria-describedby="${id}-description"`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(`id="${id}-description"`);
    expect(html).toContain("名称不能为空");
    expect(html).not.toContain("自定义名称");
  });
});
