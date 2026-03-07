import type { ExtensionSettings, OrganizationPlan } from "../shared/types";
import type { ProgressUpdate } from "../shared/messages";
import {
  buildOpenRouterPrompt,
  buildProvisionalCategories,
  buildRefinementPrompt,
  clusterTabs,
  createBatchPlan,
  getPlanSchema,
  getRefinementSchema,
  materializeRefinedPlan,
  sanitizeOrganizationPlan,
  tryRepairIndexBasedPlan,
  validateOrganizationPlan,
  validateRefinedCategoryPlan
} from "./plan";
import type {
  BatchPlan,
  BatchPreviewResult,
  PromptInput,
  TabCluster
} from "./plan";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const INITIAL_BATCH_TIMEOUT_MS = 25_000;
const REFINEMENT_TIMEOUT_MS = 15_000;
const MAX_PROVISIONAL_FOR_REFINEMENT = 100;
const REFINEMENT_TIMEOUT_MAX_MS = 90_000;
const REFINEMENT_TIMEOUT_PER_CATEGORY_MS = 200;
const INITIAL_BATCH_CONCURRENCY = 4;
const MAX_BATCH_CHAIN_ATTEMPTS = 4;
const MAX_SPLIT_DEPTH = 2;
const MIN_RETRY_BATCH_SIZE = 18;

type ProgressReporter = (
  update: Omit<ProgressUpdate, "phase" | "timestamp">
) => void | Promise<void>;

interface OpenRouterMessage {
  role: "system" | "user";
  content: string;
}

interface OpenRouterChoicePayload {
  finish_reason?: unknown;
  native_finish_reason?: unknown;
  text?: unknown;
  message?: unknown;
}

interface OpenRouterResponsePayload {
  id?: unknown;
  model?: unknown;
  provider?: unknown;
  error?: {
    message?: unknown;
  };
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  choices?: OpenRouterChoicePayload[];
}

export interface ExecutionProfile {
  concurrency: number;
  timeoutMs: number;
  targetBatchSize: number;
}

export interface AdaptiveBatchTask {
  taskId: string;
  batch: BatchPlan;
  currentBatch: number;
  totalBatches: number;
  attempt: number;
  maxAttempts: number;
  splitDepth: number;
  degradedConcurrencyApplied: boolean;
  timeoutMs: number;
}

type BatchTaskOutcome =
  | { kind: "success"; task: AdaptiveBatchTask; result: BatchPreviewResult }
  | { kind: "failure"; task: AdaptiveBatchTask; error: Error }
  | { kind: "cancelled"; task: AdaptiveBatchTask };

export class PreviewRunController {
  readonly runId: string;
  readonly profile: ExecutionProfile;
  activeBatchCount = 0;
  completedBatchCount = 0;
  failedBatchCount = 0;
  cancelled = false;
  state: NonNullable<ProgressUpdate["state"]> = "running";
  failureError: Error | null = null;
  private readonly abortControllers = new Set<AbortController>();

  constructor(runId: string, profile?: Partial<ExecutionProfile>) {
    this.runId = runId;
    this.profile = {
      concurrency: profile?.concurrency ?? INITIAL_BATCH_CONCURRENCY,
      timeoutMs: profile?.timeoutMs ?? INITIAL_BATCH_TIMEOUT_MS,
      targetBatchSize: profile?.targetBatchSize ?? 140
    };
  }

  register(controller: AbortController) {
    if (this.cancelled) {
      controller.abort();
      return false;
    }

    this.abortControllers.add(controller);
    this.activeBatchCount += 1;
    return true;
  }

  unregister(controller: AbortController) {
    this.abortControllers.delete(controller);
    this.activeBatchCount = Math.max(0, this.activeBatchCount - 1);
  }

  markState(state: NonNullable<ProgressUpdate["state"]>) {
    this.state = state;
  }

  fail(error: Error) {
    if (this.failureError) {
      return;
    }

    this.failureError = error;
    this.cancelled = true;
    this.state = "failed";

    for (const controller of this.abortControllers) {
      controller.abort();
    }
  }

