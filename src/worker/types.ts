// ── Plugin Configuration ─────────────────────────────────────
export interface SkillRouterConfig {
  enabled: boolean;
  matchingMode: "keyword" | "llm" | "hybrid";
  maxSkillsPerTask: number;
  keywordScoreThreshold: number;
  llmFallbackThreshold: number;
  llmModel: string;
  catalogRefreshMinutes: number;
  permanentSkillKeys: string[];
  debounceSeconds: number;
}

// ── Skill Catalog ────────────────────────────────────────────
export interface CatalogSkill {
  key: string;
  name: string;
  description: string | null;
  slug: string;
}

export interface CachedSkillCatalog {
  skills: CatalogSkill[];
  fetchedAt: string;
  tfidfVectors: Record<string, Record<string, number>>;
  idf: Record<string, number>;
}

// ── Routing ──────────────────────────────────────────────────
export interface SkillMatch {
  skillKey: string;
  score: number;
  source: "keyword" | "llm";
}

export interface RoutingDecision {
  id: string;
  timestamp: string;
  issueId: string;
  issueTitle: string;
  agentId: string;
  agentName: string;
  matchMode: "keyword" | "llm" | "hybrid_keyword" | "hybrid_llm";
  permanentSkills: string[];
  dynamicSkills: SkillMatch[];
  finalSkills: string[];
  latencyMs: number;
}

// ── Skill Usage Analytics ────────────────────────────────────
export interface SkillUsageStats {
  routed: number;
  read: number;
  lastRoutedAt: string | null;
  lastReadAt: string | null;
}

export interface AgentSkillProfile {
  recentSkillSets: string[][];
  diversityScore: number;
  lastUpdated: string;
}

// ── Permanent Baseline ───────────────────────────────────────
export interface PermanentBaseline {
  skills: string[];
  capturedAt: string;
}

// ── Company-level State ──────────────────────────────────────
export interface SkillRouterState {
  routingDecisions: RoutingDecision[];
  skillUsageStats: Record<string, SkillUsageStats>;
  agentSkillProfiles: Record<string, AgentSkillProfile>;
}

// ── Debounce Tracking ────────────────────────────────────────
export interface DebounceEntry {
  issueId: string;
  agentId: string;
  routedAt: string;
}
