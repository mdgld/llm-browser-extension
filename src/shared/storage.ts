import type { ExtensionSettings, LastOperationSnapshot } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SETTINGS_KEY = "settings";
const LAST_OPERATION_KEY = "lastOperation";

function normalizeList(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as
    | Partial<ExtensionSettings>
    | undefined;

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    defaultCategories: normalizeList(stored?.defaultCategories ?? DEFAULT_SETTINGS.defaultCategories),
    protectedGroupTitles: normalizeList(
      stored?.protectedGroupTitles ?? DEFAULT_SETTINGS.protectedGroupTitles
    )
  };
}

export async function saveSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const sanitized: ExtensionSettings = {
    openRouterApiKey: settings.openRouterApiKey.trim(),
    modelId: settings.modelId.trim(),
    defaultCategories: normalizeList(settings.defaultCategories),
    protectedGroupTitles: normalizeList(settings.protectedGroupTitles)
  };

  await chrome.storage.local.set({ [SETTINGS_KEY]: sanitized });
  return sanitized;
}

export async function getLastOperation(): Promise<LastOperationSnapshot | null> {
  const stored = (await chrome.storage.local.get(LAST_OPERATION_KEY))[LAST_OPERATION_KEY] as
    | LastOperationSnapshot
    | undefined;

  return stored ?? null;
}

export async function saveLastOperation(snapshot: LastOperationSnapshot): Promise<void> {
  await chrome.storage.local.set({ [LAST_OPERATION_KEY]: snapshot });
}

export async function clearLastOperation(): Promise<void> {
  await chrome.storage.local.remove(LAST_OPERATION_KEY);
}
