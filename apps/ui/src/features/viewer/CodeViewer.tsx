/**
 * Right-side viewer panel (§7.6): opens when the assistant produces a code
 * block (or when one is clicked in the chat). Syntax highlighting via
 * highlight.js — artifacts can join this panel later.
 */
import { useMemo, useState } from "react";
import hljs from "highlight.js";

export interface ViewerContent {
  code: string;
  lang?: string;
}

export function CodeViewer({
  content,
  onClose,
  embedded,
}: {
  content: ViewerContent;
  onClose: () => void;
  /** Render without the <aside> wrapper (inside the side panel). */
  embedded?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const { html, language } = useMemo(() => {
    try {
      if (content.lang && hljs.getLanguage(content.lang)) {
        return {
          html: hljs.highlight(content.code, { language: content.lang }).value,
          language: content.lang,
        };
      }
      const auto = hljs.highlightAuto(content.code);
      return { html: auto.value, language: auto.language ?? "code" };
    } catch {
      // hljs escapes its output; on failure fall back to escaped plain text.
      const escaped = content.code
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return { html: escaped, language: content.lang ?? "code" };
    }
  }, [content]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const body = (
    <>
      <div className="viewer-head">
        <span className="viewer-lang">{language}</span>
        <span className="viewer-lines dim">
          {content.code.split("\n").length} lines
        </span>
        <div className="composer-spacer" />
        <button onClick={() => void copy()}>{copied ? "copied ✓" : "copy"}</button>
        <button className="viewer-close" title="Close viewer" onClick={onClose}>
          ×
        </button>
      </div>
      <pre className="viewer-code">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </>
  );

  if (embedded) return <div className="viewer-embed">{body}</div>;
  return <aside className="viewer">{body}</aside>;
}
