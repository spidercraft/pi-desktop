/**
 * App-wide notification system. A single, module-level store any code can push
 * to via `notify(...)` — no prop drilling or context needed. `<Notifications/>`
 * (mounted once in App) subscribes and renders the toast stack. Use it for all
 * user feedback on edits/saves across the app.
 */
import { useSyncExternalStore } from "react";

export type NotifyKind = "success" | "error" | "info";

export interface NotificationAction {
  label: string;
  kind?: "primary" | "danger";
  onClick(): void;
}

export interface Notification {
  id: number;
  message: string;
  kind: NotifyKind;
  actions?: NotificationAction[];
}

interface PushOptions {
  actions?: NotificationAction[];
  durationMs?: number;
  /** Optional native notification body when it should differ from the toast. */
  systemMessage?: string;
  /** Called when the native/system notification is clicked. */
  systemOnClick?: () => void;
}

interface ConfirmOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  kind?: NotifyKind;
}

/** How long each kind stays before auto-dismissing (ms). Errors linger. */
const DURATION: Record<NotifyKind, number> = {
  success: 4000,
  info: 5000,
  error: 8000,
};

let items: Notification[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, number>();

const NOTIFICATION_SOUND_URL = "/Notification.mp3";
const SYSTEM_NOTIFICATION_TITLE = "Pi Desktop";
let notificationAudio: HTMLAudioElement | null = null;

function playNotificationSound(): void {
  notificationAudio ??= new Audio(NOTIFICATION_SOUND_URL);
  notificationAudio.currentTime = 0;
  void notificationAudio.play().catch(() => {
    // Browsers may block autoplay until the user has interacted with the app.
  });
}

async function focusApp(): Promise<void> {
  window.focus();
  try {
    const appWindow = window.__TAURI__?.window?.getCurrentWindow();
    await appWindow?.unminimize?.();
    await appWindow?.setFocus?.();
  } catch {
    // Bringing the app forward is best-effort.
  }
}

async function sendSystemNotification(message: string, onClick?: () => void): Promise<void> {
  if (document.hasFocus()) return;
  const notification = window.__TAURI__?.notification;
  if (!notification && !globalThis.Notification) return;
  try {
    if (onClick && globalThis.Notification) {
      try {
        let permission = globalThis.Notification.permission;
        if (permission === "default") permission = await globalThis.Notification.requestPermission();
        if (permission === "granted" && !document.hasFocus()) {
          const nativeNotification = new globalThis.Notification(SYSTEM_NOTIFICATION_TITLE, {
            body: message,
          });
          nativeNotification.onclick = () => {
            onClick();
            void focusApp();
            nativeNotification.close();
          };
          return;
        }
      } catch {
        // Fall back to the Tauri notification plugin below.
      }
    }

    if (!notification) return;
    let permissionGranted = await notification.isPermissionGranted();
    if (!permissionGranted) {
      const permission = await notification.requestPermission();
      permissionGranted = permission === "granted";
    }
    if (permissionGranted && !document.hasFocus()) {
      notification.sendNotification({ title: SYSTEM_NOTIFICATION_TITLE, body: message });
    }
  } catch {
    // System notifications are best-effort.
  }
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Notification[] {
  return items;
}

export function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = items.filter((n) => n.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

function push(message: string, kind: NotifyKind, options: PushOptions = {}): number {
  const id = nextId++;
  items = [...items, { id, message, kind, actions: options.actions }];
  playNotificationSound();
  emit();
  void sendSystemNotification(options.systemMessage ?? message, options.systemOnClick);
  const ttl = options.durationMs ?? DURATION[kind];
  if (ttl > 0) timers.set(id, window.setTimeout(() => dismiss(id), ttl));
  return id;
}

function confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let id = 0;
    const finish = (confirmed: boolean) => {
      dismiss(id);
      resolve(confirmed);
    };
    id = push(message, options.kind ?? "info", {
      durationMs: 0,
      actions: [
        {
          label: options.cancelLabel ?? "Cancel",
          onClick: () => finish(false),
        },
        {
          label: options.confirmLabel ?? "Confirm",
          kind: "danger",
          onClick: () => finish(true),
        },
      ],
    });
  });
}

/**
 * Show a notification. Call directly (`notify("Saved")`) or use the kind
 * helpers: `notify.success(...)`, `notify.error(...)`, `notify.info(...)`.
 */
export const notify = Object.assign(
  (message: string, kind: NotifyKind = "info", options?: PushOptions) =>
    push(message, kind, options),
  {
    success: (message: string, options?: PushOptions) => push(message, "success", options),
    error: (message: string, options?: PushOptions) => push(message, "error", options),
    info: (message: string, options?: PushOptions) => push(message, "info", options),
    confirm,
  },
);

const ICONS: Record<NotifyKind, string> = {
  success: "✓",
  error: "!",
  info: "i",
};

/** The toast stack. Mount once, near the app root. */
export function Notifications() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (list.length === 0) return null;
  return (
    <div className="toast-stack">
      {list.map((n) => (
        <div
          key={n.id}
          className={`toast toast-${n.kind}`}
          role="status"
          title={n.actions ? undefined : "Dismiss"}
          onClick={() => {
            if (!n.actions) dismiss(n.id);
          }}
        >
          <span className="toast-icon" aria-hidden>
            {ICONS[n.kind]}
          </span>
          <span className="toast-msg">{n.message}</span>
          {n.actions && (
            <span className="toast-actions">
              {n.actions.map((action) => (
                <button
                  key={action.label}
                  className={action.kind === "danger" ? "danger" : undefined}
                  onClick={(event) => {
                    event.stopPropagation();
                    action.onClick();
                  }}
                >
                  {action.label}
                </button>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
