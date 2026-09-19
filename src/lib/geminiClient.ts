import { apiUrl } from './apiBase';
import type { GenerateContentParameters } from '@google/genai';

async function request(input: GenerateContentParameters, stream = false) {
  const response = await fetch(apiUrl('/api/gemini/generate'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: input.contents, config: input.config, stream }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Generation failed (${response.status})`);
  }
  return response;
}

export const geminiClient = {
  models: {
    async generateContent(input: GenerateContentParameters): Promise<{ text: string }> {
      return (await request(input)).json();
    },
    async *generateContentStream(input: GenerateContentParameters): AsyncGenerator<{ text: string }> {
      const response = await request(input, true);
      if (!response.body) throw new Error('Missing generation stream.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          const lines = pending.split('\n');
          pending = lines.pop() || '';
          if (done && pending) lines.push(pending);
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.error) throw new Error(event.error);
            if (typeof event.text === 'string') yield { text: event.text };
          }
          if (done) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  },
};
