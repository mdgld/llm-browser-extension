import type { LiveTabGroup } from "../shared/types";

interface ResolveProtectedInput {
  liveGroups: Array<{
    groupId: number;
    title: string;
    color: LiveTabGroup["color"];
    collapsed: boolean;
    tabCount: number;
    windowId: number;
  }>;
  savedProtectedTitles: string[];
  overrideGroupIds?: number[];
}

export interface ResolveProtectedResult {
  liveGroups: LiveTabGroup[];
  selectedProtectedGroupIds: number[];
  ambiguousProtectedTitles: string[];
}

function normalizeTitle(title: string) {
  return title.trim().toLowerCase();
}

export function resolveProtectedGroups({
  liveGroups,
  savedProtectedTitles,
  overrideGroupIds
}: ResolveProtectedInput): ResolveProtectedResult {
  const groupsByTitle = new Map<string, typeof liveGroups>();
  const ambiguousTitles = new Set<string>();
  const matchedGroupIds = new Set<number>();
  const matchedDefaultTitleByGroupId = new Map<number, string>();

  for (const group of liveGroups) {
    if (!group.title.trim()) {
      continue;
    }

    const key = normalizeTitle(group.title);
    const existing = groupsByTitle.get(key) ?? [];
    existing.push(group);
    groupsByTitle.set(key, existing);
  }

  for (const savedTitle of savedProtectedTitles) {
    const key = normalizeTitle(savedTitle);
    const matches = groupsByTitle.get(key) ?? [];

    if (matches.length === 1) {
      matchedGroupIds.add(matches[0].groupId);
      matchedDefaultTitleByGroupId.set(matches[0].groupId, savedTitle);
      continue;
    }

    if (matches.length > 1) {
      ambiguousTitles.add(savedTitle);
    }
  }

  const selectedGroupIds = new Set(
    (overrideGroupIds ?? Array.from(matchedGroupIds)).filter((groupId) =>
      liveGroups.some((group) => group.groupId === groupId)
    )
  );

  return {
    ambiguousProtectedTitles: Array.from(ambiguousTitles).sort((left, right) =>
      left.localeCompare(right)
    ),
    selectedProtectedGroupIds: Array.from(selectedGroupIds).sort((left, right) => left - right),
    liveGroups: liveGroups
      .map((group) => ({
        ...group,
        canBeSaved: group.title.trim().length > 0,
        matchedDefaultTitle: matchedDefaultTitleByGroupId.get(group.groupId),
        isAmbiguousDefault:
          !!group.title.trim() &&
          Array.from(ambiguousTitles).some(
            (savedTitle) => normalizeTitle(savedTitle) === normalizeTitle(group.title)
          ),
        isSelected: selectedGroupIds.has(group.groupId)
      }))
      .sort((left, right) => {
        if (left.isSelected !== right.isSelected) {
          return left.isSelected ? -1 : 1;
        }

        return left.title.localeCompare(right.title);
      })
  };
}
