import { describe, expect, it } from "vitest";
import type { PromptInput, TabCluster } from "./plan";
import { PreviewRunController, isTransientBatchError, splitBatchForRetry } from "./openrouter";

describe("openrouter adaptive recovery helpers", () => {
  it("classifies empty responses and timeouts as transient", () => {
    expect(isTransientBatchError(new Error("OpenRouter returned an empty response."))).toBe(true);
    expect(isTransientBatchError(new Error("OpenRouter batch timed out after 25 seconds."))).toBe(true);
    expect(isTransientBatchError(new Error("Category references an unknown tab."))).toBe(false);
  });

  it("splits retry batches into smaller sub-batches", () => {
    const cluster: TabCluster = {
      clusterId: "example",
      domains: ["example.com"],
      keywords: ["docs"],
      tabs: Array.from({ length: 45 }, (_, index) => ({
        tabId: index + 1,
        title: `Doc ${index + 1}`,
        domain: "example.com"
      }))
    };
    const promptInput: PromptInput = {
      mutableTabs: [],
      preferredCategories: [],
      protectedGroups: []
    };
    const batch = {
      batchId: "batch-1",
      clusters: [cluster],
      tabs: cluster.tabs,
      estimatedPromptChars: 0
    };

    const split = splitBatchForRetry(batch, promptInput, 20);

    expect(split.length).toBe(3);
    expect(split.every((candidate) => candidate.tabs.length <= 20)).toBe(true);
  });

  it("cancels in-flight work after terminal failure", () => {
    const controller = new PreviewRunController("run-123");
    const first = new AbortController();
    const second = new AbortController();

    expect(controller.register(first)).toBe(true);
    expect(controller.register(second)).toBe(true);

    controller.fail(new Error("batch 14/40 failed after 4 adaptive attempts"));

    expect(controller.cancelled).toBe(true);
    expect(controller.state).toBe("failed");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });
});