  cancel() {
    this.cancelled = true;
    this.state = "cancelled";

    for (const controller of this.abortControllers) {
      controller.abort();
    }
  }
}

function extractMessageContent(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const record = message as Record<string, unknown>;
  const content = record.content;
  const reasoning = record.reasoning;

  if (typeof content === "string") {
    if (content.trim()) return content;
  } else if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
          if (typeof p.output === "string") return p.output;
          if (typeof p.output_text === "string") return p.output_text;
        }
        return "";
      })
      .join("");
    if (joined.trim()) return joined;
  } else if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string" && c.text.trim()) return c.text;
    if (typeof c.parts === "string" && c.parts.trim()) return c.parts;
  }

  if (record.parsed && typeof record.parsed === "object") {
    return JSON.stringify(record.parsed);
  }

  const toolCallArguments = record.tool_calls
    ?.map((toolCall) => {
      const args = (toolCall as { function?: { arguments?: unknown } })?.function?.arguments;
      return typeof args === "string" ? args : "";
    })
    .filter(Boolean)
    .join("\n");
  if (toolCallArguments) return toolCallArguments;

  if (typeof reasoning === "string" && reasoning.trim()) return reasoning.trim();
  if (Array.isArray(reasoning)) {
    const joined = reasoning
      .map((part) => (typeof part === "string" ? part : ""))
      .join("");
    if (joined.trim()) return joined;
  } else if (reasoning && typeof reasoning === "object") {
    const r = reasoning as Record<string, unknown>;
    if (typeof r.content === "string" && r.content.trim()) return r.content;
    if (typeof r.text === "string" && r.text.trim()) return r.text;
  }

  const reasoningDetails = record.reasoning_details;
  if (typeof reasoningDetails === "string" && reasoningDetails.trim()) return reasoningDetails.trim();
  if (reasoningDetails && typeof reasoningDetails === "object") {
    const rd = reasoningDetails as Record<string, unknown>;
    if (typeof rd.content === "string" && rd.content.trim()) return rd.content;
    if (typeof rd.text === "string" && rd.text.trim()) return rd.text;
  }

  /* Last resort: collect any string value in the message that looks like JSON. */
  let best = "";
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (typeof v === "string" && v.trim().includes("{") && v.length > best.length) best = v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        const s = o[k];
        if (typeof s === "string" && s.trim().includes("{") && s.length > best.length) best = s;
      }
    }
  }
  return best;
}

function clipDiagnosticValue(value: string, limit = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function describeResponseMetadata(payload: OpenRouterResponsePayload) {
  const choice = payload.choices?.[0];
  const message =
    choice?.message && typeof choice.message === "object"
      ? (choice.message as {
          content?: unknown;
          refusal?: unknown;
          parsed?: unknown;
          tool_calls?: unknown[];
        })
      : undefined;
  const details = [
    typeof payload.provider === "string" ? `provider=${payload.provider}` : null,
    typeof payload.model === "string" ? `model=${payload.model}` : null,
    typeof choice?.finish_reason === "string"
      ? `finish_reason=${choice.finish_reason}`
      : null,
    typeof choice?.native_finish_reason === "string"
      ? `native_finish_reason=${choice.native_finish_reason}`
      : null,
    typeof payload.usage?.completion_tokens === "number"
      ? `completion_tokens=${payload.usage.completion_tokens}`
      : null,
    typeof payload.usage?.prompt_tokens === "number"
      ? `prompt_tokens=${payload.usage.prompt_tokens}`
      : null,
    message
      ? `message_keys=${Object.keys(message)
          .sort()
          .join(",") || "none"}`
      : null,
    Array.isArray(message?.tool_calls) ? `tool_calls=${message.tool_calls.length}` : null,
    typeof message?.refusal === "string" && message.refusal.trim()
      ? `refusal="${clipDiagnosticValue(message.refusal)}"`
      : null
  ].filter(Boolean);

  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

function extractJsonCandidate(rawContent: string) {
  const fencedMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = rawContent.indexOf("{");
  const lastBrace = rawContent.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return rawContent.slice(firstBrace, lastBrace + 1).trim();
  }

  const firstBracket = rawContent.indexOf("[");
  const lastBracket = rawContent.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return rawContent.slice(firstBracket, lastBracket + 1).trim();
  }

  return rawContent.trim();
}

