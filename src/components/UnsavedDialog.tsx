import { AlertCircle, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef } from "react";

import { useModalFocus } from "../lib/useModalFocus";

interface UnsavedDialogProps {
  title: string;
  message: string;
  files: string[];
  saveLabel: string;
  discardLabel: string;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function UnsavedDialog({
  title,
  message,
  files,
  saveLabel,
  discardLabel,
  busy,
  error,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, cancelRef);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="dialog-icon" aria-hidden>
          <AlertCircle size={19} />
        </div>
        <div className="dialog-body">
          <h2 id={titleId}>{title}</h2>
          <p id={messageId}>{message}</p>
          {files.length > 0 && (
            <ul className="dialog-files">
              {files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          )}
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button className="button" onClick={onCancel} disabled={busy} ref={cancelRef}>
            取消
          </button>
          <button className="button" onClick={onDiscard} disabled={busy}>
            {discardLabel}
          </button>
          <button className="button button-primary" onClick={onSave} disabled={busy}>
            {busy && <LoaderCircle size={13} className="spin" />}
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
