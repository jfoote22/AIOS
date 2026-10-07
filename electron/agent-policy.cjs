const TOOL_NAMES = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite']);

function agentEnvironment(apiKey) {
  // Explicit undefined values override SDK environment merging as well as
  // avoiding concurrent runs changing the parent process's credentials.
  return {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey || undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: apiKey ? undefined : process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
  };
}

function noToolsPolicy() {
  return {
    tools: [], allowedTools: [], permissionMode: 'dontAsk',
    settingSources: [], mcpServers: {}, env: agentEnvironment(),
    canUseTool: async () => ({ behavior: 'deny', message: 'Tools are disabled for this chat or drafting operation.' }),
  };
}

function assertAgentResult(message) {
  if (message.is_error || (message.subtype && message.subtype !== 'success')) {
    throw new Error('The agent did not complete successfully. Check its permissions, model access, and run limits.');
  }
}

function executionPolicy({ tools, apiKey, approve, signal }) {
  if (!Array.isArray(tools) || tools.some(name => !TOOL_NAMES.has(name))) {
    throw new Error('Unsupported tool selection. Choose explicit tools from the Agent Builder.');
  }
  const selected = [...new Set(tools)];
  return {
    tools: selected, allowedTools: [], permissionMode: 'default',
    settingSources: [], mcpServers: {}, env: agentEnvironment(apiKey), maxTurns: 30,
    // The hook runs even for tools the SDK normally auto-approves. Each exact
    // invocation needs a desktop approval; there is no persistent blanket grant.
    hooks: { PreToolUse: [{ hooks: [async (input, _id, context) => {
      let allowed = false;
      if (!signal?.aborted && !context?.signal?.aborted && selected.includes(input.tool_name) && typeof approve === 'function') {
        try { allowed = await approve({ tool: input.tool_name, input: input.tool_input }); }
        catch { allowed = false; }
      }
      allowed = allowed === true && !signal?.aborted && !context?.signal?.aborted;
      return { hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: allowed ? 'allow' : 'deny',
        permissionDecisionReason: allowed ? 'Approved once in AIOS.' : 'Not approved in AIOS.',
      } };
    }] }] },
    // Fail closed if a tool reaches the fallback without a hook approval.
    canUseTool: async () => ({ behavior: 'deny', message: 'This tool requires an AIOS desktop approval.' }),
  };
}

module.exports = { agentEnvironment, noToolsPolicy, executionPolicy, assertAgentResult };
