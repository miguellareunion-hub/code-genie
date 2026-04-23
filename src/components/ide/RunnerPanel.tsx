import { useEffect, useRef, useState, useCallback } from "react";
import { Play, Square, Loader2, ExternalLink, Settings as SettingsIcon, Trash2, Server, Wrench } from "lucide-react";
import type { FileNode } from "@/lib/projects";
import { loadRunnerSettings, saveRunnerSettings, type RunnerSettings } from "@/lib/runnerSettings";
import { pushRuntimeError } from "@/lib/runtimeErrors";

interface Props {
  projectId: string;
  files: FileNode[];
}

type LogEntry = { level: string; line: string; ts: number };
type Status = "idle" | "starting" | "installing" | "running" | "stopped" | "error";

/** Heuristic: is this stderr line a real error (vs a warning, info, color code)? */
function isLikelyError(line: string): boolean {
  const lower = line.toLowerCase();
  if (/^npm warn/i.test(line)) return false;
  if (/^npm notice/i.test(line)) return false;
  return (
    /error[:\s]/i.test(lower) ||
    /\b(syntaxerror|typeerror|referenceerror|rangeerror)\b/i.test(lower) ||
    /\bcannot find module\b/i.test(lower) ||
    /\bdoes not provide an export\b/i.test(lower) ||
    /\beaddrinuse\b/i.test(lower) ||
    /\berr_module_not_found\b/i.test(lower) ||
    /^\s*at\s+\S+/i.test(line) // stack frame
  );
}

/** Send an error line to the AgentChat to ask the Fixer to repair it. */
function sendToFixer(errorLine: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("lovable:fix-runner-error", { detail: { error: errorLine } }),
  );
}

