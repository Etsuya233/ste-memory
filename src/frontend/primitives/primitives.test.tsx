import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";
import { NativeSelect, NativeSelectOption } from "./native-select.tsx";
import { lumaPreset } from "./preset.ts";
import { PrimitivesProvider, canRestoreSurfaceFocus } from "./provider.tsx";
import {
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuSubContent,
} from "./dropdown-menu.tsx";
import { TooltipContent } from "./tooltip.tsx";
import { cn } from "./utils.ts";

const directory = fileURLToPath(new URL(".", import.meta.url));

describe("portable Luma primitives", () => {
  it("retains the exact requested preset", () => {
    expect(lumaPreset).toEqual({
      code: "beEgoEQi",
      version: "b",
      base: "base",
      style: "luma",
      baseColor: "zinc",
      theme: "zinc",
      chartColor: "zinc",
      iconLibrary: "lucide",
      font: "inter",
      fontHeading: "inherit",
      radius: "default",
      menuAccent: "subtle",
      menuColor: "default",
    });
  });

  it("merges prefixed utilities without dropping consumer classes", () => {
    expect(cn("ste:h-9 ste:px-3", "ste:h-10", false, "consumer")).toBe(
      "ste:px-3 ste:h-10 consumer",
    );
    expect(cn("ste:hover:bg-muted", "ste:hover:bg-primary")).toBe("ste:hover:bg-primary");
  });

  it("renders native field semantics and accessible button props", () => {
    const html = renderToStaticMarkup(
      <>
        <Button aria-label="保存记录" disabled variant="outline">
          保存
        </Button>
        <Input name="record-name" required defaultValue="名称" />
        <Textarea name="note" defaultValue="备注" />
      </>,
    );
    expect(html).toContain('aria-label="保存记录"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('name="record-name"');
    expect(html).toContain('required=""');
    expect(html).toContain('name="note"');
    expect(html).toContain("备注</textarea>");
    expect(html).toContain("ste:rounded-4xl");
  });

  it("supports native multi-select size without the single-select arrow", () => {
    const html = renderToStaticMarkup(
      <NativeSelect
        multiple
        htmlSize={5}
        name="links"
        defaultValue={["one"]}
        selectClassName="field-override"
      >
        <NativeSelectOption value="one">One</NativeSelectOption>
      </NativeSelect>,
    );
    expect(html).toContain('multiple=""');
    expect(html).toContain('size="5"');
    expect(html).toContain('selected=""');
    expect(html).toContain("field-override");
    expect(html).not.toContain('data-slot="native-select-icon"');
  });

  it("keeps implementation imports independent of business and host code", () => {
    const allowed =
      /^(?:react(?:\/.*)?|@base-ui\/react\/.*|lucide-react|class-variance-authority|clsx|tailwind-merge|\.\/[^/]+\.(?:ts|tsx))$/;
    for (const name of readdirSync(directory).filter(
      (name) => /\.tsx?$/.test(name) && !name.includes(".test."),
    )) {
      const source = readFileSync(`${directory}/${name}`, "utf8");
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g))
        expect(match[1], name).toMatch(allowed);
      expect(source, name).not.toMatch(/SillyTavern|extension_settings|chat_metadata|getContext\(/);
    }
  });

  it("omits global preflight and scopes baseline and semantic tokens", () => {
    const css = readFileSync(`${directory}/theme.css`, "utf8");
    expect(css).not.toMatch(/@import\s+["']tailwindcss["']|preflight\.css|:root\s*\{|\nbody\s*\{/);
    expect(css).toContain("prefix(ste) important");
    expect(css).toContain('.stm-luma[data-tone="dark"]');
    expect(css).toMatch(/\.stm-luma\s*\{\s*--background:/);
    expect(css).toContain("Inter Variable");
  });
});

describe("overlay surface isolation", () => {
  it("never falls back to body before its caller-owned container is available", () => {
    expect(
      renderToStaticMarkup(
        <PrimitivesProvider container={null}>
          <DropdownMenuPortal>
            <span>menu</span>
          </DropdownMenuPortal>
          <DropdownMenuContent>content</DropdownMenuContent>
          <DropdownMenuSubContent>nested</DropdownMenuSubContent>
          <TooltipContent>hint</TooltipContent>
        </PrimitivesProvider>,
      ),
    ).toBe("");
  });

  it("does not restore focus into a hidden, disconnected or closed surface", () => {
    const surface = (
      overrides: {
        isConnected?: boolean;
        hidden?: boolean;
        getAttribute?: () => string | null;
        hasAttribute?: () => boolean;
        matches?: () => boolean;
      } = {},
    ) =>
      ({
        isConnected: true,
        hidden: false,
        getAttribute: () => null,
        hasAttribute: () => false,
        matches: () => false,
        ...overrides,
      }) as unknown as HTMLElement;
    expect(canRestoreSurfaceFocus(null)).toBe(false);
    expect(canRestoreSurfaceFocus(surface())).toBe(true);
    expect(canRestoreSurfaceFocus(surface({ isConnected: false }))).toBe(false);
    expect(canRestoreSurfaceFocus(surface({ hidden: true }))).toBe(false);
    expect(canRestoreSurfaceFocus(surface({ getAttribute: () => "true" }))).toBe(false);
    expect(canRestoreSurfaceFocus(surface({ hasAttribute: () => true }))).toBe(false);
    expect(canRestoreSurfaceFocus(surface({ hasAttribute: () => true, matches: () => true }))).toBe(
      true,
    );
  });

  it("closes via the Base UI action on surface dismissal and inherits live theme tokens", () => {
    const provider = readFileSync(`${directory}/provider.tsx`, "utf8");
    expect(provider).toContain('addEventListener("beforetoggle", onToggle)');
    expect(provider).toContain('removeEventListener("beforetoggle", onToggle)');
    expect(provider).toContain("actions.current?.close()");
    for (const name of ["dropdown-menu.tsx", "tooltip.tsx"]) {
      const source = readFileSync(`${directory}/${name}`, "utf8");
      expect(source).toContain("useDismissWithSurface(actions)");
      expect(source).not.toContain("document.body");
      // Portals inherit the surface rather than copying a stale tone/token snapshot.
      expect(source).not.toMatch(/getComputedStyle|data-tone=/);
    }
  });
});
