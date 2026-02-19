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
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import { getFirebaseDb } from "../firebase";

type ChatAttachment = {
  fileId: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  kind: "image" | "file";
};

type ChatMessage = {
  id: string;
  uid: string;
  fromName: string;
  ts: number;
  message: string;
  attachments: ChatAttachment[];
};

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 45_000;

function tsToMs(ts: unknown): number {
  if (typeof ts === "number") return ts;
  if (ts && typeof ts === "object" && "toMillis" in ts && typeof (ts as Timestamp).toMillis === "function") {
    return (ts as Timestamp).toMillis();
  }
  return 0;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveUploadApiBase(): string | null {
  const explicit = (import.meta.env.VITE_UPLOAD_API_BASE as string | undefined)?.trim();
  if (explicit) return stripTrailingSlash(explicit);

  const signaling = (import.meta.env.VITE_SIGNALING_URL as string | undefined)?.trim();
  if (!signaling) return null;
  try {
    const url = new URL(signaling);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return stripTrailingSlash(url.toString());
  } catch {
    return null;
  }
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** exp;
  return `${value >= 10 || exp === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exp]}`;
}

function parseAttachment(input: unknown): ChatAttachment | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const fileId = typeof record.fileId === "string" ? record.fileId : "";
  const url = typeof record.url === "string" ? record.url : "";
  const name = typeof record.name === "string" ? record.name : "";
  const size = typeof record.size === "number" ? record.size : NaN;
  const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
  if (!fileId || !url || !name || !Number.isFinite(size) || size < 0 || !mimeType) return undefined;
  const kind: ChatAttachment["kind"] = mimeType.startsWith("image/") ? "image" : "file";
  return { fileId, url, name, size, mimeType, kind };
}

function parseAttachments(input: unknown, fallback?: unknown): ChatAttachment[] {
  const arr: ChatAttachment[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      const parsed = parseAttachment(item);
      if (parsed) arr.push(parsed);
    }
  }
  if (arr.length === 0) {
    const single = parseAttachment(fallback);
    if (single) arr.push(single);
  }
  return arr;
}

function parseMessageDoc(
  id: string,
  data: { uid?: string; fromName?: string; message?: string; ts?: unknown; attachment?: unknown; attachments?: unknown }
): ChatMessage {
  return {
    id,
    uid: data.uid ?? "unknown",
    fromName: data.fromName ?? "Unknown",
    message: data.message ?? "",
    ts: tsToMs(data.ts),
    attachments: parseAttachments(data.attachments, data.attachment)
  };
}

