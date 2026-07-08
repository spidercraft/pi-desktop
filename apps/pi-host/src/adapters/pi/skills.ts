/**
 * PiSkillManager — neutral SkillManager over pi's native skill machinery.
 *
 * pi implements the Agent Skills standard (SKILL.md with name/description
 * frontmatter), the same format Claude skills use. Discovery reuses pi's own
 * loadSkills(), so what this lists is exactly what sessions see. Extra source
 * directories (e.g. ~/.claude/skills) are persisted in pi's global
 * settings.json "skills" array — pi's documented mechanism for skills from
 * other harnesses.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { SkillInfo, SkillManager } from "@pi-desktop/harness-sdk";

/** Expand a leading "~" (settings entries commonly use it). */
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\")
    ? join(homedir(), path.slice(1))
    : path;
}

/** Is `path` equal to or inside `dir`? */
function isInside(dir: string, path: string): boolean {
  const root = resolve(dir);
  const target = resolve(path);
  return target === root || target.startsWith(root + sep);
}

export class PiSkillManager implements SkillManager {
  constructor(private readonly agentDir: string) {}

  /** Managed global skills directory (installs default here). */
  private get globalDir(): string {
    return join(this.agentDir, "skills");
  }

  private get settingsPath(): string {
    return join(this.agentDir, "settings.json");
  }

  private projectDir(cwd: string): string {
    return join(cwd, ".pi", "skills");
  }

  /* ------------------------------ settings I/O ----------------------------- */

  private readSettings(): Record<string, unknown> {
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private writeSettings(settings: Record<string, unknown>): void {
    mkdirSync(this.agentDir, { recursive: true });
    writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2));
  }

  /* -------------------------------- sources -------------------------------- */

  async listSources(): Promise<string[]> {
    const raw = this.readSettings().skills;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  }

  async addSource(path: string): Promise<void> {
    const trimmed = path.trim();
    if (!trimmed) throw new Error("Skill source path is empty");
    if (!existsSync(expandHome(trimmed))) {
      throw new Error(`Directory not found: ${expandHome(trimmed)}`);
    }
    const sources = await this.listSources();
    if (sources.includes(trimmed)) return;
    // Written to pi's global settings.json — the pi CLI honors it too.
    this.writeSettings({ ...this.readSettings(), skills: [...sources, trimmed] });
  }

  async removeSource(path: string): Promise<void> {
    const sources = await this.listSources();
    this.writeSettings({
      ...this.readSettings(),
      skills: sources.filter((s) => s !== path),
    });
  }

  /* --------------------------------- skills -------------------------------- */

  async list(cwd?: string): Promise<SkillInfo[]> {
    const sources = (await this.listSources()).map(expandHome);
    const { skills } = loadSkills({
      cwd: cwd ?? homedir(),
      agentDir: this.agentDir,
      skillPaths: sources,
      includeDefaults: true,
    });
    return skills.map((skill) => {
      // Single-file skills (root .md) have baseDir = the skills dir itself;
      // their identity is the file. Directory skills are their directory.
      const isSingleFile = basename(skill.filePath).toLowerCase() !== "skill.md";
      const path = isSingleFile ? skill.filePath : dirname(skill.filePath);
      const project = cwd !== undefined && isInside(cwd, path);
      const scope: SkillInfo["scope"] = isInside(this.globalDir, path)
        ? "global"
        : project
          ? "project"
          : isInside(join(homedir(), ".agents", "skills"), path)
            ? "global"
            : "external";
      // Managed (global/project) skills, and skills living inside a registered
      // source directory, can be deleted from disk one by one.
      const removable =
        isInside(this.globalDir, path) ||
        (cwd !== undefined && isInside(this.projectDir(cwd), path)) ||
        sources.some((source) => isInside(source, path));
      return {
        name: skill.name,
        description: skill.description,
        path,
        scope,
        ...(removable ? { removable: true } : {}),
      };
    });
  }

  async install(source: string, scope: "global" | "project", cwd?: string): Promise<void> {
    const src = expandHome(source.trim());
    if (!existsSync(src)) throw new Error(`Not found: ${src}`);
    if (scope === "project" && !cwd) {
      throw new Error("Project installs need a folder-bound chat");
    }
    const destRoot = scope === "project" ? this.projectDir(cwd as string) : this.globalDir;

    const stat = statSync(src);
    if (stat.isDirectory()) {
      if (!existsSync(join(src, "SKILL.md"))) {
        throw new Error(`Not a skill: ${src} has no SKILL.md`);
      }
      const dest = join(destRoot, basename(src));
      if (existsSync(dest)) throw new Error(`Skill already installed: ${dest}`);
      mkdirSync(destRoot, { recursive: true });
      cpSync(src, dest, { recursive: true });
    } else if (src.toLowerCase().endsWith(".md")) {
      const dest = join(destRoot, basename(src));
      if (existsSync(dest)) throw new Error(`Skill already installed: ${dest}`);
      mkdirSync(destRoot, { recursive: true });
      cpSync(src, dest);
    } else {
      throw new Error("A skill is a directory containing SKILL.md, or a single .md file");
    }
  }

  async remove(path: string, cwd?: string): Promise<void> {
    const sources = (await this.listSources()).map(expandHome);
    // Never delete a skills root itself (a SKILL.md directly at the root
    // would otherwise resolve to it and take every skill with it) — neither a
    // managed root nor a registered external source directory.
    if (
      resolve(path) === resolve(this.globalDir) ||
      (cwd !== undefined && resolve(path) === resolve(this.projectDir(cwd)))
    ) {
      throw new Error("Refusing to delete the skills directory itself");
    }
    if (sources.some((source) => resolve(source) === resolve(path))) {
      throw new Error(
        "Refusing to delete a skill source directory itself — remove the source instead",
      );
    }
    // Delete inside directories we manage, or inside a registered source
    // directory (external skills, e.g. from ~/.claude/skills). External skills
    // are shared with their source, so this deletes the folder from disk.
    const managed =
      isInside(this.globalDir, path) || (cwd !== undefined && isInside(this.projectDir(cwd), path));
    const external = sources.some((source) => isInside(source, path));
    if (!managed && !external) {
      throw new Error(
        "Only skills inside the global, project, or a registered source directory can be removed",
      );
    }
    rmSync(path, { recursive: true, force: true });
  }
}
