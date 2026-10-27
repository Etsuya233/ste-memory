import { describe, expect, it } from "vitest";
import { isolateLumaStyles } from "./luma-styles.ts";

describe("embedded Tailwind output isolation", () => {
  it("isolates generated defaults, internal variables and keyframe identifiers", () => {
    const css = isolateLumaStyles(
      "@layer properties{*,:before,:after,::backdrop{--tw-border-style:solid}}" +
        "@layer theme{:root,:host{--ste-animate-spin:spin 1s linear infinite}}" +
        ".ste\\:animate-spin{animation:var(--ste-animate-spin);border-style:var(--tw-border-style)}" +
        ".ste\\:animate-in{animation:enter .15s}@keyframes spin{to{transform:rotate(360deg)}}@keyframes enter{from{opacity:0}}",
    );
    expect(css).not.toContain(":root");
    expect(css).not.toContain("--tw-");
    expect(css).not.toContain("{*,:before");
    expect(css).toContain(".stm-luma,.stm-luma *");
    expect(css).toContain("--ste-tw-border-style:solid");
    expect(css).toContain(".ste\\:animate-spin");
    expect(css).toContain("--ste-animate-spin:ste-spin 1s");
    expect(css).toContain("animation:ste-enter .15s");
    expect(css).toContain("@keyframes ste-spin");
  });
});
