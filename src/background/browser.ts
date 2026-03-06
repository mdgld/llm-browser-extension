import type {
  LastOperationSnapshot,
  LiveTabGroup,
  OrganizeRunOptions,
  OriginalGroupSnapshot,
  TabContext
} from "../shared/types";
import { isGroupColor } from "../shared/types";
import { resolveProtectedGroups } from "./protection";

type RawTab = chrome.tabs.Tab;
type RawGroup = chrome.tabGroups.TabGroup;

async function getWindowIdForScope(options: OrganizeRunOptions) {
  if (options.scope === "allWindows") {
    return undefined;
  }

  if (typeof options.currentWindowId === "number") {
    return options.currentWindowId;
  }

  const window = await chrome.windows.getLastFocused();
  return window.id;
}

async function loadTabsForScope(options: OrganizeRunOptions): Promise<RawTab[]> {
  const windowId = await getWindowIdForScope(options);
  const tabs = await chrome.tabs.query(windowId ? { windowId } : {});

  return tabs.sort((left, right) => {
    if ((left.windowId ?? 0) !== (right.windowId ?? 0)) {
      return (left.windowId ?? 0) - (right.windowId ?? 0);
    }

    return (left.index ?? 0) - (right.index ?? 0);
  });
}

function extractDomain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function getGroupMap(tabs: RawTab[]) {
  const uniqueGroupIds = Array.from(
    new Set(
      tabs
        .map((tab) => tab.groupId ?? -1)
        .filter((groupId) => groupId >= 0)
    )
  );
  const groups = await Promise.all(
    uniqueGroupIds.map(async (groupId) => {
      try {
        return await chrome.tabGroups.get(groupId);
      } catch {
        return null;
      }
    })
  );

  return new Map(uniqueGroupIds.map((groupId, index) => [groupId, groups[index]]).filter(Boolean) as [
    number,
    RawGroup | null
  ][]);
}

function toGroupColor(value?: string): LiveTabGroup["color"] {
  return value && isGroupColor(value) ? value : "grey";
}

export interface PreviewContextResult {
  tabs: TabContext[];
  liveGroups: LiveTabGroup[];
  selectedProtectedGroupIds: number[];
  ambiguousProtectedTitles: string[];
  warnings: string[];
}

export async function collectPreviewContext(
  options: OrganizeRunOptions,
  savedProtectedTitles: string[]
): Promise<PreviewContextResult> {
  const tabs = await loadTabsForScope(options);
  const groupMap = await getGroupMap(tabs);
  const liveGroupMap = new Map<number, LiveTabGroup>();

  for (const tab of tabs) {
    const groupId = tab.groupId ?? -1;

    if (groupId < 0 || liveGroupMap.has(groupId)) {
      continue;
    }

    const group = groupMap.get(groupId);

    liveGroupMap.set(groupId, {
      groupId,
      title: group?.title ?? "",
      color: toGroupColor(group?.color),
      collapsed: Boolean(group?.collapsed),
      tabCount: tabs.filter((candidate) => candidate.groupId === groupId).length,
      windowId: tab.windowId ?? -1,
      canBeSaved: Boolean(group?.title?.trim()),
      isAmbiguousDefault: false,
      isSelected: false
    });
  }

  const resolvedProtection = resolveProtectedGroups({
    liveGroups: Array.from(liveGroupMap.values()),
    savedProtectedTitles,
    overrideGroupIds: options.protectedGroupIdsOverride
  });
  const selectedProtectedGroupIds = new Set(resolvedProtection.selectedProtectedGroupIds);
  const warnings: string[] = [];

  if (resolvedProtection.ambiguousProtectedTitles.length > 0) {
    warnings.push(
      `Protected defaults need review: ${resolvedProtection.ambiguousProtectedTitles.join(", ")}`
    );
  }

  const tabContexts: TabContext[] = tabs.map((tab) => {
    const groupId = tab.groupId ?? -1;
    const group = groupMap.get(groupId);
    const isPinned = Boolean(tab.pinned);
    const isProtected = isPinned || selectedProtectedGroupIds.has(groupId);

    return {
      tabId: tab.id ?? -1,
      windowId: tab.windowId ?? -1,
      title: tab.title?.trim() || "Untitled tab",
      url: tab.url ?? "",
      domain: extractDomain(tab.url ?? ""),
      groupId,
      groupTitle: group?.title ?? undefined,
      isPinned,
      isProtected
    };
  });

  if (tabContexts.some((tab) => tab.isPinned)) {
    warnings.push("Pinned tabs are treated as protected and will not be regrouped.");
  }

  return {
    tabs: tabContexts,
    liveGroups: resolvedProtection.liveGroups,
    selectedProtectedGroupIds: resolvedProtection.selectedProtectedGroupIds,
    ambiguousProtectedTitles: resolvedProtection.ambiguousProtectedTitles,
    warnings
  };
}

export async function buildSnapshot(
  options: OrganizeRunOptions
): Promise<{
  tabs: RawTab[];
  groups: Map<number, RawGroup | null>;
  snapshot: LastOperationSnapshot;
}> {
  const tabs = await loadTabsForScope(options);
  const groups = await getGroupMap(tabs);
  const groupSnapshots: OriginalGroupSnapshot[] = Array.from(groups.entries())
    .filter((entry): entry is [number, RawGroup] => entry[1] !== null)
    .map(([groupId, group]) => ({
      originalGroupId: groupId,
      title: group.title ?? "",
      color: toGroupColor(group.color),
      collapsed: Boolean(group.collapsed)
    }));

  return {
    tabs,
    groups,
    snapshot: {
      createdAt: new Date().toISOString(),
      scope: options.scope,
      createdGroupIds: [],
      groups: groupSnapshots,
      tabs: tabs.map((tab) => ({
        tabId: tab.id ?? -1,
        originalWindowId: tab.windowId ?? -1,
        originalIndex: tab.index ?? -1,
        originalGroupId: tab.groupId ?? -1
      }))
    }
  };
}
