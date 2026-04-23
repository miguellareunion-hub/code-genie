import { createFileRoute } from "@tanstack/react-router";

type ChatBody = {
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  provider?: "lovable" | "openai";
  model?: string;
  openaiApiKey?: string;
};

const SYSTEM_PROMPT = `You are an autonomous coding agent embedded inside a browser-based web IDE called Lovable IDE.
The user is building small CLIENT-SIDE projects (HTML / CSS / JavaScript) that run in an iframe preview.

# Your capabilities
You can:
1. Discuss and explain code in clear markdown.
2. Create, modify, rename and delete files in the user's current project automatically.

# Environment constraints
- This IDE preview ONLY runs browser code.
- Do NOT generate Node.js servers, Express apps, npm install steps, package.json workflows, backend runtimes, SSH scripts, or terminal commands unless the user explicitly asks for code they will run outside this IDE.
- Default to front-end projects that work immediately in index.html + style.css + script.js.
- Keep or create index.html as the project entry point.

# How to modify the project
Whenever the user asks you to build, create, scaffold, fix, refactor, add a feature, or change code, you MUST emit one or more action tags. The IDE parses these tags and applies them automatically.

To create or fully overwrite a file:
<lov-write path="index.html">
<!DOCTYPE html>
<html>
  ...the COMPLETE file content...
</html>
</lov-write>

To rename a file:
<lov-rename from="old.js" to="new.js" />

To delete a file:
<lov-delete path="obsolete.css" />

# CRITICAL RULES
- Always output COMPLETE file contents inside <lov-write>.
- Never output partial diffs, placeholders, or 'rest of file'.
- Do NOT wrap file contents in markdown code fences inside <lov-write>.
- Use simple root-level filenames like index.html, style.css, script.js.
- Before action tags, briefly explain what you are changing.
- After all actions, briefly summarize the result.
- For pure questions without code edits, answer in markdown only.
- Be concise.`;

export const Route = createFileRoute("/api/chat")({
  // @ts-expect-error - server property typing lags behind runtime support
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        try {
          const body = (await request.json()) as ChatBody;
          const { messages, provider = "lovable", model, openaiApiKey } = body;

          let url: string;
          let apiKey: string | undefined;
          let chosenModel: string;

          if (provider === "openai") {
            url = "https://api.openai.com/v1/chat/completions";
            apiKey = openaiApiKey?.trim();
            chosenModel = model || "gpt-4o-mini";
            if (!apiKey) {
              return jsonError(
                "OpenAI API key is missing. Open Settings and paste your key.",
                400,
              );
            }
          } else {
            url = "https://ai.gateway.lovable.dev/v1/chat/completions";
            apiKey = process.env.LOVABLE_API_KEY;
            chosenModel = model || "google/gemini-3-flash-preview";
            if (!apiKey) {
              return jsonError("LOVABLE_API_KEY is not configured.", 500);
            }
          }

          const upstream = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: chosenModel,
              stream: true,
              messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
            }),
          });

          if (!upstream.ok) {
            if (upstream.status === 429) {
              return jsonError("Rate limit exceeded. Please try again shortly.", 429);
            }
            if (upstream.status === 401) {
              return jsonError(
                provider === "openai"
                  ? "Invalid OpenAI API key. Check it in Settings."
                  : "Unauthorized to AI gateway.",
                401,
              );
            }
            if (upstream.status === 402) {
              return jsonError(
                "AI credits exhausted. Add credits in Settings → Workspace → Usage.",
                402,
              );
            }
            const text = await upstream.text();
            console.error("AI provider error", provider, upstream.status, text);
            return jsonError(`AI provider error (${upstream.status})`, 500);
          }

          return new Response(upstream.body, {
            headers: { "Content-Type": "text/event-stream" },
          });
        } catch (e) {
          console.error("/api/chat error", e);
          return jsonError(e instanceof Error ? e.message : "Unknown error", 500);
        }
      },
    },
  },
});

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
