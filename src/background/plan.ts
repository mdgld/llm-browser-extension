import type {
  GroupColor,
  LiveTabGroup,
  OrganizationCategory,
  OrganizationPlan,
  TabContext
} from "../shared/types";
import { GROUP_COLORS, isGroupColor } from "../shared/types";

export interface ProtectedGroupSummary {
  groupId: number;
  title: string;
  domains: string[];
  sampleTitles: string[];
  tabCount: number;
}

export interface CompactTabInput {
  tabId: number;
  title: string;
  domain: string;
  url?: string;
  sourceGroupTitle?: string;
}

export interface PromptInput {
  mutableTabs: TabContext[];
  protectedGroups: ProtectedGroupSummary[];
  preferredCategories: string[];
}

export interface TabCluster {
  clusterId: string;
  tabs: CompactTabInput[];
  domains: string[];
  keywords: string[];
  sourceGroupTitle?: string;
}

export interface BatchPlan {
  batchId: string;
  clusters: TabCluster[];
  tabs: CompactTabInput[];
  estimatedPromptChars: number;
}

export interface BatchPreviewResult {
  categories: OrganizationCategory[];
  unassignedTabIds: number[];
  reasoningSummary: string;
}

export interface ProvisionalCategory {
  provisionalCategoryId: string;
  name: string;
  color: GroupColor;
  tabIds: number[];
  domains: string[];
  sampleTitles: string[];
  tabCount: number;
}

export interface RefinedCategorySelection {
  name: string;
  color: GroupColor;
  provisionalCategoryIds: string[];
}

export interface RefinedCategoryPlan {
  categories: RefinedCategorySelection[];
  reasoningSummary: string;
}

const MAX_TABS_PER_BATCH = 140;
const MAX_PROMPT_CHARS_PER_BATCH = 18_000;
const MAX_TITLE_LENGTH = 100;
const MAX_PROTECTED_SAMPLES = 3;
const MAX_PROTECTED_DOMAINS = 4;
const MAX_REFINED_CATEGORY_SAMPLES = 4;
const MAX_REFINED_CATEGORY_DOMAINS = 4;
const MAX_BATCHES = 80;
/** Per-batch cap so the model does not emit hundreds of micro-categories when auto-generating. */
const MAX_CATEGORIES_PER_BATCH = 12;
/** Refinement step should merge down to a small number of broad groups. */
const MAX_FINAL_CATEGORIES = 15;

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
      maxItems: MAX_CATEGORIES_PER_BATCH,
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

const REFINEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categories", "reasoningSummary"],
  properties: {
    reasoningSummary: { type: "string" },
    categories: {
      type: "array",
      maxItems: MAX_FINAL_CATEGORIES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "color", "provisionalCategoryIds"],
        properties: {
          name: { type: "string" },
          color: {
            type: "string",
            enum: [...GROUP_COLORS]
          },
          provisionalCategoryIds: {
            type: "array",
            items: { type: "string" }
          }
        }
      }
    }
  }
} as const;

export function getPlanSchema() {
  return PLAN_SCHEMA;
}

export function getRefinementSchema() {
  return REFINEMENT_SCHEMA;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function truncateTitle(title: string) {
  const normalized = normalizeWhitespace(title);
  return normalized.length > MAX_TITLE_LENGTH
    ? `${normalized.slice(0, MAX_TITLE_LENGTH - 1)}...`
    : normalized;
}

function tokenizeTitle(title: string) {
  return normalizeWhitespace(title)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token));
}

function sourceGroupKey(tab: TabContext) {
  return tab.groupTitle?.trim().toLowerCase() || "";
}

function clusterKey(tab: TabContext) {
  const domain = tab.domain || "unknown-domain";
  const group = sourceGroupKey(tab);
  const keywords = tokenizeTitle(tab.title).slice(0, 2).join("-");
  return [domain, group, keywords].filter(Boolean).join("|");
}

function compactTab(tab: TabContext): CompactTabInput {
  const title = truncateTitle(tab.title);
  const domain = tab.domain || "unknown-domain";
  const titleTokens = tokenizeTitle(title);
  const weakContext =
    !domain ||
    domain === "unknown-domain" ||
    titleTokens.length < 2 ||
    title.toLowerCase().includes("new tab");

  return {
    tabId: tab.tabId,
    title,
    domain,
    url: weakContext ? tab.url : undefined,
    sourceGroupTitle: tab.groupTitle?.trim() || undefined
  };
}