export function parseStructuredResponsePayload(payload: OpenRouterResponsePayload) {
  const firstChoice = payload.choices?.[0];
  const msg = firstChoice?.message as Record<string, unknown> | undefined;

  function isStructuredPlan(obj: unknown): obj is Record<string, unknown> {
    return (
      obj !== null &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      "categories" in obj
    );
  }

  if (msg && isStructuredPlan(msg.parsed)) {
    return msg.parsed as unknown;
  }
  const pl = payload as Record<string, unknown>;
  if (isStructuredPlan(pl.output)) return pl.output as unknown;
  if (isStructuredPlan(pl.result)) return pl.result as unknown;
  if (isStructuredPlan(pl.parsed)) return pl.parsed as unknown;

  if (msg && typeof msg.content === "object" && msg.content !== null && !Array.isArray(msg.content)) {
    const c = msg.content as Record<string, unknown>;
    if (isStructuredPlan(c)) return c as unknown;
    if (isStructuredPlan(c.output)) return c.output as unknown;
    if (isStructuredPlan(c.result)) return c.result as unknown;
  }

  const choiceText = typeof firstChoice?.text === "string" ? firstChoice.text : "";
  const rawContent = extractMessageContent(firstChoice?.message) || choiceText;

  if (!rawContent) {
    const msg = firstChoice?.message as Record<string, unknown> | undefined;
    const parts: string[] = [];
    if (msg) {
      if (msg.content !== undefined)
        parts.push(`content=${typeof msg.content}${Array.isArray(msg.content) ? `(array ${msg.content.length})` : typeof msg.content === "string" ? `(len=${msg.content.length})` : ""}`);
      if (msg.reasoning !== undefined)
        parts.push(`reasoning=${typeof msg.reasoning}${typeof msg.reasoning === "string" ? `(len=${msg.reasoning.length})` : ""}`);
      if (msg.reasoning_details !== undefined) parts.push(`reasoning_details=${typeof msg.reasoning_details}`);
    } else {
      parts.push("no message");
    }
    const debug = parts.length ? parts.join(" ") : "unknown";
    const providerMessage =
      typeof payload.error?.message === "string" && payload.error.message.trim()
        ? ` Provider message: ${clipDiagnosticValue(payload.error.message)}.`
        : "";
    throw new Error(
      `OpenRouter returned no structured content${describeResponseMetadata(payload)}. [${debug}]${providerMessage}`
    );
  }

  const candidate = extractJsonCandidate(rawContent);

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    throw new Error(
      `OpenRouter returned non-JSON structured content${describeResponseMetadata(payload)}. Response snippet: ${clipDiagnosticValue(candidate)}`
    );
  }
}

function buildProgressUpdate(
  controller: PreviewRunController,
  update: Omit<ProgressUpdate, "phase" | "timestamp">
) {
  return {
    runId: controller.runId,
    state: update.state ?? controller.state,
    ...update
  };
}

async function emitRunProgress(
  reporter: ProgressReporter | undefined,
  controller: PreviewRunController,
  update: Omit<ProgressUpdate, "phase" | "timestamp">
) {
  if (!reporter || controller.cancelled && update.state !== "failed" && update.state !== "cancelled") {
    return;
  }

  await reporter(buildProgressUpdate(controller, update));
}

