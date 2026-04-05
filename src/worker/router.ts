import type {
  SkillRouterConfig,
  CachedSkillCatalog,
  SkillMatch,
  RoutingDecision,
  PermanentBaseline,
} from "./types.js";
import { keywordMatch } from "./keyword-matcher.js";
import { llmMatch } from "./llm-matcher.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouterContext = any;

// ── Permanent Baseline ───────────────────────────────────────

function baselineKey(agentId: string) {
  return { scopeKind: "instance", stateKey: `permanent-baseline:${agentId}` };
}

/**
 * Load or capture the permanent skill baseline for an agent.
 * On first encounter, snapshots the agent's current desiredSkills.
 */
export async function ensurePermanentBaseline(
  ctx: RouterContext,
  agentId: string,
  companyId: string,
): Promise<string[]> {
  const existing = (await ctx.state.get(baselineKey(agentId))) as PermanentBaseline | null;
  if (existing) return existing.skills;

  // First encounter — snapshot current desiredSkills from agent config
  let currentSkills: string[] = [];
  try {
    const agent = await ctx.agents.get(agentId, companyId);
    if (agent) {
      const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      // Check both paperclipSkillSync.desiredSkills and top-level desiredSkills
      const sync = (config.paperclipSkillSync ?? {}) as Record<string, unknown>;
      const desired = sync.desiredSkills ?? config.desiredSkills;
      if (Array.isArray(desired)) {
        currentSkills = desired.filter((s: unknown): s is string => typeof s === "string");
      }
    }
  } catch (err) {
    ctx.logger.warn("Failed to read agent for baseline", { agentId, error: String(err) });
  }

  const baseline: PermanentBaseline = {
    skills: currentSkills,
    capturedAt: new Date().toISOString(),
  };
  await ctx.state.set(baselineKey(agentId), baseline);
  ctx.logger.info("Captured permanent baseline", { agentId, skills: currentSkills });
  return currentSkills;
}

/**
 * Re-snapshot permanent baseline (e.g., when user edits skills via UI).
 */
export async function refreshBaseline(
  ctx: RouterContext,
  agentId: string,
  newSkills: string[],
): Promise<void> {
  const baseline: PermanentBaseline = {
    skills: newSkills,
    capturedAt: new Date().toISOString(),
  };
  await ctx.state.set(baselineKey(agentId), baseline);
  ctx.logger.info("Refreshed permanent baseline", { agentId, skills: newSkills });
}

// ── Main Routing Logic ───────────────────────────────────────

export interface RouteResult {
  decision: RoutingDecision;
  mergedSkills: string[];
}

/**
 * Route skills for a task: match, merge with permanent, sync to agent.
 */
export async function routeSkills(
  ctx: RouterContext,
  cfg: SkillRouterConfig,
  catalog: CachedSkillCatalog,
  params: {
    issueId: string;
    issueTitle: string;
    issueDescription: string;
    agentId: string;
    agentName: string;
    companyId: string;
    openRouterApiKey: string;
  },
): Promise<RouteResult> {
  const start = Date.now();
  const query = `${params.issueTitle}\n${params.issueDescription}`;

  // Step 1: Get permanent baseline
  const permanentSkills = await ensurePermanentBaseline(ctx, params.agentId, params.companyId);

  // Step 2: Match skills
  let dynamicSkills: SkillMatch[] = [];
  let matchMode: RoutingDecision["matchMode"] = cfg.matchingMode === "keyword"
    ? "keyword"
    : cfg.matchingMode === "llm"
      ? "llm"
      : "hybrid_keyword";

  if (cfg.matchingMode === "keyword" || cfg.matchingMode === "hybrid") {
    dynamicSkills = keywordMatch(query, catalog, cfg.keywordScoreThreshold);
  }

  if (cfg.matchingMode === "llm") {
    dynamicSkills = await llmMatch(query, catalog, {
      model: cfg.llmModel,
      maxSkills: cfg.maxSkillsPerTask,
      apiKey: params.openRouterApiKey,
    }, ctx.http, ctx.logger);
    matchMode = "llm";
  }

  // Hybrid: fall back to LLM if keyword results are weak
  if (
    cfg.matchingMode === "hybrid" &&
    (dynamicSkills.length === 0 || (dynamicSkills[0]?.score ?? 0) < cfg.llmFallbackThreshold) &&
    params.openRouterApiKey
  ) {
    ctx.logger.debug("Hybrid fallback to LLM", {
      topKeywordScore: dynamicSkills[0]?.score ?? 0,
      threshold: cfg.llmFallbackThreshold,
    });
    dynamicSkills = await llmMatch(query, catalog, {
      model: cfg.llmModel,
      maxSkills: cfg.maxSkillsPerTask,
      apiKey: params.openRouterApiKey,
    }, ctx.http, ctx.logger);
    matchMode = "hybrid_llm";
  }

  // Cap dynamic skills
  dynamicSkills = dynamicSkills.slice(0, cfg.maxSkillsPerTask);

  // Step 3: Merge permanent + configured permanent keys + required (paperclip) + dynamic
  const mergedSet = new Set<string>([
    ...permanentSkills,
    ...cfg.permanentSkillKeys,
    "paperclip", // always required
    ...dynamicSkills.map((s) => s.skillKey),
  ]);
  const mergedSkills = Array.from(mergedSet);

  const decision: RoutingDecision = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    issueId: params.issueId,
    issueTitle: params.issueTitle.substring(0, 200),
    agentId: params.agentId,
    agentName: params.agentName,
    matchMode,
    permanentSkills,
    dynamicSkills,
    finalSkills: mergedSkills,
    latencyMs: Date.now() - start,
  };

  return { decision, mergedSkills };
}

/**
 * Sync the merged skill list to the agent via Paperclip internal API.
 * Note: uses http.fetch with localhost — requires the SSRF bypass or
 * a future SDK method for skills sync.
 */
export async function syncSkillsToAgent(
  ctx: RouterContext,
  agentId: string,
  companyId: string,
  desiredSkills: string[],
): Promise<boolean> {
  // Update agent's adapterConfig directly via ctx.agents SDK methods
  // Since there's no ctx.agents.update() for skill sync, we log the desired
  // skills and rely on the agent's next run to pick them up from the routing decision.
  // The actual skill sync would need a server-side addition.
  try {
    ctx.logger.info("Skill routing complete — desired skills updated", {
      agentId,
      desiredSkills,
      count: desiredSkills.length,
    });
    // For now, store the routing result in agent-scoped plugin state
    // so the adapter or a future hook can read it
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `routed-skills:${agentId}` },
      { desiredSkills, updatedAt: new Date().toISOString() },
    );
    return true;
  } catch (err) {
    ctx.logger.warn("Failed to store routed skills", { agentId, error: String(err) });
    return false;
  }
}
