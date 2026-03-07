import { useEffect, useMemo, useState } from "react";
import type { BackgroundEvent, ProgressUpdate } from "../shared/messages";
import { sendBackgroundMessage } from "../shared/messages";
import { DEFAULT_SETTINGS, GROUP_COLORS } from "../shared/types";
import type {
  ExtensionSettings,
  GenerateOrganizationPlanResult,
  LoadTabsForPreviewResult,
  RunScope
} from "../shared/types";

type Status =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string };

function stringifyList(values: string[]) {
  return values.join("\n");
}

function parseList(value: string) {
  return Array.from(
    new Set(
      value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function formatGroupLabel(group: LoadTabsForPreviewResult["liveGroups"][number]) {
  const title = group.title.trim() || "Untitled group";
  return `${title} · ${group.tabCount} tabs`;
}

function summarizePreview(preview: LoadTabsForPreviewResult | GenerateOrganizationPlanResult | null) {
  if (!preview) {
    return {
      totalTabs: 0,
      mutableTabs: 0,
      protectedTabs: 0
    };
  }

  return {
    totalTabs: preview.tabs.length,
    mutableTabs: preview.tabs.filter((tab) => !tab.isProtected).length,
    protectedTabs: preview.tabs.filter((tab) => tab.isProtected).length
  };
}

function formatProgressMeta(entry: ProgressUpdate) {
  const parts: string[] = [];

  if (
    typeof entry.currentBatch === "number" &&
    typeof entry.totalBatches === "number"
  ) {
    parts.push(`batch ${entry.currentBatch}/${entry.totalBatches}`);
  }

  if (typeof entry.tabCount === "number") {
    parts.push(`${entry.tabCount} tabs`);
  }

  return parts.join(" · ");
}

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [defaultCategoriesText, setDefaultCategoriesText] = useState("");
  const [protectedTitlesText, setProtectedTitlesText] = useState("");
  const [scope, setScope] = useState<RunScope>("currentWindow");
  const [runCategoriesText, setRunCategoriesText] = useState("");
  const [previewContext, setPreviewContext] = useState<LoadTabsForPreviewResult | null>(null);
  const [planResult, setPlanResult] = useState<GenerateOrganizationPlanResult | null>(null);
  const [selectedProtectedGroupIds, setSelectedProtectedGroupIds] = useState<number[]>([]);
  const [status, setStatus] = useState<Status>({
    kind: "idle",
    message: "Load tabs, generate a preview, then apply the grouped layout."
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [currentWindowId, setCurrentWindowId] = useState<number | undefined>();
  const [progressLog, setProgressLog] = useState<ProgressUpdate[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [pendingRefresh, setPendingRefresh] = useState(false);

  const previewSummary = useMemo(
    () => summarizePreview(planResult ?? previewContext),
    [planResult, previewContext]
  );

  useEffect(() => {
    let cancelled = false;

    // Hold a port to the background service worker so Chrome doesn't suspend it
    // while the side panel is open (MV3 workers die after ~30s otherwise).
    const keepalivePort = chrome.runtime.connect({ name: "sidepanel-keepalive" });

    const bootstrap = async () => {
      try {
        const window = await chrome.windows.getCurrent();
        const loadedSettings = await sendBackgroundMessage({ type: "getSettings" });

        if (cancelled) {
          return;
        }

        setCurrentWindowId(window.id);
        setSettings(loadedSettings);
        setDefaultCategoriesText(stringifyList(loadedSettings.defaultCategories));
        setProtectedTitlesText(stringifyList(loadedSettings.protectedGroupTitles));
        setRunCategoriesText(stringifyList(loadedSettings.defaultCategories));

        const initialPreview = await sendBackgroundMessage({
          type: "loadTabsForPreview",
          options: {
            scope: "currentWindow",
            categoriesMode: "hybrid",
            currentWindowId: window.id
          }
        });

        if (cancelled) {
          return;
        }

        setPreviewContext(initialPreview);
        setSelectedProtectedGroupIds(initialPreview.selectedProtectedGroupIds);
      } catch (error) {
        if (!cancelled) {
          setStatus({
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to load the extension state."
          });
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      keepalivePort.disconnect();
    };
  }, []);

  // Trigger a preview refresh after apply/undo complete (delivered via progress events).
  useEffect(() => {
    if (!pendingRefresh) {
      return;
    }

    setPendingRefresh(false);
    void refreshPreviewContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRefresh]);

  useEffect(() => {
    const listener = (message: BackgroundEvent) => {
      if (message?.type !== "progressUpdate") {
        return;
      }

      if (message.update.runId) {
        if (!activeRunId) {
          setActiveRunId(message.update.runId);
        } else if (message.update.runId !== activeRunId) {
          return;
        }
      }

      setProgressLog((current) => [...current.slice(-19), message.update]);
      setStatus({
        kind:
          message.update.phase === "error" || message.update.state === "failed"
            ? "error"
            : message.update.phase === "complete" || message.update.state === "complete"
              ? "success"
              : "info",
        message: message.update.message
      });

      // Generate preview: result arrives embedded in the progress event.
      if (message.update.result) {
        setPlanResult(message.update.result);
        setPreviewContext(message.update.result);
        setSelectedProtectedGroupIds(message.update.result.selectedProtectedGroupIds);
        setStatus({
          kind: "success",
          message:
            message.update.result.warnings[0] ?? "Preview generated. Review categories before applying."
        });
        setBusyAction(null);
      }
      if (
        (message.update.phase === "error" || message.update.state === "failed") &&
        message.update.runId === activeRunId
      ) {
        setBusyAction(null);
      }

      // Apply / undo: results arrive via progress "complete" (no runId on these runs).
      if (
        message.update.phase === "complete" &&
        !message.update.runId
      ) {
        setBusyAction((current) => {
          if (current === "apply") {
            setPlanResult(null);
            setPendingRefresh(true);
          } else if (current === "undo") {
            setPlanResult(null);
            setPendingRefresh(true);
          }
          return null;
        });
      }

      // Apply / undo error: clear busy state.
      if (
        (message.update.phase === "error" || message.update.state === "failed") &&
        !message.update.runId
      ) {
        setBusyAction(null);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [activeRunId]);

  function beginTrackedAction(action: string, initialMessage: string) {
    setBusyAction(action);
    setActiveRunId(null);
    setProgressLog([
      {
        phase: "loading_tabs",
        message: initialMessage,
        timestamp: new Date().toISOString()
      }
    ]);
    setStatus({ kind: "info", message: initialMessage });
  }

  async function refreshPreviewContext(nextScope = scope) {
    beginTrackedAction("refresh", "Refreshing live tabs and groups...");

    try {
      const result = await sendBackgroundMessage({
        type: "loadTabsForPreview",
        options: {
          scope: nextScope,
          categoriesMode: "hybrid",
          currentWindowId,
          protectedGroupIdsOverride: selectedProtectedGroupIds,
          protectedGroupTitlesOverride: parseList(protectedTitlesText)
        }
      });
      setPreviewContext(result);
      setPlanResult(null);
      setSelectedProtectedGroupIds(result.selectedProtectedGroupIds);
      setStatus({
        kind: "success",
        message:
          result.warnings[0] ?? `Loaded ${result.tabs.length} tabs for ${nextScope === "allWindows" ? "all windows" : "the current window"}.`
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to refresh tabs."
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveSettings() {
    beginTrackedAction("save", "Saving settings...");

    try {
      const nextSettings = await sendBackgroundMessage({
        type: "saveSettings",
        settings: {
          openRouterApiKey: settings.openRouterApiKey,
          modelId: settings.modelId,
          defaultCategories: parseList(defaultCategoriesText),
          protectedGroupTitles: parseList(protectedTitlesText)
        }
      });
      setSettings(nextSettings);
      setDefaultCategoriesText(stringifyList(nextSettings.defaultCategories));
      setProtectedTitlesText(stringifyList(nextSettings.protectedGroupTitles));
      setStatus({ kind: "success", message: "Settings saved locally on this browser." });
      await refreshPreviewContext();
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to save settings."
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleGeneratePreview() {
    beginTrackedAction("generate", "Generating an LLM preview...");

    try {
      const { runId } = await sendBackgroundMessage({
        type: "generateOrganizationPlan",
        options: {
          scope,
          categoriesMode: "hybrid",
          currentWindowId,
          runCategories: parseList(runCategoriesText),
          protectedGroupIdsOverride: selectedProtectedGroupIds,
          protectedGroupTitlesOverride: parseList(protectedTitlesText)
        }
      });
      setActiveRunId(runId);
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to generate a preview."
      });
      setBusyAction(null);
    }
  }

  async function handleApplyPreview() {
    if (!planResult) {
      setStatus({ kind: "error", message: "Generate a preview before applying changes." });
      return;
    }

    beginTrackedAction("apply", "Applying grouped tab layout...");

    try {
      // sendBackgroundMessage now returns an immediate ack ({}).
      // The real progress and completion come through progressUpdate events.
      await sendBackgroundMessage({
        type: "applyOrganizationPlan",
        options: {
          scope,
          categoriesMode: "hybrid",
          currentWindowId,
          runCategories: parseList(runCategoriesText),
          protectedGroupIdsOverride: selectedProtectedGroupIds,
          protectedGroupTitlesOverride: parseList(protectedTitlesText)
        },
        plan: planResult.plan,
        tabs: planResult.tabs
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to apply the preview."
      });
      setBusyAction(null);
    }
  }

  async function handleUndo() {
    beginTrackedAction("undo", "Restoring the previous tab layout...");

    try {
      // sendBackgroundMessage now returns an immediate ack ({}).
      // The real progress and completion come through progressUpdate events.
      await sendBackgroundMessage({ type: "undoLastOrganization" });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Undo failed."
      });
      setBusyAction(null);
    }
  }

  const liveGroups = previewContext?.liveGroups ?? [];

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Chrome tab grouping via OpenRouter</p>
          <h1>Tab Tonic</h1>
          <p className="hero-copy">
            Review a model-generated grouping plan before touching your browser.
          </p>
        </div>
        <div className="hero-grid">
          <article>
            <strong>{previewSummary.totalTabs}</strong>
            <span>Total tabs</span>
          </article>
          <article>
            <strong>{previewSummary.mutableTabs}</strong>
            <span>Mutable</span>
          </article>
          <article>
            <strong>{previewSummary.protectedTabs}</strong>
            <span>Protected</span>
          </article>
        </div>
      </header>

      <section className="status-card" data-kind={status.kind}>
        <strong>{status.kind === "error" ? "Issue" : status.kind === "success" ? "Ready" : "Status"}</strong>
        <p>{status.message}</p>
      </section>

      <section className="panel">
        <div className="section-title">
          <h2>Activity</h2>
          <span className="helper-text">
            Long preview runs report each stage here.
          </span>
        </div>
        <div className="activity-log">
          {progressLog.length === 0 ? (
            <p className="helper-text">No activity yet.</p>
          ) : (
            progressLog.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className="activity-item">
                <strong>{new Date(entry.timestamp).toLocaleTimeString()}</strong>
                {formatProgressMeta(entry) ? (
                  <span className="activity-meta">{formatProgressMeta(entry)}</span>
                ) : null}
                <p>{entry.message}</p>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="panel-grid">
        <article className="panel">
          <div className="section-title">
            <h2>Settings</h2>
            <button type="button" onClick={handleSaveSettings} disabled={busyAction !== null}>
              {busyAction === "save" ? "Saving..." : "Save"}
            </button>
          </div>

          <label>
            <span>OpenRouter API key</span>
            <input
              type="password"
              value={settings.openRouterApiKey}
              placeholder="sk-or-v1-..."
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  openRouterApiKey: event.target.value
                }))
              }
            />
          </label>

          <label>
            <span>Model ID</span>
            <input
              type="text"
              value={settings.modelId}
              placeholder="anthropic/claude-3.7-sonnet"
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  modelId: event.target.value
                }))
              }
            />
          </label>

          <label>
            <span>Default categories</span>
            <textarea
              rows={4}
              value={defaultCategoriesText}
              placeholder={"Research\nWork\nShopping"}
              onChange={(event) => setDefaultCategoriesText(event.target.value)}
            />
          </label>

          <label>
            <span>Saved protected group titles</span>
            <textarea
              rows={4}
              value={protectedTitlesText}
              placeholder={"Reading queue\nCurrent sprint"}
              onChange={(event) => setProtectedTitlesText(event.target.value)}
            />
          </label>
        </article>

        <article className="panel">
          <div className="section-title">
            <h2>Run</h2>
            <button
              type="button"
              onClick={() => void refreshPreviewContext()}
              disabled={busyAction !== null}
            >
              {busyAction === "refresh" ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          <div className="scope-picker">
            <button
              type="button"
              className={scope === "currentWindow" ? "active" : ""}
              onClick={() => {
                setScope("currentWindow");
                void refreshPreviewContext("currentWindow");
              }}
              disabled={busyAction !== null}
            >
              Current window
            </button>
            <button
              type="button"
              className={scope === "allWindows" ? "active" : ""}
              onClick={() => {
                setScope("allWindows");
                void refreshPreviewContext("allWindows");
              }}
              disabled={busyAction !== null}
            >
              All windows
            </button>
          </div>

          <label>
            <span>Run categories override</span>
            <textarea
              rows={4}
              value={runCategoriesText}
              placeholder={"Leave empty for LLM-generated categories"}
              onChange={(event) => setRunCategoriesText(event.target.value)}
            />
          </label>

          <div className="action-row">
            <button type="button" onClick={handleGeneratePreview} disabled={busyAction !== null}>
              {busyAction === "generate" ? "Generating..." : "Generate preview"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={handleApplyPreview}
              disabled={busyAction !== null || !planResult}
            >
              {busyAction === "apply" ? "Applying..." : "Apply preview"}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={handleUndo}
              disabled={busyAction !== null}
            >
              {busyAction === "undo" ? "Undoing..." : "Undo"}
            </button>
          </div>
        </article>
      </section>

      <section className="panel">
        <div className="section-title">
          <h2>Protected groups</h2>
          <span className="helper-text">
            Saved defaults match by title. Unnamed groups can be protected only for this run.
          </span>
        </div>

        {previewContext?.ambiguousProtectedTitles.length ? (
          <div className="warning-banner">
            Resolve duplicate protected titles by selecting the exact live groups below:{" "}
            {previewContext.ambiguousProtectedTitles.join(", ")}
          </div>
        ) : null}

        <div className="group-list">
          {liveGroups.length === 0 ? (
            <p className="helper-text">No live tab groups found in the selected scope.</p>
          ) : (
            liveGroups.map((group) => {
              const checked = selectedProtectedGroupIds.includes(group.groupId);

              return (
                <label key={group.groupId} className="group-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      setSelectedProtectedGroupIds((current) => {
                        if (event.target.checked) {
                          return Array.from(new Set([...current, group.groupId]));
                        }

                        return current.filter((groupId) => groupId !== group.groupId);
                      });
                    }}
                  />
                  <div>
                    <strong>{formatGroupLabel(group)}</strong>
                    <p>
                      {group.color} {group.isAmbiguousDefault ? "· duplicate saved title" : ""}{" "}
                      {group.canBeSaved ? "" : "· unnamed groups can only be protected per run"}
                    </p>
                  </div>
                </label>
              );
            })
          )}
        </div>
      </section>

      <section className="panel preview-panel">
        <div className="section-title">
          <h2>Preview</h2>
          <span className="helper-text">
            {planResult ? "Review before applying." : "Generate a preview to inspect model output."}
          </span>
        </div>

        {planResult ? (
          <>
            <div className="reasoning-card">
              <strong>Model summary</strong>
              <p>{planResult.plan.reasoningSummary}</p>
            </div>

            <div className="category-grid">
              {planResult.plan.categories.map((category) => (
                <article key={category.name} className="category-card">
                  <header>
                    <span
                      className="color-chip"
                      style={{
                        background:
                          {
                            grey: "#67768d",
                            blue: "#377dff",
                            red: "#f04b68",
                            yellow: "#d4a935",
                            green: "#33a36b",
                            pink: "#f46bb2",
                            purple: "#8467e6",
                            cyan: "#37a6c2",
                            orange: "#db7b3f"
                          }[category.color]
                      }}
                    />
                    <div>
                      <strong>{category.name}</strong>
                      <p>
                        {category.tabIds.length} tabs · native group color {category.color}
                      </p>
                    </div>
                  </header>
                  <ul>
                    {category.tabIds.map((tabId) => {
                      const tab = planResult.tabs.find((candidate) => candidate.tabId === tabId);

                      return (
                        <li key={tabId}>
                          <span>{tab?.title ?? `Tab ${tabId}`}</span>
                          <small>{tab?.domain || tab?.url || "No URL"}</small>
                        </li>
                      );
                    })}
                  </ul>
                </article>
              ))}
            </div>

            {planResult.plan.unassignedTabIds.length > 0 ? (
              <div className="unassigned-card">
                <strong>Left unassigned</strong>
                <ul>
                  {planResult.plan.unassignedTabIds.map((tabId) => {
                    const tab = planResult.tabs.find((candidate) => candidate.tabId === tabId);

                    return <li key={tabId}>{tab?.title ?? `Tab ${tabId}`}</li>;
                  })}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            <p>Preview cards will appear here after the model returns a valid grouping plan.</p>
            <p className="helper-text">Available colors: {GROUP_COLORS.join(", ")}</p>
          </div>
        )}
      </section>
    </main>
  );
}