export async function generatePlanWithOpenRouter(
  settings: ExtensionSettings,
  input: PromptInput,
  runId: string,
  progress?: {
    onClusteringTabs?: ProgressReporter;
    onPlanningBatches?: ProgressReporter;
    onRequestingModel?: ProgressReporter;
    onWaitingForModel?: ProgressReporter;
    onParsingResponse?: ProgressReporter;
    onValidatingPlan?: ProgressReporter;
  }
): Promise<OrganizationPlan> {
  if (!settings.openRouterApiKey) {
    throw new Error("Add an OpenRouter API key before generating a preview.");
  }

  if (!settings.modelId) {
    throw new Error("Add an OpenRouter model ID before generating a preview.");
  }

  if (input.mutableTabs.length === 0) {
    return {
      categories: [],
      unassignedTabIds: [],
      reasoningSummary: "No mutable tabs are available for grouping."
    };
  }

  const controller = new PreviewRunController(runId);

  await emitRunProgress(progress?.onClusteringTabs, controller, {
    message: `Pre-clustering ${input.mutableTabs.length} mutable tabs by domain and title similarity...`,
    tabCount: input.mutableTabs.length,
    state: "running"
  });
  const clusters = clusterTabs(input.mutableTabs);

  await emitRunProgress(progress?.onPlanningBatches, controller, {
    message: `Built ${clusters.length} local clusters. Packing them into LLM batches...`,
    tabCount: input.mutableTabs.length,
    state: "running"
  });

  const batches = createBatchPlan(clusters, input);
  const batchResults = await runBatchesWithAdaptiveRecovery(
    settings,
    input,
    batches,
    controller,
    progress
  );

  if (batches.length === 1) {
    controller.markState("complete");
    return batchResults[0];
  }

  await emitRunProgress(progress?.onValidatingPlan, controller, {
    message: `Refining ${batchResults.length} provisional batch results into one coherent preview...`,
    totalBatches: batches.length,
    tabCount: input.mutableTabs.length,
    state: "running"
  });

  const provisionalCategories = buildProvisionalCategories(batchResults, input.mutableTabs);
  const refinementSubset =
    provisionalCategories.length <= MAX_PROVISIONAL_FOR_REFINEMENT
      ? provisionalCategories
      : [...provisionalCategories]
          .sort((a, b) => b.tabCount - a.tabCount)
          .slice(0, MAX_PROVISIONAL_FOR_REFINEMENT);

  const refinement = await runRefinement(settings, refinementSubset, controller, progress);

  if (provisionalCategories.length > MAX_PROVISIONAL_FOR_REFINEMENT && refinement.categories.length > 0) {
    const subsetIds = new Set(refinementSubset.map((p) => p.provisionalCategoryId));
    const orphanIds = provisionalCategories
      .filter((p) => !subsetIds.has(p.provisionalCategoryId))
      .map((p) => p.provisionalCategoryId);
    refinement.categories[0].provisionalCategoryIds.push(...orphanIds);
  }

  controller.markState("complete");
  return materializeRefinedPlan(
    refinement,
    provisionalCategories,
    input.mutableTabs.map((tab) => tab.tabId),
    batchResults
  );
}

