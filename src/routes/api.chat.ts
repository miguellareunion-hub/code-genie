import { createFileRoute } from "@tanstack/react-router";

type ChatBody = {
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  provider?: "lovable" | "openai";
  model?: string;
  openaiApiKey?: string;
};

export const Route = createFileRoute("/api/chat")({
  // @ts-expect-error - server property typing lags behind runtime support
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        try {
          const body = (await request.json()) as ChatBody;
          const { messages, provider = "lovable", model, openaiApiKey } = body;

          const systemPrompt = `You are an autonomous coding agent embedded inside a web IDE called Lovable IDE.
The user is building small HTML/CSS/JS projects in the browser.
Help them: explain code, generate snippets, debug errors, suggest refactors.
Always reply in clear markdown. When giving code, use fenced code blocks with the correct language tag.
Be concise and practical.`;

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
              messages: [{ role: "system", content: systemPrompt }, ...messages],
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
