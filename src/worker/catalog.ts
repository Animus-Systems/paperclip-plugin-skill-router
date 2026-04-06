import type { CachedSkillCatalog, CatalogSkill } from "./types.js";
import { buildTfidfVectors } from "./keyword-matcher.js";

const CATALOG_STATE_KEY = "skill-catalog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PluginContext = any;

function catalogKey(companyId: string) {
  return { scopeKind: "company", companyId, stateKey: CATALOG_STATE_KEY };
}

/**
 * Load cached skill catalog from plugin state.
 */
export async function loadCatalog(
  ctx: PluginContext,
  companyId: string,
): Promise<CachedSkillCatalog | null> {
  const raw = await ctx.state.get(catalogKey(companyId));
  return (raw as CachedSkillCatalog) ?? null;
}

/**
 * Build skill catalog by scanning all agents' desiredSkills.
 * Skill keys are typically descriptive (e.g., "igic-calculation-helper"),
 * so we use them as both key and name for TF-IDF matching.
 */
export async function refreshCatalog(
  ctx: PluginContext,
  companyId: string,
): Promise<CachedSkillCatalog> {
  ctx.logger.info("Refreshing skill catalog", { companyId });

  const skillSet = new Map<string, CatalogSkill>();

  try {
    // Scan all agents to discover skills in use
    const agents = await ctx.agents.list({ companyId }) as Array<Record<string, unknown>>;
    for (const agent of agents) {
      const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const sync = (config.paperclipSkillSync ?? {}) as Record<string, unknown>;
      const desired = sync.desiredSkills ?? config.desiredSkills;
      if (Array.isArray(desired)) {
        for (const rawKey of desired) {
          if (typeof rawKey !== "string") continue;
          // Normalize: "paperclipai/paperclip/paperclip" → "paperclip", "local/send-email/send-email" → "send-email"
          const key = rawKey.includes("/") ? rawKey.split("/").pop()! : rawKey;
          if (!skillSet.has(key)) {
            const name = key.replace(/[-_]/g, " ");
            skillSet.set(key, { key, name, description: null, slug: key });
          }
        }
      }
    }
  } catch (err) {
    ctx.logger.warn("Error scanning agents for skills", { error: String(err) });
  }

  const skills = Array.from(skillSet.values());

  // Build TF-IDF vectors from skill names
  const { vectors, idf } = buildTfidfVectors(skills);

  const catalog: CachedSkillCatalog = {
    skills,
    fetchedAt: new Date().toISOString(),
    tfidfVectors: vectors,
    idf,
  };

  await ctx.state.set(catalogKey(companyId), catalog);
  ctx.logger.info("Skill catalog cached", { companyId, skillCount: skills.length });
  return catalog;
}

/**
 * Load catalog, refreshing if stale or missing.
 */
export async function ensureCatalog(
  ctx: PluginContext,
  companyId: string,
  refreshMinutes: number,
): Promise<CachedSkillCatalog> {
  const cached = await loadCatalog(ctx, companyId);
  if (cached && cached.skills.length > 0) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < refreshMinutes * 60 * 1000) {
      return cached;
    }
  }
  return refreshCatalog(ctx, companyId);
}