async function runBatchesWithAdaptiveRecovery(
  settings: ExtensionSettings,
  input: PromptInput,
  batches: BatchPlan[],
  controller: PreviewRunController,
  progress?: {
    onRequestingModel?: ProgressReporter;
    onWaitingForModel?: ProgressReporter;
    onParsingResponse?: ProgressReporter;
    onValidatingPlan?: ProgressReporter;
  }
) {
  const queue: AdaptiveBatchTask[] = batches.map((batch, index) => ({
    taskId: `batch-${index + 1}`,
    batch,
    currentBatch: index + 1,
    totalBatches: batches.length,
    attempt: 1,
    maxAttempts: MAX_BATCH_CHAIN_ATTEMPTS,
    splitDepth: 0,
    degradedConcurrencyApplied: false,
      timeoutMs: controller.profile.timeoutMs
    }));
  let activeTaskId = 0;
  const active = new Map<number, Promise<{ id: number; outcome: BatchTaskOutcome }>>();
  const results: BatchPreviewResult[] = [];

  while ((queue.length > 0 || active.size > 0) && !controller.failureError) {
    while (!controller.cancelled && active.size < controller.profile.concurrency && queue.length > 0) {
      const task = queue.shift()!;
      const id = ++activeTaskId;
      const promise = executeAdaptiveBatchTask(settings, input, task, controller, progress).then(
        (outcome) => ({ id, outcome })
      );
      active.set(id, promise);
    }

    if (active.size === 0) {
      break;
    }

    const settled = await Promise.race(active.values());
    active.delete(settled.id);

    if (controller.failureError) {
      break;
    }

    switch (settled.outcome.kind) {
      case "success":
        if (!controller.cancelled) {
          results.push(settled.outcome.result);
        }
        break;

      case "failure": {
        const failedTask = settled.outcome.task;
        const failedError = settled.outcome.error;
        const recoveryTasks = await planBatchRecovery(
          failedTask,
          failedError,
          input,
          controller,
          progress
        );

        if (recoveryTasks.length === 0) {
          controller.fail(
            new Error(
              `batch ${failedTask.currentBatch}/${failedTask.totalBatches} failed after ${failedTask.maxAttempts} adaptive attempts: ${failedError.message}`
            )
          );
          await emitRunProgress(progress?.onParsingResponse, controller, {
            message: `batch ${failedTask.currentBatch}/${failedTask.totalBatches} failed after ${failedTask.maxAttempts} adaptive attempts: ${failedError.message}`,
            currentBatch: failedTask.currentBatch,
            totalBatches: failedTask.totalBatches,
            tabCount: failedTask.batch.tabs.length,
            attempt: failedTask.attempt,
            maxAttempts: failedTask.maxAttempts,
            state: "failed"
          });
        } else {
          queue.unshift(...[...recoveryTasks].reverse());
        }
        break;
      }

      case "cancelled":
        break;
    }
  }

  if (controller.failureError) {
    controller.cancel();
    await Promise.allSettled(Array.from(active.values()));
    throw controller.failureError;
  }

  return results;
}

async function executeAdaptiveBatchTask(
  settings: ExtensionSettings,
  input: PromptInput,
  task: AdaptiveBatchTask,
  controller: PreviewRunController,
  progress?: {
    onRequestingModel?: ProgressReporter;
    onWaitingForModel?: ProgressReporter;
    onParsingResponse?: ProgressReporter;
    onValidatingPlan?: ProgressReporter;
  }
): Promise<BatchTaskOutcome> {
  if (controller.cancelled) {
    return { kind: "cancelled", task };
  }

  try {
    const result = await runBatch(settings, input, task, controller, progress);

    if (controller.cancelled) {
      return { kind: "cancelled", task };
    }

    controller.completedBatchCount += 1;
    return { kind: "success", task, result };
  } catch (error) {
    if (controller.cancelled) {
      return { kind: "cancelled", task };
    }

    controller.failedBatchCount += 1;
    return {
      kind: "failure",
      task,
      error: error instanceof Error ? error : new Error("Unknown batch error.")
    };
  }
}

