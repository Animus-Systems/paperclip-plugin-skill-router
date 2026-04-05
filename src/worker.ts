import { definePlugin, startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type {
  SkillRouterConfig,
  SkillRouterState,
  RoutingDecision,
  DebounceEntry,
  SkillUsageStats,
  AgentSkillProfile,
} from "./worker/types.js";
import { ensureCatalog, refreshCatalog } from "./worker/catalog.js";
import { routeSkills, syncSkillsToAgent, refreshBaseline } from "./worker/router.js";

const DEFAULT_CONFIG: SkillRouterConfig = {
  enabled: true,
  matchingMode: "hybrid",
  maxSkillsPerTask: 5,
  keywordScoreThreshold: 0.3,
  llmFallbackThreshold: 0.5,
  llmModel: "mistralai/mistral-small-3.2-24b-instruct",
  catalogRefreshMinutes: 60,
  permanentSkillKeys: [],
  debounceSeconds: 5,
};

const MAX_DECISIONS = 200;
const MAX_SKILL_SETS = 20;

// ── State helpers ────────────────────────────────────────────

function stateKey(companyId: string) {
  return { scopeKind: "company", companyId, stateKey: "router-state" };
}

function debounceKey() {
  return { scopeKind: "instance", stateKey: "debounce-log" };
}

async function loadState(ctx: PluginCtx, companyId: string): Promise<SkillRouterState> {
  const raw = await ctx.state.get(stateKey(companyId));
  return (raw as SkillRouterState) ?? {
    routingDecisions: [],
    skillUsageStats: {},
    agentSkillProfiles: {},
  };
}

async function saveState(ctx: PluginCtx, companyId: string, state: SkillRouterState): Promise<void> {
  // Keep ring buffer trimmed
  if (state.routingDecisions.length > MAX_DECISIONS) {
    state.routingDecisions = state.routingDecisions.slice(-MAX_DECISIONS);
  }
  await ctx.state.set(stateKey(companyId), state);
}

async function loadDebounce(ctx: PluginCtx): Promise<DebounceEntry[]> {
  const raw = await ctx.state.get(debounceKey());
  return (raw as DebounceEntry[]) ?? [];
}

async function saveDebounce(ctx: PluginCtx, entries: DebounceEntry[]): Promise<void> {
  // Prune entries older than 60 seconds
  const cutoff = Date.now() - 60_000;
  const pruned = entries.filter((e) => new Date(e.routedAt).getTime() > cutoff);
  await ctx.state.set(debounceKey(), pruned);
}

function isDebounced(entries: DebounceEntry[], issueId: string, agentId: string, seconds: number): boolean {
  const cutoff = Date.now() - seconds * 1000;
  return entries.some(
    (e) => e.issueId === issueId && e.agentId === agentId && new Date(e.routedAt).getTime() > cutoff,
  );
}

// ── Type for the plugin context ──────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginCtx = any;

const plugin = definePlugin({
  async setup(ctx: PluginCtx) {
    const rawConfig = await ctx.config.get();
    const cfg: SkillRouterConfig = { ...DEFAULT_CONFIG, ...(rawConfig as Partial<SkillRouterConfig>) };

    // Resolve OpenRouter API key from secrets
    let openRouterApiKey = "";
    if ((rawConfig as Record<string, unknown>)?.openRouterApiKeyRef) {
      try {
        openRouterApiKey = (await ctx.secrets.resolve(
          (rawConfig as Record<string, unknown>).openRouterApiKeyRef as string,
        )) as string;
      } catch {
        ctx.logger.warn("Could not resolve OpenRouter API key secret");
      }
    }

    ctx.logger.info("Skill Router plugin starting", {
      matchingMode: cfg.matchingMode,
      maxSkillsPerTask: cfg.maxSkillsPerTask,
      catalogRefreshMinutes: cfg.catalogRefreshMinutes,
    });

    // ── Core routing handler ─────────────────────────────────
    async function handleIssueEvent(
      event: PluginEvent,
      reason: string,
    ): Promise<void> {
      if (!cfg.enabled) return;

      const companyId = event.companyId ?? "";
      const entityId = event.entityId ?? "";
      if (!companyId || !entityId) return;

      // Get issue details
      let issue: Record<string, unknown> | null = null;
      try {
        issue = (await ctx.issues.get(entityId, companyId)) as Record<string, unknown>;
      } catch {
        ctx.logger.debug("Could not fetch issue", { issueId: entityId });
        return;
      }
      if (!issue) return;

      const agentId = issue.assigneeAgentId as string | undefined;
      if (!agentId) {
        ctx.logger.debug("Issue has no assignee, skipping", { issueId: entityId });
        return;
      }

      // Debounce check
      const debounceEntries = await loadDebounce(ctx);
      if (isDebounced(debounceEntries, entityId, agentId, cfg.debounceSeconds)) {
        ctx.logger.debug("Debounced, skipping", { issueId: entityId, agentId });
        return;
      }

      // Load skill catalog
      const catalog = await ensureCatalog(ctx, companyId, cfg.catalogRefreshMinutes);
      if (catalog.skills.length === 0) {
        ctx.logger.debug("No skills in catalog, skipping routing");
        return;
      }

      // Get agent name
      let agentName = agentId;
      try {
        const agent = await ctx.agents.get(agentId, companyId);
        agentName = agent?.name || agentId;
      } catch { /* use agentId */ }

      // Route
      const { decision, mergedSkills } = await routeSkills(ctx, cfg, catalog, {
        issueId: entityId,
        issueTitle: (issue.title as string) ?? "",
        issueDescription: (issue.description as string) ?? "",
        agentId,
        agentName,
        companyId,
        openRouterApiKey,
      });

      // Sync skills to agent
      const synced = await syncSkillsToAgent(ctx, agentId, mergedSkills);

      // Record debounce
      debounceEntries.push({
        issueId: entityId,
        agentId,
        routedAt: new Date().toISOString(),
      });
      await saveDebounce(ctx, debounceEntries);

      // Record decision
      const state = await loadState(ctx, companyId);
      state.routingDecisions.push(decision);

      // Update usage stats
      for (const match of decision.dynamicSkills) {
        if (!state.skillUsageStats[match.skillKey]) {
          state.skillUsageStats[match.skillKey] = {
            routed: 0,
            read: 0,
            lastRoutedAt: null,
            lastReadAt: null,
          };
        }
        state.skillUsageStats[match.skillKey].routed++;
        state.skillUsageStats[match.skillKey].lastRoutedAt = decision.timestamp;
      }

      // Update agent skill profile
      if (!state.agentSkillProfiles[agentId]) {
        state.agentSkillProfiles[agentId] = {
          recentSkillSets: [],
          diversityScore: 0,
          lastUpdated: decision.timestamp,
        };
      }
      const profile = state.agentSkillProfiles[agentId];
      profile.recentSkillSets.push(decision.dynamicSkills.map((s) => s.skillKey));
      if (profile.recentSkillSets.length > MAX_SKILL_SETS) {
        profile.recentSkillSets = profile.recentSkillSets.slice(-MAX_SKILL_SETS);
      }
      profile.diversityScore = computeDiversityScore(profile.recentSkillSets);
      profile.lastUpdated = decision.timestamp;

      await saveState(ctx, companyId, state);

      // Activity log
      await ctx.activity.log({
        companyId,
        message: `Skill Router: routed ${decision.dynamicSkills.length} skill(s) to ${agentName} [${decision.matchMode}]`,
        entityType: "agent",
        entityId: agentId,
        metadata: {
          trigger: reason,
          issueId: entityId,
          matchMode: decision.matchMode,
          dynamicSkills: decision.dynamicSkills.map((s) => s.skillKey),
          synced,
          latencyMs: decision.latencyMs,
        },
      });

      ctx.logger.info("Routed skills", {
        agentId,
        agentName,
        issueId: entityId,
        matchMode: decision.matchMode,
        dynamic: decision.dynamicSkills.length,
        total: mergedSkills.length,
        synced,
        latencyMs: decision.latencyMs,
      });
    }

    // ══════════════════════════════════════════════════════════
    // EVENT: issue.created — route skills for the assigned agent
    // ══════════════════════════════════════════════════════════
    ctx.events.on("issue.created", async (event: PluginEvent) => {
      await handleIssueEvent(event, "issue_created");
    });

    // ══════════════════════════════════════════════════════════
    // EVENT: issue.updated — re-route if assignee changed or content changed
    // ══════════════════════════════════════════════════════════
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      await handleIssueEvent(event, "issue_updated");
    });

    // ══════════════════════════════════════════════════════════
    // EVENT: agent.run.finished — track which skills were actually read
    // ══════════════════════════════════════════════════════════
    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      if (!cfg.enabled) return;

      const payload = event.payload as Record<string, unknown>;
      const agentId = (payload?.agentId ?? "") as string;
      const runId = (payload?.runId ?? (event.entityId ?? "")) as string;
      const evtCompanyId = event.companyId ?? "";
      if (!agentId || !runId || !evtCompanyId) return;

      // Try to read the run's log to find skill reads
      try {
        const resp = await ctx.http.fetch(
          `/api/heartbeat/runs/${runId}/log`,
          { method: "GET" },
        );
        if (!resp.ok) return;

        const logText = await resp.text();
        // Look for skill file reads: read_file .skills/{key}/SKILL.md
        const skillReads = new Set<string>();
        const pattern = /\.skills\/([^/]+)\/SKILL\.md/g;
        let match;
        while ((match = pattern.exec(logText)) !== null) {
          skillReads.add(match[1]);
        }

        if (skillReads.size === 0) return;

        const state = await loadState(ctx, evtCompanyId);
        for (const key of skillReads) {
          if (!state.skillUsageStats[key]) {
            state.skillUsageStats[key] = {
              routed: 0,
              read: 0,
              lastRoutedAt: null,
              lastReadAt: null,
            };
          }
          state.skillUsageStats[key].read++;
          state.skillUsageStats[key].lastReadAt = new Date().toISOString();
        }
        await saveState(ctx, evtCompanyId, state);

        ctx.logger.debug("Tracked skill reads", {
          agentId,
          runId,
          skillsRead: Array.from(skillReads),
        });
      } catch {
        // Best effort — run log may not be available
      }
    });

    // ══════════════════════════════════════════════════════════
    // EVENT: agent.updated — re-snapshot permanent baseline
    // ══════════════════════════════════════════════════════════
    ctx.events.on("agent.updated", async (event: PluginEvent) => {
      if (!cfg.enabled) return;

      const payload = event.payload as Record<string, unknown>;
      const source = payload?.source as string | undefined;

      // Only re-snapshot if the update was NOT from skill-sync (i.e. user changed skills via UI)
      if (source === "skill-sync") return;

      const agentEntityId = event.entityId ?? "";
      if (!agentEntityId) return;

      try {
        const resp = await ctx.http.fetch(
          `/api/agents/${agentEntityId}`,
          { method: "GET" },
        );
        if (!resp.ok) return;
        const agent = (await resp.json()) as Record<string, unknown>;
        const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
        const sync = (config.paperclipSkillSync ?? {}) as Record<string, unknown>;
        const desired = sync.desiredSkills;
        if (Array.isArray(desired)) {
          const skills = desired.filter((s): s is string => typeof s === "string");
          await refreshBaseline(ctx, agentEntityId, skills);
        }
      } catch {
        // Best effort
      }
    });

    // ══════════════════════════════════════════════════════════
    // JOB: catalog-refresh — refresh skill catalog hourly
    // ══════════════════════════════════════════════════════════
    ctx.jobs.register("catalog-refresh", async () => {
      if (!cfg.enabled) return;

      let companies: Array<{ id: string }> = [];
      try {
        companies = (await ctx.companies.list()) as Array<{ id: string }>;
      } catch (err) {
        ctx.logger.warn("Failed to list companies for catalog refresh", { error: String(err) });
        return;
      }

      for (const company of companies) {
        try {
          await refreshCatalog(ctx, company.id);
        } catch (err) {
          ctx.logger.warn("Catalog refresh failed", { companyId: company.id, error: String(err) });
        }
      }
    });

    // ══════════════════════════════════════════════════════════
    // DATA: dashboard widget + settings data
    // ══════════════════════════════════════════════════════════
    ctx.data.register("skill-router:status", async (params: Record<string, unknown>) => {
      const companyId = params.companyId as string;
      const state = await loadState(ctx, companyId);

      // Skill effectiveness
      const skillEffectiveness: Array<{
        key: string;
        routed: number;
        read: number;
        readRate: number;
      }> = [];
      for (const [key, stats] of Object.entries(state.skillUsageStats)) {
        if (stats.routed > 0) {
          skillEffectiveness.push({
            key,
            routed: stats.routed,
            read: stats.read,
            readRate: stats.routed > 0 ? Math.round((stats.read / stats.routed) * 100) : 0,
          });
        }
      }
      skillEffectiveness.sort((a, b) => b.routed - a.routed);

      // Recent decisions
      const recentDecisions = state.routingDecisions.slice(-15).reverse();

      // Match mode breakdown
      const modeBreakdown = { keyword: 0, llm: 0, hybrid_keyword: 0, hybrid_llm: 0 };
      for (const d of state.routingDecisions) {
        modeBreakdown[d.matchMode]++;
      }

      // Agent consolidation signals
      const consolidation = computeConsolidationSignals(state.agentSkillProfiles);

      return {
        enabled: cfg.enabled,
        matchingMode: cfg.matchingMode,
        maxSkillsPerTask: cfg.maxSkillsPerTask,
        totalDecisions: state.routingDecisions.length,
        recentDecisions,
        skillEffectiveness: skillEffectiveness.slice(0, 20),
        modeBreakdown,
        consolidation,
        zeroMatchCount: state.routingDecisions.filter((d) => d.dynamicSkills.length === 0).length,
      };
    });
  },

  async onHealth() {
    return { status: "ok" };
  },
});