export function ChatPanel(props: {
  channelId: string | null;
  uid: string | null;
  displayName: string;
  disabled?: boolean;
  onError?: (msg: string) => void;
  onIncomingMessage?: () => void;
  onSentMessage?: () => void;
}) {
  const canUse = Boolean(props.channelId && props.uid) && !props.disabled;
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [lightboxSlides, setLightboxSlides] = useState<Array<{ src: string; alt: string }>>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number>(-1);
  const [sending, setSending] = useState(false);
  const uploadApiBase = useMemo(() => resolveUploadApiBase(), []);

  const loadingOlderRef = useRef(false);
  const hasMoreRef = useRef(true);

  const messageByIdRef = useRef<Map<string, ChatMessage>>(new Map());
  const cursorRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollAdjustRef = useRef<{ prevScrollTop: number; prevScrollHeight: number } | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const atBottomRef = useRef(true);
  const lastCountRef = useRef(0);
  const firstLiveSnapRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);

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
          const data = d.data() as { uid?: string; fromName?: string; message?: string; ts?: unknown; attachment?: unknown };
          messageByIdRef.current.set(d.id, parseMessageDoc(d.id, data));
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
    setSelectedFiles([]);
    setLightboxSlides([]);
    setLightboxIndex(-1);
    setSending(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    lastCountRef.current = 0;
    firstLiveSnapRef.current = true;

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
          const addedFromOthers = snap
            .docChanges()
            .filter((c) => c.type === "added")
            .some((c) => {
              const data = c.doc.data() as { uid?: string };
              return Boolean(data.uid && data.uid !== props.uid);
            });
          for (const d of snap.docs) {
            const data = d.data() as { uid?: string; fromName?: string; message?: string; ts?: unknown; attachment?: unknown };
            messageByIdRef.current.set(d.id, parseMessageDoc(d.id, data));
          }
          recomputeMessages();
          if (firstLiveSnapRef.current) {
            firstLiveSnapRef.current = false;
          } else if (addedFromOthers) {
            props.onIncomingMessage?.();
          }
        },
        (err) => props.onError?.(err instanceof Error ? err.message : "Failed to listen for messages")
      );
      unsubRef.current = unsub;
    } catch (e) {
      props.onError?.(e instanceof Error ? e.message : "Failed to start message listener");
    }
  }, [loadOlder, props.channelId, props.onError, props.onIncomingMessage, props.uid, recomputeMessages]);

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

  async function uploadFile(file: File): Promise<ChatAttachment> {
    if (!uploadApiBase) {
      throw new Error("File upload is not configured. Set VITE_UPLOAD_API_BASE.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error("File is too large. Max allowed size is 50MB.");
    }

    const form = new FormData();
    form.append("file", file);
    if (props.channelId) form.append("channelId", props.channelId);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${uploadApiBase}/api/upload`, {
        method: "POST",
        body: form,
        signal: controller.signal
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Upload timed out. Please try again.");
      }
      throw new Error("Upload request failed. Check server/proxy.");
    } finally {
      window.clearTimeout(timeout);
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // fallthrough
    }

    if (!res.ok) {
      const errMsg =
        body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : `Upload failed (${res.status})`;
      throw new Error(errMsg);
    }

    if (!body || typeof body !== "object") throw new Error("Upload failed: invalid response");
    const attachment = parseAttachment(body);
    if (!attachment) throw new Error("Upload failed: malformed metadata");
    return attachment;
  }

  async function sendMessage() {
    if (!canUse) return;
    const text = draft.trim();
    if (!text && selectedFiles.length === 0) return;
    if (sending) return;
    setSending(true);
    try {
      const attachments: ChatAttachment[] = [];
      for (const file of selectedFiles) {
        attachments.push(await uploadFile(file));
      }
      const db = getFirebaseDb();
      const payload: {
        uid: string | null;
        fromName: string;
        message: string;
        ts: ReturnType<typeof serverTimestamp>;
        attachments?: ChatAttachment[];
        attachment?: ChatAttachment;
      } = {
        uid: props.uid,
        fromName: props.displayName,
        message: text,
        ts: serverTimestamp()
      };
      if (attachments.length > 0) {
        payload.attachments = attachments;
        payload.attachment = attachments[0];
      }
      await addDoc(collection(db, "channels", props.channelId!, "messages"), payload);
      setDraft("");
      setSelectedFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      props.onSentMessage?.();
    } catch (e) {
      props.onError?.(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  function pickFiles(files: readonly File[] | FileList | null) {
    if (!files || files.length === 0) return;
    const next: File[] = [];
    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        props.onError?.(`"${file.name}" is too large. Max allowed size is 50MB.`);
        continue;
      }
      next.push(file);
    }
    if (next.length === 0) return;
    setSelectedFiles((prev) => {
      const merged = [...prev];
      for (const file of next) {
        const exists = merged.some((x) => x.name === file.name && x.size === file.size && x.lastModified === file.lastModified);
        if (!exists) merged.push(file);
      }
      return merged;
    });
  }

  function hasFilesInDrag(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes("Files");
  }

  function openLightboxFromMessage(message: ChatMessage, clickedFileId: string) {
    const imageAttachments = message.attachments.filter((a) => a.kind === "image");
    if (imageAttachments.length === 0) return;
    const slides = imageAttachments.map((a) => ({ src: a.url, alt: a.name }));
    const idx = imageAttachments.findIndex((a) => a.fileId === clickedFileId);
    setLightboxSlides(slides);
    setLightboxIndex(idx >= 0 ? idx : 0);
  }

  return (
    <div className="panel mainPanel">
      <div className="panelHeader">
        <div>
          <div style={{ fontWeight: 700 }}>#{props.channelId ?? "…"}</div>
          <div className="muted">Text</div>
        </div>
      </div>

      <div
        className={`chat ${dragActive ? "chatDropActive" : ""}`}
        onDragEnter={(e) => {
          if (!canUse || sending || !hasFilesInDrag(e)) return;
          e.preventDefault();
          dragDepthRef.current += 1;
          setDragActive(true);
        }}
        onDragOver={(e) => {
          if (!canUse || sending || !hasFilesInDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(e) => {
          if (!hasFilesInDrag(e)) return;
          e.preventDefault();
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragActive(false);
        }}
        onDrop={(e) => {
          if (!canUse || sending || !hasFilesInDrag(e)) return;
          e.preventDefault();
          dragDepthRef.current = 0;
          setDragActive(false);
          pickFiles(e.dataTransfer.files);
        }}
      >
        {dragActive ? <div className="chatDropHint">Drop file to attach</div> : null}
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
            <div className={`chatMsgRow ${m.uid === props.uid ? "chatMsgOwn" : ""}`} key={m.id}>
              <div className="chatMsgAvatar">{(m.fromName || "?").slice(0, 1).toUpperCase()}</div>
              <div className="chatMsgBody">
                <div className="chatMsgMeta">
                  <span className="chatMsgAuthor">{m.fromName}</span>
                  <span className="chatMsgTs">
                    {m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}
                  </span>
                </div>
                <div className="chatMsgBubble">
                  {m.message ? <div className="chatMsgText">{m.message}</div> : null}
                  {m.attachments.length > 0 ? (
                    <div className="chatAttachments">
                      {m.attachments.map((attachment) => (
                        <div className="chatAttachment" key={`${m.id}-${attachment.fileId}`}>
                          {attachment.kind === "image" ? (
                            <button
                              type="button"
                              className="chatAttachmentPreviewBtn"
                              onClick={() => openLightboxFromMessage(m, attachment.fileId)}
                            >
                              <img className="chatAttachmentImage" src={attachment.url} alt={attachment.name} loading="lazy" />
                            </button>
                          ) : null}
                          <a className="chatAttachmentMeta" href={attachment.url} target="_blank" rel="noreferrer">
                            <span className="chatAttachmentName">{attachment.name}</span>
                            <span className="chatAttachmentInfo">
                              {formatBytes(attachment.size)} · {attachment.mimeType}
                            </span>
                          </a>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="chatComposer">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              pickFiles(e.target.files);
              e.currentTarget.value = "";
            }}
            disabled={!canUse || sending}
          />
          {selectedFiles.length > 0 ? (
            <div className="chatComposerAttachments">
              {selectedFiles.map((file) => (
                <div className="chatComposerAttachment" key={`${file.name}-${file.lastModified}-${file.size}`}>
                  <div className="chatComposerAttachmentMeta">
                    <span className="chatComposerAttachmentName">{file.name}</span>
                    <span className="chatComposerAttachmentInfo">{formatBytes(file.size)}</span>
                  </div>
                  <button
                    className="btn"
                    onClick={() =>
                      setSelectedFiles((prev) =>
                        prev.filter((x) => !(x.name === file.name && x.size === file.size && x.lastModified === file.lastModified))
                      )
                    }
                    disabled={sending}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="chatComposerRow">
            <button className="btn btnIcon chatAttachIconBtn" onClick={() => fileInputRef.current?.click()} disabled={!canUse || sending} aria-label="Attach file">
              <svg viewBox="0 0 24 24" className="iconSvg" aria-hidden="true">
                <path
                  d="M16.5 6.5l-7.8 7.8a3.2 3.2 0 104.5 4.5l8.4-8.4a5 5 0 10-7.1-7.1l-8.8 8.8a7 7 0 109.9 9.9l7.2-7.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <input
              className="input"
              value={draft}
              placeholder={canUse ? "Message..." : "Select a text channel"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void sendMessage();
              }}
              disabled={!canUse || sending}
            />
            <button className="btn btnPrimary" onClick={() => void sendMessage()} disabled={!canUse || sending}>
              {sending ? "Sending..." : "Send"}
            </button>
          </div>
          {!uploadApiBase ? <div className="muted">File upload is disabled until VITE_UPLOAD_API_BASE is set.</div> : null}
        </div>
      </div>
      <Lightbox
        open={lightboxIndex >= 0}
        close={() => setLightboxIndex(-1)}
        slides={lightboxSlides}
        index={Math.max(0, lightboxIndex)}
        controller={{ closeOnBackdropClick: true }}
        plugins={[Zoom]}
      />
    </div>
  );
}