function summarizeProtectedGroups(
  tabs: TabContext[],
  selectedProtectedGroupIds: number[],
  liveGroups: LiveTabGroup[]
): ProtectedGroupSummary[] {
  const protectedGroupIds = new Set(selectedProtectedGroupIds);
  const protectedTabs = tabs.filter((tab) => protectedGroupIds.has(tab.groupId));

  return liveGroups
    .filter((group) => protectedGroupIds.has(group.groupId))
    .map((group) => {
      const groupTabs = protectedTabs.filter((tab) => tab.groupId === group.groupId);
      const domains = Array.from(
        new Set(groupTabs.map((tab) => tab.domain).filter(Boolean))
      ).slice(0, MAX_PROTECTED_DOMAINS);
      const sampleTitles = groupTabs.slice(0, MAX_PROTECTED_SAMPLES).map((tab) => truncateTitle(tab.title));

      return {
        groupId: group.groupId,
        title: group.title || `Protected Group ${group.groupId}`,
        domains,
        sampleTitles,
        tabCount: groupTabs.length
      };
    });
}

export function buildPromptInput(
  tabs: TabContext[],
  selectedProtectedGroupIds: number[],
  liveGroups: LiveTabGroup[],
  preferredCategories: string[]
): PromptInput {
  return {
    mutableTabs: tabs.filter((tab) => !tab.isProtected),
    protectedGroups: summarizeProtectedGroups(tabs, selectedProtectedGroupIds, liveGroups),
    preferredCategories
  };
}

export function clusterTabs(tabs: TabContext[]): TabCluster[] {
  const clusters = new Map<string, CompactTabInput[]>();

  for (const tab of tabs) {
    const key = clusterKey(tab);
    const existing = clusters.get(key) ?? [];
    existing.push(compactTab(tab));
    clusters.set(key, existing);
  }

  return Array.from(clusters.entries())
    .map(([clusterId, clusterTabs]) => ({
      clusterId,
      tabs: clusterTabs.sort((left, right) => left.tabId - right.tabId),
      domains: Array.from(new Set(clusterTabs.map((tab) => tab.domain))).slice(0, 4),
      keywords: Array.from(
        new Set(clusterTabs.flatMap((tab) => tokenizeTitle(tab.title)).slice(0, 8))
      ).slice(0, 6),
      sourceGroupTitle: clusterTabs[0]?.sourceGroupTitle
    }))
    .sort((left, right) => {
      if (right.tabs.length !== left.tabs.length) {
        return right.tabs.length - left.tabs.length;
      }

      return left.clusterId.localeCompare(right.clusterId);
    });
}

function buildBatchPromptPayload(input: PromptInput, batch: BatchPlan) {
  const categoryGuidance =
    input.preferredCategories.length > 0
      ? `Prefer these category names when they fit: ${input.preferredCategories.join(", ")}.`
      : `Invent at most ${MAX_CATEGORIES_PER_BATCH} concise, broad category names (e.g. Work, Research, Shopping, Social, Entertainment, Reference). Use 5–10 categories when possible; do not create many narrow categories.`;

  return {
    instructions: [
      "Use every mutable tab at most once.",
      "Put tabs that do not fit in unassignedTabIds.",
      "Keep categories broad enough to avoid one-tab groups unless necessary.",
      categoryGuidance
    ],
    protectedGroups: input.protectedGroups,
    clusters: batch.clusters.map((cluster) => ({
      clusterId: cluster.clusterId,
      domains: cluster.domains,
      keywords: cluster.keywords,
      sourceGroupTitle: cluster.sourceGroupTitle,
      tabCount: cluster.tabs.length
    })),
    mutableTabs: [...batch.tabs].sort((left, right) => left.tabId - right.tabId).map((tab) => ({
      tabId: tab.tabId,
      title: tab.title,
      domain: tab.domain,
      ...(tab.url ? { url: tab.url } : {}),
      ...(tab.sourceGroupTitle ? { sourceGroupTitle: tab.sourceGroupTitle } : {})
    }))
  };
}

function estimateBatchPromptChars(input: PromptInput, batch: BatchPlan) {
  const systemPrompt =
    "You organize browser tabs into concise, mutually exclusive Chrome tab groups. Respect protected groups as context only. Return JSON only.";
  return systemPrompt.length + JSON.stringify(buildBatchPromptPayload(input, batch), null, 2).length;
}

