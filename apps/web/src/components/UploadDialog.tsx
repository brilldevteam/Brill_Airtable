import type { AttachmentInfo } from "@brill/shared";
import { Camera, CheckCircle2, Files, Laptop, Link2, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { formatBytes } from "./attachmentUtils";

type Source = "local" | "link" | "webcam";

interface Props {
  tableId: string;
  onUploaded: (files: AttachmentInfo[]) => void;
  onClose: () => void;
}

interface Item { key: string; name: string; size: number; progress: number; error?: string; done?: AttachmentInfo }

/** Airtable-style "add attachment" dialog: local files (with progress), a web link, or a webcam photo. */
export function UploadDialog({ tableId, onUploaded, onClose }: Props) {
  const [source, setSource] = useState<Source>("local");

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const tabs: { id: Source; label: string; icon: JSX.Element }[] = [
    { id: "local", label: "Local files", icon: <Laptop size={16} /> },
    { id: "link", label: "Link (URL)", icon: <Link2 size={16} /> },
    { id: "webcam", label: "Webcam", icon: <Camera size={16} /> },
  ];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="upload-dialog" role="dialog" aria-label="Add attachments">
        <nav className="upload-nav">
          {tabs.map((t) => (
            <button key={t.id} className={source === t.id ? "on" : ""} onClick={() => setSource(t.id)}>
              {t.icon} {t.label}
            </button>
          ))}
        </nav>
        <div className="upload-body">
          <button className="icon-btn upload-close" title="Close" onClick={onClose}><X size={18} /></button>
          {source === "local" && <LocalFiles tableId={tableId} onUploaded={onUploaded} onClose={onClose} />}
          {source === "link" && <FromLink tableId={tableId} onUploaded={onUploaded} onClose={onClose} />}
          {source === "webcam" && <Webcam tableId={tableId} onUploaded={onUploaded} onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}

function LocalFiles({ tableId, onUploaded, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const busy = items.some((i) => !i.done && !i.error);

  const start = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (!files.length) return;
    const batch = files.map((f, n) => ({ key: `${Date.now()}-${n}`, name: f.name, size: f.size, progress: 0 }));
    setItems((s) => [...s, ...batch]);
    const update = (key: string, patch: Partial<Item>) => setItems((s) => s.map((i) => (i.key === key ? { ...i, ...patch } : i)));
    const saved: AttachmentInfo[] = [];
    // Upload up to 3 at a time.
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const n = next++;
        const it = batch[n];
        if (files[n].size > 25 * 1024 * 1024) { update(it.key, { error: "Larger than 25 MB" }); continue; }
        try {
          const info = await api.uploadFile(tableId, files[n], (p) => update(it.key, { progress: p }));
          saved[n] = info;
          update(it.key, { progress: 1, done: info });
        } catch (e) {
          update(it.key, { error: (e as Error).message });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const ok = saved.filter(Boolean);
    if (ok.length) onUploaded(ok);
    if (ok.length === files.length) setTimeout(onClose, 450);
  };

  return (
    <div className="upload-local">
      <div
        className={"upload-drop" + (over ? " over" : "")}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); start(e.dataTransfer.files); }}
      >
        <Files size={38} strokeWidth={1.5} />
        <div>Drop files here or <button className="link" onClick={() => input.current?.click()}>browse files</button></div>
        <span className="muted small">Images, videos, PDFs and documents · up to 25 MB each</span>
        <input ref={input} type="file" multiple hidden onChange={(e) => { start(e.target.files); e.target.value = ""; }} />
      </div>
      {items.length > 0 && (
        <div className="upload-list">
          {items.map((i) => (
            <div key={i.key} className={"upload-item" + (i.error ? " err" : "")}>
              <div className="upload-item-top">
                <span className="upload-name">{i.name}</span>
                <span className="muted small">{i.error ?? (i.done ? <CheckCircle2 size={15} className="ok" /> : `${Math.round(i.progress * 100)}% · ${formatBytes(i.size)}`)}</span>
              </div>
              {!i.error && <div className="upload-bar"><div style={{ width: `${i.progress * 100}%` }} /></div>}
            </div>
          ))}
        </div>
      )}
      {busy && <div className="muted small">Uploading… keep this window open.</div>}
    </div>
  );
}

function FromLink({ tableId, onUploaded, onClose }: Props) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { attachments } = await api.attachFromUrl(tableId, url.trim());
      onUploaded(attachments);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="upload-link" onSubmit={(e) => { e.preventDefault(); if (url.trim()) submit(); }}>
      <h4>Add a file from a link</h4>
      <p className="muted">Paste a public link to an image, video, PDF or other file. We'll download a copy.</p>
      <input autoFocus type="url" placeholder="https://example.com/photo.jpg" value={url} onChange={(e) => setUrl(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary" disabled={!url.trim() || busy}>{busy ? "Downloading…" : "Add file"}</button></div>
    </form>
  );
}

function Webcam({ tableId, onUploaded, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<Blob | null>(null);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  const startCamera = async () => {
    setError(null);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
      if (video.current) { video.current.srcObject = stream.current; await video.current.play(); }
    } catch (e) {
      setError(
        (e as Error).name === "NotAllowedError"
          ? "Camera access was blocked. Allow the camera for this site in your browser, then try again."
          : "No camera found, or it's in use by another app.",
      );
    }
  };
  useEffect(() => { startCamera(); return stop; }, []);
  useEffect(() => () => { if (shotUrl) URL.revokeObjectURL(shotUrl); }, [shotUrl]);

  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) { setShot(b); setShotUrl(URL.createObjectURL(b)); } }, "image/jpeg", 0.92);
  };
  const save = async () => {
    if (!shot) return;
    setBusy(true);
    try {
      const name = `Webcam ${new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".")}.jpg`;
      const info = await api.uploadFile(tableId, new File([shot], name, { type: "image/jpeg" }));
      stop();
      onUploaded([info]);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="upload-webcam">
      <div className="webcam-frame">
        {shotUrl ? <img src={shotUrl} alt="Captured" /> : <video ref={video} muted playsInline />}
        {error && <div className="webcam-error"><Camera size={26} /><span>{error}</span><button className="btn sm" onClick={startCamera}>Try again</button></div>}
      </div>
      <div className="webcam-actions">
        {shotUrl ? (
          <>
            <button className="btn" onClick={() => { setShot(null); setShotUrl(null); }} disabled={busy}><RotateCcw size={15} /> Retake</button>
            <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Use photo"}</button>
          </>
        ) : (
          <button className="btn primary" onClick={capture} disabled={!!error}><Camera size={15} /> Take photo</button>
        )}
      </div>
    </div>
  );
}
