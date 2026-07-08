/**
 * Settings → Skills: manage Agent-Skills-standard skills (the format Claude
 * skills use). Lists everything the harness discovers, installs skill folders
 * into the global/project skills directory, and manages extra source
 * directories — with a one-click shortcut for ~/.claude/skills.
 */
import { useEffect, useState } from "react";
import type { SkillInfo } from "@pi-desktop/protocol";
import type { HostClient } from "../../client.js";
import { notify } from "../../notifications.js";

const CLAUDE_SKILLS_DIR = "~/.claude/skills";

export function Skills({ client, cwd }: { client: HostClient; cwd?: string }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [installPath, setInstallPath] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const [skillList, sourceList] = await Promise.all([
        client.send<SkillInfo[]>({ type: "list_skills", cwd }),
        client.send<string[]>({ type: "list_skill_sources" }),
      ]);
      setSkills(skillList);
      setSources(sourceList);
    } catch (err) {
      notify.error((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cwd]);

  /** Run a mutation, refresh the lists, surface feedback via notifications. */
  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      if (done) notify.success(done);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const install = () =>
    run(
      () =>
        client.send({
          type: "install_skill",
          source: installPath.trim(),
          scope: "global",
          cwd,
        }),
      "Installed — applies to newly opened chats.",
    ).then(() => setInstallPath(""));

  /** Delete a single skill from disk. External skills live in a shared source
   *  directory, so confirm before removing those. */
  const deleteSkill = async (s: SkillInfo) => {
    if (s.scope === "external") {
      const ok = await notify.confirm(
        `Delete "${s.name}" from disk?\n${s.path}\n\n` +
          "It lives in a source directory shared with other tools (e.g. Claude Code), " +
          "so this removes the skill folder itself.",
        { confirmLabel: "Delete" },
      );
      if (!ok) return;
    }
    void run(() => client.send({ type: "remove_skill", path: s.path, cwd }), "Removed.");
  };

  const addSource = (path: string) =>
    run(
      () => client.send({ type: "add_skill_source", path }),
      "Added — applies to newly opened chats.",
    ).then(() => setSourcePath(""));

  const hasClaudeSource = sources.includes(CLAUDE_SKILLS_DIR);

  return (
    <>
      <div className="setting">
        <label>Skills</label>
        <div className="dim">
          Skills follow the Agent Skills standard (a folder with SKILL.md) — the same format
          Claude skills use. Descriptions are always in the model's context; full instructions
          load on demand. Changes apply to newly opened chats.
        </div>
        <div className="custom-model-list">
          {skills.length === 0 && <div className="dim">No skills discovered yet.</div>}
          {skills.map((s) => (
            <div key={s.path} className="custom-model-row skill-row" title={s.path}>
              <div className="skill-main">
                <div className="skill-head">
                  <span className="custom-model-name">{s.name}</span>
                  <span className="pill">{s.scope}</span>
                  {s.scope === "external" && s.removable && (
                    <button
                      className="danger icon-btn pill-delete"
                      disabled={busy}
                      title={`Delete ${s.name} from its source directory (${s.path})`}
                      onClick={() => deleteSkill(s)}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="dim skill-desc">{s.description}</div>
              </div>
              {s.scope !== "external" &&
                (s.removable ? (
                  <button
                    className="danger icon-btn"
                    disabled={busy}
                    title={`Remove ${s.name} (${s.path})`}
                    onClick={() => deleteSkill(s)}
                  >
                    ✕
                  </button>
                ) : (
                  <span className="icon-btn-placeholder" title="Managed by its source directory" />
                ))}
            </div>
          ))}
        </div>
      </div>

      <div className="setting">
        <label>Install a skill</label>
        <div className="row">
          <input
            value={installPath}
            placeholder="Path to a skill folder (contains SKILL.md) or .md file"
            onChange={(e) => setInstallPath(e.target.value)}
          />
          <button className="primary" disabled={busy || !installPath.trim()} onClick={() => void install()}>
            Install
          </button>
        </div>
        <div className="dim">
          Copies the skill into the global skills directory, available in every chat.
        </div>
      </div>

      <div className="setting">
        <label>Skill sources (other harnesses)</label>
        <div className="dim">
          Extra directories scanned for skills without copying — use this to share skills with
          Claude Code, Codex, or any Agent Skills tool.
        </div>
        <div className="custom-model-list">
          {sources.map((source) => (
            <div key={source} className="custom-model-row">
              <span className="custom-model-name">{source}</span>
              <button
                className="danger icon-btn"
                disabled={busy}
                title={`Stop loading skills from ${source}`}
                onClick={() =>
                  void run(() => client.send({ type: "remove_skill_source", path: source }))
                }
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="row">
          <input
            value={sourcePath}
            placeholder={CLAUDE_SKILLS_DIR}
            onChange={(e) => setSourcePath(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || !sourcePath.trim()}
            onClick={() => void addSource(sourcePath.trim())}
          >
            Add
          </button>
        </div>
        {!hasClaudeSource && (
          <div className="row">
            <button disabled={busy} onClick={() => void addSource(CLAUDE_SKILLS_DIR)}>
              + Use my Claude skills ({CLAUDE_SKILLS_DIR})
            </button>
          </div>
        )}
      </div>
    </>
  );
}
