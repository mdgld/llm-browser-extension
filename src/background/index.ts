import type {
  BackgroundEvent,
  BackgroundRequest,
  BackgroundResponse,
  BackgroundResponseMap,
  ProgressUpdate
} from "../shared/messages";
import type { GenerateOrganizationPlanResult } from "../shared/types";
import { clearLastOperation, getLastOperation, getSettings, saveLastOperation, saveSettings } from "../shared/storage";
import { collectPreviewContext } from "./browser";
import { generatePlanWithOpenRouter } from "./openrouter";
import { applyOrganizationPlan, undoLastOrganization, validateApplyInput } from "./snapshot";
import { buildPromptInput } from "./plan";

async function emitProgress(update: Omit<ProgressUpdate, "timestamp">) {
  const event: BackgroundEvent = {
    type: "progressUpdate",
    update: {
      ...update,
      timestamp: new Date().toISOString()
    }
  };

  try {
    chrome.runtime.sendMessage(event).catch(() => {});
  } catch {
    // Ignore when no side panel is actively listening.
  }
}

async function handleRequest(
  request: BackgroundRequest
): Promise<BackgroundResponseMap[keyof BackgroundResponseMap]> {
  switch (request.type) {
    case "getSettings":
      return await getSettings();

    case "saveSettings":
      return await saveSettings(request.settings);

    case "loadTabsForPreview": {
      const settings = await getSettings();
      return await collectPreviewContext(
        request.options,
        request.options.protectedGroupTitlesOverride ?? settings.protectedGroupTitles
      );
    }

    case "generateOrganizationPlan": {
      const runId = crypto.randomUUID();
      return { runId } as BackgroundResponseMap["generateOrganizationPlan"];
    }

    // applyOrganizationPlan and undoLastOrganization are handled as fire-and-forget
    // runners below to avoid holding the message channel open while the service
    // worker does async work (which causes "message channel closed" errors).
    case "applyOrganizationPlan":
    case "undoLastOrganization":
      return {} as never;
  }
}

