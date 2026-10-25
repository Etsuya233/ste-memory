import type { ComponentProps } from "react";
import { Disclosure as UiDisclosure } from "../kit/disclosure.tsx";

/** Host icon adapter; the kit accepts arbitrary icon content. */
export function Disclosure({
  icon,
  ...props
}: Omit<ComponentProps<typeof UiDisclosure>, "leading"> & { readonly icon: string }) {
  return <UiDisclosure {...props} leading={<i className={`fa-solid ${icon}`} />} />;
}
