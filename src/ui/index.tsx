import React, { useState, useCallback } from "react";
import type { PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";

// ── Types ────────────────────────────────────────────────────

interface SkillMatch {
  skillKey: string;
  score: number;
  source: "keyword" | "llm";
}

interface RoutingDecision {
  id: string;
  timestamp: string;
  issueId: string;
  issueTitle: string;
  agentId: string;
  agentName: string;
  matchMode: string;
  permanentSkills: string[];
  dynamicSkills: SkillMatch[];
  finalSkills: string[];
  latencyMs: number;
}

interface SkillEffectiveness {
  key: string;
  routed: number;
  read: number;
  readRate: number;
}

interface ConsolidationSignal {
  agents: string[];
  sharedSkills: string[];
  overlapPct: number;
}

interface RouterStatus {
  enabled: boolean;
  matchingMode: string;
  maxSkillsPerTask: number;
  totalDecisions: number;
  recentDecisions: RoutingDecision[];
  skillEffectiveness: SkillEffectiveness[];
  modeBreakdown: Record<string, number>;
  consolidation: ConsolidationSignal[];
  zeroMatchCount: number;
}

// ── Styles ───────────────────────────────────────────────────

const muted: React.CSSProperties = {
  color: "rgba(255,255,255,0.45)",
  fontSize: "0.8rem",
};

const sectionHeader: React.CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "rgba(255,255,255,0.5)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 6,
};

const badge = (bg: string, fg: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 3,
  fontSize: "0.7rem",
  fontWeight: 500,
  background: bg,
  color: fg,
  marginRight: 4,
});

const MODE_COLORS: Record<string, { bg: string; fg: string }> = {
  keyword: { bg: "rgba(34,197,94,0.15)", fg: "rgb(34,197,94)" },
  llm: { bg: "rgba(147,51,234,0.15)", fg: "rgb(167,139,250)" },
  hybrid_keyword: { bg: "rgba(34,197,94,0.15)", fg: "rgb(34,197,94)" },
  hybrid_llm: { bg: "rgba(147,51,234,0.15)", fg: "rgb(167,139,250)" },
};

