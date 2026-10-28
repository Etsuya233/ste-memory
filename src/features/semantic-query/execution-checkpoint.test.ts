import { afterEach, expect, it, vi } from "vitest";
import { createExecutionCheckpoint } from "./execution-checkpoint.ts";

afterEach(() => vi.useRealTimers());

it("yields a real task initially and after each CPU slice without paying per cheap batch", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  const checkpoint = createExecutionCheckpoint(() => {});
  let settled = false;
  const initial = checkpoint().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.runOnlyPendingTimersAsync();
  await initial;
  expect(settled).toBe(true);
  for (let i = 0; i < 100; i++) await checkpoint();
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(8);
  settled = false;
  const exhausted = checkpoint().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.runOnlyPendingTimersAsync();
  await exhausted;
  expect(settled).toBe(true);
});

it("observes cancellation before resuming after the macrotask", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
  const controller = new AbortController();
  const checkpoint = createExecutionCheckpoint(() => controller.signal.throwIfAborted());
  const pending = checkpoint();
  const rejected = expect(pending).rejects.toThrow();
  controller.abort();
  await vi.runOnlyPendingTimersAsync();
  await rejected;
});
