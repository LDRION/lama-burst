import type { ModelInfo } from '../shared/types';

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> | string };
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface ChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: unknown[];
  options?: Record<string, unknown>;
  keep_alive?: string;
}

export interface ChatChunk {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

interface ShowResponse {
  capabilities?: string[];
  parameters?: string;
  model_info?: Record<string, unknown>;
}

interface TagsResponse {
  models: { name: string; size: number; details?: { family?: string; parameter_size?: string; quantization_level?: string } }[];
}

export class OllamaError extends Error {}

export class Ollama {
  private cache = new Map<string, ModelInfo>();

  constructor(private baseUrl: () => string) {}

  private url(p: string): string {
    return this.baseUrl().replace(/\/+$/, '') + p;
  }

  private async request<T>(p: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(p), init);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new OllamaError(`Ollama не отвечает по адресу ${this.baseUrl()}. Запущена ли она?`);
    }
    if (!res.ok) throw new OllamaError(await errorText(res));
    return (await res.json()) as T;
  }

  async listModels(): Promise<ModelInfo[]> {
    const tags = await this.request<TagsResponse>('/api/tags');
    const models = await Promise.all(
      tags.models.map(async m => {
        const show = await this.request<ShowResponse>('/api/show', {
          method: 'POST',
          body: JSON.stringify({ model: m.name }),
        }).catch(() => ({}) as ShowResponse);
        const ctxKey = Object.keys(show.model_info ?? {}).find(k => k.endsWith('.context_length'));
        const info: ModelInfo = {
          name: m.name,
          size: m.size,
          family: m.details?.family ?? '',
          parameterSize: m.details?.parameter_size ?? '',
          quantization: m.details?.quantization_level ?? '',
          capabilities: show.capabilities ?? [],
          contextLength: ctxKey ? Number(show.model_info![ctxKey]) : undefined,
          stop: [...(show.parameters ?? '').matchAll(/^stop\s+"(.*)"\s*$/gm)].map(x => x[1]),
        };
        this.cache.set(m.name, info);
        return info;
      }),
    );
    return models.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getModel(name: string): Promise<ModelInfo | undefined> {
    if (!this.cache.has(name)) await this.listModels().catch(() => undefined);
    return this.cache.get(name);
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatChunk> {
    let res: Response;
    try {
      res = await fetch(this.url('/api/chat'), {
        method: 'POST',
        body: JSON.stringify({ ...req, stream: true }),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new OllamaError(`Ollama не отвечает по адресу ${this.baseUrl()}. Запущена ли она?`);
    }
    if (!res.ok || !res.body) throw new OllamaError(await errorText(res));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as ChatChunk;
        if (chunk.error) throw new OllamaError(chunk.error);
        yield chunk;
      }
    }
    if (buf.trim()) yield JSON.parse(buf) as ChatChunk;
  }
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    return (JSON.parse(body) as { error?: string }).error ?? `Ollama: HTTP ${res.status}`;
  } catch {
    return body || `Ollama: HTTP ${res.status}`;
  }
}
