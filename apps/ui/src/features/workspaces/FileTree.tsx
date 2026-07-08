/** Lazy-loaded file tree for cwd-bound workspaces (§7.5). */
import { useCallback, useEffect, useRef, useState } from "react";
import type { HostClient } from "../../client.js";
import type { ViewerContent } from "../viewer/CodeViewer.js";

interface DirEntry {
  name: string;
  dir: boolean;
}

const PANEL_EXTENSIONS = new Set([
  "bat",
  "c",
  "cc",
  "cmd",
  "cpp",
  "cs",
  "css",
  "csv",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "md",
  "mjs",
  "py",
  "rs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const LANG_BY_EXTENSION: Record<string, string> = {
  h: "c",
  hpp: "cpp",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  md: "markdown",
  py: "python",
  rs: "rust",
  sh: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isPanelCompatible(path: string): boolean {
  return PANEL_EXTENSIONS.has(extensionOf(path));
}

function viewerLang(path: string): string | undefined {
  const ext = extensionOf(path);
  return LANG_BY_EXTENSION[ext] ?? (ext || undefined);
}

function base64ToText(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function joinPath(base: string, name: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return base.endsWith(sep) ? base + name : base + sep + name;
}

function TreeGuides({ depth }: { depth: number }) {
  if (depth === 0) return null;
  return (
    <span className="tree-guides" aria-hidden="true">
      {Array.from({ length: depth }, (_, index) => (
        <span key={index} className="tree-guide" />
      ))}
    </span>
  );
}

function Node({
  client,
  path,
  name,
  dir,
  depth,
  selectedPath,
  onSelectFile,
  onOpenDefault,
}: {
  client: HostClient;
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  selectedPath?: string;
  onSelectFile: (path: string) => void;
  onOpenDefault: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[]>();
  const [error, setError] = useState(false);
  const clickTimer = useRef<number>();

  useEffect(() => () => window.clearTimeout(clickTimer.current), []);

  const toggle = async () => {
    if (!dir) return;
    setOpen(!open);
    if (children === undefined && !open) {
      try {
        setChildren(await client.send<DirEntry[]>({ type: "list_dir", path }));
      } catch {
        setError(true);
      }
    }
  };

  const singleClick = () => {
    if (dir) {
      void toggle();
      return;
    }
    if (isPanelCompatible(path)) onSelectFile(path);
    else onOpenDefault(path);
  };

  const doubleClick = () => {
    if (dir) return;
    window.clearTimeout(clickTimer.current);
    onOpenDefault(path);
  };

  return (
    <>
      <button
        className={`tree-node ${dir ? "dir" : "file"} ${selectedPath === path ? "selected" : ""}`}
        onClick={() => {
          window.clearTimeout(clickTimer.current);
          clickTimer.current = window.setTimeout(singleClick, 180);
        }}
        onDoubleClick={doubleClick}
        title={path}
      >
        <TreeGuides depth={depth} />
        <span className="tree-icon">{dir ? (open ? "▾" : "▸") : "·"}</span>
        <span className="tree-label">{name}</span>
      </button>
      {open && error && (
        <div className="tree-message dim">
          <TreeGuides depth={depth + 1} />
          unreadable
        </div>
      )}
      {open &&
        children?.map((child) => (
          <Node
            key={child.name}
            client={client}
            path={joinPath(path, child.name)}
            name={child.name}
            dir={child.dir}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
            onOpenDefault={onOpenDefault}
          />
        ))}
    </>
  );
}

export function FileTree({
  client,
  cwd,
  selectedPath,
  onSelectPath,
  onPreview,
  onClosePreview,
}: {
  client: HostClient;
  cwd: string;
  selectedPath?: string;
  onSelectPath: (path?: string) => void;
  onPreview: (content: ViewerContent) => void;
  onClosePreview: () => void;
}) {
  const [roots, setRoots] = useState<DirEntry[]>();

  const refresh = useCallback(() => {
    client
      .send<DirEntry[]>({ type: "list_dir", path: cwd })
      .then(setRoots)
      .catch(() => setRoots([]));
  }, [client, cwd]);

  useEffect(refresh, [refresh]);

  const openDefault = useCallback(
    (path: string) => {
      void client.send({ type: "open_path", path });
    },
    [client],
  );

  const selectFile = useCallback(
    (path: string) => {
      if (selectedPath === path) {
        onSelectPath(undefined);
        onClosePreview();
        return;
      }
      onSelectPath(path);
      client
        .send<string>({ type: "read_file_base64", path })
        .then((base64) => onPreview({ code: base64ToText(base64), lang: viewerLang(path) }))
        .catch(() => {
          onSelectPath(undefined);
          openDefault(path);
        });
    },
    [client, onClosePreview, onPreview, onSelectPath, openDefault, selectedPath],
  );

  return (
    <div className="file-tree">
      {roots?.map((entry) => (
        <Node
          key={entry.name}
          client={client}
          path={joinPath(cwd, entry.name)}
          name={entry.name}
          dir={entry.dir}
          depth={0}
          selectedPath={selectedPath}
          onSelectFile={selectFile}
          onOpenDefault={openDefault}
        />
      ))}
      {roots?.length === 0 && <div className="dim" style={{ fontSize: 12 }}>empty</div>}
    </div>
  );
}
