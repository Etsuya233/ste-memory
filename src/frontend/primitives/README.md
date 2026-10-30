# Portable UI primitives

This directory is a host-independent shadcn/ui **Base UI / Luma** layer. It must not import SillyTavern globals, extension state, schemas, or record services. Business composition belongs to `../components` and `../pages`.

## Provenance

Official CLI `shadcn preset decode beEgoEQi --json` resolves to:

- style: `luma`; base/theme/chart color: `zinc`
- icons: `lucide`; font: `inter`; heading font: `inherit`
- radius: `default`; menu accent: `subtle`; menu color: `default`

Components were obtained from `https://ui.shadcn.com/r/styles/base-luma/{component}.json`, and tokens from `https://ui.shadcn.com/r/colors/zinc.json`. The checked-in components retain the official geometry and Base UI behavior. Adaptations: `ste:` utility prefix, relative imports, Lucide placeholder resolution, local class merger, and caller-owned portal container.

## Embedding contract

Wrap the consumer in `.stm-luma` with `data-tone="light"` or `data-tone="dark"`. Supply the same DOM surface to `PrimitivesProvider` as `container`, and pass `active={false}` while that surface is hidden or its consumer is inactive. This is essential when the consumer is inside a native top-layer popover: overlays must remain inside that top-layer surface rather than portal to `document.body`. Menus and tooltips use this container and inherit its live theme. They render no portal until the container exists, never fall back to `document.body`, and close via Base UI actions when inactive or when the surface receives a closing native `beforetoggle` event. Menu focus returns normally unless the surface is hidden/disconnected; in that case the host owns restoring focus to its launcher.

`theme.css` omits global Tailwind preflight. Its minimal baseline only affects `.stm-luma`; utility classes and generated theme tokens are prefixed. Font bytes are bundled by the build, with no runtime font/CDN request. `cn` uses `tailwind-merge` configured for the `ste` prefix.

Composition uses Base UI `render`, **not Radix `asChild`**. `NativeSelect` adds `htmlSize` (native numeric `size`) and `selectClassName`, while keeping shadcn's `size="sm" | "default"` and wrapper `className`. Multiple selects omit the decorative arrow. `PaginationLink` renders a native button for this app's client-side paging, and `PaginationContent` restores the list resets that the official preflight would otherwise provide.

Do not overwrite these adaptations by blindly re-running `shadcn add --overwrite`. Fetch and review upstream diffs, preserve the prefix and portal contract, and rerun type/build/interaction checks.

The shared compiler additionally namespaces Tailwind's internal variables and animation names, and scopes its generated property fallback and default theme root. This avoids modifying another embedded Tailwind application's internal state. The bundled CSS retains both shadcn's MIT and Inter's OFL notices.