async function runBatch(
  settings: ExtensionSettings,
  input: PromptInput,
  task: AdaptiveBatchTask,
  controller: PreviewRunController,
  progress?: {
    onRequestingModel?: ProgressReporter;
    onWaitingForModel?: ProgressReporter;
    onParsingResponse?: ProgressReporter;
    onValidatingPlan?: ProgressReporter;
  }
): Promise<BatchPreviewResult> {
  const { systemPrompt, userPrompt } = buildOpenRouterPrompt(input, task.batch);
  const messages: OpenRouterMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
  const startedAt = performance.now();

  await emitRunProgress(progress?.onRequestingModel, controller, {
    message:
      task.attempt > 1
        ? `Batch ${task.currentBatch}/${task.totalBatches}: adaptive attempt ${task.attempt}/${task.maxAttempts}, sending ${task.batch.tabs.length} tabs across ${task.batch.clusters.length} clusters...`
        : `Batch ${task.currentBatch}/${task.totalBatches}: sending ${task.batch.tabs.length} tabs across ${task.batch.clusters.length} clusters to OpenRouter...`,
    currentBatch: task.currentBatch,
    totalBatches: task.totalBatches,
    tabCount: task.batch.tabs.length,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    state: task.attempt > 1 ? "retrying" : controller.state
  });

  const parsed = await requestStructuredJson(
    settings,
    {
      name: "tab_organization_plan",
      schema: getPlanSchema()
    },
    messages,
    task.timeoutMs,
    controller,
    {
      currentBatch: task.currentBatch,
      totalBatches: task.totalBatches,
      tabCount: task.batch.tabs.length,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts
    },
    progress
  );
  const elapsedMs = Math.round(performance.now() - startedAt);

  await emitRunProgress(progress?.onWaitingForModel, controller, {
    message: `Batch ${task.currentBatch}/${task.totalBatches}: attempt ${task.attempt}/${task.maxAttempts} returned in ${elapsedMs} ms. Validating model output...`,
    currentBatch: task.currentBatch,
    totalBatches: task.totalBatches,
    tabCount: task.batch.tabs.length,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    state: task.attempt > 1 ? "retrying" : controller.state
  });

  await emitRunProgress(progress?.onValidatingPlan, controller, {
    message: `Batch ${task.currentBatch}/${task.totalBatches}: validating category assignments...`,
    currentBatch: task.currentBatch,
    totalBatches: task.totalBatches,
    tabCount: task.batch.tabs.length,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts
  });

  try {
    const out = validateOrganizationPlan(
      parsed,
      task.batch.tabs.map((tab) => tab.tabId)
    );
    return out;
  } catch {
    const mutableTabIds = task.batch.tabs.map((tab) => tab.tabId);
    const repaired = tryRepairIndexBasedPlan(parsed, mutableTabIds);
    if (repaired !== null) {
      return repaired;
    }

    await emitRunProgress(progress?.onValidatingPlan, controller, {
      message: `Batch ${task.currentBatch}/${task.totalBatches}: correcting tab IDs and continuing.`,
      currentBatch: task.currentBatch,
      totalBatches: task.totalBatches,
      tabCount: task.batch.tabs.length,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts
    });

    return sanitizeOrganizationPlan(parsed, mutableTabIds);
  }
}

async function planBatchRecovery(
  task: AdaptiveBatchTask,
  error: Error,
  input: PromptInput,
  controller: PreviewRunController,
  progress?: {
    onParsingResponse?: ProgressReporter;
  }
) {
  if (!isTransientBatchError(error) || task.attempt >= task.maxAttempts) {
    return [] as AdaptiveBatchTask[];
  }

  if (!task.degradedConcurrencyApplied && controller.profile.concurrency > 1) {
    controller.profile.concurrency -= 1;
    controller.markState("degraded");
    await emitRunProgress(progress?.onParsingResponse, controller, {
      message: `Batch ${task.currentBatch}/${task.totalBatches}: degrading concurrency to ${controller.profile.concurrency} and retrying after "${error.message}".`,
      currentBatch: task.currentBatch,
      totalBatches: task.totalBatches,
      tabCount: task.batch.tabs.length,
      attempt: task.attempt + 1,
      maxAttempts: task.maxAttempts,
      state: "degraded"
    });

    return [
      {
        ...task,
        attempt: task.attempt + 1,
        degradedConcurrencyApplied: true,
        timeoutMs: Math.round(task.timeoutMs * 1.15)
      }
    ];
  }

  if (task.splitDepth < MAX_SPLIT_DEPTH && task.batch.tabs.length > MIN_RETRY_BATCH_SIZE) {
    controller.markState("degraded");
    const nextTargetBatchSize = Math.max(
      MIN_RETRY_BATCH_SIZE,
      Math.ceil(task.batch.tabs.length / 2)
    );
    controller.profile.targetBatchSize = Math.min(
      controller.profile.targetBatchSize,
      nextTargetBatchSize
    );
    const splitBatches = splitBatchForRetry(task.batch, input, controller.profile.targetBatchSize);

    await emitRunProgress(progress?.onParsingResponse, controller, {
      message: `Batch ${task.currentBatch}/${task.totalBatches}: splitting into ${splitBatches.length} smaller retries after "${error.message}".`,
      currentBatch: task.currentBatch,
      totalBatches: task.totalBatches,
      tabCount: task.batch.tabs.length,
      attempt: task.attempt + 1,
      maxAttempts: task.maxAttempts,
      state: "degraded"
    });

    return splitBatches.map((batch, index) => ({
      taskId: `${task.taskId}.split.${index + 1}`,
      batch,
      currentBatch: task.currentBatch,
      totalBatches: task.totalBatches,
      attempt: task.attempt + 1,
      maxAttempts: task.maxAttempts,
      splitDepth: task.splitDepth + 1,
      degradedConcurrencyApplied: true,
      timeoutMs: Math.round(task.timeoutMs * 1.15)
    }));
  }

  await emitRunProgress(progress?.onParsingResponse, controller, {
    message: `Batch ${task.currentBatch}/${task.totalBatches}: retrying once more after "${error.message}".`,
    currentBatch: task.currentBatch,
    totalBatches: task.totalBatches,
    tabCount: task.batch.tabs.length,
    attempt: task.attempt + 1,
    maxAttempts: task.maxAttempts,
    state: "retrying"
  });

  return [
    {
      ...task,
      attempt: task.attempt + 1,
      timeoutMs: Math.round(task.timeoutMs * 1.2)
    }
  ];
}