// ── Analytics Helpers ────────────────────────────────────────

function computeDiversityScore(skillSets: string[][]): number {
  if (skillSets.length < 2) return 1;
  const uniqueSets = new Set(skillSets.map((s) => [...s].sort().join(",")));
  return Math.round((uniqueSets.size / skillSets.length) * 100) / 100;
}

function computeConsolidationSignals(
  profiles: Record<string, AgentSkillProfile>,
): Array<{ agents: string[]; sharedSkills: string[]; overlapPct: number }> {
  const signals: Array<{ agents: string[]; sharedSkills: string[]; overlapPct: number }> = [];
  const agentIds = Object.keys(profiles);

  for (let i = 0; i < agentIds.length; i++) {
    for (let j = i + 1; j < agentIds.length; j++) {
      const a = profiles[agentIds[i]];
      const b = profiles[agentIds[j]];
      if (!a || !b || a.recentSkillSets.length < 3 || b.recentSkillSets.length < 3) continue;

      // Flatten recent skills
      const aSkills = new Set(a.recentSkillSets.flat());
      const bSkills = new Set(b.recentSkillSets.flat());
      const shared = [...aSkills].filter((s) => bSkills.has(s));
      const union = new Set([...aSkills, ...bSkills]);
      const overlapPct = Math.round((shared.length / union.size) * 100);

      if (overlapPct >= 80) {
        signals.push({
          agents: [agentIds[i], agentIds[j]],
          sharedSkills: shared,
          overlapPct,
        });
      }
    }
  }

  return signals.sort((a, b) => b.overlapPct - a.overlapPct);
}

export default plugin;
startWorkerRpcHost({ plugin });
