import type {
  ApplyOrganizationResult,
  ExtensionSettings,
  GenerateOrganizationPlanResult,
  LoadTabsForPreviewResult,
  OrganizationPlan,
  OrganizeRunOptions,
  TabContext,
  UndoOrganizationResult
} from "./types";

export type BackgroundRequest =
  | { type: "getSettings" }
  | { type: "saveSettings"; settings: ExtensionSettings }
  | { type: "loadTabsForPreview"; options: OrganizeRunOptions }
  | { type: "generateOrganizationPlan"; options: OrganizeRunOptions }
  | {
      type: "applyOrganizationPlan";
      options: OrganizeRunOptions;
      plan: OrganizationPlan;
      tabs: TabContext[];
    }
  | { type: "undoLastOrganization" };

export interface BackgroundSuccess<T> {
  ok: true;
  data: T;
}

export interface BackgroundFailure {
  ok: false;
  error: string;
}

export type BackgroundResponse<T> = BackgroundSuccess<T> | BackgroundFailure;

export interface BackgroundResponseMap {
  getSettings: ExtensionSettings;
  saveSettings: ExtensionSettings;
  loadTabsForPreview: LoadTabsForPreviewResult;
  generateOrganizationPlan: GenerateOrganizationPlanResult;
  applyOrganizationPlan: ApplyOrganizationResult;
  undoLastOrganization: UndoOrganizationResult;
}

export async function sendBackgroundMessage<T extends keyof BackgroundResponseMap>(
  request: Extract<BackgroundRequest, { type: T }>
): Promise<BackgroundResponseMap[T]> {
  const response = (await chrome.runtime.sendMessage(request)) as BackgroundResponse<
    BackgroundResponseMap[T]
  >;

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.data;
}
