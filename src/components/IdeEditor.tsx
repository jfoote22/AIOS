import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  Folder, FolderOpen, FileText, ChevronRight, ChevronDown, FilePlus, FolderPlus,
  RefreshCw, Trash2, Save, X, AlertCircle, Loader2, Code2,
} from 'lucide-react';
import { setupMonaco, AIOS_DARK_THEME } from '../lib/monacoSetup';
import { fsTree, fsRead, fsWrite, fsCreate, fsDelete, type FsNode } from '../lib/fsapi';

setupMonaco();

interface OpenFile {
  path: string;       // relative to root
  content: string;
  original: string;
}

interface Props {
  /** Working dir whose .claude/<sub> folder is the editor root. Empty = none. */
  baseDir: string;
  /** Which .claude subfolder to root the tree at. */
  sub: 'agents' | 'skills';
  /** Let the user pick/replace the working dir from inside the editor. */
  onChangeBaseDir: (dir: string) => void;
  accent?: 'indigo' | 'emerald';
}

const LANG_BY_EXT: Record<string, string> = {
  md: 'markdown', markdown: 'markdown',
  json: 'json', jsonc: 'json',
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  css: 'css', scss: 'scss', html: 'html', xml: 'xml', sql: 'sql',
  txt: 'plaintext',
};

function langFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXT[ext] ?? 'plaintext';
}

