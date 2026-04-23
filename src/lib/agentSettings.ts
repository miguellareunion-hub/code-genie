export type AgentRole = "builder" | "fixer" | "planner";

export type AgentConfig = {
  enabled: boolean;
  /** Custom system prompt override. Empty string = use server default. */
  systemPrompt: string;
};

export type AgentsSettings = {
  builder: AgentConfig;
  fixer: AgentConfig;
  planner: AgentConfig;
  /** Max repair passes performed by the fixer. */
  maxFixIterations: number;
  /** Min prompt length (chars) to trigger the planner. */
  plannerMinChars: number;
};

const STORAGE_KEY = "lovable-ide:agents-settings";

export const DEFAULT_BUILDER_PROMPT = `You are the BUILDER agent of an autonomous multi-agent system inside Lovable IDE.
Your job: design and write working client-side projects from the user's request.
- Output ONLY browser code (HTML/CSS/vanilla JS), no Node.
- Use <lov-write path="..."> for full-file writes, <lov-rename from to> and <lov-delete path> for file ops.
- Always emit COMPLETE files. Keep filenames at project root.
- When files already exist in <context>, ADD or PATCH only what's needed; do not recreate from scratch.`;

export const DEFAULT_FIXER_PROMPT = `You are the FIXER agent of an autonomous multi-agent system inside Lovable IDE.
The previous code produced runtime errors in the browser preview.
- Read the errors in the user message and fix the ROOT cause.
- Re-emit only the file(s) that need changes, in full, using <lov-write>.
- Do not apologize or restate the prompt. Briefly explain the fix in 1-2 sentences.`;

export const DEFAULT_PLANNER_PROMPT = `You are the PLANNER agent of an autonomous multi-agent system inside Lovable IDE.
Split a long/complex user request into 2-6 SMALL ordered build steps for the BUILDER.
- Output ONLY JSON: { "steps": [ { "title": "...", "instruction": "..." } ] }
- Step 1 is always the base structure (HTML+CSS+JS skeleton).
- Each next step adds ONE feature on top. Max 6 steps. No prose, no markdown fences.`;

export const DEFAULT_AGENTS_SETTINGS: AgentsSettings = {
  builder: { enabled: true, systemPrompt: "" },
  fixer: { enabled: true, systemPrompt: "" },
  planner: { enabled: true, systemPrompt: "" },
  maxFixIterations: 3,
  plannerMinChars: 280,
};

export function loadAgentsSettings(): AgentsSettings {
  if (typeof window === "undefined") return DEFAULT_AGENTS_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_AGENTS_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AgentsSettings>;
    return {
      ...DEFAULT_AGENTS_SETTINGS,
      ...parsed,
      builder: { ...DEFAULT_AGENTS_SETTINGS.builder, ...(parsed.builder ?? {}) },
      fixer: { ...DEFAULT_AGENTS_SETTINGS.fixer, ...(parsed.fixer ?? {}) },
      planner: { ...DEFAULT_AGENTS_SETTINGS.planner, ...(parsed.planner ?? {}) },
    };
  } catch {
    return DEFAULT_AGENTS_SETTINGS;
  }
}

export function saveAgentsSettings(s: AgentsSettings) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export const AGENT_META: Record<
  AgentRole,
  { name: string; emoji: string; description: string; defaultPrompt: string }
> = {
  builder: {
    name: "Builder",
    emoji: "🏗️",
    description: "Génère le code des fichiers à partir de ta demande.",
    defaultPrompt: DEFAULT_BUILDER_PROMPT,
  },
  fixer: {
    name: "Fixer",
    emoji: "🔧",
    description:
      "Corrige automatiquement les erreurs runtime détectées dans la preview.",
    defaultPrompt: DEFAULT_FIXER_PROMPT,
  },
  planner: {
    name: "Planner",
    emoji: "📋",
    description:
      "Découpe les gros prompts en 2 à 6 étapes que le Builder exécute une par une.",
    defaultPrompt: DEFAULT_PLANNER_PROMPT,
  },
};
