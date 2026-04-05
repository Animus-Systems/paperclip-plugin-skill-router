import type { CatalogSkill, CachedSkillCatalog, SkillMatch } from "./types.js";

// ── Stopwords (common English words that add noise) ──────────
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "need", "must",
  "it", "its", "this", "that", "these", "those", "i", "me", "my", "we",
  "our", "you", "your", "he", "she", "they", "them", "their", "what",
  "which", "who", "when", "where", "how", "not", "no", "nor", "if",
  "then", "than", "so", "as", "up", "out", "about", "into", "over",
  "after", "before", "between", "under", "again", "further", "once",
  "here", "there", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "only", "own", "same", "too",
  "very", "just", "because", "also", "any", "work", "task", "issue",
  "agent", "please", "make", "sure", "get", "set", "use", "using",
]);

/**
 * Tokenize text: lowercase, split on non-alphanumeric, remove stopwords.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Compute term frequency for a list of tokens.
 */
function termFrequency(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokens) {
    tf[t] = (tf[t] ?? 0) + 1;
  }
  // Normalize by max frequency
  const max = Math.max(...Object.values(tf), 1);
  for (const t of Object.keys(tf)) {
    tf[t] = tf[t] / max;
  }
  return tf;
}

/**
 * Build TF-IDF vectors for all skills in the catalog.
 * Called once when the catalog is refreshed.
 */
export function buildTfidfVectors(
  skills: CatalogSkill[],
): { vectors: Record<string, Record<string, number>>; idf: Record<string, number> } {
  // Tokenize each skill's text (name + description)
  const skillTokens: Record<string, string[]> = {};
  for (const skill of skills) {
    const text = `${skill.name} ${skill.description ?? ""} ${skill.key}`;
    skillTokens[skill.key] = tokenize(text);
  }

  // Compute IDF: log(N / df) where df = number of documents containing the term
  const N = skills.length || 1;
  const docFreq: Record<string, number> = {};
  for (const tokens of Object.values(skillTokens)) {
    const unique = new Set(tokens);
    for (const t of unique) {
      docFreq[t] = (docFreq[t] ?? 0) + 1;
    }
  }
  const idf: Record<string, number> = {};
  for (const [term, df] of Object.entries(docFreq)) {
    idf[term] = Math.log(N / df);
  }

  // Build TF-IDF vectors per skill
  const vectors: Record<string, Record<string, number>> = {};
  for (const skill of skills) {
    const tf = termFrequency(skillTokens[skill.key]);
    const vec: Record<string, number> = {};
    for (const [term, tfVal] of Object.entries(tf)) {
      vec[term] = tfVal * (idf[term] ?? 0);
    }
    vectors[skill.key] = vec;
  }

  return { vectors, idf };
}

/**
 * Cosine similarity between two sparse vectors.
 */
function cosineSimilarity(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (const [key, val] of Object.entries(a)) {
    magA += val * val;
    if (key in b) {
      dot += val * b[key];
    }
  }
  for (const val of Object.values(b)) {
    magB += val * val;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Match a query (issue title + description) against the cached skill catalog.
 * Returns sorted matches above the score threshold.
 */
export function keywordMatch(
  query: string,
  catalog: CachedSkillCatalog,
  threshold: number,
): SkillMatch[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const queryTf = termFrequency(queryTokens);
  const queryVec: Record<string, number> = {};
  for (const [term, tfVal] of Object.entries(queryTf)) {
    queryVec[term] = tfVal * (catalog.idf[term] ?? 0);
  }

  const matches: SkillMatch[] = [];
  for (const skill of catalog.skills) {
    const skillVec = catalog.tfidfVectors[skill.key];
    if (!skillVec) continue;
    const score = cosineSimilarity(queryVec, skillVec);
    if (score >= threshold) {
      matches.push({ skillKey: skill.key, score, source: "keyword" });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}