export default function IdeEditor({ baseDir, sub, onChangeBaseDir, accent = 'indigo' }: Props) {
  const root = baseDir ? `${baseDir.replace(/[\\/]+$/, '')}/.claude/${sub}` : '';
  const [tree, setTree] = useState<FsNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>(''); // tree selection (file or dir)
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const accentText = accent === 'emerald' ? 'text-emerald-300' : 'text-indigo-300';
  const accentBtn = accent === 'emerald'
    ? 'bg-emerald-600 hover:bg-emerald-500'
    : 'bg-indigo-600 hover:bg-indigo-500';

  const refreshTree = useCallback(async () => {
    if (!root) { setTree([]); return; }
    setLoadingTree(true); setTreeError(null);
    try {
      const { tree } = await fsTree(root);
      setTree(tree);
    } catch (e: any) {
      setTreeError(e?.message ?? String(e));
      setTree([]);
    } finally {
      setLoadingTree(false);
    }
  }, [root]);

  useEffect(() => {
    // Reset open files when the root changes; reload the tree.
    setOpen([]); setActivePath(null); setSelectedPath(''); setError(null);
    refreshTree();
  }, [refreshTree]);

  const activeFile = useMemo(() => open.find(f => f.path === activePath) ?? null, [open, activePath]);
  const dirty = (f: OpenFile) => f.content !== f.original;

  const openFile = async (path: string) => {
    setSelectedPath(path);
    const existing = open.find(f => f.path === path);
    if (existing) { setActivePath(path); return; }
    setBusy(true); setError(null);
    try {
      const { content } = await fsRead(root, path);
      setOpen(prev => [...prev, { path, content, original: content }]);
      setActivePath(path);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const setActiveContent = (content: string) => {
    if (!activePath) return;
    setOpen(prev => prev.map(f => f.path === activePath ? { ...f, content } : f));
  };

  const saveFile = useCallback(async (path: string) => {
    const file = open.find(f => f.path === path);
    if (!file) return;
    setBusy(true); setError(null);
    try {
      await fsWrite(root, path, file.content);
      setOpen(prev => prev.map(f => f.path === path ? { ...f, original: f.content } : f));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [open, root]);

  const closeFile = (path: string) => {
    const file = open.find(f => f.path === path);
    if (file && dirty(file) && !confirm(`Discard unsaved changes to ${path}?`)) return;
    setOpen(prev => prev.filter(f => f.path !== path));
    if (activePath === path) {
      const remaining = open.filter(f => f.path !== path);
      setActivePath(remaining.length ? remaining[remaining.length - 1].path : null);
    }
  };

  // Directory to create new entries in: the selected dir, or the dir of the
  // selected file, or the root.
  const targetDir = useMemo(() => {
    if (!selectedPath) return '';
    const node = findNode(tree, selectedPath);
    if (node?.type === 'dir') return selectedPath;
    const slash = selectedPath.lastIndexOf('/');
    return slash >= 0 ? selectedPath.slice(0, slash) : '';
  }, [selectedPath, tree]);

  const createEntry = async (kind: 'file' | 'dir') => {
    if (!root) return;
    const name = prompt(kind === 'file' ? 'New file name (e.g. reference.md):' : 'New folder name:');
    if (!name || !name.trim()) return;
    const clean = name.trim().replace(/^[\\/]+|[\\/]+$/g, '');
    if (!clean) return;
    const relPath = targetDir ? `${targetDir}/${clean}` : clean;
    setBusy(true); setError(null);
    try {
      await fsCreate(root, relPath, kind);
      // Expand the parent so the new entry is visible.
      if (targetDir) setExpanded(prev => new Set(prev).add(targetDir));
      await refreshTree();
      if (kind === 'file') await openFile(relPath);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteEntry = async (path: string) => {
    const node = findNode(tree, path);
    const what = node?.type === 'dir' ? 'folder (and everything in it)' : 'file';
    if (!confirm(`Delete ${what} "${path}"?`)) return;
    setBusy(true); setError(null);
    try {
      await fsDelete(root, path);
      setOpen(prev => prev.filter(f => f.path !== path && !f.path.startsWith(path + '/')));
      if (activePath && (activePath === path || activePath.startsWith(path + '/'))) setActivePath(null);
      await refreshTree();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleDir = (path: string) => {
    setSelectedPath(path);
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  // Ctrl/Cmd+S saves the active file.
  const onEditorMount = (editor: any, monaco: any) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activePathRef.current) saveFileRef.current(activePathRef.current);
    });
  };
  // Refs so the Monaco command (bound once) always sees the latest values.
  const activePathRef = useRef<string | null>(activePath);
  activePathRef.current = activePath;
  const saveFileRef = useRef(saveFile);
  saveFileRef.current = saveFile;

  const pickDir = async () => {
    const picked = await window.aios?.pickFolder({
      title: 'Pick the working directory whose .claude folder you want to edit',
      defaultPath: baseDir || undefined,
    });
    if (picked) onChangeBaseDir(picked);
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Working-dir bar */}
      <div className="h-10 px-3 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <Code2 className={`w-3.5 h-3.5 ${accentText}`} />
        <button
          onClick={pickDir}
          title={baseDir ? `${root} — click to change working dir` : 'No working dir set — click to pick'}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] min-w-0 max-w-[40ch] border transition-colors ${
            baseDir
              ? 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700'
              : 'bg-amber-500/10 border-amber-500/40 text-amber-300 hover:bg-amber-500/15'
          }`}
        >
          <Folder className="w-3 h-3 shrink-0" />
          <span className="font-mono truncate">
            {baseDir ? `${baseDir.replace(/\\/g, '/')}/.claude/${sub}` : 'Pick working folder'}
          </span>
          <FolderOpen className="w-3 h-3 shrink-0 opacity-60" />
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn title="New file" onClick={() => createEntry('file')} disabled={!root || busy}><FilePlus className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title="New folder" onClick={() => createEntry('dir')} disabled={!root || busy}><FolderPlus className="w-3.5 h-3.5" /></IconBtn>
          <IconBtn title="Refresh" onClick={refreshTree} disabled={!root || loadingTree}><RefreshCw className={`w-3.5 h-3.5 ${loadingTree ? 'animate-spin' : ''}`} /></IconBtn>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* File tree */}
        <aside className="w-52 shrink-0 border-r border-zinc-800/60 overflow-y-auto py-1.5 text-[12px]">
          {!root ? (
            <p className="px-3 py-4 text-[11px] text-zinc-500">Set a working folder to browse its <code className="text-zinc-400">.claude/{sub}</code> files.</p>
          ) : treeError ? (
            <p className="px-3 py-4 text-[11px] text-red-300">{treeError}</p>
          ) : tree.length === 0 ? (
            <p className="px-3 py-4 text-[11px] text-zinc-500">
              No files yet in <code className="text-zinc-400">.claude/{sub}</code>. Use <FilePlus className="w-3 h-3 inline -mt-0.5" /> to add one.
            </p>
          ) : (
            <TreeView
              nodes={tree}
              depth={0}
              expanded={expanded}
              activePath={activePath}
              selectedPath={selectedPath}
              onToggleDir={toggleDir}
              onOpenFile={openFile}
              onDelete={deleteEntry}
            />
          )}
        </aside>

        {/* Editor area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Open-file tabs */}
          {open.length > 0 && (
            <div className="flex items-stretch gap-px overflow-x-auto border-b border-zinc-800 bg-zinc-900/30 shrink-0">
              {open.map(f => (
                <div
                  key={f.path}
                  className={`group flex items-center gap-1.5 pl-2.5 pr-1 py-1 text-[11px] border-r border-zinc-800 cursor-pointer ${
                    activePath === f.path ? 'bg-zinc-950 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60'
                  }`}
                  onClick={() => { setActivePath(f.path); setSelectedPath(f.path); }}
                  title={f.path}
                >
                  <FileText className="w-3 h-3 shrink-0 opacity-70" />
                  <span className="max-w-[14ch] truncate">{f.path.split('/').pop()}</span>
                  {dirty(f) && <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 shrink-0" title="Unsaved changes" />}
                  <button
                    onClick={(e) => { e.stopPropagation(); closeFile(f.path); }}
                    className="p-0.5 rounded text-zinc-600 hover:text-zinc-200 hover:bg-zinc-800 opacity-0 group-hover:opacity-100"
                    title="Close"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <div className="flex-1" />
              {activeFile && (
                <button
                  onClick={() => saveFile(activeFile.path)}
                  disabled={!dirty(activeFile) || busy}
                  className={`shrink-0 flex items-center gap-1 px-2.5 my-1 mr-1 rounded text-white text-[10px] font-bold uppercase tracking-wider disabled:opacity-40 ${accentBtn}`}
                  title="Save (Ctrl/Cmd+S)"
                >
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 m-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-[11px] shrink-0">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200"><X className="w-3 h-3" /></button>
            </div>
          )}

          <div className="flex-1 min-h-0">
            {activeFile ? (
              <Editor
                key={activeFile.path}
                theme={AIOS_DARK_THEME}
                language={langFor(activeFile.path)}
                value={activeFile.content}
                onChange={(v) => setActiveContent(v ?? '')}
                onMount={onEditorMount}
                options={{
                  fontSize: 12,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  tabSize: 2,
                  automaticLayout: true,
                  renderWhitespace: 'selection',
                  padding: { top: 10 },
                }}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-zinc-600">
                <Code2 className="w-8 h-8" />
                <p className="text-[12px]">
                  {root ? 'Open a file from the tree to start editing.' : 'Pick a working folder to begin.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TreeView({
  nodes, depth, expanded, activePath, selectedPath, onToggleDir, onOpenFile, onDelete,
}: {
  nodes: FsNode[];
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  selectedPath: string;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  return (
    <ul>
      {nodes.map(node => {
        const isOpen = expanded.has(node.path);
        const isActive = node.type === 'file' && activePath === node.path;
        const isSelected = selectedPath === node.path;
        return (
          <li key={node.path}>
            <div
              className={`group flex items-center gap-1 pr-1 py-0.5 cursor-pointer rounded-sm ${
                isActive ? 'bg-zinc-800 text-zinc-100' : isSelected ? 'bg-zinc-900 text-zinc-200' : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
              }`}
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() => node.type === 'dir' ? onToggleDir(node.path) : onOpenFile(node.path)}
              title={node.path}
            >
              {node.type === 'dir' ? (
                <>
                  {isOpen ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                  {isOpen ? <FolderOpen className="w-3.5 h-3.5 shrink-0 text-amber-400/80" /> : <Folder className="w-3.5 h-3.5 shrink-0 text-amber-400/70" />}
                </>
              ) : (
                <>
                  <span className="w-3 shrink-0" />
                  <FileText className="w-3.5 h-3.5 shrink-0 opacity-70" />
                </>
              )}
              <span className="truncate flex-1">{node.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(node.path); }}
                className="p-0.5 rounded text-zinc-600 hover:text-red-300 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 shrink-0"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            {node.type === 'dir' && isOpen && node.children && node.children.length > 0 && (
              <TreeView
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                activePath={activePath}
                selectedPath={selectedPath}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onDelete={onDelete}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function IconBtn({ title, onClick, disabled, children }: {
  title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function findNode(nodes: FsNode[], path: string): FsNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.type === 'dir' && n.children) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}