export function RunnerPanel({ projectId, files }: Props) {
  const [settings, setSettings] = useState<RunnerSettings>(() => loadRunnerSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [healthMsg, setHealthMsg] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const baseUrl = settings.url.replace(/\/+$/, "");
  const previewUrl = `${baseUrl}/preview/${encodeURIComponent(projectId)}/`;
  const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(settings.token)}&projectId=${encodeURIComponent(projectId)}`;

  // connect WS
  useEffect(() => {
    if (!settings.token || !settings.url) return;
    let closed = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "log") {
          const entry = { level: m.level, line: m.line, ts: m.ts };
          setLogs((p) => [...p.slice(-1999), entry]);
          // Forward stderr / process exit lines to the global runtime error bus
          // so the Fixer agent picks them up automatically.
          if (m.level === "stderr" && typeof m.line === "string") {
            const trimmed = m.line.trim();
            if (trimmed && isLikelyError(trimmed)) {
              pushRuntimeError({ level: "stderr", msg: trimmed, ts: m.ts || Date.now() });
            }
          }
        }
        if (m.type === "status") setStatus(m.status as Status);
      } catch (_) {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) wsRef.current = null;
    };
    return () => {
      closed = true;
      try { ws.close(); } catch (_) { /* */ }
    };
  }, [wsUrl, settings.token, settings.url]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs.length]);

  // Auto-run when the agent finishes a cycle (if URL + token are configured).
  useEffect(() => {
    const onAgentDone = () => {
      if (!settings.token || !settings.url) return;
      // Fire and forget — handleRun reads the latest files via closure.
      void handleRun();
    };
    window.addEventListener("lovable:agent-done", onAgentDone);
    return () => window.removeEventListener("lovable:agent-done", onAgentDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.token, settings.url, files, projectId, settings.script]);

  const checkHealth = useCallback(async () => {
    setHealthMsg("…");
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      const j = await r.json();
      setHealthMsg(j.ok ? (j.hasToken ? "✓ Runner OK (token configuré)" : "⚠ Runner sans token — refusera les requêtes") : "Erreur");
    } catch (e) {
      setHealthMsg(`✗ Inaccessible: ${(e as Error).message}`);
    }
  }, [baseUrl]);

  const handleRun = useCallback(async () => {
    if (!settings.token) {
      setShowSettings(true);
      setHealthMsg("Définis l'URL et le token d'abord.");
      return;
    }
    setBusy(true);
    setLogs([]);
    setStatus("starting");
    try {
      const payload = {
        projectId,
        script: settings.script || "dev",
        files: files.map((f) => ({ path: f.name, content: f.content })),
      };
      const r = await fetch(`${baseUrl}/api/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.token}`,
        },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const t = await r.text();
        setLogs((p) => [...p, { level: "stderr", line: `HTTP ${r.status}: ${t}`, ts: Date.now() }]);
        setStatus("error");
      } else {
        setPreviewKey((k) => k + 1);
      }
    } catch (e) {
      setLogs((p) => [...p, { level: "stderr", line: `Connexion échouée: ${(e as Error).message}`, ts: Date.now() }]);
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }, [baseUrl, files, projectId, settings.script, settings.token]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`${baseUrl}/api/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ projectId }),
      });
    } catch (e) {
      setLogs((p) => [...p, { level: "stderr", line: `Stop échoué: ${(e as Error).message}`, ts: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }, [baseUrl, projectId, settings.token]);

  const isRunning = status === "running" || status === "installing" || status === "starting";

  return (
    <div className="flex h-full flex-col bg-[var(--panel-bg)]">
      <div className="flex items-center justify-between border-b border-border bg-[var(--sidebar-bg)] px-3 py-1.5">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Server className="h-3.5 w-3.5" /> Node Runner
          <span className={
            "ml-2 rounded px-1.5 py-0.5 text-[10px] " +
            (status === "running" ? "bg-emerald-500/20 text-emerald-300" :
             status === "installing" || status === "starting" ? "bg-amber-500/20 text-amber-300" :
             status === "error" ? "bg-red-500/20 text-red-300" :
             "bg-muted text-muted-foreground")
          }>{status}</span>
        </span>
        <div className="flex items-center gap-1">
          {isRunning ? (
            <button
              onClick={handleStop}
              disabled={busy}
              className="flex items-center gap-1 rounded bg-red-500/80 px-2 py-1 text-xs text-white hover:bg-red-500 disabled:opacity-50"
            >
              <Square className="h-3 w-3" /> Stop
            </button>
          ) : (
            <button
              onClick={handleRun}
              disabled={busy}
              className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run
            </button>
          )}
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Ouvrir la preview"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <button
            onClick={() => setLogs([])}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Vider les logs"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Réglages runner"
          >
            <SettingsIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="border-b border-border bg-[var(--sidebar-bg)] p-3 text-xs space-y-2">
          <div>
            <label className="mb-1 block text-muted-foreground">Runner URL</label>
            <input
              value={settings.url}
              onChange={(e) => setSettings({ ...settings, url: e.target.value })}
              placeholder="http://localhost:7070"
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
          </div>
          <div>
            <label className="mb-1 block text-muted-foreground">Runner Token</label>
            <input
              type="password"
              value={settings.token}
              onChange={(e) => setSettings({ ...settings, token: e.target.value })}
              placeholder="même valeur que RUNNER_TOKEN côté serveur"
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
          </div>
          <div>
            <label className="mb-1 block text-muted-foreground">npm script (ou "install")</label>
            <input
              value={settings.script}
              onChange={(e) => setSettings({ ...settings, script: e.target.value })}
              placeholder="dev"
              className="w-full rounded border border-border bg-background px-2 py-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { saveRunnerSettings(settings); setHealthMsg("Enregistré."); }}
              className="rounded bg-primary px-2 py-1 text-primary-foreground"
            >
              Enregistrer
            </button>
            <button onClick={checkHealth} className="rounded border border-border px-2 py-1">
              Tester
            </button>
            {healthMsg && <span className="text-muted-foreground">{healthMsg}</span>}
          </div>
          <p className="text-muted-foreground">
            Lance le serveur en local : <code>cd runner-server && npm install && RUNNER_TOKEN=monsecret npm start</code>
          </p>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-1/2 flex-col border-r border-border">
          <div ref={logRef} className="flex-1 overflow-auto bg-[var(--terminal-bg)] px-3 py-2 font-mono text-xs leading-relaxed">
            {logs.length === 0 ? (
              <p className="text-muted-foreground">
                Logs du serveur Node apparaîtront ici. Configure URL + token, puis clique <strong>Run</strong>.
              </p>
            ) : (
              logs.map((l, i) => (
                <div key={i} className={
                  l.level === "stderr" ? "text-red-400" :
                  l.level === "system" ? "text-emerald-300" :
                  "text-foreground/90"
                }>
                  <span className="opacity-50">[{new Date(l.ts).toLocaleTimeString([], { hour12: false })}]</span>{" "}
                  <span className="whitespace-pre-wrap">{l.line}</span>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="flex w-1/2 flex-col">
          <div className="border-b border-border bg-[var(--sidebar-bg)] px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            App preview ({previewUrl})
          </div>
          <iframe
            key={previewKey}
            src={previewUrl}
            title="runner-preview"
            className="flex-1 bg-white"
          />
        </div>
      </div>
    </div>
  );
}
