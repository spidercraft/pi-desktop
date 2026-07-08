/**
 * Per-workspace permission policy control (§7.3): mode dropdown plus a small
 * rule editor for custom mode. Talks get/set_permission_policy.
 */
import { useEffect, useState } from "react";
import type {
  HostSettings,
  PermissionPolicyConfig,
  PermissionRule,
  ToolDecision,
} from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { Dropdown } from "../../components/Dropdown.js";

/** danger: safe (green) < medium (accent) < variable (orange) < high (red). */
const MODES = [
  { value: "ask", label: "Ask before edits", danger: "medium" },
  { value: "full-auto", label: "Full auto", danger: "high" },
  { value: "deny-all-mutation", label: "Read-only", danger: "safe" },
  { value: "custom", label: "Custom rules", danger: "variable" },
];

function policyLabel(mode: (typeof MODES)[number]) {
  return (
    <span className={`policy-label danger-${mode.danger}`}>
      <span className="policy-dot" />
      {mode.label}
    </span>
  );
}

const DECISIONS = [
  { value: "allow", label: "allow" },
  { value: "ask", label: "ask" },
  { value: "deny", label: "deny" },
];

const EMPTY_RULE: PermissionRule = { toolName: "*", decision: "ask" };

export function PolicyControl({
  client,
  sessionId,
  onPick,
}: {
  client: HostClient;
  /** Omitted on the home screen (no session yet): the pick still becomes the
   *  saved default, and is reported via onPick for the very first session. */
  sessionId?: string;
  /** Called with the chosen policy when there is no session to apply it to. */
  onPick?: (policy: PermissionPolicyConfig) => void;
}) {
  const [policy, setPolicy] = useState<PermissionPolicyConfig>();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      // No session yet — reflect the saved default so the home bar matches chats.
      client
        .send<HostSettings>({ type: "get_settings" })
        .then((s) => setPolicy(s.defaultPermissionPolicy ?? { mode: "ask" }))
        .catch(() => setPolicy({ mode: "ask" }));
      return;
    }
    setPolicy(undefined);
    client
      .send<PermissionPolicyConfig>({ type: "get_permission_policy", sessionId })
      .then(setPolicy)
      .catch(() => setPolicy(undefined));
  }, [client, sessionId]);

  if (!policy) return null;

  const push = (next: PermissionPolicyConfig) => {
    setPolicy(next);
    // Always remember the choice as the default for new chats (persisted, so it
    // survives restarts); apply it to the live session too when there is one.
    void client
      .send({ type: "set_setting", key: "defaultPermissionPolicy", value: next })
      .catch(() => {});
    if (sessionId) {
      void client.send({ type: "set_permission_policy", sessionId, policy: next }).catch(() => {});
    } else {
      onPick?.(next);
    }
  };

  const setRule = (index: number, patch: Partial<PermissionRule>) => {
    const rules = [...(policy.rules ?? [])];
    rules[index] = { ...rules[index], ...patch };
    push({ ...policy, rules });
  };

  return (
    <div className="policy-control">
      <Dropdown
        up
        title="Permission policy for this workspace"
        value={policy.mode}
        options={MODES.map((m) => ({ value: m.value, label: policyLabel(m) }))}
        onChange={(v) => {
          const mode = v as PermissionPolicyConfig["mode"];
          push({ mode, rules: mode === "custom" ? (policy.rules ?? [EMPTY_RULE]) : policy.rules });
          setExpanded(mode === "custom");
        }}
      />

      {policy.mode === "custom" && (
        <button className={expanded ? "active" : ""} onClick={() => setExpanded(!expanded)}>
          rules ({policy.rules?.length ?? 0})
        </button>
      )}

      {policy.mode === "custom" && expanded && (
        <div className="rules-pop">
          <div className="dim" style={{ fontSize: 12 }}>
            First matching rule wins. Unmatched mutations ask; everything else is allowed.
          </div>
          {(policy.rules ?? []).map((rule, i) => (
            <div key={i} className="rule-row">
              <input
                value={rule.toolName}
                placeholder="tool (* = any)"
                onChange={(e) => setRule(i, { toolName: e.target.value })}
              />
              <input
                value={rule.pathPrefix ?? ""}
                placeholder="path prefix (optional)"
                onChange={(e) =>
                  setRule(i, { pathPrefix: e.target.value ? e.target.value : undefined })
                }
              />
              <Dropdown
                value={rule.decision}
                options={DECISIONS}
                onChange={(v) => setRule(i, { decision: v as ToolDecision })}
              />
              <button
                className="danger"
                onClick={() => push({ ...policy, rules: policy.rules?.filter((_, j) => j !== i) })}
              >
                ×
              </button>
            </div>
          ))}
          <button onClick={() => push({ ...policy, rules: [...(policy.rules ?? []), { ...EMPTY_RULE }] })}>
            + rule
          </button>
        </div>
      )}
    </div>
  );
}
