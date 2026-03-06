import { describe, expect, it } from "vitest";
import type { LiveTabGroup, TabContext } from "../shared/types";
import {
  buildOpenRouterPrompt,
  buildPromptInput,
  buildProvisionalCategories,
  buildRefinementPrompt,
  clusterTabs,
  createBatchPlan,
  materializeRefinedPlan,
  sanitizeOrganizationPlan,
  validateOrganizationPlan,
  validateRefinedCategoryPlan
} from "./plan";

const protectedGroups: LiveTabGroup[] = [
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

describe("plan prompt building", () => {
  const tabs: TabContext[] = [
    {
      tabId: 1,
      windowId: 1,
      title: "OpenRouter docs and structured output examples",
      url: "https://openrouter.ai/docs/features/structured-outputs",
      domain: "openrouter.ai",
      groupId: -1,
      isProtected: false,
      isPinned: false
    },
    {
      tabId: 2,
      windowId: 1,
      title: "A",
      url: "https://example.com/path/to/something/useful",
      domain: "example.com",
      groupId: -1,
      isProtected: false,
      isPinned: false
    },
    {
      tabId: 3,
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

  it("keeps protected tabs out of mutable candidates and compacts prompt fields", () => {
    const promptInput = buildPromptInput(tabs, [100], protectedGroups, ["Research"]);
    const batchPlan = createBatchPlan(clusterTabs(promptInput.mutableTabs), promptInput);
    const { userPrompt } = buildOpenRouterPrompt(promptInput, batchPlan[0]);
    const parsed = JSON.parse(userPrompt) as {
      mutableTabs: Array<{ tabId: number; url?: string }>;
      protectedGroups: Array<{ tabCount: number; sampleTitles: string[] }>;
    };

    expect(parsed.mutableTabs.map((tab) => tab.tabId)).toEqual([1, 2]);
    expect(parsed.mutableTabs.find((tab) => tab.tabId === 1)?.url).toBeUndefined();
    expect(parsed.mutableTabs.find((tab) => tab.tabId === 2)?.url).toContain("example.com");
    expect(parsed.protectedGroups[0]?.tabCount).toBe(1);
    expect(parsed.protectedGroups[0]?.sampleTitles).toEqual(["Quarterly roadmap"]);
  });
});

describe("batch planning", () => {
  it("splits large tab sets into deterministic batches using the serialized prompt budget", () => {
    const tabs: TabContext[] = Array.from({ length: 220 }, (_, index) => ({
      tabId: index + 1,
      windowId: 1,
      title: `Engineering dashboard ${index + 1}`,
      url: `https://example${index % 6}.com/${index + 1}`,
      domain: `example${index % 6}.com`,
      groupId: -1,
      isProtected: false,
      isPinned: false
    }));

    const promptInput = buildPromptInput(tabs, [], [], ["Research"]);
    const batches = createBatchPlan(clusterTabs(promptInput.mutableTabs), promptInput);

    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches.every((batch) => {
        const { userPrompt, systemPrompt } = buildOpenRouterPrompt(promptInput, batch);
        return batch.tabs.length <= 140 && userPrompt.length + systemPrompt.length <= 18_000;
      })
    ).toBe(true);
  });

  it("accounts for protected-group overhead in batch splitting", () => {
    const tabs: TabContext[] = Array.from({ length: 120 }, (_, index) => ({
      tabId: index + 1,
      windowId: 1,
      title: `Planning note ${index + 1}`,
      url: `https://notes.example.com/${index + 1}`,
      domain: "notes.example.com",
      groupId: -1,
      isProtected: false,
      isPinned: false
    }));
    const promptInput = {
      mutableTabs: tabs,
      preferredCategories: [],
      protectedGroups: Array.from({ length: 12 }, (_, index) => ({
        groupId: index + 1,
        title: `Protected Group ${index + 1} with a very long descriptive name for budget accounting`,
        domains: [
          "alpha.example.com",
          "beta.example.com",
          "gamma.example.com",
          "delta.example.com"
        ],
        sampleTitles: [
          "One long protected title that should materially affect serialized prompt size",
          "Another long protected title that should materially affect serialized prompt size",
          "Third protected title that should materially affect serialized prompt size"
        ],
        tabCount: 40
      }))
    };

    const batches = createBatchPlan(clusterTabs(promptInput.mutableTabs), promptInput);

    expect(batches.length).toBeGreaterThan(1);
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

  it("salvages hallucinated tab ids by dropping invalid references and leaving remaining tabs unassigned", () => {
    const plan = sanitizeOrganizationPlan(
      {
        reasoningSummary: "Mac apps and work.",
        categories: [
          { name: "Mac Apps", color: "blue", tabIds: [999, 1] },
          { name: "Work", color: "green", tabIds: [2] }
        ],
        unassignedTabIds: []
      },
      [1, 2, 3]
    );

    expect(plan.categories).toEqual([
      { name: "Mac Apps", color: "blue", tabIds: [1] },
      { name: "Work", color: "green", tabIds: [2] }
    ]);
    expect(plan.unassignedTabIds).toEqual([3]);
  });
});

describe("refinement planning", () => {
  it("builds provisional categories and materializes refined merges without name-based collapsing", () => {
    const tabs: TabContext[] = [
      {
        tabId: 1,
        windowId: 1,
        title: "Product spec",
        url: "https://docs.example.com/spec",
        domain: "docs.example.com",
        groupId: -1,
        isProtected: false,
        isPinned: false
      },
      {
        tabId: 2,
        windowId: 1,
        title: "Admin PTO policy",
        url: "https://hr.example.com/pto",
        domain: "hr.example.com",
        groupId: -1,
        isProtected: false,
        isPinned: false
      },
      {
        tabId: 3,
        windowId: 1,
        title: "Roadmap planning",
        url: "https://docs.example.com/roadmap",
        domain: "docs.example.com",
        groupId: -1,
        isProtected: false,
        isPinned: false
      }
    ];
    const batchResults = [
      {
        reasoningSummary: "Batch one.",
        categories: [{ name: "Work", color: "blue" as const, tabIds: [1, 3] }],
        unassignedTabIds: []
      },
      {
        reasoningSummary: "Batch two.",
        categories: [{ name: "Work", color: "red" as const, tabIds: [2] }],
        unassignedTabIds: []
      }
    ];
    const provisional = buildProvisionalCategories(batchResults, tabs);
    const refinementPrompt = buildRefinementPrompt(provisional);

    expect(refinementPrompt.userPrompt).toContain("provisionalCategories");

    const refinement = validateRefinedCategoryPlan(
      {
        reasoningSummary: "Separate docs from admin.",
        categories: [
          {
            name: "Product Docs",
            color: "blue",
            provisionalCategoryIds: [provisional[0].provisionalCategoryId]
          },
          {
            name: "HR Admin",
            color: "red",
            provisionalCategoryIds: [provisional[1].provisionalCategoryId]
          }
        ]
      },
      provisional.map((category) => category.provisionalCategoryId)
    );

    const plan = materializeRefinedPlan(
      refinement,
      provisional,
      [1, 2, 3],
      batchResults
    );

    expect(plan.categories).toEqual([
      { name: "Product Docs", color: "blue", tabIds: [1, 3] },
      { name: "HR Admin", color: "red", tabIds: [2] }
    ]);
  });
});
