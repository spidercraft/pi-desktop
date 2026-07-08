/** Sanitized markdown rendering with syntax-highlighted code blocks (§7.1). */
import { useEffect, useMemo, useRef } from "react";
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";

const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      try {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      } catch {
        return code;
      }
    },
  }),
);
marked.setOptions({ gfm: true, breaks: true });

// Open links in the system browser / new tab, never in the webview itself.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noreferrer noopener");
  }
});

const ANIMATION_SKIP_TAGS = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);

function animatedHtml(html: string, animatedTokenCount: number): { html: string; tokenCount: number } {
  const template = document.createElement("template");
  template.innerHTML = html;

  let tokenCount = 0;
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (ANIMATION_SKIP_TAGS.has(element.tagName)) return;
      [...node.childNodes].forEach(walk);
      return;
    }

    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return;

    const fragment = document.createDocumentFragment();
    for (const part of node.textContent.match(/\s+|\S+/g) ?? []) {
      if (/^\s+$/.test(part)) {
        fragment.append(part);
        continue;
      }

      const span = document.createElement("span");
      span.className =
        tokenCount < animatedTokenCount ? "md-fade-token visible" : "md-fade-token";
      span.style.setProperty(
        "--md-token-delay",
        `${Math.min(tokenCount - animatedTokenCount, 24) * 38}ms`,
      );
      span.textContent = part;
      fragment.append(span);
      tokenCount += 1;
    }
    node.parentNode?.replaceChild(fragment, node);
  };

  [...template.content.childNodes].forEach(walk);
  return { html: template.innerHTML, tokenCount };
}

export function Markdown({ text, animate = false }: { text: string; animate?: boolean }) {
  const animatedTokenCount = useRef(0);
  const rendered = useMemo(() => {
    const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
    return animate ? animatedHtml(html, animatedTokenCount.current) : { html, tokenCount: 0 };
  }, [animate, text]);

  useEffect(() => {
    animatedTokenCount.current = animate ? rendered.tokenCount : 0;
  }, [animate, rendered.tokenCount]);

  return <div className="md" dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}
