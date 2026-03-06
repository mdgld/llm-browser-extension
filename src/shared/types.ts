export const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];
export type RunScope = "currentWindow" | "allWindows";
export type CategoriesMode = "hybrid";

export interface ExtensionSettings {
  openRouterApiKey: string;
  modelId: string;
  defaultCategories: string[];
  protectedGroupTitles: string[];
}

export interface OrganizeRunOptions {
  scope: RunScope;
  categoriesMode: CategoriesMode;
  runCategories?: string[];
  protectedGroupTitlesOverride?: string[];
  protectedGroupIdsOverride?: number[];
  currentWindowId?: number;
}

export interface TabContext {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  domain: string;
  groupId: number;
  groupTitle?: string;
  isProtected: boolean;
  isPinned: boolean;
}

export interface LiveTabGroup {
  groupId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  tabCount: number;
  windowId: number;
  canBeSaved: boolean;
  matchedDefaultTitle?: string;
  isAmbiguousDefault: boolean;
  isSelected: boolean;
}

export interface OrganizationCategory {
  name: string;
  color: GroupColor;
  tabIds: number[];
}

export interface OrganizationPlan {
  categories: OrganizationCategory[];
  unassignedTabIds: number[];
  reasoningSummary: string;
}

export interface LoadTabsForPreviewResult {
  tabs: TabContext[];
  liveGroups: LiveTabGroup[];
  selectedProtectedGroupIds: number[];
  ambiguousProtectedTitles: string[];
  warnings: string[];
}

export interface GenerateOrganizationPlanResult extends LoadTabsForPreviewResult {
  plan: OrganizationPlan;
}

export interface OriginalGroupSnapshot {
  originalGroupId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface TabSnapshot {
  tabId: number;
  originalWindowId: number;
  originalIndex: number;
  originalGroupId: number;
}

export interface LastOperationSnapshot {
  createdAt: string;
  scope: RunScope;
  tabs: TabSnapshot[];
  groups: OriginalGroupSnapshot[];
  createdGroupIds: number[];
}

export interface ApplyOrganizationResult {
  warnings: string[];
}

export interface UndoOrganizationResult {
  warnings: string[];
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  openRouterApiKey: "",
  modelId: "",
  defaultCategories: [],
  protectedGroupTitles: []
};

export function isGroupColor(value: string): value is GroupColor {
  return GROUP_COLORS.includes(value as GroupColor);
}
