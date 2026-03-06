import { describe, expect, it } from "vitest";
import { resolveProtectedGroups } from "./protection";

describe("protected group resolution", () => {
  it("marks duplicate saved titles as ambiguous until the user picks concrete live groups", () => {
    const result = resolveProtectedGroups({
      liveGroups: [
        {
          groupId: 10,
          title: "Reading Queue",
          color: "blue",
          collapsed: false,
          tabCount: 3,
          windowId: 1
        },
        {
          groupId: 11,
          title: "Reading Queue",
          color: "red",
          collapsed: true,
          tabCount: 2,
          windowId: 2
        },
        {
          groupId: 12,
          title: "Current sprint",
          color: "green",
          collapsed: false,
          tabCount: 4,
          windowId: 1
        },
        {
          groupId: 13,
          title: "",
          color: "grey",
          collapsed: false,
          tabCount: 1,
          windowId: 1
        }
      ],
      savedProtectedTitles: ["Reading Queue", "Current Sprint"]
    });

    expect(result.ambiguousProtectedTitles).toEqual(["Reading Queue"]);
    expect(result.selectedProtectedGroupIds).toEqual([12]);
    expect(result.liveGroups.find((group) => group.groupId === 13)?.canBeSaved).toBe(false);
    expect(result.liveGroups.find((group) => group.groupId === 10)?.isAmbiguousDefault).toBe(true);
  });

  it("uses explicit per-run group selections when provided", () => {
    const result = resolveProtectedGroups({
      liveGroups: [
        {
          groupId: 10,
          title: "Reading Queue",
          color: "blue",
          collapsed: false,
          tabCount: 3,
          windowId: 1
        },
        {
          groupId: 11,
          title: "Current sprint",
          color: "green",
          collapsed: false,
          tabCount: 4,
          windowId: 1
        }
      ],
      savedProtectedTitles: ["Current sprint"],
      overrideGroupIds: [10]
    });

    expect(result.selectedProtectedGroupIds).toEqual([10]);
    expect(result.liveGroups.find((group) => group.groupId === 10)?.isSelected).toBe(true);
    expect(result.liveGroups.find((group) => group.groupId === 11)?.isSelected).toBe(false);
  });
});