function buildBatchFromClusters(
  clusters: TabCluster[],
  batchId: string,
  input: PromptInput
): BatchPlan {
  const batch: BatchPlan = {
    batchId,
    clusters,
    tabs: clusters.flatMap((cluster) => cluster.tabs),
    estimatedPromptChars: 0
  };
  const prompt = buildOpenRouterPrompt(input, batch);
  batch.estimatedPromptChars = prompt.systemPrompt.length + prompt.userPrompt.length;
  return batch;
}

export function splitBatchForRetry(
  batch: BatchPlan,
  input: PromptInput,
  targetBatchSize: number
) {
  const output: BatchPlan[] = [];
  let currentClusters: TabCluster[] = [];
  let currentTabs = 0;
  let splitIndex = 1;

  const flush = () => {
    if (currentClusters.length === 0) {
      return;
    }

    output.push(buildBatchFromClusters(currentClusters, `${batch.batchId}-retry-${splitIndex}`, input));
    splitIndex += 1;
    currentClusters = [];
    currentTabs = 0;
  };

  for (const cluster of batch.clusters) {
    if (cluster.tabs.length > targetBatchSize) {
      flush();

      for (let index = 0; index < cluster.tabs.length; index += targetBatchSize) {
        const clusterSlice: TabCluster = {
          ...cluster,
          clusterId: `${cluster.clusterId}.retry.${index / targetBatchSize + 1}`,
          tabs: cluster.tabs.slice(index, index + targetBatchSize)
        };
        output.push(
          buildBatchFromClusters(
            [clusterSlice],
            `${batch.batchId}-retry-${splitIndex}`,
            input
          )
        );
        splitIndex += 1;
      }

      continue;
    }

    if (currentTabs > 0 && currentTabs + cluster.tabs.length > targetBatchSize) {
      flush();
    }

    currentClusters.push(cluster);
    currentTabs += cluster.tabs.length;
  }

  flush();
  return output;
}

export function isTransientBatchError(error: Error) {
  const message = error.message.toLowerCase();

  return (
    message.includes("no structured content") ||
    message.includes("non-json structured content") ||
    message.includes("empty response") ||
    message.includes("invalid json") ||
    message.includes("timed out") ||
    message.includes("failed to fetch") ||
    /openrouter request failed \((408|409|425|429|500|502|503|504)\)/i.test(error.message)
  );
}