function splitOversizedCluster(cluster: TabCluster, input: PromptInput): TabCluster[] {
  const initialBatch: BatchPlan = {
    batchId: "probe",
    clusters: [cluster],
    tabs: cluster.tabs,
    estimatedPromptChars: 0
  };

  if (
    cluster.tabs.length <= MAX_TABS_PER_BATCH &&
    estimateBatchPromptChars(input, initialBatch) <= MAX_PROMPT_CHARS_PER_BATCH
  ) {
    return [cluster];
  }

  const chunks: TabCluster[] = [];
  let index = 0;
  let chunkNumber = 1;

  while (index < cluster.tabs.length) {
    const currentTabs: CompactTabInput[] = [];

    while (index < cluster.tabs.length) {
      const nextTab = cluster.tabs[index];
      const trialTabs = [...currentTabs, nextTab];
      const trialCluster: TabCluster = {
        ...cluster,
        clusterId: `${cluster.clusterId}#${chunkNumber}`,
        tabs: trialTabs
      };
      const trialBatch: BatchPlan = {
        batchId: "probe",
        clusters: [trialCluster],
        tabs: trialTabs,
        estimatedPromptChars: 0
      };
      const wouldOverflow =
        currentTabs.length > 0 &&
        (trialTabs.length > MAX_TABS_PER_BATCH ||
          estimateBatchPromptChars(input, trialBatch) > MAX_PROMPT_CHARS_PER_BATCH);

      if (wouldOverflow) {
        break;
      }

      currentTabs.push(nextTab);
      index += 1;
    }

    const chunk: TabCluster = {
      ...cluster,
      clusterId: `${cluster.clusterId}#${chunkNumber}`,
      tabs: currentTabs
    };

    const chunkBatch: BatchPlan = {
      batchId: "probe",
      clusters: [chunk],
      tabs: currentTabs,
      estimatedPromptChars: 0
    };

    chunks.push({
      ...chunk,
      tabs: currentTabs
    });
    chunkBatch.estimatedPromptChars = estimateBatchPromptChars(input, chunkBatch);
    chunkNumber += 1;
  }

  return chunks;
}

export function createBatchPlan(clusters: TabCluster[], input: PromptInput): BatchPlan[] {
  const normalizedClusters = clusters.flatMap((cluster) => splitOversizedCluster(cluster, input));
  const batches: BatchPlan[] = [];
  let currentClusters: TabCluster[] = [];
  let currentTabs: CompactTabInput[] = [];
  let batchNumber = 1;

  for (const cluster of normalizedClusters) {
    const trialClusters = [...currentClusters, cluster];
    const trialTabs = [...currentTabs, ...cluster.tabs];
    const trialBatch: BatchPlan = {
      batchId: `batch-${batchNumber}`,
      clusters: trialClusters,
      tabs: trialTabs,
      estimatedPromptChars: 0
    };
    trialBatch.estimatedPromptChars = estimateBatchPromptChars(input, trialBatch);

    const wouldOverflow =
      currentTabs.length > 0 &&
      (trialTabs.length > MAX_TABS_PER_BATCH ||
        trialBatch.estimatedPromptChars > MAX_PROMPT_CHARS_PER_BATCH);

    if (wouldOverflow) {
      const finalizedBatch: BatchPlan = {
        batchId: `batch-${batchNumber}`,
        clusters: currentClusters,
        tabs: currentTabs,
        estimatedPromptChars: 0
      };
      finalizedBatch.estimatedPromptChars = estimateBatchPromptChars(input, finalizedBatch);
      batches.push(finalizedBatch);
      batchNumber += 1;
      currentClusters = [cluster];
      currentTabs = [...cluster.tabs];
      continue;
    }

    currentClusters = trialClusters;
    currentTabs = trialTabs;
  }

  if (currentTabs.length > 0) {
    const finalizedBatch: BatchPlan = {
      batchId: `batch-${batchNumber}`,
      clusters: currentClusters,
      tabs: currentTabs,
      estimatedPromptChars: 0
    };
    finalizedBatch.estimatedPromptChars = estimateBatchPromptChars(input, finalizedBatch);
    batches.push(finalizedBatch);
  }

  if (batches.length > MAX_BATCHES) {
    throw new Error(
      `Preview would require ${batches.length} model batches, which exceeds the safety limit of ${MAX_BATCHES}. Narrow the scope or protect more groups.`
    );
  }

  return batches;
}

