// Curated text/vision generation; no caller-supplied tools, URLs, API endpoints,
// credentials, or arbitrary SDK options cross this boundary.
function generationInput(body) {
  if (!body || !Array.isArray(body.contents) || !body.contents.length || body.contents.length > 200) {
    throw new Error('Expected 1–200 content messages.');
  }
  const contents = body.contents.map((message) => {
    if (!['user', 'model'].includes(message?.role) || !Array.isArray(message.parts) ||
        !message.parts.length || message.parts.length > 64) throw new Error('Invalid content message.');
    return { role: message.role, parts: message.parts.map((part) => {
      if (typeof part?.text === 'string') return { text: part.text };
      const inline = part?.inlineData;
      if (inline && /^image\/(png|jpeg|webp|gif)$/.test(inline.mimeType) &&
          typeof inline.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(inline.data)) {
        return { inlineData: { mimeType: inline.mimeType, data: inline.data } };
      }
      throw new Error('Only text and inline images are supported.');
    }) };
  });
  const input = body.config || {};
  const config = { maxOutputTokens: 8192 };
  if (input.responseMimeType !== undefined) {
    if (input.responseMimeType !== 'application/json') throw new Error('Invalid response type.');
    config.responseMimeType = input.responseMimeType;
  }
  if (input.responseSchema !== undefined) {
    if (!input.responseSchema || typeof input.responseSchema !== 'object' ||
        JSON.stringify(input.responseSchema).length > 100000) throw new Error('Invalid response schema.');
    config.responseSchema = input.responseSchema;
  }
  if (input.systemInstruction !== undefined) {
    if (typeof input.systemInstruction !== 'string' || input.systemInstruction.length > 100000) {
      throw new Error('Invalid system instruction.');
    }
    config.systemInstruction = input.systemInstruction;
  }
  return { model: 'gemini-2.5-flash', contents, config };
}

function registerGeminiGeneration(app, { getProviderKey }) {
  app.post('/api/gemini/generate', async (req, res) => {
    let input;
    try { input = generationInput(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const key = getProviderKey('gemini');
    if (!key) return res.status(400).json({ error: 'Gemini API key is not configured. Open Models to add your key.' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    res.on('close', () => controller.abort());
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const client = new GoogleGenAI({ apiKey: key });
      input.config.abortSignal = controller.signal;
      if (req.body.stream === true) {
        const stream = await client.models.generateContentStream(input);
        res.type('application/x-ndjson');
        for await (const chunk of stream) {
          if (controller.signal.aborted) break;
          if (chunk.text) res.write(JSON.stringify({ text: chunk.text }) + '\n');
        }
        res.end();
      } else {
        const result = await client.models.generateContent(input);
        res.json({ text: result.text || '' });
      }
    } catch (error) {
      // Do not serialize provider exceptions, request headers, or API URLs.
      const message = controller.signal.aborted ? 'Generation canceled or timed out.' : 'Gemini generation failed. Check your model access and connection.';
      if (!res.headersSent) res.status(502).json({ error: message });
      else res.end(JSON.stringify({ error: message }) + '\n');
    } finally { clearTimeout(timer); }
  });
}

module.exports = { generationInput, registerGeminiGeneration };
