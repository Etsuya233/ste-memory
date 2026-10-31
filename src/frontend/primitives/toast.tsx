// Adapted from the official shadcn base-luma Toast registry.
import * as React from "react";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { cn } from "./utils.ts";

import { Button } from "./button.tsx";
import {
  XIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

const toast = ToastPrimitive.createToastManager();

function ToastProvider({ ...props }: ToastPrimitive.Provider.Props) {
  return <ToastPrimitive.Provider {...props} />;
}

function ToastPortal({ ...props }: ToastPrimitive.Portal.Props & { container: HTMLElement }) {
  return <ToastPrimitive.Portal data-slot="toast-portal" {...props} />;
}

function ToastViewport({ className, ...props }: ToastPrimitive.Viewport.Props) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "ste:pointer-events-none ste:fixed ste:inset-x-4 ste:bottom-4 ste:z-50 ste:mx-auto ste:w-auto ste:max-w-sm ste:outline-none ste:sm:right-4 ste:sm:left-auto ste:sm:mx-0 ste:sm:w-full",
        className,
      )}
      {...props}
    />
  );
}

function Toast({ className, ...props }: ToastPrimitive.Root.Props) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(
        "ste:group/toast ste:pointer-events-auto ste:absolute ste:right-0 ste:bottom-0 ste:z-[calc(1000-var(--toast-index))] ste:w-full ste:origin-bottom ste:rounded-2xl ste:border ste:bg-popover ste:text-popover-foreground ste:shadow-lg ste:will-change-transform ste:outline-none ste:select-none ste:focus-visible:border-ring ste:focus-visible:ring-[3px] ste:focus-visible:ring-ring/50",
        "ste:[--gap:0.75rem] ste:[--height:var(--toast-frontmost-height,var(--toast-height))] ste:[--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] ste:[--peek:0.75rem] ste:[--scale:calc(max(0,1-(var(--toast-index)*0.1)))] ste:[--shrink:calc(1-var(--scale))]",
        "ste:h-(--height) ste:[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] ste:[transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms]",
        "ste:after:absolute ste:after:top-full ste:after:left-0 ste:after:h-[calc(var(--gap)+1px)] ste:after:w-full ste:after:content-[]",
        "ste:data-expanded:h-(--toast-height) ste:data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
        "ste:data-limited:opacity-0 ste:data-starting-style:[transform:translateY(150%)]",
        "ste:[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]",
        "ste:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "ste:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "ste:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "ste:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        "ste:data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
        "ste:data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
        "ste:data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
        "ste:data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        className,
      )}
      {...props}
    />
  );
}

function ToastContent({ className, ...props }: ToastPrimitive.Content.Props) {
  return (
    <ToastPrimitive.Content
      data-slot="toast-content"
      className={cn(
        "ste:flex ste:h-full ste:items-center ste:gap-3 ste:overflow-hidden ste:p-4 ste:transition-opacity ste:duration-250 ste:ease-[cubic-bezier(0.22,1,0.36,1)] ste:data-behind:opacity-0 ste:data-expanded:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function ToastTitle({ className, ...props }: ToastPrimitive.Title.Props) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("ste:text-sm ste:font-medium", className)}
      {...props}
    />
  );
}

function ToastDescription({ className, ...props }: ToastPrimitive.Description.Props) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("ste:text-sm ste:text-muted-foreground", className)}
      {...props}
    />
  );
}

function ToastAction({
  className,
  render = <Button variant="outline" size="sm" />,
  ...props
}: ToastPrimitive.Action.Props) {
  return (
    <ToastPrimitive.Action
      data-slot="toast-action"
      render={render}
      className={cn("ste:min-h-11 ste:shrink-0", className)}
      {...props}
    />
  );
}

function ToastClose({
  className,
  children,
  render = <Button variant="ghost" size="icon-sm" />,
  ...props
}: ToastPrimitive.Close.Props) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      aria-label="关闭通知"
      render={render}
      className={cn(
        "ste:relative ste:shrink-0 ste:after:absolute ste:after:-inset-1.5 ste:after:content-[]",
        className,
      )}
      {...props}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </ToastPrimitive.Close>
  );
}

function ToastIcon({ type }: { type: string | undefined }) {
  let icon: React.ReactNode = null;

  if (type === "success") {
    icon = <CircleCheckIcon aria-hidden="true" />;
  }

  if (type === "info") {
    icon = <InfoIcon aria-hidden="true" />;
  }

  if (type === "warning") {
    icon = <TriangleAlertIcon aria-hidden="true" />;
  }

  if (type === "error") {
    icon = <OctagonXIcon className="ste:text-destructive" aria-hidden="true" />;
  }

  if (type === "loading") {
    icon = <Loader2Icon className="ste:animate-spin" aria-hidden="true" />;
  }

  if (!icon) {
    return null;
  }

  return (
    <span
      data-slot="toast-icon"
      className="ste:shrink-0 ste:[&_svg]:pointer-events-none ste:[&_svg:not([class*=size-])]:size-4"
    >
      {icon}
    </span>
  );
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();

  return toasts.map((toastItem) => (
    <Toast key={toastItem.id} toast={toastItem}>
      <ToastContent className="ste:items-start">
        <ToastIcon type={toastItem.type} />
        <div className="ste:flex ste:min-w-0 ste:flex-1 ste:flex-col ste:gap-2">
          <div className="ste:flex ste:min-w-0 ste:flex-col ste:gap-1 ste:wrap-anywhere">
            <ToastTitle />
            <ToastDescription />
          </div>
          {toastItem.actionProps && <ToastAction className="ste:self-start" />}
        </div>
        <ToastClose />
      </ToastContent>
    </Toast>
  ));
}

function Toaster({
  children,
  toastManager = toast,
  container,
  ...props
}: ToastPrimitive.Provider.Props & { container: HTMLElement | null }) {
  return (
    <ToastProvider toastManager={toastManager} {...props}>
      {children}
      {container && (
        <ToastPortal container={container}>
          <ToastViewport aria-label="记忆工作台通知">
            <ToastList />
          </ToastViewport>
        </ToastPortal>
      )}
    </ToastProvider>
  );
}

const createToastManager = ToastPrimitive.createToastManager;
const useToastManager = ToastPrimitive.useToastManager;

export {
  Toaster,
  Toast,
  ToastAction,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  createToastManager,
  toast,
  useToastManager,
};