export function buildOpenRouterPrompt(input: PromptInput, batch: BatchPlan) {
  const systemPrompt =
    "You organize browser tabs into concise, mutually exclusive Chrome tab groups. " +
    "Respect protected groups as context only. Return JSON only.";
  const userPrompt = JSON.stringify(buildBatchPromptPayload(input, batch), null, 2);

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

export function sanitizeOrganizationPlan(
  candidate: unknown,
  mutableTabIds: number[]
): OrganizationPlan {
  const mutableIdSet = new Set(mutableTabIds);

  if (!candidate || typeof candidate !== "object") {
    throw new Error("LLM response must be a JSON object.");
  }

  const raw = candidate as Record<string, unknown>;
  const categories = Array.isArray(raw.categories) ? raw.categories : [];
  const unassigned = Array.isArray(raw.unassignedTabIds) ? raw.unassignedTabIds : [];
  const reasoningSummary =
    typeof raw.reasoningSummary === "string" ? raw.reasoningSummary.trim() : "Tabs grouped by topic.";
  const seenAssignments = new Set<number>();

  const normalizedCategories = categories
    .map((category) => {
      if (!category || typeof category !== "object") {
        return null;
      }

      const record = category as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const color = typeof record.color === "string" ? record.color : "grey";
      const tabIds = Array.isArray(record.tabIds) ? record.tabIds : [];

      if (!name) {
        return null;
      }

      const normalizedTabIds = tabIds
        .filter((tabId): tabId is number => typeof tabId === "number" && mutableIdSet.has(tabId))
        .filter((tabId) => {
          if (seenAssignments.has(tabId)) {
            return false;
          }

          seenAssignments.add(tabId);
          return true;
        });

      if (normalizedTabIds.length === 0) {
        return null;
      }

      return {
        name,
        color: normalizeColor(color, name),
        tabIds: normalizedTabIds
      };
    })
    .filter((category): category is OrganizationCategory => Boolean(category));

  const normalizedUnassigned = unassigned
    .filter((tabId): tabId is number => typeof tabId === "number" && mutableIdSet.has(tabId))
    .filter((tabId) => !seenAssignments.has(tabId));

  for (const tabId of mutableIdSet) {
    if (!seenAssignments.has(tabId) && !normalizedUnassigned.includes(tabId)) {
      normalizedUnassigned.push(tabId);
    }
  }

  return {
    categories: normalizedCategories,
    unassignedTabIds: normalizedUnassigned.sort((left, right) => left - right),
    reasoningSummary
  };
}

export function buildProvisionalCategories(results: BatchPreviewResult[], tabs: TabContext[]) {
  const tabMap = new Map(tabs.map((tab) => [tab.tabId, tab]));
  let categoryIndex = 1;

  return results.flatMap((result) =>
    result.categories.map((category) => {
      const categoryTabs = category.tabIds
        .map((tabId) => tabMap.get(tabId))
        .filter((tab): tab is TabContext => Boolean(tab));
      const domains = Array.from(
        new Set(categoryTabs.map((tab) => tab.domain).filter(Boolean))
      ).slice(0, MAX_REFINED_CATEGORY_DOMAINS);
      const sampleTitles = categoryTabs
        .slice(0, MAX_REFINED_CATEGORY_SAMPLES)
        .map((tab) => truncateTitle(tab.title));

      return {
        provisionalCategoryId: `cat-${categoryIndex++}`,
        name: normalizeWhitespace(category.name),
        color: category.color,
        tabIds: [...category.tabIds].sort((left, right) => left - right),
        domains,
        sampleTitles,
        tabCount: category.tabIds.length
      };
    })
  );
}

export function buildRefinementPrompt(provisionalCategories: ProvisionalCategory[]) {
  const systemPrompt =
    "You refine provisional browser tab categories. Merge only categories that are clearly about the same topic. Return JSON only.";
  const userPrompt = JSON.stringify(
    {
      instructions: [
        "You may merge provisional categories, rename them, or leave them separate.",
        `Produce at most ${MAX_FINAL_CATEGORIES} final categories. Merge aggressively so the result has 8–15 broad groups (e.g. Work, Research, Shopping, Social), not dozens or hundreds.`,
        "Each provisional category must appear in exactly one final category.",
        "Do not invent or drop provisionalCategoryIds.",
        "Prefer semantically precise names over generic names like Work or Misc unless the content truly matches."
      ],
      provisionalCategories: provisionalCategories.map((category) => ({
        provisionalCategoryId: category.provisionalCategoryId,
        name: category.name,
        color: category.color,
        tabCount: category.tabCount,
        domains: category.domains,
        sampleTitles: category.sampleTitles
      }))
    },
    null,
    2
  );

  return { systemPrompt, userPrompt };
}

export function validateRefinedCategoryPlan(
  candidate: unknown,
  provisionalCategoryIds: string[]
): RefinedCategoryPlan {
  const provisionalIdSet = new Set(provisionalCategoryIds);

  if (!candidate || typeof candidate !== "object") {
    throw new Error("Refinement response must be a JSON object.");
  }

  const raw = candidate as Record<string, unknown>;
  const categories = raw.categories;
  const reasoningSummary = raw.reasoningSummary;

  if (!Array.isArray(categories) || typeof reasoningSummary !== "string") {
    throw new Error("Refinement response is missing required fields.");
  }

  const seenIds = new Set<string>();
  const normalizedCategories = categories.map((category, index) => {
    if (!category || typeof category !== "object") {
      throw new Error(`Refinement category ${index + 1} is invalid.`);
    }

    const record = category as Record<string, unknown>;
    const name = typeof record.name === "string" ? normalizeWhitespace(record.name) : "";
    const color = typeof record.color === "string" ? record.color : "grey";
    const ids = record.provisionalCategoryIds;

    if (!name || !Array.isArray(ids) || ids.length === 0) {
      throw new Error(`Refinement category ${index + 1} is missing required fields.`);
    }

    const normalizedIds = ids.map((id) => {
      if (typeof id !== "string" || !provisionalIdSet.has(id)) {
        throw new Error(`Refinement category "${name}" references an unknown provisional category.`);
      }

      if (seenIds.has(id)) {
        throw new Error(`Provisional category ${id} was assigned more than once in refinement.`);
      }

      seenIds.add(id);
      return id;
    });

    return {
      name,
      color: normalizeColor(color, name),
      provisionalCategoryIds: normalizedIds
    };
  });

  for (const provisionalId of provisionalIdSet) {
    if (!seenIds.has(provisionalId)) {
      throw new Error(`Refinement omitted provisional category ${provisionalId}.`);
    }
  }

  return {
    categories: normalizedCategories,
    reasoningSummary: normalizeWhitespace(reasoningSummary) || "Refined provisional categories."
  };
}

export function materializeRefinedPlan(
  refinement: RefinedCategoryPlan,
  provisionalCategories: ProvisionalCategory[],
  mutableTabIds: number[],
  batchResults: BatchPreviewResult[]
): OrganizationPlan {
  const provisionalMap = new Map(
    provisionalCategories.map((category) => [category.provisionalCategoryId, category])
  );
  const mutableIdSet = new Set(mutableTabIds);
  const assigned = new Set<number>();
  const categories = refinement.categories.map((category) => {
    const tabIds = category.provisionalCategoryIds
      .flatMap((provisionalCategoryId) => provisionalMap.get(provisionalCategoryId)?.tabIds ?? [])
      .filter((tabId, index, array) => array.indexOf(tabId) === index)
      .filter((tabId) => mutableIdSet.has(tabId))
      .sort((left, right) => left - right);

    for (const tabId of tabIds) {
      assigned.add(tabId);
    }

    return {
      name: category.name,
      color: category.color,
      tabIds
    };
  });

  const unassignedFromBatches = batchResults.flatMap((result) => result.unassignedTabIds);
  const unassigned = Array.from(
    new Set(
      [
        ...unassignedFromBatches.filter((tabId) => !assigned.has(tabId) && mutableIdSet.has(tabId)),
        ...mutableTabIds.filter((tabId) => !assigned.has(tabId))
      ].sort((left, right) => left - right)
    )
  );

  return {
    categories: categories.filter((category) => category.tabIds.length > 0),
    unassignedTabIds: unassigned,
    reasoningSummary: refinement.reasoningSummary
  };
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "into",
  "about",
  "www",
  "com",
  "org",
  "net"
]);
