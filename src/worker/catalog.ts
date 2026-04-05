import type { CachedSkillCatalog, CatalogSkill } from "./types.js";
import { buildTfidfVectors } from "./keyword-matcher.js";

const CATALOG_STATE_KEY = "skill-catalog";

interface PluginContext {
  state: {
    get(key: unknown): Promise<unknown>;
    set(key: unknown, value: unknown): Promise<void>;
  };
  companies: {
    list(): Promise<Array<{ id: string }>>;
  };
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    debug(msg: string, meta?: Record<string, unknown>): void;
  };
  http: {
    fetch(url: string, options?: Record<string, unknown>): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  };
}

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
 * Fetch the skill catalog from Paperclip API, compute TF-IDF vectors, and cache.
 */
export async function refreshCatalog(
  ctx: PluginContext,
  companyId: string,
): Promise<CachedSkillCatalog> {
  ctx.logger.info("Refreshing skill catalog", { companyId });

  let skills: CatalogSkill[] = [];
  try {
    const resp = await ctx.http.fetch(
      `/api/companies/${companyId}/skills`,
      { method: "GET" },
    );
    if (resp.ok) {
      const data = (await resp.json()) as Array<Record<string, unknown>>;
      skills = data.map((s) => ({
        key: s.key as string,
        name: s.name as string,
        description: (s.description as string) ?? null,
        slug: s.slug as string,
      }));
    } else {
      ctx.logger.warn("Failed to fetch skill catalog", { status: resp.status });
    }
  } catch (err) {
    ctx.logger.warn("Error fetching skill catalog", { error: String(err) });
  }

  // Build TF-IDF vectors from skill names + descriptions
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
