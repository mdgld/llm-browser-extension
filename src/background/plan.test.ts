import { describe, expect, it } from "vitest";
import type { LiveTabGroup, TabContext } from "../shared/types";
import { buildOpenRouterPrompt, buildPromptInput, validateOrganizationPlan } from "./plan";

describe("plan prompt building", () => {
  const tabs: TabContext[] = [
    {
      tabId: 1,
      windowId: 1,
      title: "OpenRouter docs",
      url: "https://openrouter.ai/docs",
      domain: "openrouter.ai",
      groupId: -1,
      isProtected: false,
      isPinned: false
    },
    {
      tabId: 2,
      windowId: 1,
      title: "Quarterly roadmap",
      url: "https://notion.so/roadmap",
      domain: "notion.so",
      groupId: 100,
      groupTitle: "Current sprint",
      isProtected: true,
      isPinned: false
    }
  ];
  const liveGroups: LiveTabGroup[] = [
    {
      groupId: 100,
      title: "Current sprint",
      color: "green",
      collapsed: false,
      tabCount: 1,
      windowId: 1,
      canBeSaved: true,
      matchedDefaultTitle: "Current sprint",
      isAmbiguousDefault: false,
      isSelected: true
    }
  ];

  it("keeps protected tabs out of mutable candidates and includes them as read-only context", () => {
    const promptInput = buildPromptInput(tabs, [100], liveGroups, ["Research"]);
    const { userPrompt } = buildOpenRouterPrompt(promptInput);
    const parsed = JSON.parse(userPrompt) as {
      mutableTabs: Array<{ tabId: number }>;
      protectedGroups: Array<{ tabs: Array<{ tabId: number }> }>;
    };

    expect(parsed.mutableTabs.map((tab) => tab.tabId)).toEqual([1]);
    expect(parsed.protectedGroups[0]?.tabs.map((tab) => tab.tabId)).toEqual([2]);
  });
});

describe("organization plan validation", () => {
  it("rejects duplicate assignments", () => {
    expect(() =>
      validateOrganizationPlan(
        {
          reasoningSummary: "Grouped everything.",
          categories: [
            { name: "Research", color: "blue", tabIds: [1, 2] },
            { name: "Work", color: "green", tabIds: [2] }
          ],
          unassignedTabIds: []
        },
        [1, 2, 3]
      )
    ).toThrowError(/assigned more than once/i);
  });

  it("fills missing mutable tabs into unassigned", () => {
    const plan = validateOrganizationPlan(
      {
        reasoningSummary: "Mostly organized.",
        categories: [{ name: "Research", color: "blue", tabIds: [1] }],
        unassignedTabIds: []
      },
      [1, 2]
    );

    expect(plan.unassignedTabIds).toEqual([2]);
  });
});
