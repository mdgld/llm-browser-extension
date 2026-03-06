import type { BackgroundRequest, BackgroundResponse, BackgroundResponseMap } from "../shared/messages";
import type { GenerateOrganizationPlanResult } from "../shared/types";
import { clearLastOperation, getLastOperation, getSettings, saveLastOperation, saveSettings } from "../shared/storage";
import { collectPreviewContext } from "./browser";
import { generatePlanWithOpenRouter } from "./openrouter";
import { applyOrganizationPlan, undoLastOrganization, validateApplyInput } from "./snapshot";
import { buildPromptInput } from "./plan";

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
      const settings = await getSettings();
      const previewContext = await collectPreviewContext(
        request.options,
        request.options.protectedGroupTitlesOverride ?? settings.protectedGroupTitles
      );
      const promptInput = buildPromptInput(
        previewContext.tabs,
        previewContext.selectedProtectedGroupIds,
        previewContext.liveGroups,
        request.options.runCategories?.length ? request.options.runCategories : settings.defaultCategories
      );
      const plan = await generatePlanWithOpenRouter(settings, promptInput);
      const result: GenerateOrganizationPlanResult = {
        ...previewContext,
        plan
      };

      return result;
    }

    case "applyOrganizationPlan": {
      const settings = await getSettings();
      await validateApplyInput(
        request.options,
        request.tabs.filter((tab) => !tab.isProtected).map((tab) => tab.tabId),
        request.options.protectedGroupTitlesOverride ?? settings.protectedGroupTitles
      );
      const { warnings, snapshot } = await applyOrganizationPlan(request.options, request.plan);
      await saveLastOperation(snapshot);

      return {
        warnings
      };
    }

    case "undoLastOrganization": {
      const snapshot = await getLastOperation();

      if (!snapshot) {
        throw new Error("Nothing to undo yet.");
      }

      const result = await undoLastOrganization(snapshot);
      await clearLastOperation();
      return result;
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.runtime.onMessage.addListener((request: BackgroundRequest, _sender, sendResponse) => {
  handleRequest(request)
    .then((data) => {
      sendResponse({ ok: true, data } satisfies BackgroundResponse<unknown>);
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown extension error."
      } satisfies BackgroundResponse<never>);
    });

  return true;
});
