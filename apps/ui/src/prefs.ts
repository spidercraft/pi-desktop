/** Small localStorage-backed UI preferences (client-only, not host settings). */

const AUTO_EXPAND_THINKING_KEY = "pd-auto-expand-thinking";

export function autoExpandThinking(): boolean {
  try {
    return localStorage.getItem(AUTO_EXPAND_THINKING_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoExpandThinking(value: boolean): void {
  try {
    localStorage.setItem(AUTO_EXPAND_THINKING_KEY, value ? "1" : "0");
  } catch {
    /* private mode etc. — preference just won't persist */
  }
}
