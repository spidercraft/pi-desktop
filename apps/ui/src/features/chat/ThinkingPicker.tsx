/**
 * Thinking (reasoning effort) switcher for the active workspace. Shown next to
 * the model picker when the adapter supports thinking levels. Lists only the
 * levels the session's current model supports; the host clamps and returns the
 * effective state, so what the trigger shows is always what the model runs at.
 */
import { useEffect, useState } from "react";
import type { HostSettings, ThinkingInfo, ThinkingLevel } from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { Dropdown } from "../../components/Dropdown.js";

/** Canonical display order (mirrors the ThinkingLevel union). */
const LEVEL_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "extra high",
};

export function ThinkingPicker({
  client,
  sessionId,
  version = 0,
}: {
  client: HostClient;
  /** Omitted on the home screen: the picker then sets the default reasoning
   *  effort applied to new chats (saved in host settings). */
  sessionId?: string;
  /** Bump to force a re-fetch (e.g. after switching models). */
  version?: number;
}) {
  const [info, setInfo] = useState<ThinkingInfo>();
  /** Home mode (no session): the saved default level. */
  const [homeLevel, setHomeLevel] = useState<ThinkingLevel>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (sessionId) {
        try {
          const thinking = await client.send<ThinkingInfo | null>({
            type: "get_thinking",
            sessionId,
          });
          if (!cancelled) setInfo(thinking ?? undefined);
        } catch {
          if (!cancelled) setInfo(undefined);
        }
      } else {
        try {
          const settings = await client.send<HostSettings>({ type: "get_settings" });
          if (!cancelled) setHomeLevel(settings.defaultThinking ?? "off");
        } catch {
          if (!cancelled) setHomeLevel("off");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, version]);

  // Home screen: offer every level, persist the choice as the default for new
  // chats (the host clamps it per model when a chat starts).
  if (!sessionId) {
    if (homeLevel === undefined) return null;
    const applyDefault = async (level: ThinkingLevel) => {
      setHomeLevel(level);
      await client
        .send({ type: "set_setting", key: "defaultThinking", value: level })
        .catch(() => {});
    };
    return (
      <Dropdown
        className="thinking-picker"
        up
        title="Default reasoning effort for new chats (clamped to what each model supports)"
        value={homeLevel}
        onChange={(level) => void applyDefault(level as ThinkingLevel)}
        options={LEVEL_ORDER.map((level) => ({ value: level, label: LEVEL_LABELS[level] }))}
      />
    );
  }

  if (!info) return null;

  const levels = LEVEL_ORDER.filter((level) => info.available.includes(level));
  // A model that only does "off" has nothing to pick — hide the control.
  if (levels.length < 2) return null;

  const apply = async (level: ThinkingLevel) => {
    try {
      const effective = await client.send<ThinkingInfo | null>({
        type: "set_thinking_level",
        sessionId,
        level,
      });
      // Host returns the clamped state; fall back to optimistic update.
      setInfo(effective ?? { ...info, level });
      // Remember it as the default for new chats too (persisted across restarts).
      void client
        .send({ type: "set_setting", key: "defaultThinking", value: level })
        .catch(() => {});
    } catch {
      /* keep previous state */
    }
  };

  return (
    <Dropdown
      className="thinking-picker"
      up
      title="Reasoning effort for this workspace (clamped to what the model supports)"
      value={info.level}
      onChange={(level) => void apply(level as ThinkingLevel)}
      options={levels.map((level) => ({
        value: level,
        label: LEVEL_LABELS[level],
      }))}
    />
  );
}
