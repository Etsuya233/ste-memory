import { describe, expect, it, vi } from "vitest";
import type { VectorEmbeddingPort } from "../vector-index/index.ts";
import { QueryVectorCache } from "./query-vector-cache.ts";

function setup(options: ConstructorParameters<typeof QueryVectorCache>[0] = {}) {
  const cache = new QueryVectorCache(options);
  let connection = { model: "model", apiKey: "first" };
  const embedding: VectorEmbeddingPort = {
    getProfile: () => ({ model: "model", version: "v1", dimensions: 2, maxInputChars: 4000 }),
    embed: vi.fn(async () => [1, 0]),
  };
  const execution = (signal = new AbortController().signal) => {
    const revision = cache.revisionFor(connection);
    return cache.createExecution({
      embedding,
      revision,
      signal,
      isCurrent: () => cache.revisionFor(connection) === revision,
    });
  };
  return {
    embedding,
    execution,
    changeConnection: () => {
      connection = { model: "model", apiKey: "second" };
    },
  };
}

describe("query vector cache", () => {
  it("shares one request within a batch, then reuses a successful vector across executions", async () => {
    const h = setup();
    const first = h.execution();
    const [a, b] = await Promise.all([first.get(" input "), first.get("input")]);
    expect(a.calls).toBe(1);
    expect(b.executionHits).toBe(1);
    first.close();
    const second = h.execution();
    expect((await second.get("input")).sharedHits).toBe(1);
    expect(h.embedding.embed).toHaveBeenCalledExactlyOnceWith("input", expect.any(AbortSignal));
    second.close();
  });

  it("expires by absolute TTL even after cache hits and evicts the least recently used entry", async () => {
    let now = 0;
    const h = setup({ now: () => now, ttlMs: 100, maxEntries: 2 });
    const run = async (text: string) => {
      const current = h.execution();
      const result = await current.get(text);
      current.close();
      return result;
    };
    await run("a");
    await run("b");
    now = 50;
    expect((await run("a")).sharedHits).toBe(1);
    await run("c");
    expect((await run("b")).calls).toBe(1);
    now = 101;
    expect((await run("a")).calls).toBe(1);
  });

  it("does not store an entry that exceeds the payload budget", async () => {
    const h = setup({ maxBytes: 1 });
    const first = h.execution();
    await first.get("a");
    expect((await first.get("a")).executionHits).toBe(1);
    first.close();
    const second = h.execution();
    expect((await second.get("a")).calls).toBe(1);
    second.close();
  });

  it("invalidates successful vectors on credential changes without changing the index profile", async () => {
    const h = setup();
    const first = h.execution();
    await first.get("same");
    first.close();
    h.changeConnection();
    const second = h.execution();
    expect((await second.get("same")).calls).toBe(1);
    expect(h.embedding.getProfile()?.version).toBe("v1");
    second.close();
  });

  it("does not coalesce pending requests across independent execution contexts", async () => {
    const h = setup();
    const first = h.execution();
    const second = h.execution();
    await Promise.all([first.get("same"), second.get("same")]);
    expect(h.embedding.embed).toHaveBeenCalledTimes(2);
    first.close();
    second.close();
  });

  it("releases ignored cancellation and never caches the late result or deletes a newer request", async () => {
    const h = setup();
    let finish!: (values: number[]) => void;
    vi.mocked(h.embedding.embed).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const first = h.execution(controller.signal);
    const pending = first.get("same");
    await vi.waitFor(() => expect(h.embedding.embed).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const next = h.execution();
    expect((await next.get("same")).calls).toBe(1);
    finish([0, 1]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.close();
    next.close();
    const final = h.execution();
    expect((await final.get("same")).values).toEqual([1, 0]);
    final.close();
  });

  it("does not publish a response from an obsolete request configuration", async () => {
    const h = setup();
    let finish!: (values: number[]) => void;
    vi.mocked(h.embedding.embed).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.execution();
    const pending = first.get("same");
    await vi.waitFor(() => expect(h.embedding.embed).toHaveBeenCalledOnce());
    h.changeConnection();
    finish([1, 0]);
    await pending;
    first.close();
    const next = h.execution();
    expect((await next.get("same")).calls).toBe(1);
    next.close();
  });

  it("does not cache failed or malformed responses", async () => {
    const h = setup();
    const current = h.execution();
    vi.mocked(h.embedding.embed).mockRejectedValueOnce(new Error("provider failed"));
    await expect(current.get("same")).rejects.toThrow("provider failed");
    vi.mocked(h.embedding.embed).mockResolvedValueOnce([0, 0]);
    await expect(current.get("same")).rejects.toThrow("维度或数值");
    vi.mocked(h.embedding.embed).mockResolvedValueOnce([1]);
    await expect(current.get("same")).rejects.toThrow("维度或数值");
    expect((await current.get("same")).calls).toBe(1);
    expect(h.embedding.embed).toHaveBeenCalledTimes(4);
    current.close();
  });
});
