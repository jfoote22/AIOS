export async function ensureWorkspaceAccess(root: string): Promise<void> {
  if (!window.aios?.authorizeWorkspace || !(await window.aios.authorizeWorkspace(root))) {
    throw new Error('Folder access was not approved. Select the folder again to continue.');
  }
}

export function editorWorkspace(root: string): string {
  const match = /[\\/]\.claude(?:[\\/]|$)/.exec(root);
  if (!match) throw new Error('The editor root must be inside .claude.');
  return root.slice(0, match.index) || root.slice(0, match.index + 1);
}
