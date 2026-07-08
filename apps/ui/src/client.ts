/**
 * Typed WebSocket client for the neutral wire protocol. This module (and the
 * whole UI) imports @pi-desktop/protocol ONLY — never pi.
 */
import {
  DEFAULT_HOST_PORT,
  type ClientCommand,
  type HarnessCapabilities,
  type HarnessEvent,
  type HostMessage,
  type UiRequest,
  type WorkspaceInfo,
} from "@pi-desktop/protocol";

/** Distributive omit: keeps the command union discriminated after dropping `id`. */
type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CommandInput = DistributedOmit<ClientCommand, "id">;

export interface UiRequestEnvelope {
  requestId: string;
  sessionId?: string;
  request: UiRequest;
}

type Listener = {
  onEvent: (sessionId: string, event: HarnessEvent) => void;
  onWorkspaces: (workspaces: WorkspaceInfo[]) => void;
  onHello: (capabilities: HarnessCapabilities, workspaces: WorkspaceInfo[]) => void;
  onUiRequest: (envelope: UiRequestEnvelope) => void;
  onConnectionChange: (connected: boolean) => void;
};

export class HostClient {
  #ws: WebSocket | undefined;
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #listener: Listener;
  #retryTimer: number | undefined;

  constructor(listener: Listener) {
    this.#listener = listener;
    this.connect();
  }

  connect(): void {
    const port = new URLSearchParams(location.search).get("hostPort") ?? DEFAULT_HOST_PORT;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.#ws = ws;
    ws.onopen = () => this.#listener.onConnectionChange(true);
    ws.onclose = () => {
      this.#listener.onConnectionChange(false);
      for (const { reject } of this.#pending.values()) reject(new Error("Connection lost"));
      this.#pending.clear();
      this.#retryTimer = window.setTimeout(() => this.connect(), 1500);
    };
    ws.onmessage = (raw) => {
      const message = JSON.parse(raw.data as string) as HostMessage;
      switch (message.kind) {
        case "hello":
          this.#listener.onHello(message.capabilities, message.workspaces);
          break;
        case "event":
          this.#listener.onEvent(message.sessionId, message.event);
          break;
        case "workspaces":
          this.#listener.onWorkspaces(message.workspaces);
          break;
        case "ui_request":
          this.#listener.onUiRequest({
            requestId: message.requestId,
            sessionId: message.sessionId,
            request: message.request,
          });
          break;
        case "response": {
          const pending = this.#pending.get(message.id);
          if (!pending) break;
          this.#pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.error));
          break;
        }
      }
    };
  }

  send<T = unknown>(command: CommandInput): Promise<T> {
    const id = String(this.#nextId++);
    const full = { ...command, id } as ClientCommand;
    return new Promise<T>((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected to host"));
        return;
      }
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#ws.send(JSON.stringify(full));
    });
  }

  respondUi(requestId: string, value: unknown): void {
    this.#ws?.send(
      JSON.stringify({ id: String(this.#nextId++), type: "ui_response", requestId, value }),
    );
  }

  dispose(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#ws?.close();
  }
}
