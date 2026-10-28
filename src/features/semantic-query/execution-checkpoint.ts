/** Check every batch, but spend a macrotask only after a CPU time slice.
 * Timer latency counts against the caller's deadline and must not be paid once
 * per fixed number of cheap records (especially with coarse browser timers).
 */
export function createExecutionCheckpoint(check: () => void): () => Promise<void> {
  let resumedAt = -Infinity;
  return async () => {
    check();
    if (performance.now() - resumedAt < 8) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    resumedAt = performance.now();
    check();
  };
}