async function runRefinement(
  settings: ExtensionSettings,
  provisionalCategories: ReturnType<typeof buildProvisionalCategories>,
  controller: PreviewRunController,
  progress?: {
    onRequestingModel?: ProgressReporter;
    onWaitingForModel?: ProgressReporter;
    onParsingResponse?: ProgressReporter;
    onValidatingPlan?: ProgressReporter;
  }
) {
  const { systemPrompt, userPrompt } = buildRefinementPrompt(provisionalCategories);
  const messages: OpenRouterMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
  const startedAt = performance.now();
  const timeoutMs = Math.min(
    REFINEMENT_TIMEOUT_MAX_MS,
    REFINEMENT_TIMEOUT_MS + provisionalCategories.length * REFINEMENT_TIMEOUT_PER_CATEGORY_MS
  );

  await emitRunProgress(progress?.onRequestingModel, controller, {
    message:
      provisionalCategories.length > 50
        ? `Final refinement: reconciling ${provisionalCategories.length} provisional categories… (may take up to ${Math.round(timeoutMs / 1000)}s)`
        : `Final refinement: reconciling ${provisionalCategories.length} provisional categories...`,
    tabCount: provisionalCategories.reduce((sum, category) => sum + category.tabCount, 0),
    state: "running"
  });

  const parsed = await requestStructuredJson(
    settings,
    {
      name: "refined_tab_category_plan",
      schema: getRefinementSchema()
    },
    messages,
    timeoutMs,
    controller,
    {
      tabCount: provisionalCategories.reduce((sum, category) => sum + category.tabCount, 0),
      attempt: 1,
      maxAttempts: 1
    },
    progress
  );
  const elapsedMs = Math.round(performance.now() - startedAt);

  await emitRunProgress(progress?.onWaitingForModel, controller, {
    message: `Final refinement returned in ${elapsedMs} ms. Validating merged category output...`,
    tabCount: provisionalCategories.reduce((sum, category) => sum + category.tabCount, 0),
    attempt: 1,
    maxAttempts: 1
  });

  await emitRunProgress(progress?.onValidatingPlan, controller, {
    message: `Validating refined category merges across ${provisionalCategories.length} provisional categories...`,
    tabCount: provisionalCategories.reduce((sum, category) => sum + category.tabCount, 0)
  });

  return validateRefinedCategoryPlan(
    parsed,
    provisionalCategories.map((category) => category.provisionalCategoryId)
  );
}

async function requestStructuredJson(
  settings: ExtensionSettings,
  responseSchema: { name: string; schema: object },
  messages: OpenRouterMessage[],
  timeoutMs: number,
  controller: PreviewRunController,
  metadata: {
    currentBatch?: number;
    totalBatches?: number;
    tabCount?: number;
    attempt?: number;
    maxAttempts?: number;
  },
  progress?: {
    onParsingResponse?: ProgressReporter;
  }
) {
  const response = await fetchWithTimeout(
    OPENROUTER_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.openRouterApiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Tab Tonic"
      },
      body: JSON.stringify({
        model: settings.modelId,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: responseSchema.name,
            strict: true,
            schema: responseSchema.schema
          }
        },
        plugins: [{ id: "response-healing" }],
        temperature: 0.2
      })
    },
    timeoutMs,
    controller
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as OpenRouterResponsePayload;

  await emitRunProgress(progress?.onParsingResponse, controller, {
    message:
      typeof metadata.currentBatch === "number"
        ? `batch ${metadata.currentBatch}/${metadata.totalBatches}: extracting JSON payload from model response...`
        : "final refinement: extracting JSON payload from model response...",
    ...metadata
  });

  return parseStructuredResponsePayload(payload);
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  controller: PreviewRunController
) {
  const requestController = new AbortController();

  if (!controller.register(requestController)) {
    throw new Error("Preview run was cancelled.");
  }

  const timeoutId = setTimeout(() => requestController.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: requestController.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (controller.cancelled) {
        throw new Error("Preview run was cancelled.");
      }

      throw new Error(`OpenRouter batch timed out after ${timeoutMs / 1000} seconds.`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    controller.unregister(requestController);
  }
}
