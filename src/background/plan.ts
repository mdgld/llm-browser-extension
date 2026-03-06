import type {
  GroupColor,
  LiveTabGroup,
  OrganizationPlan,
  TabContext
} from "../shared/types";
import { GROUP_COLORS, isGroupColor } from "../shared/types";

export interface PromptInput {
  mutableTabs: TabContext[];
  protectedGroups: Array<{
    groupId: number;
    title: string;
    tabs: Array<Pick<TabContext, "tabId" | "title" | "url" | "domain">>;
  }>;
  preferredCategories: string[];
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categories", "unassignedTabIds", "reasoningSummary"],
  properties: {
    reasoningSummary: { type: "string" },
    unassignedTabIds: {
      type: "array",
      items: { type: "integer" }
    },
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "color", "tabIds"],
        properties: {
          name: { type: "string" },
          color: {
            type: "string",
            enum: [...GROUP_COLORS]
          },
          tabIds: {
            type: "array",
            items: { type: "integer" }
          }
        }
      }
    }
  }
} as const;

export function getPlanSchema() {
  return PLAN_SCHEMA;
}

export function buildPromptInput(
  tabs: TabContext[],
  selectedProtectedGroupIds: number[],
  liveGroups: LiveTabGroup[],
  preferredCategories: string[]
): PromptInput {
  const protectedGroupIds = new Set(selectedProtectedGroupIds);
  const protectedTabs = tabs.filter((tab) => protectedGroupIds.has(tab.groupId));
  const protectedGroups = liveGroups
    .filter((group) => protectedGroupIds.has(group.groupId))
    .map((group) => ({
      groupId: group.groupId,
      title: group.title || `Protected Group ${group.groupId}`,
      tabs: protectedTabs
        .filter((tab) => tab.groupId === group.groupId)
        .map((tab) => ({
          tabId: tab.tabId,
          title: tab.title,
          url: tab.url,
          domain: tab.domain
        }))
    }));

  return {
    mutableTabs: tabs.filter((tab) => !tab.isProtected),
    protectedGroups,
    preferredCategories
  };
}

export function buildOpenRouterPrompt(input: PromptInput) {
  const systemPrompt =
    "You organize browser tabs into concise, mutually exclusive Chrome tab groups. " +
    "Respect protected groups as context only. Return JSON only.";
  const categoryInstruction =
    input.preferredCategories.length > 0
      ? `Prefer these category names when they fit: ${input.preferredCategories.join(", ")}.`
      : "Invent concise category names when no user categories fit cleanly.";
  const userPrompt = JSON.stringify(
    {
      instructions: [
        "Use every mutable tab at most once.",
        "Put tabs that do not fit in unassignedTabIds.",
        "Keep categories broad enough to avoid one-tab groups unless necessary.",
        categoryInstruction
      ],
      mutableTabs: input.mutableTabs.map((tab) => ({
        tabId: tab.tabId,
        title: tab.title,
        url: tab.url,
        domain: tab.domain
      })),
      protectedGroups: input.protectedGroups
    },
    null,
    2
  );

  return {
    systemPrompt,
    userPrompt
  };
}

function normalizeColor(color: string, categoryName: string): GroupColor {
  if (isGroupColor(color)) {
    return color;
  }

  const hash = Array.from(categoryName).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

export function validateOrganizationPlan(
  candidate: unknown,
  mutableTabIds: number[]
): OrganizationPlan {
  const mutableIdSet = new Set(mutableTabIds);

  if (!candidate || typeof candidate !== "object") {
    throw new Error("LLM response must be a JSON object.");
  }

  const raw = candidate as Record<string, unknown>;
  const categories = raw.categories;
  const unassigned = raw.unassignedTabIds;
  const reasoningSummary = raw.reasoningSummary;

  if (!Array.isArray(categories) || !Array.isArray(unassigned) || typeof reasoningSummary !== "string") {
    throw new Error("LLM response is missing required plan fields.");
  }

  const seenAssignments = new Set<number>();
  const normalizedCategories = categories.map((category, index) => {
    if (!category || typeof category !== "object") {
      throw new Error(`Category ${index + 1} is invalid.`);
    }

    const record = category as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const color = typeof record.color === "string" ? record.color : "grey";
    const tabIds = record.tabIds;

    if (!name || !Array.isArray(tabIds)) {
      throw new Error(`Category ${index + 1} is missing a name or tab list.`);
    }

    const normalizedTabIds = tabIds.map((tabId) => {
      if (typeof tabId !== "number" || !mutableIdSet.has(tabId)) {
        throw new Error(`Category "${name}" references an unknown tab.`);
      }

      if (seenAssignments.has(tabId)) {
        throw new Error(`Tab ${tabId} was assigned more than once.`);
      }

      seenAssignments.add(tabId);
      return tabId;
    });

    return {
      name,
      color: normalizeColor(color, name),
      tabIds: normalizedTabIds
    };
  });

  const normalizedUnassigned = unassigned.map((tabId) => {
    if (typeof tabId !== "number" || !mutableIdSet.has(tabId)) {
      throw new Error("Unassigned tabs contain an unknown tab.");
    }

    if (seenAssignments.has(tabId)) {
      throw new Error(`Tab ${tabId} was assigned both to a category and unassigned.`);
    }

    seenAssignments.add(tabId);
    return tabId;
  });

  for (const tabId of mutableIdSet) {
    if (!seenAssignments.has(tabId)) {
      normalizedUnassigned.push(tabId);
    }
  }

  return {
    categories: normalizedCategories,
    unassignedTabIds: Array.from(new Set(normalizedUnassigned)),
    reasoningSummary: reasoningSummary.trim() || "Tabs grouped by topic."
  };
}
