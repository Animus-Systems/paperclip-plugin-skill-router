import type { CachedSkillCatalog, SkillMatch } from "./types.js";

interface LlmMatcherConfig {
  model: string;
  maxSkills: number;
  apiKey: string;
}

interface HttpClient {
  fetch(url: string, options?: Record<string, unknown>): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Use an LLM via OpenRouter to match skills to a task.
 * Only called when keyword matching is ambiguous (hybrid mode).
 */
export async function llmMatch(
  query: string,
  catalog: CachedSkillCatalog,
  config: LlmMatcherConfig,
  http: HttpClient,
  logger: Logger,
): Promise<SkillMatch[]> {
  if (!config.apiKey) {
    logger.warn("No OpenRouter API key configured, skipping LLM matching");
    return [];
  }

  if (catalog.skills.length === 0) return [];

  // Build compact skill list for the prompt
  const skillList = catalog.skills
    .map((s) => `- ${s.key}: ${s.name}${s.description ? ` — ${s.description}` : ""}`)
    .join("\n");

  const systemPrompt = `You are a skill-matching assistant. Given a task description and a list of available skills, select the most relevant skills for the task.

Available skills:
${skillList}

Rules:
- Return ONLY a JSON array of skill keys (strings), e.g. ["skill-a", "skill-b"]
- Select at most ${config.maxSkills} skills
- Only select skills that are clearly relevant to the task
- If no skills are relevant, return an empty array []`;

  const userMessage = `Task:\n${query}`;

  try {
    const resp = await http.fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 500,
      }),
    });

    if (!resp.ok) {
      logger.warn("LLM match request failed", { status: resp.status });
      return [];
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";

    // Parse JSON array from response (handle markdown fences)
    const jsonStr = content.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    let skillKeys: string[];
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        skillKeys = parsed.filter((k): k is string => typeof k === "string");
      } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.skills)) {
        skillKeys = parsed.skills.filter((k: unknown): k is string => typeof k === "string");
      } else {
        logger.warn("LLM returned unexpected format", { content });
        return [];
      }
    } catch {
      logger.warn("Failed to parse LLM response as JSON", { content });
      return [];
    }

    // Validate keys exist in catalog
    const validKeys = new Set(catalog.skills.map((s) => s.key));
    return skillKeys
      .filter((k) => validKeys.has(k))
      .slice(0, config.maxSkills)
      .map((k, i) => ({
        skillKey: k,
        score: 1 - i * 0.05, // Rank-based pseudo-score
        source: "llm" as const,
      }));
  } catch (err) {
    logger.warn("LLM match error", { error: String(err) });
    return [];
  }
}