function timeAgo(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ══════════════════════════════════════════════════════════════
// Dashboard Widget
// ══════════════════════════════════════════════════════════════

export function SkillRouterWidget() {
  const context = useHostContext();
  const { data } = usePluginData<RouterStatus>("skill-router:status", {
    companyId: context.companyId,
  });

  const state = data ?? {
    enabled: false,
    matchingMode: "hybrid",
    maxSkillsPerTask: 5,
    totalDecisions: 0,
    recentDecisions: [],
    skillEffectiveness: [],
    modeBreakdown: {},
    consolidation: [],
    zeroMatchCount: 0,
  };

  const [tab, setTab] = useState<"recent" | "skills" | "agents">("recent");

  const tabBtn = (key: typeof tab, label: string): React.CSSProperties => ({
    padding: "4px 10px",
    fontSize: "0.75rem",
    fontWeight: 500,
    cursor: "pointer",
    borderRadius: 4,
    border: "none",
    background: tab === key ? "rgba(255,255,255,0.1)" : "transparent",
    color: tab === key ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.45)",
  });

  return (
    <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {/* Summary */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: state.enabled ? "rgb(34,197,94)" : "rgb(239,68,68)",
        }} />
        <span style={{ fontSize: "0.8rem", color: "rgba(255,255,255,0.7)" }}>
          {state.enabled ? state.matchingMode : "disabled"}
        </span>
        <span style={muted}>{state.totalDecisions} total decisions</span>
        {state.zeroMatchCount > 0 && (
          <span style={{ ...muted, color: "rgb(250,204,21)" }}>
            {state.zeroMatchCount} zero-match
          </span>
        )}
      </div>

      {/* Mode breakdown */}
      {state.totalDecisions > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {Object.entries(state.modeBreakdown).map(([mode, count]) =>
            count > 0 ? (
              <span key={mode} style={badge(
                MODE_COLORS[mode]?.bg ?? "rgba(255,255,255,0.1)",
                MODE_COLORS[mode]?.fg ?? "rgba(255,255,255,0.7)",
              )}>
                {mode}: {count}
              </span>
            ) : null,
          )}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4 }}>
        <button style={tabBtn("recent", "Recent")} onClick={() => setTab("recent")}>
          Recent
        </button>
        <button style={tabBtn("skills", "Skills")} onClick={() => setTab("skills")}>
          Skills
        </button>
        <button style={tabBtn("agents", "Agents")} onClick={() => setTab("agents")}>
          Agents
        </button>
      </div>

      {/* Tab Content */}
      {tab === "recent" && (
        <div>
          {state.recentDecisions.length === 0 ? (
            <div style={{ ...muted, fontStyle: "italic" }}>No routing decisions yet</div>
          ) : (
            state.recentDecisions.slice(0, 8).map((d) => (
              <div
                key={d.id}
                style={{
                  padding: "6px 0",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  fontSize: "0.8rem",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ color: "rgba(255,255,255,0.8)" }}>
                    {d.agentName}
                  </span>
                  <span style={badge(
                    MODE_COLORS[d.matchMode]?.bg ?? "rgba(255,255,255,0.1)",
                    MODE_COLORS[d.matchMode]?.fg ?? "rgba(255,255,255,0.7)",
                  )}>
                    {d.matchMode}
                  </span>
                </div>
                <div style={{ color: "rgba(255,255,255,0.55)", fontSize: "0.75rem" }}>
                  {d.issueTitle.substring(0, 80)}{d.issueTitle.length > 80 ? "..." : ""}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                  {d.dynamicSkills.map((s) => (
                    <span
                      key={s.skillKey}
                      style={badge("rgba(59,130,246,0.15)", "rgb(147,197,253)")}
                    >
                      {s.skillKey} ({Math.round(s.score * 100)}%)
                    </span>
                  ))}
                  {d.dynamicSkills.length === 0 && (
                    <span style={{ ...muted, fontSize: "0.7rem" }}>no dynamic skills matched</span>
                  )}
                </div>
                <div style={{ ...muted, fontSize: "0.7rem", marginTop: 2 }}>
                  {timeAgo(d.timestamp)} &middot; {d.latencyMs}ms &middot; {d.finalSkills.length} total skills
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "skills" && (
        <div>
          <div style={sectionHeader}>Skill Effectiveness</div>
          {state.skillEffectiveness.length === 0 ? (
            <div style={{ ...muted, fontStyle: "italic" }}>No skill data yet</div>
          ) : (
            <table style={{ width: "100%", fontSize: "0.78rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "rgba(255,255,255,0.5)", fontSize: "0.7rem", textAlign: "left" }}>
                  <th style={{ padding: "4px 6px" }}>Skill</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Routed</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Read</th>
                  <th style={{ padding: "4px 6px", textAlign: "right" }}>Rate</th>
                </tr>
              </thead>
              <tbody>
                {state.skillEffectiveness.slice(0, 12).map((s) => (
                  <tr
                    key={s.key}
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                  >
                    <td style={{ padding: "4px 6px", color: "rgba(255,255,255,0.8)" }}>
                      {s.key}
                    </td>
                    <td style={{ padding: "4px 6px", textAlign: "right", ...muted }}>
                      {s.routed}
                    </td>
                    <td style={{ padding: "4px 6px", textAlign: "right", ...muted }}>
                      {s.read}
                    </td>
                    <td
                      style={{
                        padding: "4px 6px",
                        textAlign: "right",
                        color:
                          s.readRate >= 70
                            ? "rgb(34,197,94)"
                            : s.readRate >= 40
                              ? "rgb(250,204,21)"
                              : "rgb(239,68,68)",
                      }}
                    >
                      {s.readRate}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "agents" && (
        <div>
          <div style={sectionHeader}>Consolidation Signals</div>
          {state.consolidation.length === 0 ? (
            <div style={{ ...muted, fontStyle: "italic" }}>
              Not enough data yet. Agents need 3+ routing decisions each.
            </div>
          ) : (
            state.consolidation.slice(0, 5).map((c, i) => (
              <div
                key={i}
                style={{
                  padding: "6px 0",
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  fontSize: "0.78rem",
                }}
              >
                <div style={{ color: "rgba(255,255,255,0.8)" }}>
                  {c.agents.join(" + ")}
                  <span
                    style={{
                      ...badge(
                        c.overlapPct >= 90
                          ? "rgba(239,68,68,0.15)"
                          : "rgba(250,204,21,0.15)",
                        c.overlapPct >= 90
                          ? "rgb(252,165,165)"
                          : "rgb(253,224,71)",
                      ),
                      marginLeft: 6,
                    }}
                  >
                    {c.overlapPct}% overlap
                  </span>
                </div>
                <div style={{ ...muted, fontSize: "0.7rem", marginTop: 2 }}>
                  Shared: {c.sharedSkills.slice(0, 5).join(", ")}
                  {c.sharedSkills.length > 5 ? ` +${c.sharedSkills.length - 5} more` : ""}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// Settings Page
// ══════════════════════════════════════════════════════════════

export function SkillRouterSettings(props: PluginSettingsPageProps) {
  const context = useHostContext();
  const { data } = usePluginData<RouterStatus>("skill-router:status", {
    companyId: context.companyId,
  });

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [enabled, setEnabled] = useState(data?.enabled ?? true);
  const [matchingMode, setMatchingMode] = useState(data?.matchingMode ?? "hybrid");
  const [maxSkills, setMaxSkills] = useState(data?.maxSkillsPerTask ?? 5);

  // Sync from data when it loads
  React.useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setMatchingMode(data.matchingMode);
      setMaxSkills(data.maxSkillsPerTask);
    }
  }, [data]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const pluginId = "animusystems.skill-router";
      const current = await fetch(`/api/plugins/${pluginId}/config`).then((r) => r.json());
      const updated = {
        ...(current?.configJson ?? {}),
        enabled,
        matchingMode,
        maxSkillsPerTask: maxSkills,
      };
      await fetch(`/api/plugins/${pluginId}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configJson: updated }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save config", err);
    }
    setSaving(false);
  }, [enabled, matchingMode, maxSkills]);

  const labelStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 0",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    fontSize: "0.85rem",
  };

  const selectStyle: React.CSSProperties = {
    background: "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.9)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 4,
    padding: "4px 8px",
    fontSize: "0.82rem",
  };

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 12px",
    borderRadius: 4,
    border: "none",
    cursor: "pointer",
    fontSize: "0.82rem",
    fontWeight: 500,
    background: active ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.15)",
    color: active ? "rgb(34,197,94)" : "rgb(252,165,165)",
  });

  return (
    <div style={{ padding: "1rem", maxWidth: 480, display: "flex", flexDirection: "column", gap: 4 }}>
      <h3 style={{ fontSize: "1rem", fontWeight: 600, color: "rgba(255,255,255,0.9)", margin: "0 0 8px" }}>
        Skill Router Configuration
      </h3>

      <div style={labelStyle}>
        <span>Enabled</span>
        <button style={toggleStyle(enabled)} onClick={() => setEnabled(!enabled)}>
          {enabled ? "ON" : "OFF"}
        </button>
      </div>

      <div style={labelStyle}>
        <span>Matching Mode</span>
        <select
          style={selectStyle}
          value={matchingMode}
          onChange={(e) => setMatchingMode(e.target.value)}
        >
          <option value="keyword">Keyword (free)</option>
          <option value="hybrid">Hybrid (keyword + LLM fallback)</option>
          <option value="llm">LLM only</option>
        </select>
      </div>

      <div style={labelStyle}>
        <span>Max Skills per Task</span>
        <input
          type="number"
          style={{ ...selectStyle, width: 60, textAlign: "center" }}
          value={maxSkills}
          min={1}
          max={20}
          onChange={(e) => setMaxSkills(Number(e.target.value))}
        />
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <button
          style={{
            padding: "6px 16px",
            borderRadius: 4,
            border: "none",
            cursor: saving ? "wait" : "pointer",
            fontSize: "0.85rem",
            fontWeight: 600,
            background: "rgba(59,130,246,0.2)",
            color: "rgb(147,197,253)",
          }}
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {saved && (
          <span style={{ fontSize: "0.8rem", color: "rgb(34,197,94)" }}>Saved!</span>
        )}
      </div>

      {/* Analytics summary */}
      {data && data.totalDecisions > 0 && (
        <div style={{ marginTop: 16, padding: 12, background: "rgba(255,255,255,0.03)", borderRadius: 6 }}>
          <div style={sectionHeader}>Analytics Summary</div>
          <div style={{ fontSize: "0.8rem", color: "rgba(255,255,255,0.6)", lineHeight: 1.5 }}>
            <div>{data.totalDecisions} routing decisions recorded</div>
            <div>{data.skillEffectiveness.length} unique skills routed</div>
            <div>{data.zeroMatchCount} zero-match tasks ({data.totalDecisions > 0 ? Math.round((data.zeroMatchCount / data.totalDecisions) * 100) : 0}%)</div>
            {data.consolidation.length > 0 && (
              <div style={{ color: "rgb(250,204,21)" }}>
                {data.consolidation.length} agent consolidation signal(s) detected
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
