// Prompt delivery for the Claude Agent SDK.
//
// query({ prompt: "<string>" }) spawns the `claude` CLI and passes the prompt as
// a command-line argument. Windows caps a whole command line near 32,767
// characters, so a large prompt fails the spawn outright with ENAMETOOLONG —
// reported from a Deep Dive, where the research report is attached as context
// and the conversation history is folded in ahead of it. The failure is abrupt
// and the message says nothing about size.
//
// The SDK also accepts `prompt` as an AsyncIterable<SDKUserMessage>, which sends
// the message over the child's stdin instead. stdin has no comparable limit, so
// this removes the ceiling rather than raising it. Verified end to end against
// the real CLI: a single-message iterable completes the turn and the stream ends.

/**
 * Wrap prompt text as the SDK's streaming-input form.
 *
 * Yields exactly one user message and completes, which the SDK treats as the end
 * of input for this turn. Use everywhere instead of a bare string: prompt size
 * is driven by conversation history and attached context, so any call site can
 * exceed the limit given a long enough dive.
 */
function promptStream(text) {
  const content = typeof text === 'string' ? text : String(text ?? '');
  return (async function* () {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    };
  })();
}

module.exports = { promptStream };
