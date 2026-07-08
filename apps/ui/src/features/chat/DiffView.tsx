/**
 * Minimal dependency-free line diff for edit/write tool cards (§7.5/§7.6).
 * LCS-based; inputs are capped so pathological tool args can't freeze the UI.
 */

interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

const MAX_LINES = 400;

function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n").slice(0, MAX_LINES);
  const b = newText.split("\n").slice(0, MAX_LINES);

  // LCS table (small inputs only — capped above).
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < m) out.push({ kind: "del", text: a[i++] });
  while (j < n) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Collapse long runs of unchanged lines around the interesting parts. */
function withContext(lines: DiffLine[], context = 3): (DiffLine | { kind: "skip"; count: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, idx) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });
  if (!keep.includes(true)) return lines; // pure same (or pure add/del handled above)

  const out: (DiffLine | { kind: "skip"; count: number })[] = [];
  let skipped = 0;
  lines.forEach((line, idx) => {
    if (keep[idx]) {
      if (skipped > 0) {
        out.push({ kind: "skip", count: skipped });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: "skip", count: skipped });
  return out;
}

export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = withContext(diffLines(oldText, newText));
  return (
    <pre className="diff">
      {lines.map((line, i) =>
        line.kind === "skip" ? (
          <div key={i} className="diff-line skip">
            ⋯ {line.count} unchanged line{line.count === 1 ? "" : "s"}
          </div>
        ) : (
          <div key={i} className={`diff-line ${line.kind}`}>
            <span className="diff-sign">
              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
            </span>
            {line.text || " "}
          </div>
        ),
      )}
    </pre>
  );
}
