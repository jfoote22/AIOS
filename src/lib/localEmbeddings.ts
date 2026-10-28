// Built-in embeddings: a small sentence-embedding model running in this window
// (transformers.js on WebAssembly), so semantic search and graph links work
// with no API key. The model (~35 MB) downloads from Hugging Face on first use
// and is cached by the browser afterwards.

const MODEL = 'Xenova/bge-small-en-v1.5';
/** Identifies vectors from this model; 384 dimensions. */
export const LOCAL_EMBEDDING_DIM = 384;

type Extractor = (texts: string[], opts: { pooling: 'cls'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let extractor: Promise<Extractor> | null = null;

function load(): Promise<Extractor> {
  if (!extractor) {
    extractor = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return (await pipeline('feature-extraction', MODEL, { dtype: 'q8' })) as unknown as Extractor;
    })();
    // A failed download shouldn't poison every later attempt.
    extractor.catch(() => { extractor = null; });
  }
  return extractor;
}

export async function embedLocal(texts: string[]): Promise<number[][]> {
  const run = await load();
  const out = await run(texts, { pooling: 'cls', normalize: true });
  return out.tolist();
}
