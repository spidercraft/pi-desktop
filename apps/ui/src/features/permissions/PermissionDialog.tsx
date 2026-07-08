/** Renders host ui_request dialogs (permission asks, selects, inputs). */
import { useState } from "react";
import type { UiRequestEnvelope } from "../../client.js";

export function PermissionDialog({
  envelope,
  onAnswer,
}: {
  envelope: UiRequestEnvelope;
  onAnswer: (requestId: string, value: unknown) => void;
}) {
  const { requestId, request } = envelope;
  const [text, setText] = useState("");

  return (
    <div className="overlay">
      <div className="dialog">
        <div className="dialog-title">{request.title}</div>
        {request.message && <pre className="dialog-message">{request.message}</pre>}

        {request.method === "confirm" && (
          <div className="dialog-actions">
            <button className="primary" onClick={() => onAnswer(requestId, true)}>
              Allow
            </button>
            <button className="danger" onClick={() => onAnswer(requestId, false)}>
              Deny
            </button>
          </div>
        )}

        {request.method === "select" && (
          <div className="dialog-options">
            {(request.options ?? []).map((option) => (
              <button key={option} onClick={() => onAnswer(requestId, option)}>
                {option}
              </button>
            ))}
            <button className="danger" onClick={() => onAnswer(requestId, undefined)}>
              Cancel
            </button>
          </div>
        )}

        {request.method === "ask" && (
          <>
            {(request.options ?? []).length > 0 && (
              <div className="dialog-options ask-options">
                {(request.options ?? []).map((option) => (
                  <button key={option} onClick={() => onAnswer(requestId, option)}>
                    {option}
                  </button>
                ))}
              </div>
            )}
            <input
              autoFocus
              value={text}
              placeholder={request.placeholder ?? "Type your own answer…"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && text.trim() && onAnswer(requestId, text.trim())}
            />
            <div className="dialog-actions">
              <button
                className="primary"
                disabled={!text.trim()}
                onClick={() => onAnswer(requestId, text.trim())}
              >
                Answer
              </button>
              <button onClick={() => onAnswer(requestId, undefined)}>Skip</button>
            </div>
          </>
        )}

        {request.method === "input" && (
          <>
            <input
              autoFocus
              value={text}
              placeholder={request.placeholder}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onAnswer(requestId, text)}
            />
            <div className="dialog-actions">
              <button className="primary" onClick={() => onAnswer(requestId, text)}>
                OK
              </button>
              <button onClick={() => onAnswer(requestId, undefined)}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
