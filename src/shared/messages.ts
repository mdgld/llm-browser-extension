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

export interface ProgressUpdate {
  phase:
    | "error"
    | "clustering_tabs"
    | "planning_batches"
    | "loading_tabs"
    | "resolving_protection"
    | "building_prompt"
    | "requesting_model"
    | "waiting_for_model"
    | "parsing_response"
    | "validating_plan"
    | "applying_plan"
    | "undoing_plan"
    | "complete";
  message: string;
  timestamp: string;
  runId?: string;
  state?: "running" | "retrying" | "degraded" | "failed" | "cancelled" | "complete";
  currentBatch?: number;
  totalBatches?: number;
  tabCount?: number;
  attempt?: number;
  maxAttempts?: number;
}

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

export type BackgroundEvent = {
  type: "progressUpdate";
  update: ProgressUpdate;
};

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
