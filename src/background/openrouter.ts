import type { ExtensionSettings, OrganizationPlan } from "../shared/types";
import { buildOpenRouterPrompt, getPlanSchema, validateOrganizationPlan } from "./plan";
import type { PromptInput } from "./plan";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterMessage {
  role: "system" | "user";
  content: string;
}

function extractMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }

        return "";
      })
      .join("");
  }

  return "";
}

export async function generatePlanWithOpenRouter(
  settings: ExtensionSettings,
  input: PromptInput
): Promise<OrganizationPlan> {
  if (!settings.openRouterApiKey) {
    throw new Error("Add an OpenRouter API key before generating a preview.");
  }

  if (!settings.modelId) {
    throw new Error("Add an OpenRouter model ID before generating a preview.");
  }

  if (input.mutableTabs.length === 0) {
    return {
      categories: [],
      unassignedTabIds: [],
      reasoningSummary: "No mutable tabs are available for grouping."
    };
  }

  const { systemPrompt, userPrompt } = buildOpenRouterPrompt(input);
  const messages: OpenRouterMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  const response = await fetch(OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.openRouterApiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Tab Tonic"
    },
    body: JSON.stringify({
      model: settings.modelId,
      messages,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "tab_organization_plan",
          strict: true,
          schema: getPlanSchema()
        }
      },
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };
  const rawContent = extractMessageContent(payload.choices?.[0]?.message?.content);

  if (!rawContent) {
    throw new Error("OpenRouter returned an empty response.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error("OpenRouter returned invalid JSON.");
  }

  return validateOrganizationPlan(
    parsed,
    input.mutableTabs.map((tab) => tab.tabId)
  );
}