/** Runs applyOrganizationPlan work and delivers result/error via progress so the message channel is not held open. */
async function runApplyOrganizationPlan(
  request: Extract<BackgroundRequest, { type: "applyOrganizationPlan" }>
): Promise<void> {
  try {
    const settings = await getSettings();
    await emitProgress({
      phase: "applying_plan",
      message: "Validating the preview against current browser state before applying..."
    });
    await validateApplyInput(
      request.options,
      request.tabs.filter((tab) => !tab.isProtected).map((tab) => tab.tabId),
      request.options.protectedGroupTitlesOverride ?? settings.protectedGroupTitles
    );
    await emitProgress({
      phase: "applying_plan",
      message: `Applying ${request.plan.categories.length} category groups to the browser...`
    });
    const { warnings, snapshot } = await applyOrganizationPlan(request.options, request.plan);
    await saveLastOperation(snapshot);
    await emitProgress({
      phase: "complete",
      message: warnings[0] ?? "Apply finished.",
      warnings
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extension error.";
    await emitProgress({
      phase: "error",
      message,
      error: message
    });
  }
}

/** Runs undoLastOrganization work and delivers result/error via progress so the message channel is not held open. */
async function runUndoLastOrganization(): Promise<void> {
  try {
    const snapshot = await getLastOperation();

    if (!snapshot) {
      throw new Error("Nothing to undo yet.");
    }

    await emitProgress({
      phase: "undoing_plan",
      message: "Restoring the most recent tab layout snapshot..."
    });
    const result = await undoLastOrganization(snapshot);
    await clearLastOperation();
    await emitProgress({
      phase: "complete",
      message: result.warnings[0] ?? "Undo finished.",
      warnings: result.warnings
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extension error.";
    await emitProgress({
      phase: "error",
      message,
      error: message
    });
  }
}

/** Runs generateOrganizationPlan work and delivers result/error via progress so the message channel is not held open. */
async function runGenerateOrganizationPlan(
  request: Extract<BackgroundRequest, { type: "generateOrganizationPlan" }>,
  runId: string
): Promise<void> {
  const settings = await getSettings();

  try {
    await emitProgress({
      phase: "loading_tabs",
      message: "Starting preview generation...",
      runId,
      state: "running"
    });
    const previewContext = await collectPreviewContext(
      request.options,
      request.options.protectedGroupTitlesOverride ?? settings.protectedGroupTitles,
      {
        onLoadingTabs: (message) =>
          emitProgress({
            phase: "loading_tabs",
            message,
            runId,
            state: "running"
          }),
        onResolvingProtection: (message) =>
          emitProgress({
            phase: "resolving_protection",
            message,
            runId,
            state: "running"
          })
      }
    );
    await emitProgress({
      phase: "clustering_tabs",
      message: `Loaded ${previewContext.tabs.length} tabs. Starting local clustering before model calls...`,
      tabCount: previewContext.tabs.length,
      runId,
      state: "running"
    });
    await emitProgress({
      phase: "building_prompt",
      message: `Preparing a prompt for ${previewContext.tabs.filter((tab) => !tab.isProtected).length} mutable tabs...`,
      runId,
      state: "running"
    });
    const promptInput = buildPromptInput(
      previewContext.tabs,
      previewContext.selectedProtectedGroupIds,
      previewContext.liveGroups,
      request.options.runCategories?.length ? request.options.runCategories : settings.defaultCategories
    );
    const plan = await generatePlanWithOpenRouter(settings, promptInput, runId, {
      onClusteringTabs: (update) =>
        emitProgress({
          phase: "clustering_tabs",
          runId,
          ...update
        }),
      onPlanningBatches: (update) =>
        emitProgress({
          phase: "planning_batches",
          runId,
          ...update
        }),
      onRequestingModel: (update) =>
        emitProgress({
          phase: "requesting_model",
          runId,
          ...update
        }),
      onWaitingForModel: (update) =>
        emitProgress({
          phase: "waiting_for_model",
          runId,
          ...update
        }),
      onParsingResponse: (update) =>
        emitProgress({
          phase: "parsing_response",
          runId,
          ...update
        }),
      onValidatingPlan: (update) =>
        emitProgress({
          phase: "validating_plan",
          runId,
          ...update
        })
    });
    const result: GenerateOrganizationPlanResult = {
      ...previewContext,
      plan
    };
    await emitProgress({
      phase: "complete",
      message: `Preview ready with ${plan.categories.length} categories.`,
      runId,
      state: "complete",
      result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown extension error.";
    await emitProgress({
      phase: "error",
      message,
      runId,
      state: "failed",
      error: message
    });
  }
}

// Keep the service worker alive while the side panel is open.
// Chrome MV3 suspends workers after ~30s of inactivity; a connected Port prevents that.
chrome.runtime.onConnect.addListener((_port) => {
  // Nothing to do — the open port itself keeps the worker alive.
});

chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onMessage.addListener((request: BackgroundRequest, _sender, sendResponse) => {
  // Fire-and-forget handlers: respond immediately so the message channel closes
  // before the service worker can be suspended by Chrome mid-operation.
  if (request.type === "generateOrganizationPlan") {
    const runId = crypto.randomUUID();
    sendResponse({ ok: true, data: { runId } } as BackgroundResponse<{ runId: string }>);
    void runGenerateOrganizationPlan(request, runId);
    return false;
  }

  if (request.type === "applyOrganizationPlan") {
    sendResponse({ ok: true, data: {} } as BackgroundResponse<unknown>);
    void runApplyOrganizationPlan(request);
    return false;
  }

  if (request.type === "undoLastOrganization") {
    sendResponse({ ok: true, data: {} } as BackgroundResponse<unknown>);
    void runUndoLastOrganization();
    return false;
  }

  handleRequest(request)
    .then((data) => {
      sendResponse({ ok: true, data } satisfies BackgroundResponse<unknown>);
    })
    .catch(async (error) => {
      await emitProgress({
        phase: "error",
        message: error instanceof Error ? error.message : "Unknown extension error."
      });
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown extension error."
      } satisfies BackgroundResponse<never>);
    });

  return true;
});
