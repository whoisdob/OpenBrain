/**
 * Ollama embedder — local, free, private.
 * Uses your existing ollama-gpu-bridge in the K8s cluster.
 */

import {
  type Embedder,
  type ThoughtMetadataExtracted,
  DEFAULT_METADATA,
  METADATA_PROMPT,
} from "./types.js";

export class OllamaEmbedder implements Embedder {
  private readonly endpoint: string;
  private readonly embedModel: string;
  private readonly llmModel: string;

  constructor() {
    this.endpoint = process.env.OLLAMA_ENDPOINT ?? "http://ollama-gpu-bridge:11434";
    this.embedModel = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    this.llmModel = process.env.OLLAMA_LLM_MODEL ?? "llama3.2";

    console.log(
      `[embedder] Ollama → ${this.endpoint} (embed: ${this.embedModel}, llm: ${this.llmModel})`
    );
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${this.endpoint}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.embedModel, input: text, truncate: true }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const snippet = bodyText.slice(0, 300).replace(/\s+/g, " ").trim();
      throw new Error(
        `Ollama embed failed: ${response.status} ${response.statusText}` +
          (snippet ? ` — ${snippet}` : "") +
          ` (content_bytes=${Buffer.byteLength(text, "utf8")})`
      );
    }

    const data = (await response.json()) as { embeddings?: number[][] };
    const embedding = data.embeddings?.[0];

    if (!embedding || embedding.length === 0) {
      throw new Error(
        `Ollama returned no vector for this content — likely empty, whitespace-only, or unsupported by ${this.embedModel} (content_bytes=${Buffer.byteLength(text, "utf8")})`
      );
    }

    return embedding;
  }

  async extractMetadata(content: string): Promise<ThoughtMetadataExtracted> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.llmModel,
        messages: [
          { role: "system", content: METADATA_PROMPT },
          { role: "user", content },
        ],
        format: "json",
        stream: false,
      }),
    });

    if (!response.ok) {
      console.warn(`[embedder] Ollama metadata extraction failed: ${response.status}`);
      return DEFAULT_METADATA;
    }

    const data = (await response.json()) as { message: { content: string } };

    try {
      const parsed = JSON.parse(data.message.content) as ThoughtMetadataExtracted;
      return {
        type: parsed.type ?? "observation",
        topics: parsed.topics ?? [],
        people: parsed.people ?? [],
        action_items: parsed.action_items ?? [],
        dates: parsed.dates ?? [],
      };
    } catch (e) {
      console.warn("[embedder] Failed to parse metadata JSON:", e);
      return DEFAULT_METADATA;
    }
  }
}
