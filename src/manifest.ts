import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "animusystems.skill-router",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Dynamic Skill Router",
  description:
    "Automatically assigns relevant skills to agents based on task content using TF-IDF keyword matching with optional LLM fallback.",
  author: "Animus Systems",
  categories: ["automation"],

  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "agents.read",
    "issues.read",
    "companies.read",
    "projects.read",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "jobs.schedule",
    "ui.dashboardWidget.register",
    "instance.settings.register",
  ],

  instanceConfigSchema: {
    type: "object" as const,
    properties: {
      enabled: { type: "boolean" as const, default: true, description: "Enable skill routing" },
      matchingMode: {
        type: "string" as const,
        enum: ["keyword", "llm", "hybrid"],
        default: "hybrid",
        description: "Matching strategy: keyword (free), llm, or hybrid (keyword first, LLM fallback)",
      },
      maxSkillsPerTask: {
        type: "number" as const,
        default: 5,
        description: "Maximum dynamic skills added per task",
      },
      keywordScoreThreshold: {
        type: "number" as const,
        default: 0.3,
        description: "Minimum TF-IDF cosine similarity score for keyword match",
      },
      llmFallbackThreshold: {
        type: "number" as const,
        default: 0.5,
        description: "In hybrid mode, use LLM if top keyword score is below this",
      },
      llmModel: {
        type: "string" as const,
        default: "mistralai/mistral-small-3.2-24b-instruct",
        description: "OpenRouter model for LLM skill matching",
      },
      catalogRefreshMinutes: {
        type: "number" as const,
        default: 60,
        description: "How often to refresh the skill catalog cache",
      },
      permanentSkillKeys: {
        type: "array" as const,
        items: { type: "string" as const },
        default: [],
        description: "Skill keys that are always included for every agent",
      },
      debounceSeconds: {
        type: "number" as const,
        default: 5,
        description: "Skip re-routing if same issue+agent was routed within this window",
      },
      openRouterApiKeyRef: {
        type: "string" as const,
        default: "",
        description: "Secret reference for OpenRouter API key (for LLM matching)",
      },
    },
  },

  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },

  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "skill-router-widget",
        displayName: "Skill Router",
        exportName: "SkillRouterWidget",
      },
      {
        type: "settingsPage",
        id: "skill-router-settings",
        displayName: "Skill Router Settings",
        exportName: "SkillRouterSettings",
      },
    ],
  },

  jobs: [
    {
      jobKey: "catalog-refresh",
      displayName: "Skill Catalog Refresh",
      schedule: "0 * * * *", // hourly
    },
  ],
};

export default manifest;
