import React, { useMemo, useState } from "react";

export function Onboarding(props: {
  initialName?: string;
  onSubmit: (displayName: string) => void;
}) {
  const [name, setName] = useState(props.initialName ?? "");
  const trimmed = name.trim();
  const error = useMemo(() => {
    if (!trimmed) return "Please enter a username.";
    if (trimmed.length > 64) return "Username is too long (max 64).";
    return null;
  }, [trimmed]);

  return (
    <div className="overlay">
      <div className="modal">
        <div style={{ fontWeight: 750, fontSize: 18 }}>Welcome</div>
        <div className="muted" style={{ marginTop: 6 }}>
          Pick a username to continue.
        </div>

        <div style={{ height: 12 }} />

        <input
          className="input"
          value={name}
          placeholder="Username"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !error) props.onSubmit(trimmed);
          }}
        />

        {error ? (
          <div className="muted" style={{ color: "var(--danger)", marginTop: 8 }}>
            {error}
          </div>
        ) : null}

        <div style={{ height: 12 }} />

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn btnPrimary" onClick={() => props.onSubmit(trimmed)} disabled={Boolean(error)}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

