import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Timestamp
} from "firebase/firestore";
import { getFirebaseDb } from "../firebase";

type ChatMessage = {
  id: string;
  uid: string;
  fromName: string;
  ts: number;
  message: string;
};

function tsToMs(ts: unknown): number {
  if (typeof ts === "number") return ts;
  if (ts && typeof ts === "object" && "toMillis" in ts && typeof (ts as Timestamp).toMillis === "function") {
    return (ts as Timestamp).toMillis();
  }
  return 0;
}

export function ChatPanel(props: {
  channelId: string | null;
  uid: string | null;
  displayName: string;
  disabled?: boolean;
  onError?: (msg: string) => void;
}) {
  const canUse = Boolean(props.channelId && props.uid) && !props.disabled;
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loadingOlderRef = useRef(false);
  const hasMoreRef = useRef(true);

  const messageByIdRef = useRef<Map<string, ChatMessage>>(new Map());
  const cursorRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollAdjustRef = useRef<{ prevScrollTop: number; prevScrollHeight: number } | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const atBottomRef = useRef(true);
  const lastCountRef = useRef(0);

  const emptyState = useMemo(() => {
    if (!props.channelId) return "Select a channel.";
    if (!props.uid) return "Connecting…";
    return null;
  }, [props.channelId, props.uid]);

  const recomputeMessages = useCallback(() => {
    const arr = [...messageByIdRef.current.values()];
    arr.sort((a, b) => (a.ts - b.ts) || a.id.localeCompare(b.id));
    setMessages(arr);
  }, []);

  useEffect(() => {
    loadingOlderRef.current = loadingOlder;
  }, [loadingOlder]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const loadOlder = useCallback(
    async (mode: "initial" | "older") => {
      if (!props.channelId) return;
      if (mode === "older" && (!hasMoreRef.current || loadingOlderRef.current)) return;

      const el = scrollRef.current;
      if (mode === "older" && el) {
        pendingScrollAdjustRef.current = { prevScrollTop: el.scrollTop, prevScrollHeight: el.scrollHeight };
      }

      loadingOlderRef.current = true;
      setLoadingOlder(true);
      try {
        const db = getFirebaseDb();
        const colRef = collection(db, "channels", props.channelId, "messages");
        const pageSize = 50;
        const q =
          mode === "older" && cursorRef.current
            ? query(colRef, orderBy("ts", "desc"), startAfter(cursorRef.current), limit(pageSize))
            : query(colRef, orderBy("ts", "desc"), limit(pageSize));

        const snap = await getDocs(q);
        if (snap.docs.length === 0) {
          hasMoreRef.current = false;
          setHasMore(false);
          return;
        }
        cursorRef.current = snap.docs[snap.docs.length - 1] ?? null;
        if (snap.docs.length < pageSize) {
          hasMoreRef.current = false;
          setHasMore(false);
        }

        for (const d of snap.docs) {
          const data = d.data() as { uid?: string; fromName?: string; message?: string; ts?: unknown };
          messageByIdRef.current.set(d.id, {
            id: d.id,
            uid: data.uid ?? "unknown",
            fromName: data.fromName ?? "Unknown",
            message: data.message ?? "",
            ts: tsToMs(data.ts)
          });
        }
        recomputeMessages();
      } catch (e) {
        props.onError?.(e instanceof Error ? e.message : "Failed to load messages");
      } finally {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    },
    [props.channelId, props.onError, recomputeMessages]
  );

  useEffect(() => {
    messageByIdRef.current = new Map();
    cursorRef.current = null;
    setMessages([]);
    setDraft("");
    hasMoreRef.current = true;
    setHasMore(true);
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    lastCountRef.current = 0;

    unsubRef.current?.();
    unsubRef.current = null;

    if (!props.channelId) return;

    // Initial page
    void loadOlder("initial");

    // Live tail (merge-only) listener
    try {
      const db = getFirebaseDb();
      const colRef = collection(db, "channels", props.channelId, "messages");
      const live = query(colRef, orderBy("ts", "desc"), limit(50));
      const unsub = onSnapshot(
        live,
        (snap) => {
          for (const d of snap.docs) {
            const data = d.data() as { uid?: string; fromName?: string; message?: string; ts?: unknown };
            messageByIdRef.current.set(d.id, {
              id: d.id,
              uid: data.uid ?? "unknown",
              fromName: data.fromName ?? "Unknown",
              message: data.message ?? "",
              ts: tsToMs(data.ts)
            });
          }
          recomputeMessages();
        },
        (err) => props.onError?.(err instanceof Error ? err.message : "Failed to listen for messages")
      );
      unsubRef.current = unsub;
    } catch (e) {
      props.onError?.(e instanceof Error ? e.message : "Failed to start message listener");
    }
  }, [loadOlder, props.channelId, props.onError, recomputeMessages]);

  useLayoutEffect(() => {
    const adj = pendingScrollAdjustRef.current;
    const el = scrollRef.current;
    if (!adj || !el) return;
    pendingScrollAdjustRef.current = null;
    const nextScrollTop = el.scrollHeight - adj.prevScrollHeight + adj.prevScrollTop;
    el.scrollTop = Math.max(0, nextScrollTop);
  }, [messages.length]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = lastCountRef.current;
    lastCountRef.current = messages.length;
    if (messages.length === 0) return;
    // Auto-scroll when user is at the bottom (or on initial load).
    if (prev === 0 || atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  async function sendMessage() {
    if (!canUse) return;
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      const db = getFirebaseDb();
      await addDoc(collection(db, "channels", props.channelId!, "messages"), {
        uid: props.uid,
        fromName: props.displayName,
        message: text,
        ts: serverTimestamp()
      });
    } catch (e) {
      props.onError?.(e instanceof Error ? e.message : "Failed to send message");
    }
  }

  return (
    <div className="panel mainPanel">
      <div className="panelHeader">
        <div>
          <div style={{ fontWeight: 700 }}>#{props.channelId ?? "…"}</div>
          <div className="muted">Text</div>
        </div>
      </div>

      <div className="chat">
        <div
          ref={scrollRef}
          className="chatLog"
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            if (el.scrollTop < 120) void loadOlder("older");
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
            atBottomRef.current = distance < 80;
          }}
        >
          {emptyState ? <div className="muted">{emptyState}</div> : null}

          {!emptyState && hasMore ? (
            <div className="row" style={{ justifyContent: "center" }}>
              <button className="btn" onClick={() => void loadOlder("older")} disabled={loadingOlder}>
                {loadingOlder ? "Loading…" : "Load older"}
              </button>
            </div>
          ) : null}

          {messages.map((m) => (
            <div className="chatMsgRow" key={m.id}>
              <div className="chatMsgAvatar">{(m.fromName || "?").slice(0, 1).toUpperCase()}</div>
              <div className="chatMsgBody">
                <div className="chatMsgMeta">
                  <span className="chatMsgAuthor">{m.fromName}</span>
                  <span className="chatMsgTs">
                    {m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                  </span>
                </div>
                <div className="chatMsgText">{m.message}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="chatComposer">
          <input
            className="input"
            value={draft}
            placeholder={canUse ? "Message..." : "Select a text channel"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void sendMessage();
            }}
            disabled={!canUse}
          />
          <button className="btn btnPrimary" onClick={() => void sendMessage()} disabled={!canUse}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

