import { describe, expect, it } from "vitest";
import type { LastOperationSnapshot } from "../shared/types";
import { buildRestorePlan } from "./snapshot";

describe("restore plan builder", () => {
  it("preserves tab order and group metadata while falling back missing windows", () => {
    const snapshot: LastOperationSnapshot = {
      createdAt: "2026-03-06T12:00:00.000Z",
      scope: "allWindows",
      createdGroupIds: [99],
      groups: [
        {
          originalGroupId: 7,
          title: "Research",
          color: "blue",
          collapsed: true
        }
      ],
      tabs: [
        {
          tabId: 102,
          originalWindowId: 1,
          originalIndex: 3,
          originalGroupId: -1
        },
        {
          tabId: 101,
          originalWindowId: 1,
          originalIndex: 1,
          originalGroupId: 7
        },
        {
          tabId: 201,
          originalWindowId: 2,
          originalIndex: 0,
          originalGroupId: 7
        }
      ]
    };

    const restorePlan = buildRestorePlan(snapshot, [1], 1);

    expect(restorePlan.tabMoves).toEqual([
      { tabId: 201, targetWindowId: 1, targetIndex: 0, originalGroupId: 7 },
      { tabId: 101, targetWindowId: 1, targetIndex: 1, originalGroupId: 7 },
      { tabId: 102, targetWindowId: 1, targetIndex: 3, originalGroupId: -1 }
    ]);
    expect(restorePlan.groupedTabs).toEqual([
      {
        originalGroupId: 7,
        title: "Research",
        color: "blue",
        collapsed: true,
        tabIds: [201, 101]
      }
    ]);
    expect(restorePlan.ungroupedTabIds).toEqual([102]);
  });
});
