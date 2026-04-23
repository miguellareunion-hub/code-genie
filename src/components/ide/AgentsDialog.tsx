import { useEffect, useState } from "react";
import { X, RotateCcw, Save, Bot, ShieldCheck, ListOrdered } from "lucide-react";
import {
  AGENT_META,
  DEFAULT_AGENTS_SETTINGS,
  loadAgentsSettings,
  saveAgentsSettings,
  type AgentRole,
  type AgentsSettings,
} from "@/lib/agentSettings";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onClose: () => void;
}

const ROLE_ICON: Record<AgentRole, React.ReactNode> = {
  builder: <Bot className="h-4 w-4" />,
  fixer: <ShieldCheck className="h-4 w-4" />,
  planner: <ListOrdered className="h-4 w-4" />,
};

export function AgentsDialog({ open, onClose }: Props) {
  const [settings, setSettings] = useState<AgentsSettings>(DEFAULT_AGENTS_SETTINGS);
  const [active, setActive] = useState<AgentRole>("builder");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (open) {
      setSettings(loadAgentsSettings());
      setDirty(false);
    }
  }, [open]);

  if (!open) return null;

  const updateAgent = (role: AgentRole, patch: Partial<AgentsSettings["builder"]>) => {
    setSettings((s) => ({ ...s, [role]: { ...s[role], ...patch } }));
    setDirty(true);
  };

  const handleSave = () => {
    saveAgentsSettings(settings);
    setDirty(false);
    onClose();
  };

  const handleResetPrompt = () => {
    updateAgent(active, { systemPrompt: "" });
  };

  const handleResetAll = () => {
    setSettings(DEFAULT_AGENTS_SETTINGS);
    setDirty(true);
  };

  const meta = AGENT_META[active];
  const cfg = settings[active];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Gestion des agents</h2>
            <p className="text-xs text-muted-foreground">
              Active, désactive et personnalise le prompt de chaque agent du système.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Sidebar list */}
          <aside className="w-56 shrink-0 border-r border-border bg-[var(--sidebar-bg)] p-2">
            <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Agents
            </div>
            <div className="space-y-1">
              {(Object.keys(AGENT_META) as AgentRole[]).map((role) => {
                const m = AGENT_META[role];
                const c = settings[role];
                return (
                  <button
                    key={role}
                    onClick={() => setActive(role)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm transition",
                      active === role
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span className="text-base leading-none">{m.emoji}</span>
                    <span className="flex-1">
                      <span className="block font-medium">{m.name}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        {c.enabled ? "Activé" : "Désactivé"}
                        {c.systemPrompt ? " · custom" : ""}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        c.enabled ? "bg-emerald-500" : "bg-muted-foreground/40",
                      )}
                    />
                  </button>
                );
              })}
            </div>

            <div className="mt-4 border-t border-border pt-3">
              <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Réglages globaux
              </div>
              <label className="block px-2 text-xs text-muted-foreground">
                Max passes du Fixer
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={settings.maxFixIterations}
                  onChange={(e) => {
                    setSettings((s) => ({
                      ...s,
                      maxFixIterations: Math.max(
                        0,
                        Math.min(10, Number(e.target.value) || 0),
                      ),
                    }));
                    setDirty(true);
                  }}
                  className="mt-1 w-full rounded border border-border bg-input px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              <label className="mt-2 block px-2 text-xs text-muted-foreground">
                Seuil Planner (caractères)
                <input
                  type="number"
                  min={50}
                  max={4000}
                  value={settings.plannerMinChars}
                  onChange={(e) => {
                    setSettings((s) => ({
                      ...s,
                      plannerMinChars: Math.max(
                        50,
                        Math.min(4000, Number(e.target.value) || 0),
                      ),
                    }));
                    setDirty(true);
                  }}
                  className="mt-1 w-full rounded border border-border bg-input px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
            </div>
          </aside>

          {/* Detail panel */}
          <div className="flex min-w-0 flex-1 flex-col overflow-auto p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary">
                    {ROLE_ICON[active]}
                  </span>
                  {meta.emoji} {meta.name}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">{meta.description}</p>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <span>{cfg.enabled ? "Activé" : "Désactivé"}</span>
                <input
                  type="checkbox"
                  checked={cfg.enabled}
                  onChange={(e) => updateAgent(active, { enabled: e.target.checked })}
                  className="h-4 w-4 accent-primary"
                />
              </label>
            </div>

            {!cfg.enabled && active !== "planner" && (
              <div className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
                ⚠️ Désactiver le {meta.name} cassera la chaîne (le pipeline ne pourra pas
                {active === "builder" ? " écrire de fichiers" : " corriger les erreurs"}).
              </div>
            )}
            {!cfg.enabled && active === "planner" && (
              <div className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Le Planner désactivé : tous les prompts iront directement au Builder en un seul
                passage.
              </div>
            )}

            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-foreground">
                System prompt personnalisé
              </label>
              <button
                onClick={handleResetPrompt}
                disabled={!cfg.systemPrompt}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <RotateCcw className="h-3 w-3" /> Réinitialiser
              </button>
            </div>
            <p className="mb-2 text-[11px] text-muted-foreground">
              Laisse vide pour utiliser le prompt par défaut. Sinon ton texte remplace
              entièrement les instructions de cet agent.
            </p>
            <textarea
              value={cfg.systemPrompt}
              onChange={(e) => updateAgent(active, { systemPrompt: e.target.value })}
              placeholder={meta.defaultPrompt}
              rows={14}
              className="flex-1 resize-none rounded border border-border bg-input p-3 font-mono text-xs text-foreground outline-none focus:border-primary"
            />

            <details className="mt-3 rounded border border-border bg-muted/30 p-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Voir le prompt par défaut
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                {meta.defaultPrompt}
              </pre>
            </details>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <button
            onClick={handleResetAll}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Tout réinitialiser
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Annuler
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Save className="h-3 w-3" /> Enregistrer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
