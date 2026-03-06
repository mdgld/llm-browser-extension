import type {
  GroupColor,
  LastOperationSnapshot,
  OrganizationPlan,
  OrganizeRunOptions
} from "../shared/types";
import { buildSnapshot, collectPreviewContext } from "./browser";

interface RestoreWindowTarget {
  originalWindowId: number;
  targetWindowId: number;
}

export interface RestorePlan {
  tabMoves: Array<{
    tabId: number;
    targetWindowId: number;
    targetIndex: number;
    originalGroupId: number;
  }>;
  groupedTabs: Array<{
    originalGroupId: number;
    tabIds: number[];
    title: string;
    color: GroupColor;
    collapsed: boolean;
  }>;
  ungroupedTabIds: number[];
}

export function buildRestorePlan(
  snapshot: LastOperationSnapshot,
  existingWindowIds: number[],
  fallbackWindowId: number
): RestorePlan {
  const targetWindowIds = new Map<number, RestoreWindowTarget>();

  for (const tab of snapshot.tabs) {
    const targetWindowId = existingWindowIds.includes(tab.originalWindowId)
      ? tab.originalWindowId
      : fallbackWindowId;
    targetWindowIds.set(tab.originalWindowId, {
      originalWindowId: tab.originalWindowId,
      targetWindowId
    });
  }

  const tabMoves = [...snapshot.tabs]
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .map((tab) => ({
      tabId: tab.tabId,
      targetWindowId:
        targetWindowIds.get(tab.originalWindowId)?.targetWindowId ?? fallbackWindowId,
      targetIndex: tab.originalIndex,
      originalGroupId: tab.originalGroupId
    }));

  const groupedTabs = snapshot.groups.map((group) => ({
    originalGroupId: group.originalGroupId,
    title: group.title,
    color: group.color,
    collapsed: group.collapsed,
    tabIds: tabMoves
      .filter((move) => move.originalGroupId === group.originalGroupId)
      .map((move) => move.tabId)
  }));

  const groupedTabIds = new Set(groupedTabs.flatMap((group) => group.tabIds));

  return {
    tabMoves,
    groupedTabs,
    ungroupedTabIds: tabMoves
      .filter((move) => move.originalGroupId < 0 && !groupedTabIds.has(move.tabId))
      .map((move) => move.tabId)
  };
}

async function groupTabsByWindow(tabIds: number[]) {
  const tabs = await Promise.all(
    tabIds.map(async (tabId) => {
      try {
        return await chrome.tabs.get(tabId);
      } catch {
        return null;
      }
    })
  );
  const byWindow = new Map<number, number[]>();

  for (const tab of tabs) {
    if (!tab?.id || typeof tab.windowId !== "number") {
      continue;
    }

    const existing = byWindow.get(tab.windowId) ?? [];
    existing.push(tab.id);
    byWindow.set(tab.windowId, existing);
  }

  return byWindow;
}

export async function applyOrganizationPlan(
  options: OrganizeRunOptions,
  plan: OrganizationPlan
): Promise<{ warnings: string[]; snapshot: LastOperationSnapshot }> {
  const { snapshot } = await buildSnapshot(options);
  const warnings: string[] = [];
  const createdGroupIds: number[] = [];

  for (const tabId of plan.unassignedTabIds) {
    try {
      await chrome.tabs.ungroup(tabId);
    } catch (error) {
      warnings.push(`Could not ungroup tab ${tabId}: ${(error as Error).message}`);
    }
  }

  for (const category of plan.categories) {
    const groupedByWindow = await groupTabsByWindow(category.tabIds);

    for (const tabIds of groupedByWindow.values()) {
      if (tabIds.length === 0) {
        continue;
      }

      try {
        const groupId = await chrome.tabs.group({ tabIds });
        createdGroupIds.push(groupId);
        await chrome.tabGroups.update(groupId, {
          title: category.name,
          color: category.color
        });
      } catch (error) {
        warnings.push(
          `Could not apply category "${category.name}": ${(error as Error).message}`
        );
      }
    }
  }

  snapshot.createdGroupIds = createdGroupIds;
  return { snapshot, warnings };
}

export async function undoLastOrganization(
  snapshot: LastOperationSnapshot
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const windows = await chrome.windows.getAll();
  const fallbackWindowId = windows[0]?.id;

  if (typeof fallbackWindowId !== "number") {
    throw new Error("No browser windows are available to restore tabs into.");
  }

  const restorePlan = buildRestorePlan(
    snapshot,
    windows.map((window) => window.id ?? -1),
    fallbackWindowId
  );

  const existingTabIds = new Set(
    (
      await chrome.tabs.query({})
    )
      .map((tab) => tab.id)
      .filter((tabId): tabId is number => typeof tabId === "number")
  );

  for (const move of restorePlan.tabMoves) {
    if (!existingTabIds.has(move.tabId)) {
      warnings.push(`Tab ${move.tabId} was closed and could not be restored.`);
      continue;
    }

    try {
      await chrome.tabs.move(move.tabId, {
        windowId: move.targetWindowId,
        index: move.targetIndex
      });
    } catch (error) {
      warnings.push(`Could not move tab ${move.tabId}: ${(error as Error).message}`);
    }
  }

  const stillOpenUngrouped = restorePlan.ungroupedTabIds.filter((tabId) => existingTabIds.has(tabId));

  if (stillOpenUngrouped.length > 0) {
    try {
      await chrome.tabs.ungroup(stillOpenUngrouped);
    } catch (error) {
      warnings.push(`Could not ungroup restored tabs: ${(error as Error).message}`);
    }
  }

  for (const group of restorePlan.groupedTabs) {
    const liveTabIds = group.tabIds.filter((tabId) => existingTabIds.has(tabId));

    if (liveTabIds.length === 0) {
      continue;
    }

    try {
      const restoredGroupId = await chrome.tabs.group({ tabIds: liveTabIds });
      await chrome.tabGroups.update(restoredGroupId, {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed
      });
    } catch (error) {
      warnings.push(`Could not restore group "${group.title}": ${(error as Error).message}`);
    }
  }

  return { warnings };
}

export async function validateApplyInput(
  options: OrganizeRunOptions,
  previewTabs: number[],
  savedProtectedTitles: string[]
) {
  const previewContext = await collectPreviewContext(options, savedProtectedTitles);
  const currentMutableTabs = previewContext.tabs
    .filter((tab) => !tab.isProtected)
    .map((tab) => tab.tabId)
    .sort((left, right) => left - right);
  const requestedMutableTabs = [...previewTabs].sort((left, right) => left - right);

  if (
    currentMutableTabs.length !== requestedMutableTabs.length ||
    currentMutableTabs.some((tabId, index) => tabId !== requestedMutableTabs[index])
  ) {
    throw new Error("The tab set changed since preview generation. Refresh and generate a new preview.");
  }
}
