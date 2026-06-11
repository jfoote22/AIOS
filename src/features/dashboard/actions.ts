// Loop-closing writes: turn a GitHub repo or a quick note into a real neuron
// (snippet) in the brain — same persist + best-effort embed path the rest of the
// app uses (memory.ts / SnippingTab), so it shows up in the graph and search.

import * as db from "@/lib/db";
import * as ai from "@/lib/ai";
import { emitSnippetsChange } from "@/lib/snippetStore";
import type { Repo } from "./github";

function newId(): string {
  return `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface NewNeuron {
  id: string;
  title: string;
  summary: string;
  category: string;
  source: string;
  tags: string[];
  extractedText: string;
  timestamp: number;
  status: "ready";
}

async function persist(base: NewNeuron): Promise<void> {
  await db.putSnippet(base);
  // Best-effort embedding so it links into the graph + semantic search. Skipped
  // silently if Gemini isn't configured (a later enrich pass can fill it in).
  try {
    if (ai.isGeminiReady()) {
      const embedding = await ai.embedText(ai.buildEmbedSource(base));
      await db.putSnippet({ ...base, embedding });
    }
  } catch (e) {
    console.error("[dashboard] embed failed (saved without embedding):", e);
  }
  emitSnippetsChange({ newId: base.id });
}

export async function saveRepoToBrain(repo: Repo, topic: string): Promise<void> {
  const tags = [
    "github",
    topic.toLowerCase().trim(),
    ...(repo.language ? [repo.language.toLowerCase()] : []),
    ...repo.topics,
  ].filter(Boolean);
  await persist({
    id: newId(),
    title: repo.fullName,
    summary: repo.description || `GitHub repository (${repo.stars}★)`,
    category: "Tools",
    source: "GitHub",
    tags,
    extractedText:
      `${repo.fullName}\n${repo.description}\n${repo.url}\n` +
      `Stars: ${repo.stars}${repo.language ? `\nLanguage: ${repo.language}` : ""}` +
      `${repo.topics.length ? `\nTopics: ${repo.topics.join(", ")}` : ""}`,
    timestamp: Date.now(),
    status: "ready",
  });
}

export async function saveNoteToBrain(text: string, category = "Notes"): Promise<void> {
  const trimmed = text.trim();
  const firstLine = trimmed.split("\n")[0].slice(0, 80);
  await persist({
    id: newId(),
    title: firstLine || "Quick note",
    summary: trimmed.slice(0, 160),
    category,
    source: "Dashboard",
    tags: ["note", "dashboard"],
    extractedText: trimmed,
    timestamp: Date.now(),
    status: "ready",
  });
}
