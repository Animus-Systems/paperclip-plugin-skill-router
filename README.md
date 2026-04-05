# paperclip-plugin-skill-router

Dynamic skill assignment plugin for [Paperclip](https://github.com/paperclipai/paperclip). Automatically matches relevant skills to agents based on task content, replacing manual per-agent skill curation.

## Problem

With 50+ skills and 49 agents, statically assigning skills per-agent doesn't scale. You either overload agents with irrelevant context or manually curate per-agent per-task. This plugin solves that by reading the incoming task (issue title + description) and loading only the relevant skills.

## How It Works

```
Issue assigned to agent
       |
       v
Plugin receives issue.created / issue.updated event
       |
       v
Reads issue title + description
       |
       v
Matches against cached skill catalog
  - Keyword: TF-IDF cosine similarity (zero deps, free)
  - LLM: OpenRouter call (Mistral Small 3.2, fallback only)
       |
       v
Merges: agent's permanent skills + required skills + matched dynamic skills
       |
       v
Calls POST /api/agents/{id}/skills/sync with merged list
       |
       v
Adapter picks up updated desiredSkills on next run start
```

## Features

- **Hybrid matching**: TF-IDF keyword match first (free, fast), LLM fallback when ambiguous
- **Permanent skill preservation**: Snapshots each agent's existing skills on first encounter, always includes them
- **Debounce**: Skips re-routing if same issue+agent was routed within configurable window
- **Skill usage tracking**: Records which skills were routed AND which were actually read (from run logs)
- **Agent consolidation signals**: Flags agents with 80%+ skill overlap as merge candidates
- **Dashboard widget**: Recent routing decisions, skill effectiveness table, consolidation signals
- **Settings page**: Toggle, matching mode, max skills per task

## Matching Modes

| Mode | Cost | Speed | Best For |
|------|------|-------|----------|
| `keyword` | Free | ~5ms | Large catalogs, predictable tasks |
| `hybrid` (default) | Free most of the time | ~5ms keyword, ~2s LLM fallback | General use |
| `llm` | ~$0.001/match | ~2s | Small catalogs, ambiguous tasks |

### Keyword Matching (TF-IDF)

Zero-dependency implementation:
1. Tokenize: lowercase, split on non-alphanumeric, remove stopwords
2. Build term frequency vectors per skill (pre-computed at catalog refresh)
3. At match time: vectorize query, cosine similarity against each skill
4. Return sorted matches above threshold

### LLM Matching (OpenRouter)

Only fires when keyword matching is ambiguous (hybrid mode, top score < threshold):
- System prompt: compact skill catalog list
- Response: JSON array of skill keys
- Model: configurable (default `mistralai/mistral-small-3.2-24b-instruct`)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Master toggle |
| `matchingMode` | `hybrid` | `keyword`, `llm`, or `hybrid` |
| `maxSkillsPerTask` | `5` | Max dynamic skills added per task |
| `keywordScoreThreshold` | `0.3` | Min TF-IDF cosine similarity for keyword match |
| `llmFallbackThreshold` | `0.5` | In hybrid mode, use LLM if top keyword score < this |
| `llmModel` | `mistralai/mistral-small-3.2-24b-instruct` | OpenRouter model for LLM matching |
| `catalogRefreshMinutes` | `60` | How often to refresh skill catalog cache |
| `permanentSkillKeys` | `[]` | Skill keys always included for every agent |
| `debounceSeconds` | `5` | Skip re-routing within this window |
| `openRouterApiKeyRef` | `""` | Secret reference for OpenRouter API key |

## Analytics

### Skill Effectiveness

Tracks per-skill:
- **Routed count**: how many times the skill was assigned to an agent
- **Read count**: how many times the agent actually opened the skill file during a run
- **Read rate**: `read / routed` — low rates indicate poor matching or irrelevant skills

### Agent Consolidation

Detects agents with 80%+ identical dynamic skill sets across their last 20 tasks. These are candidates for merging — they're effectively doing the same type of work.

### Routing Health

- Total decisions (with mode breakdown: keyword vs LLM)
- Zero-match tasks (tasks where no skills were relevant)
- Per-decision latency

## Permanent vs Dynamic Skills

The plugin preserves user-configured skills:

1. On first encounter with an agent, snapshots its current `desiredSkills` as "permanent baseline"
2. On every routing decision: `permanent baseline + configured permanentSkillKeys + "paperclip" + dynamic matches`
3. If user changes skills via UI, the `agent.updated` event triggers a baseline re-snapshot
4. Skill sync calls from this plugin are tagged with `source: "skill-sync"` to distinguish from manual changes

## Events

| Event | Action |
|-------|--------|
| `issue.created` | Route skills for the assigned agent |
| `issue.updated` | Re-route if content/assignee changed |
| `agent.run.finished` | Track which skills were read from run logs |
| `agent.updated` | Re-snapshot permanent baseline (if not from skill-sync) |

## Jobs

| Job | Schedule | Action |
|-----|----------|--------|
| `catalog-refresh` | Hourly | Refresh skill catalog + TF-IDF vectors |

## Requirements

- Paperclip with plugin SDK v2026.318.0+
- OpenRouter API key (optional — only needed for `llm` or `hybrid` mode LLM fallback)

## Installation

```bash
# Build
npm install && npm run build

# Symlink into Paperclip plugins (Docker deployment)
cd ~/Documents/paperclip-data/appdata/.paperclip/plugins/node_modules/@animusystems
ln -s ../../../../../data/github/animusystems/paperclip-plugin-skill-router paperclip-plugin-skill-router

# Add to plugins/package.json
# "@animusystems/paperclip-plugin-skill-router": "file:../../../data/github/animusystems/paperclip-plugin-skill-router"

# Install in container
docker compose exec server sh -c "cd /paperclip/.paperclip/plugins && npm install /data/github/animusystems/paperclip-plugin-skill-router"

# Restart and register
docker compose restart server
# Settings -> Plugins -> Install -> @animusystems/paperclip-plugin-skill-router
```

## License

MIT
