import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useChat } from 'ai/react';
import React from 'react';
import {
  Search, Link2, Video, FileText, Target, MessageSquare, Scissors, Brain,
  RotateCw, Maximize2, Minimize2, ChevronLeft, ChevronRight, X,
  Eye, EyeOff, Palette, ClipboardList, FileX2, Lightbulb, Sparkles, RefreshCw,
  ChevronsUp, ChevronsDown, Globe, Loader2, Paperclip, ExternalLink, PlayCircle, AlertCircle,
} from 'lucide-react';
import { apiUrl } from '../lib/apiBase';
import {
  type Attachment, type LinkItem, type VideoItem,
  detectUrls, newAttachmentId, fetchUrlAttachment, fetchFileAttachment, buildSourcesBlock,
  findLinks, findVideos, formatCount, timeAgo,
} from '../lib/research';

// Verified results attached to a "Get Links" / "Get Videos" thread.
interface ThreadResearch {
  kind: 'links' | 'videos';
  status: 'loading' | 'ready' | 'error';
  intro?: string;
  links?: LinkItem[];
  videos?: VideoItem[];
  error?: string;
}

// Renders verified link/video results (curated intro + cards) for a thread.
function ResearchResultsPanel({ research, onRetry }: { research: ThreadResearch; onRetry: () => void }) {
  const isVideos = research.kind === 'videos';

  if (research.status === 'loading') {
    return (
      <div className="flex items-center gap-3 text-sm text-zinc-400 bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
        <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
        {isVideos ? 'Searching YouTube and ranking by recency & quality…' : 'Searching the web and verifying links…'}
      </div>
    );
  }

  if (research.status === 'error') {
    return (
      <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
        <div className="flex items-center gap-2 font-semibold mb-1">
          <AlertCircle className="w-4 h-4" /> Couldn’t fetch {isVideos ? 'videos' : 'links'}
        </div>
        <p className="text-red-300/80 text-xs leading-relaxed mb-3">{research.error}</p>
        <button onClick={onRetry} className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-bold rounded-lg transition-colors">
          Retry
        </button>
      </div>
    );
  }

  const links = research.links || [];
  const videos = research.videos || [];
  const empty = isVideos ? videos.length === 0 : links.length === 0;

  return (
    <div className="space-y-3">
      {research.intro && (
        <div className="bg-gradient-to-r from-indigo-500/10 to-transparent border-l-4 border-indigo-500/50 rounded-r-lg p-3 text-sm text-zinc-200 leading-relaxed">
          {research.intro}
        </div>
      )}

      {empty && (
        <div className="text-center text-zinc-500 text-sm py-6">
          No {isVideos ? 'videos' : 'links'} found for this selection.
          <button onClick={onRetry} className="ml-2 text-indigo-400 hover:text-indigo-300 underline">Retry</button>
        </div>
      )}

      {/* Link cards */}
      {!isVideos && links.map((l, i) => (
        <a
          key={`${l.url}-${i}`}
          href={l.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block group bg-zinc-900/70 hover:bg-zinc-800/80 border border-zinc-800 hover:border-indigo-500/40 rounded-xl p-3 transition-all"
        >
          <div className="flex items-start gap-2">
            <Globe className="w-4 h-4 text-indigo-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-100 group-hover:text-white truncate">{l.title}</span>
                <ExternalLink className="w-3 h-3 text-zinc-600 group-hover:text-indigo-400 shrink-0" />
              </div>
              <div className="text-[11px] text-emerald-400/80 truncate">{l.source}</div>
              {l.reason && <div className="text-xs text-zinc-400 mt-1 leading-snug line-clamp-2">{l.reason}</div>}
            </div>
          </div>
        </a>
      ))}

      {/* Video cards */}
      {isVideos && videos.map((v, i) => (
        <a
          key={`${v.videoId}-${i}`}
          href={v.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex gap-3 group bg-zinc-900/70 hover:bg-zinc-800/80 border border-zinc-800 hover:border-indigo-500/40 rounded-xl p-2.5 transition-all"
        >
          <div className="relative shrink-0">
            {v.thumbnail
              ? <img src={v.thumbnail} alt="" className="w-32 h-[72px] object-cover rounded-lg bg-zinc-800" />
              : <div className="w-32 h-[72px] rounded-lg bg-zinc-800 flex items-center justify-center"><PlayCircle className="w-6 h-6 text-zinc-600" /></div>}
            {v.duration && (
              <span className="absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 text-white text-[10px] font-medium rounded">{v.duration}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-zinc-100 group-hover:text-white line-clamp-2 leading-snug">{v.title}</div>
            <div className="text-[11px] text-zinc-400 mt-1 truncate">{v.channel}</div>
            <div className="flex items-center gap-2 text-[10px] text-zinc-500 mt-1">
              {v.viewCount != null && <span>{formatCount(v.viewCount)} views</span>}
              {v.publishedAt && <><span>•</span><span>{timeAgo(v.publishedAt)}</span></>}
              {v.likeCount ? <><span>•</span><span>{formatCount(v.likeCount)} likes</span></> : null}
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}
import { getCachedModels, onModelsChange, type ModelSlot } from '../lib/models';
import { getConfigured, onConfiguredChange, type ProviderId } from '../lib/providers';
import {
  getAnthropicAuthMode, onAnthropicAuthModeChange,
  getOpenAIAuthMode, onOpenAIAuthModeChange,
  type AnthropicAuthMode, type AuthMode,
} from '../lib/authMode';

export interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant';
  timestamp: number;
}

export interface Thread {
  id: string;
  messages: Message[];
  parentThreadId?: string;
  selectedContext?: string;
  title?: string;
  rowId?: number; // Track which row this thread belongs to
  sourceType?: 'main' | 'thread'; // Track if created from main chat or another thread
  actionType?: 'ask' | 'details' | 'simplify' | 'examples' | 'learning' | 'links' | 'videos'; // Track which context action was used
  research?: ThreadResearch; // Verified links/videos for 'links'/'videos' threads
}

// Mobile selection state interface
interface MobileSelection {
  isActive: boolean;
  startOffset: number;
  endOffset: number;
  text: string;
  messageElement: HTMLElement | null;
  messageId: string;
  isFromThread: boolean;
  threadId?: string;
}

type ModelProvider = 'openai' | 'claude' | 'anthropic' | 'grok';

// Custom hook for thread chat instances - creates isolated chat for each thread
function useThreadChat(
  selectedModel: ModelProvider,
  threadId: string,
  initialMessages?: Message[],
  grokMode: string = 'normal',
  anthropicAuthMode: AnthropicAuthMode = 'api',
  openaiAuthMode: AuthMode = 'api',
) {
  const [showReasoning, setShowReasoning] = useState(false);

  const getApiEndpoint = (model: ModelProvider) => {
    switch (model) {
      case 'openai':
        return apiUrl(openaiAuthMode === 'subscription' ? '/api/codex-agent/chat' : '/api/openai/chat');
      case 'claude':
      case 'anthropic':
        return apiUrl(anthropicAuthMode === 'subscription' ? '/api/claude-agent/chat' : '/api/anthropic/chat');
      case 'grok':
        return apiUrl('/api/grok/chat');
      default:
        return apiUrl('/api/openai/chat');
    }
  };

  // Convert our Message format to the format expected by useChat
  const formattedInitialMessages = initialMessages?.map(msg => ({
    id: msg.id,
    content: msg.content,
    role: msg.role as 'user' | 'assistant',
  })) || [];

  // Create a unique chat instance for this specific thread
  const { messages, input, handleInputChange, handleSubmit, isLoading, append, stop } = useChat({
    id: `thread-${threadId}`, // Unique ID ensures complete isolation
    api: getApiEndpoint(selectedModel),
    initialMessages: formattedInitialMessages,
    body: {
      showReasoning,
      ...(selectedModel === 'grok' && { mode: grokMode }),
      ...(selectedModel === 'claude' && { variant: 'opus' }),
      ...(selectedModel === 'anthropic' && { variant: 'sonnet' }),
    },
    onError: (error) => {
      console.error(`Thread ${threadId} chat error:`, error);
    },
  });

  return {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    append,
    stop,
    showReasoning,
    setShowReasoning
  };
}

const ThreadedChat = forwardRef<any, {}>((props, ref) => {
  const [selectedModel, setSelectedModel] = useState<ModelProvider>('grok');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState<string>('');
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [selectedMessageId, setSelectedMessageId] = useState<string>('');
  const [mainShowReasoning, setMainShowReasoning] = useState(false);

  const [grokMode, setGrokMode] = useState<'normal' | 'fun' | 'creative' | 'precise'>('normal');

  // Add state for thread expansion
  const [expandedThread, setExpandedThread] = useState<string | 'main' | null>('main');
  // Track which message/thread context menu originated from
  const [contextMenuSource, setContextMenuSource] = useState<{ messageId: string; isFromThread: boolean; threadId?: string }>({ messageId: '', isFromThread: false });
  // Manual resize state
  const [manualMainWidth, setManualMainWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [startX, setStartX] = useState(0);
  const [startWidth, setStartWidth] = useState(0);
  // Row collapse state
  const [collapsedRows, setCollapsedRows] = useState<Set<number>>(new Set());
  // Context collapse state - start with all contexts collapsed by default
  const [collapsedContexts, setCollapsedContexts] = useState<Set<string>>(new Set());
  // Fullscreen state for threads
  const [fullscreenThread, setFullscreenThread] = useState<string | null>(null);
  // Thread header color toggle state
  const [threadHeaderColorsEnabled, setThreadHeaderColorsEnabled] = useState<boolean>(false);
  // Global context visibility toggle state
  const [showAllContexts, setShowAllContexts] = useState<boolean>(false);
  // Split screen mode state
  const [isSplitScreenMode, setIsSplitScreenMode] = useState<boolean>(false);
  
  // New UI enhancement toggles
  const [compactThreadHeaders, setCompactThreadHeaders] = useState<boolean>(false);
  const [hideInputFields, setHideInputFields] = useState<boolean>(false);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  
  // Learning snippets state
  const [learningSnippets, setLearningSnippets] = useState<Array<{
    id: string;
    text: string;
    timestamp: number;
    source: string;
  }>>([]);
  const [showLearningModal, setShowLearningModal] = useState<boolean>(false);

  // Research attachments (links/files added as model-agnostic context).
  // attachmentsRef mirrors state synchronously so submit logic can read the
  // latest values immediately after awaiting in-flight extractions.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const pendingExtractions = useRef<Map<string, Promise<void>>>(new Map());
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [urlInputValue, setUrlInputValue] = useState('');

  const commitAttachments = (next: Attachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  };
  const upsertAttachment = (id: string, patch: Partial<Attachment>) =>
    commitAttachments(attachmentsRef.current.map(a => (a.id === id ? { ...a, ...patch } : a)));
  const removeAttachment = (id: string) => {
    pendingExtractions.current.delete(id);
    commitAttachments(attachmentsRef.current.filter(a => a.id !== id));
  };

  // Add a URL attachment and kick off server-side extraction. Returns once the
  // attachment has settled (ready/error). De-dupes by source URL.
  const addUrlAttachment = (url: string): Promise<void> => {
    const trimmed = url.trim();
    if (!trimmed) return Promise.resolve();
    if (attachmentsRef.current.some(a => a.source === trimmed)) return Promise.resolve();
    const id = newAttachmentId();
    commitAttachments([
      ...attachmentsRef.current,
      { id, kind: 'url', label: trimmed, source: trimmed, status: 'extracting' },
    ]);
    const p = (async () => {
      const result = await fetchUrlAttachment(trimmed);
      upsertAttachment(id, { ...result, id });
      pendingExtractions.current.delete(id);
    })();
    pendingExtractions.current.set(id, p);
    return p;
  };

  // Add a file attachment and kick off server-side extraction. De-dupes by path.
  const addFileAttachment = (filePath: string): Promise<void> => {
    if (attachmentsRef.current.some(a => a.source === filePath)) return Promise.resolve();
    const id = newAttachmentId();
    const label = filePath.split(/[\\/]/).pop() || filePath;
    commitAttachments([
      ...attachmentsRef.current,
      { id, kind: 'file', label, source: filePath, status: 'extracting' },
    ]);
    const p = (async () => {
      const result = await fetchFileAttachment(filePath);
      upsertAttachment(id, { ...result, id });
      pendingExtractions.current.delete(id);
    })();
    pendingExtractions.current.set(id, p);
    return p;
  };

  // Open the native file picker and attach the chosen files.
  const handlePickFiles = async () => {
    if (!window.aios?.pickFiles) return;
    try {
      const paths = await window.aios.pickFiles();
      for (const p of paths) addFileAttachment(p);
    } catch (e) {
      console.error('File pick failed:', e);
    }
  };

  // Build the outgoing main-chat message: auto-detect any pasted URLs, wait for
  // all in-flight extractions, then prepend ready (not-yet-injected) sources.
  const submitMainMessage = async (rawText: string) => {
    const text = rawText.trim();
    if (!text) return;

    // Auto-detect URLs the user pasted into the message itself.
    for (const url of detectUrls(text)) addUrlAttachment(url);

    // Wait for every still-extracting attachment to settle.
    if (pendingExtractions.current.size > 0) {
      await Promise.allSettled(Array.from(pendingExtractions.current.values()));
    }

    const block = buildSourcesBlock(attachmentsRef.current);
    const injectedIds = attachmentsRef.current
      .filter(a => a.status === 'ready' && a.text && !a.injected)
      .map(a => a.id);
    if (injectedIds.length) {
      commitAttachments(
        attachmentsRef.current.map(a => (injectedIds.includes(a.id) ? { ...a, injected: true } : a)),
      );
    }

    mainChat.append({ role: 'user', content: block ? `${block}\n${text}` : text });
  };

  // Mobile selection state
  const [mobileSelection, setMobileSelection] = useState<MobileSelection>({
    isActive: false,
    startOffset: 0,
    endOffset: 0,
    text: '',
    messageElement: null,
    messageId: '',
    isFromThread: false,
    threadId: undefined
  });
  const [showMobileSelectionHandles, setShowMobileSelectionHandles] = useState(false);
  const [isMobileDevice, setIsMobileDevice] = useState(false);
  
  // Touch event state
  const [touchState, setTouchState] = useState({
    lastTapTime: 0,
    tapCount: 0,
    isLongPress: false,
    longPressTimer: null as NodeJS.Timeout | null,
    startX: 0,
    startY: 0,
    isDragging: false
  });
  
  // Store chat instances for each thread - each thread gets its own isolated chat
  const [threadChatInstances, setThreadChatInstances] = useState<{[key: string]: any}>({});
  
  // Track messages that need to be loaded into thread chat instances
  const [threadMessagesToLoad, setThreadMessagesToLoad] = useState<{[key: string]: Message[]}>({});

  // Store references to thread chat instances for copying
  const threadChatRefs = useRef<{[key: string]: any}>({});

  // Ensure collapsed contexts are properly initialized when showAllContexts is false
  useEffect(() => {
    if (!showAllContexts && threads.length > 0) {
      const allThreadIds = threads.map(thread => thread.id);
      setCollapsedContexts(new Set(allThreadIds));
    }
  }, [threads, showAllContexts]);

  const [anthropicAuthMode, setAnthropicAuthMode] = useState<AnthropicAuthMode>('api');
  const [openaiAuthMode, setOpenaiAuthMode] = useState<AuthMode>('api');
  useEffect(() => {
    getAnthropicAuthMode().then(setAnthropicAuthMode).catch(() => {});
    return onAnthropicAuthModeChange(setAnthropicAuthMode);
  }, []);
  useEffect(() => {
    getOpenAIAuthMode().then(setOpenaiAuthMode).catch(() => {});
    return onOpenAIAuthModeChange(setOpenaiAuthMode);
  }, []);

  const getApiEndpoint = (model: ModelProvider) => {
    switch (model) {
      case 'openai':
        return apiUrl(openaiAuthMode === 'subscription' ? '/api/codex-agent/chat' : '/api/openai/chat');
      case 'claude':
      case 'anthropic':
        return apiUrl(anthropicAuthMode === 'subscription' ? '/api/claude-agent/chat' : '/api/anthropic/chat');
      case 'grok':
        return apiUrl('/api/grok/chat');
      default:
        return apiUrl('/api/anthropic/chat');
    }
  };

  // Main chat hook
  const mainChat = useChat({
    api: getApiEndpoint(selectedModel),
    body: {
      showReasoning: mainShowReasoning,
      ...(selectedModel === 'grok' && { mode: grokMode }),
      ...(selectedModel === 'claude' && { variant: 'opus' }),
      ...(selectedModel === 'anthropic' && { variant: 'sonnet' }),
    }
  });

  // Detect mobile device
  useEffect(() => {
    const checkMobile = () => {
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || 
                      ('ontouchstart' in window) || 
                      (window.innerWidth <= 768);
      setIsMobileDevice(isMobile);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Helper function for mobile selection
  const startMobileSelection = React.useCallback((touch: Touch, messageElement: HTMLElement, messageId: string, isFromThread: boolean, threadId?: string) => {
    const textContent = messageElement.textContent || '';
    const rect = messageElement.getBoundingClientRect();
    const relativeX = touch.clientX - rect.left;
    const relativeY = touch.clientY - rect.top;
    
    // Find approximate text offset based on touch position
    const charOffset = estimateTextOffset(messageElement, relativeX, relativeY);
    
    setMobileSelection({
      isActive: true,
      startOffset: charOffset,
      endOffset: charOffset + 10, // Start with a small selection
      text: textContent.substring(charOffset, charOffset + 10),
      messageElement,
      messageId,
      isFromThread,
      threadId
    });
    
    setTouchState(prev => ({ ...prev, isDragging: true }));
    highlightMobileSelection(messageElement, charOffset, charOffset + 10);
  }, []);

  // Mobile touch handlers
  const handleTouchStart = React.useCallback((e: TouchEvent, messageId: string, isFromThread: boolean, threadId?: string) => {
    const touch = e.touches[0];
    const currentTime = Date.now();
    const target = e.target as HTMLElement;
    
    // Clear any existing long press timer
    if (touchState.longPressTimer) {
      clearTimeout(touchState.longPressTimer);
    }
    
    // Check for double tap
    const timeDiff = currentTime - touchState.lastTapTime;
    const isDoubleTap = timeDiff < 300 && touchState.tapCount === 1;
    
    if (isDoubleTap) {
      // Double tap detected - start selection process
      setTouchState(prev => ({
        ...prev,
        tapCount: 2,
        startX: touch.clientX,
        startY: touch.clientY,
        isLongPress: false,
        longPressTimer: setTimeout(() => {
          // Long press after double tap - start selection
          const messageElement = target.closest('[data-role="assistant"]') as HTMLElement;
          if (messageElement) {
            startMobileSelection(touch, messageElement, messageId, isFromThread, threadId);
          }
        }, 500)
      }));
    } else {
      // Single tap
      setTouchState(prev => ({
        ...prev,
        lastTapTime: currentTime,
        tapCount: 1,
        startX: touch.clientX,
        startY: touch.clientY,
        isLongPress: false,
        longPressTimer: null
      }));
    }
  }, [touchState, startMobileSelection]);

  const handleTouchMove = React.useCallback((e: TouchEvent) => {
    if (!mobileSelection.isActive || !touchState.isDragging || !mobileSelection.messageElement) return;
    
    const touch = e.touches[0];
    const rect = mobileSelection.messageElement.getBoundingClientRect();
    const relativeX = touch.clientX - rect.left;
    const relativeY = touch.clientY - rect.top;
    
    const newOffset = estimateTextOffset(mobileSelection.messageElement, relativeX, relativeY);
    const textContent = mobileSelection.messageElement.textContent || '';
    
    const startOffset = Math.min(mobileSelection.startOffset, newOffset);
    const endOffset = Math.max(mobileSelection.startOffset, newOffset);
    
    setMobileSelection(prev => ({
      ...prev,
      endOffset,
      text: textContent.substring(startOffset, endOffset)
    }));
    
    highlightMobileSelection(mobileSelection.messageElement, startOffset, endOffset);
  }, [mobileSelection, touchState]);

  const handleTouchEnd = React.useCallback(() => {
    if (touchState.longPressTimer) {
      clearTimeout(touchState.longPressTimer);
    }
    
    if (mobileSelection.isActive && touchState.isDragging) {
      // Show selection handles for adjustment
      setShowMobileSelectionHandles(true);
      setTouchState(prev => ({ ...prev, isDragging: false }));
    }
  }, [mobileSelection, touchState]);

  // Helper function to estimate text offset from coordinates
  const estimateTextOffset = (element: HTMLElement, x: number, y: number): number => {
    const textContent = element.textContent || '';
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const lineHeight = parseInt(style.lineHeight) || parseInt(style.fontSize) * 1.2;
    
    // Rough estimation based on character width and line position
    const avgCharWidth = parseInt(style.fontSize) * 0.6;
    const lineNumber = Math.floor(y / lineHeight);
    const charInLine = Math.floor(x / avgCharWidth);
    
    // This is a rough estimation - in a real implementation you'd want more precise calculation
    const estimatedOffset = Math.min(lineNumber * 50 + charInLine, textContent.length - 1);
    return Math.max(0, estimatedOffset);
  };

  // Helper function to highlight selected text
  const highlightMobileSelection = (element: HTMLElement, startOffset: number, endOffset: number) => {
    const textContent = element.textContent || '';
    const selectedText = textContent.substring(startOffset, endOffset);
    
    // Create a temporary selection to show visual feedback
    const range = document.createRange();
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );
    
    let currentOffset = 0;
    let startNode: Node | null = null;
    let endNode: Node | null = null;
    let startNodeOffset = 0;
    let endNodeOffset = 0;
    
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const nodeLength = node.textContent?.length || 0;
      
      if (!startNode && currentOffset + nodeLength > startOffset) {
        startNode = node;
        startNodeOffset = startOffset - currentOffset;
      }
      
      if (currentOffset + nodeLength >= endOffset) {
        endNode = node;
        endNodeOffset = endOffset - currentOffset;
        break;
      }
      
      currentOffset += nodeLength;
    }
    
    if (startNode && endNode) {
      range.setStart(startNode, startNodeOffset);
      range.setEnd(endNode, endNodeOffset);
      
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  const commitMobileSelection = () => {
    if (mobileSelection.isActive && mobileSelection.text.length >= 10) {
      setSelectedText(mobileSelection.text);
      setSelectedMessageId(mobileSelection.messageId);
      setContextMenuSource({ 
        messageId: mobileSelection.messageId, 
        isFromThread: mobileSelection.isFromThread, 
        threadId: mobileSelection.threadId 
      });
      setShowContextMenu(true);
    }
    
    // Reset mobile selection state
    setMobileSelection({
      isActive: false,
      startOffset: 0,
      endOffset: 0,
      text: '',
      messageElement: null,
      messageId: '',
      isFromThread: false,
      threadId: undefined
    });
    setShowMobileSelectionHandles(false);
  };

  const cancelMobileSelection = () => {
    // Clear any selection
    window.getSelection()?.removeAllRanges();
    
    // Reset mobile selection state
    setMobileSelection({
      isActive: false,
      startOffset: 0,
      endOffset: 0,
      text: '',
      messageElement: null,
      messageId: '',
      isFromThread: false,
      threadId: undefined
    });
    setShowMobileSelectionHandles(false);
  };

  // Function to expand all collapsed rows
  const expandAllRows = () => {
    const threadRowsData = getThreadRows();
    const allRowIndices = threadRowsData.map((_, index) => index);
    
    // Clear all collapsed rows (expand everything)
    setCollapsedRows(new Set());
  };

  // Function to copy all AI responses to clipboard
  const copyAllAIResponses = async () => {
    try {
      // First, expand all rows to ensure all threads are visible
      const hadCollapsedRows = collapsedRows.size > 0;
      if (hadCollapsedRows) {
        expandAllRows();
        // Wait a moment for the UI to update and render all threads
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      let allResponses = '';
      
      // Add main chat AI responses
      const mainAIResponses = mainChat.messages.filter(msg => msg.role === 'assistant');
      if (mainAIResponses.length > 0) {
        allResponses += '=== MAIN CHAT RESPONSES ===\n\n';
        mainAIResponses.forEach((msg, index) => {
          allResponses += `[Main Response ${index + 1}]\n${msg.content}\n\n`;
        });
      }
      
      // Add thread AI responses - now all should be rendered and accessible
      if (threads.length > 0) {
        allResponses += '=== THREAD RESPONSES ===\n\n';
        
        threads.forEach((thread, threadIndex) => {
          // Find rendered messages in the DOM for this thread
          const threadElement = document.querySelector(`[data-thread-id="${thread.id}"]`);
          if (threadElement) {
            const assistantMessages = threadElement.querySelectorAll('[data-role="assistant"]');
            
            if (assistantMessages.length > 0) {
              allResponses += `--- Thread ${threadIndex + 1}: ${thread.title || 'Untitled'} ---\n`;
              if (thread.selectedContext) {
                allResponses += `Context: "${thread.selectedContext}"\n\n`;
              }
              
              assistantMessages.forEach((msgElement, msgIndex) => {
                const content = msgElement.textContent || '';
                if (content.trim()) {
                  // Remove the "Select text to create a new thread" text that appears at the end
                  const cleanContent = content.replace(/Select text to create a new thread$/, '').trim();
                  if (cleanContent) {
                    allResponses += `[Thread ${threadIndex + 1} Response ${msgIndex + 1}]\n${cleanContent}\n\n`;
                  }
                }
              });
            } else {
              // Thread exists but has no messages yet
              allResponses += `--- Thread ${threadIndex + 1}: ${thread.title || 'Untitled'} ---\n`;
              if (thread.selectedContext) {
                allResponses += `Context: "${thread.selectedContext}"\n\n`;
              }
              allResponses += `[Thread ${threadIndex + 1}] No AI responses yet - conversation not started.\n\n`;
            }
          }
        });
      }
      
      if (allResponses.trim() === '' || allResponses.trim() === '=== MAIN CHAT RESPONSES ===') {
        allResponses = 'No AI responses found to copy. Make sure you have had conversations with the AI first.';
      }
      
      // Copy to clipboard
      await navigator.clipboard.writeText(allResponses);
      
      // Show success feedback with more details
      const threadCount = threads.length;
      const mainResponseCount = mainChat.messages.filter(msg => msg.role === 'assistant').length;
      console.log('All AI responses copied to clipboard!');
      
      const expandMessage = hadCollapsedRows ? '\n\nNote: auto-expanded all collapsed rows to access all responses.' : '';
      alert(`Copied to clipboard!\n- Main chat: ${mainResponseCount} responses\n- Threads: ${threadCount} threads${expandMessage}`);
      
    } catch (error) {
      console.error('Failed to copy responses:', error);
      alert('Failed to copy responses. Please try again.');
    }
  };

  // Force update thread messages before saving
  const forceUpdateThreadMessages = () => {
    console.log('🔄 Force updating thread messages before save...');
    
    // Update thread messages from live chat instances
    setThreads(prev => prev.map(thread => {
      const threadChatInstance = threadChatRefs.current[thread.id];
      
      if (threadChatInstance && threadChatInstance.messages) {
        const updatedMessages = threadChatInstance.messages.map((msg: any) => ({
          id: msg.id,
          content: msg.content,
          role: msg.role,
          timestamp: msg.timestamp || Date.now(),
        }));
        
        console.log(`🔄 Updated thread ${thread.id} with ${updatedMessages.length} messages`);
        
        return {
          ...thread,
          messages: updatedMessages,
        };
      }
      
      return thread;
    }));
  };

  // Function to get current state for saving
  const getCurrentState = () => {
    // Collect messages from all thread chat instances with improved fallback handling
    const threadsWithMessages = threads.map(thread => {
      const threadChatInstance = threadChatRefs.current[thread.id];
      let currentMessages = thread.messages || [];
      let messageSource = 'static';
      
      // If we have a live chat instance, get its current messages
      if (threadChatInstance && threadChatInstance.messages) {
        currentMessages = threadChatInstance.messages.map((msg: any) => ({
          id: msg.id,
          content: msg.content,
          role: msg.role,
          timestamp: msg.timestamp || Date.now(),
        }));
        messageSource = 'live';
      } else if (threadMessagesToLoad[thread.id]) {
        // Fallback to messages that were queued for loading
        currentMessages = threadMessagesToLoad[thread.id];
        messageSource = 'queued';
      }
      
      console.log(`📊 Thread ${thread.id}: ${currentMessages.length} messages from ${messageSource} source`);
      
      return {
        ...thread,
        messages: currentMessages,
      };
    });

    // Enhanced logging with source information
    console.log('📊 getCurrentState - Thread message counts:', 
      threadsWithMessages.map(t => ({ 
        id: t.id, 
        messageCount: t.messages.length,
        title: t.title?.substring(0, 30) || 'Untitled'
      }))
    );

    // Include UI state for better restoration
    const uiState = {
      collapsedRows: Array.from(collapsedRows),
      collapsedContexts: Array.from(collapsedContexts),
      expandedThread: expandedThread,
      fullscreenThread: fullscreenThread,
      manualMainWidth: manualMainWidth,
      threadHeaderColorsEnabled: threadHeaderColorsEnabled,
      showAllContexts: showAllContexts,
    };

    return {
      mainMessages: mainChat.messages,
      threads: threadsWithMessages,
      selectedModel: selectedModel,
      activeThreadId: activeThreadId,
      uiState: uiState, // New: preserve UI state
      learningSnippets: learningSnippets, // Include learning snippets for content selection
      attachments: attachmentsRef.current, // Research links/files attached as context
    };
  };

  // Function to load state from saved deep dive
  const loadState = (state: any) => {
    console.log('🔄 Loading deep dive state...', {
      title: state.title || 'Unknown',
      mainMessagesCount: state.mainMessages?.length || 0,
      threadsCount: state.threads?.length || 0,
      snippetsCount: state.learningSnippets?.length || 0, // Add snippet count to debug log
      selectedModel: state.selectedModel
    });

    try {
      // Clear current state first
      clearAllAndStartFresh();
      
      // Wait a bit for the clear to take effect
      setTimeout(() => {
        // Set model first
        setSelectedModel(state.selectedModel || 'anthropic');
        
        // Set threads - ensure they have all required properties
        const loadedThreads = (state.threads || []).map((thread: any) => ({
          id: thread.id || `thread-${Date.now()}-${Math.random()}`,
          messages: thread.messages || [],
          selectedContext: thread.selectedContext || '',
          title: thread.title || 'Untitled Thread',
          rowId: thread.rowId || 0,
          sourceType: thread.sourceType || 'main',
          actionType: thread.actionType || 'ask',
          parentThreadId: thread.parentThreadId || undefined,
          research: thread.research || undefined,
        }));
        
        // Store thread messages to be loaded into chat instances when they're ready
        const messagesToLoad: {[key: string]: Message[]} = {};
        loadedThreads.forEach((thread: Thread) => {
          if (thread.messages && thread.messages.length > 0) {
            messagesToLoad[thread.id] = thread.messages;
          }
        });
        setThreadMessagesToLoad(messagesToLoad);
        
        setThreads(loadedThreads);
        
        // Set active thread
        setActiveThreadId(state.activeThreadId || null);
        
        // Load learning snippets from saved state
        if (state.learningSnippets && Array.isArray(state.learningSnippets)) {
          console.log('📚 Loading learning snippets:', state.learningSnippets.length);
          setLearningSnippets(state.learningSnippets);
        } else {
          console.log('📚 No learning snippets found in saved state');
          setLearningSnippets([]);
        }

        // Restore research attachments
        commitAttachments(Array.isArray(state.attachments) ? state.attachments : []);
        
        // Load main messages if available
        if (state.mainMessages && state.mainMessages.length > 0) {
          console.log('💬 Loading main chat messages:', state.mainMessages.length);
          const formattedMessages: Message[] = state.mainMessages.map((msg: any) => ({
            id: msg.id || Date.now().toString(),
            role: msg.role,
            content: msg.content,
          }));
          mainChat.setMessages(formattedMessages);
        }
        
        // Restore UI state if available
        if (state.uiState) {
          console.log('🎨 Restoring UI state:', state.uiState);
          setExpandedThread(state.uiState.expandedThread || 'main');
          setCollapsedRows(new Set(state.uiState.collapsedRows || []));
          setCollapsedContexts(new Set(state.uiState.collapsedContexts || []));
          setManualMainWidth(state.uiState.manualMainWidth || null);
          setFullscreenThread(state.uiState.fullscreenThread || null);
          setThreadHeaderColorsEnabled(state.uiState.threadHeaderColorsEnabled !== undefined ? state.uiState.threadHeaderColorsEnabled : true);
          setShowAllContexts(state.uiState.showAllContexts !== undefined ? state.uiState.showAllContexts : true);
        } else {
          // Fallback to default UI state for older saves
          console.log('🎨 Using default UI state (older save format)');
          setExpandedThread('main');
          setCollapsedRows(new Set());
          setCollapsedContexts(new Set());
          setManualMainWidth(null);
          setFullscreenThread(null);
          setThreadHeaderColorsEnabled(true);
          setShowAllContexts(true);
        }
        
        // Clear context menu
        setShowContextMenu(false);
        setSelectedText('');
        setSelectedMessageId('');
        
        console.log('✅ Deep dive state loaded successfully');
      }, 100);
      
    } catch (error) {
      console.error('❌ Error loading deep dive state:', error);
      throw error;
    }
  };

  // Function to clear all threads and main chat for a fresh start
  const clearAllAndStartFresh = () => {
    setThreads([]);
    setActiveThreadId(null);
    pendingExtractions.current.clear();
    commitAttachments([]);
    setExpandedThread('main');
    setCollapsedRows(new Set());
    setCollapsedContexts(new Set());
    setFullscreenThread(null);
    setManualMainWidth(null);
    setSelectedText('');
    setShowContextMenu(false);
    setSelectedMessageId('');
    setContextMenuSource({ messageId: '', isFromThread: false });
    // Clear main chat messages
    mainChat.setMessages([]);
    // Clear thread chat instances
    setThreadChatInstances({});
    setThreadMessagesToLoad({});
    // Remove the window.location.reload() to prevent infinite loop during state loading
    // Force a re-render by updating the key is no longer needed
  };

  // Function to add snippets to learning collection
  const addToLearningSnippets = (text: string) => {
    const newSnippet = {
      id: Date.now().toString(),
      text: text.trim(),
      timestamp: Date.now(),
      source: contextMenuSource.isFromThread
        ? `Thread ${threads.findIndex(t => t.id === contextMenuSource.threadId) + 1}`
        : 'Main Chat'
    };

    setLearningSnippets(prev => [newSnippet, ...prev]);
    setShowContextMenu(false);

    // Show brief confirmation
    // You could add a toast notification here if desired
  };

  // Cross-link to the Snipping Vault: persist selected text as a Snippet record
  // with origin metadata so the Snipping tab can show "from thread …" and link back.
  const saveSelectionAsSnippet = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setShowContextMenu(false);
    try {
      const db = await import('../lib/db');
      const ai = await import('../lib/ai');
      const providers = await import('../lib/providers');

      const id = `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const sourceLabel = contextMenuSource.isFromThread
        ? `DeepDive Thread ${threads.findIndex(t => t.id === contextMenuSource.threadId) + 1}`
        : 'DeepDive Main Chat';

      const placeholder = {
        id,
        image: '',
        timestamp: Date.now(),
        tags: [] as string[],
        title: trimmed.slice(0, 60),
        summary: trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed,
        source: sourceLabel,
        category: 'DeepDive',
        entities: [] as any[],
        subImages: [],
        extractedText: trimmed,
        status: 'ready' as const,
        originThreadId: contextMenuSource.isFromThread ? contextMenuSource.threadId : undefined,
      };
      await db.putSnippet(placeholder);

      // Best-effort: enrich with Gemini analysis + embedding if configured.
      if (providers.isConfigured('gemini') && ai.isGeminiReady()) {
        try {
          const analysis = await ai.analyzeText(trimmed);
          const enriched = {
            ...placeholder,
            title: analysis.label || placeholder.title,
            summary: analysis.summary || placeholder.summary,
            tags: analysis.tags || [],
            entities: analysis.entities || [],
          };
          await db.putSnippet(enriched);
          try {
            const embedding = await ai.embedText(ai.buildEmbedSource(enriched));
            await db.putSnippet({ ...enriched, embedding });
          } catch (e) { console.error('Snippet embedding failed:', e); }
        } catch (e) { console.error('Snippet enrichment failed:', e); }
      }
    } catch (e) {
      console.error('Failed to save snippet:', e);
      alert(`Failed to save snippet: ${(e as any)?.message ?? e}`);
    }
  };

  // Function to remove snippet from learning collection
  const removeLearningSnippet = (id: string) => {
    setLearningSnippets(prev => prev.filter(snippet => snippet.id !== id));
  };

  // Function to clear all learning snippets
  const clearLearningSnippets = () => {
    setLearningSnippets([]);
  };

  // Expose functions to parent component
  useImperativeHandle(ref, () => ({
    copyAllAIResponses,
    clearAllAndStartFresh,
    getCurrentState,
    loadState,
    forceUpdateThreadMessages, // New: ensure all messages are captured before save
    setMainInput: (text: string) => mainChat.setInput(text),
  }));

  const handleTextSelection = React.useCallback((messageId: string, isFromThread: boolean = false, threadId?: string) => {
    const selection = window.getSelection();
    if (!selection || selection.toString().trim().length === 0) {
      setShowContextMenu(false);
      return;
    }

    const selectedText = selection.toString().trim();
    if (selectedText.length < 10) return; // Minimum selection length

    console.log('Text selected:', selectedText); // Debug log

    setSelectedText(selectedText);
    setSelectedMessageId(messageId);
    setContextMenuSource({ messageId, isFromThread, threadId });
    
    // Always position the context menu in the center of the screen
    const xPos = window.innerWidth / 2;
    const yPos = window.innerHeight / 2;
    
    console.log('Setting context menu position:', { x: xPos, y: yPos }); // Debug log
    
    setContextMenuPosition({ x: xPos, y: yPos });
    setShowContextMenu(true);
    
    console.log('Context menu should be showing'); // Debug log
  }, []);

  // Run real retrieval for a 'links'/'videos' thread and store verified results
  // on the thread. Replaces sending a (hallucination-prone) prompt to the model.
  const runThreadResearch = async (threadId: string, kind: 'links' | 'videos', context: string) => {
    const patch = (research: ThreadResearch) =>
      setThreads(prev => prev.map(t => (t.id === threadId ? { ...t, research } : t)));
    patch({ kind, status: 'loading' });
    try {
      if (kind === 'links') {
        const { intro, items } = await findLinks(context);
        patch({ kind, status: 'ready', intro, links: items });
      } else {
        const { intro, items } = await findVideos(context);
        patch({ kind, status: 'ready', intro, videos: items });
      }
    } catch (e: any) {
      patch({ kind, status: 'error', error: e?.message || 'Retrieval failed' });
    }
  };

  const createNewThread = (context: string, autoExpand: boolean = false, autoSend: boolean = false, actionType: 'ask' | 'details' | 'simplify' | 'examples' | 'learning' | 'links' | 'videos' = 'ask') => {
    // Auto-exit fullscreen mode when creating new thread to ensure proper functionality
    const wasInFullscreen = !!fullscreenThread;
    if (fullscreenThread) {
      setFullscreenThread(null);
    }
    
    // Create a unique thread ID with timestamp and random component for complete uniqueness
    const newThreadId = `thread-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Create a more descriptive title based on context
    let title = context.substring(0, 60) + (context.length > 60 ? '...' : '');
    
    // Handle special cases for auto-generated prompts
    if (context.includes('Please explain this in the simplest terms possible')) {
      const match = context.match(/"([^"]+)"/);
      if (match) {
        title = `Simplify: ${match[1].substring(0, 40)}${match[1].length > 40 ? '...' : ''}`;
      }
    } else if (context.includes('Please provide 3-5 concrete, practical examples')) {
      const match = context.match(/"([^"]+)"/);
      if (match) {
        title = `Examples: ${match[1].substring(0, 40)}${match[1].length > 40 ? '...' : ''}`;
      }
    } else if (context.includes('Please provide more details about')) {
      const match = context.match(/"([^"]+)"/);
      if (match) {
        title = `Details: ${match[1].substring(0, 40)}${match[1].length > 40 ? '...' : ''}`;
      }
    } else {
      // If it's a question or statement, try to extract the key topic
      const sentences = context.split(/[.!?]+/);
      if (sentences.length > 0 && sentences[0].trim().length > 10) {
        const firstSentence = sentences[0].trim();
        if (firstSentence.length <= 50) {
          title = firstSentence;
        }
      }
    }

    // Determine row assignment based on source
    let rowId = 0;
    let sourceType: 'main' | 'thread' = 'main';
    
    if (contextMenuSource.isFromThread && contextMenuSource.threadId) {
      // Thread created from another thread - stays in same row
      const parentThread = threads.find(t => t.id === contextMenuSource.threadId);
      rowId = parentThread?.rowId || 0;
      sourceType = 'thread';
    } else {
      // Thread created from main chat
      sourceType = 'main';
      // Find existing threads from main chat to determine row
      const mainChatThreads = threads.filter(t => t.sourceType === 'main');
      const existingRows = Array.from(new Set(mainChatThreads.map(t => t.rowId || 0)));
      
      if (mainChatThreads.length === 0) {
        // First thread from main chat - goes to row 0
        rowId = 0;
      } else {
        // Second+ thread from main chat - create new row
        rowId = Math.max(...existingRows) + 1;
      }
    }
    
    const newThread: Thread = {
      id: newThreadId,
      messages: [],
      selectedContext: context,
      title: title,
      rowId: rowId,
      sourceType: sourceType,
      actionType: actionType,
      parentThreadId: (contextMenuSource.isFromThread && contextMenuSource.threadId) ? contextMenuSource.threadId : undefined
    };

    // Add thread to the list - each thread is completely independent
    setThreads(prev => {
      console.log(`Creating new thread: ${newThreadId}`, { 
        context: context.substring(0, 100), 
        rowId, 
        sourceType,
        totalThreads: prev.length + 1 
      });
      
      // If this is the first thread being created, collapse the main chat and expand this thread
      if (prev.length === 0) {
        setExpandedThread(newThreadId);
      }
      
      return [...prev, newThread];
    });
    
    setActiveThreadId(newThreadId);
    setShowContextMenu(false);

    // Handle auto-expansion for "Get more details"
    // Add extra delay if we were in fullscreen to allow layout to settle
    const baseDelay = wasInFullscreen ? 500 : 100;
    
    if (autoExpand) {
      setTimeout(() => {
        const event = new CustomEvent('autoExpandThread', {
          detail: { threadId: newThreadId, context: context }
        });
        window.dispatchEvent(event);
      }, baseDelay);
    }
    
    // Handle auto-send for "Simplify this" and "Give examples"
    if (autoSend) {
      setTimeout(() => {
        const event = new CustomEvent('autoSendToThread', {
          detail: { threadId: newThreadId, message: context }
        });
        window.dispatchEvent(event);
      }, baseDelay);
    }

    // "Get links" / "Get videos": run real retrieval instead of prompting a model.
    if (actionType === 'links' || actionType === 'videos') {
      runThreadResearch(newThreadId, actionType, context);
    }
  };

  const closeThread = (threadId: string) => {
    console.log(`Closing thread: ${threadId}`);
    
    // Remove thread from the list
    setThreads(prev => {
      const filtered = prev.filter(t => t.id !== threadId);
      console.log(`Remaining threads: ${filtered.length}`);
      return filtered;
    });
    
    // Clean up any stored chat instances for this thread
    setThreadChatInstances(prev => {
      const newInstances = { ...prev };
      delete newInstances[threadId];
      return newInstances;
    });
    
    // Clear active thread if it's the one being closed
    if (activeThreadId === threadId) {
      setActiveThreadId(null);
    }
    
    // If this was the fullscreen thread, reset fullscreen
    if (fullscreenThread === threadId) {
      setFullscreenThread(null);
    }

  };

  const ContextMenu = () => {
    if (!showContextMenu) return null;

    // Context menu buttons in the requested order: Get more details (Green), Get links (Blue), Get videos (Yellow), Give examples (Purple), Simplify this (Orange), Ask about this (Cyan)
    const menuItems = [
      {
        action: 'details',
        icon: <Search className="w-3.5 h-3.5 text-white" />,
        label: 'Get more details',
        onClick: () => createNewThread(selectedText, true, false, 'details'),
        colorScheme: getActionColorScheme('details')
      },
      {
        action: 'links',
        icon: <Link2 className="w-3.5 h-3.5 text-white" />,
        label: 'Get links',
        // Real retrieval: pass the raw selection; createNewThread kicks off
        // grounded web search + verification instead of prompting the model.
        // No autoExpand/autoSend — those fire model prompts; research replaces that.
        onClick: () => createNewThread(selectedText, false, false, 'links'),
        colorScheme: getActionColorScheme('links')
      },
      {
        action: 'videos',
        icon: <Video className="w-3.5 h-3.5 text-white" />,
        label: 'Get videos',
        onClick: () => createNewThread(selectedText, false, false, 'videos'),
        colorScheme: getActionColorScheme('videos')
      },
      {
        action: 'examples',
        icon: <FileText className="w-3.5 h-3.5 text-white" />,
        label: 'Give examples',
        onClick: () => createNewThread(`Please provide 3-5 concrete, practical examples that illustrate or relate to: "${selectedText}". Make the examples diverse and easy to understand.`, false, true, 'examples'),
        colorScheme: getActionColorScheme('examples')
      },
      {
        action: 'simplify',
        icon: <Target className="w-3.5 h-3.5 text-white" />,
        label: 'Simplify this',
        onClick: () => createNewThread(`Please explain this in the simplest terms possible, as if you're teaching it to someone who is completely new to the topic: "${selectedText}"`, false, true, 'simplify'),
        colorScheme: getActionColorScheme('simplify')
      },
      {
        action: 'ask',
        icon: <MessageSquare className="w-3.5 h-3.5 text-white" />,
        label: 'Ask about this',
        onClick: () => createNewThread(selectedText, false, true, 'ask'),
        colorScheme: getActionColorScheme('ask')
      },
      {
        action: 'snippet',
        icon: <Scissors className="w-3.5 h-3.5 text-white" />,
        label: 'Save to Vault',
        onClick: () => saveSelectionAsSnippet(selectedText),
        colorScheme: getActionColorScheme('learning')
      }
    ];

    console.log('Rendering context menu at position:', contextMenuPosition); // Debug log
    
    return (
      <div 
        data-context-menu
        className="fixed bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl py-2 min-w-[240px]"
        style={{ 
          left: contextMenuPosition.x - 120, // Center horizontally (240px width / 2)
          top: contextMenuPosition.y - 140,  // Center vertically (approximate menu height / 2)
          transform: 'translateZ(0)', // Force hardware acceleration for smooth positioning
          pointerEvents: 'auto', // Ensure it can be clicked
          zIndex: 99999 // Ensure it's above everything else
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.preventDefault()} // Prevent text selection from being cleared
      >
        <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">
          Create new thread from selection
        </div>
        <div className="py-1">
          {menuItems.map((item) => (
            <button
              key={item.action}
              onClick={item.onClick}
              className={`w-full px-3 py-2 text-left text-sm font-medium transition-all duration-200 flex items-center gap-3 hover:scale-[1.02] ${item.colorScheme.bg}/20 hover:${item.colorScheme.bg}/30 border-l-4 ${item.colorScheme.border} mx-1 my-1 rounded-r-lg`}
            >
              <div className={`w-6 h-6 rounded-full ${item.colorScheme.bg} flex items-center justify-center text-xs`}>
                {item.icon}
              </div>
              <span className="text-white">{item.label}</span>
              <div className="ml-auto">
                <div className={`w-3 h-3 rounded-full ${item.colorScheme.bg} opacity-80`}></div>
              </div>
            </button>
          ))}
        </div>
        <div className="border-t border-zinc-800 mt-1 pt-1">
          <button
            onClick={() => setShowContextMenu(false)}
            className="w-full px-4 py-2 text-left hover:bg-zinc-800 text-sm text-zinc-500 font-medium transition-colors duration-200"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  };

  const [configuredModels, setConfiguredModels] = useState<Record<ModelSlot, string>>(getCachedModels());
  useEffect(() => onModelsChange(setConfiguredModels), []);
  const [configuredProviders, setConfiguredProviders] = useState<Set<ProviderId>>(getConfigured());
  useEffect(() => onConfiguredChange(setConfiguredProviders), []);
  const labelFor = (slot: ModelSlot, fallback: string) => configuredModels[slot]?.trim() || fallback;

  // Map each model button to the provider whose API key it requires.
  const providerForModel = (m: ModelProvider): ProviderId => {
    if (m === 'openai') return 'openai';
    if (m === 'grok') return 'grok';
    return 'anthropic'; // 'claude' (Opus) and 'anthropic' (Sonnet) both use the Anthropic key
  };

  const isModelReady = (m: ModelProvider) => {
    // Subscription modes bypass the per-provider API key requirement —
    // the local CLI (claude / codex) supplies auth from the user's plan.
    if ((m === 'claude' || m === 'anthropic') && anthropicAuthMode === 'subscription') return true;
    if (m === 'openai' && openaiAuthMode === 'subscription') return true;
    return configuredProviders.has(providerForModel(m));
  };

  const ModelSelector = () => (
    <div className="flex flex-wrap gap-2">
      {[
        { value: 'openai' as ModelProvider,    label: labelFor('openai', 'GPT-4o'),              color: 'green'  },
        { value: 'claude' as ModelProvider,    label: labelFor('claude', 'Claude Opus 4.7'),     color: 'blue'   },
        { value: 'anthropic' as ModelProvider, label: labelFor('anthropic', 'Claude Sonnet 4.6'),color: 'purple' },
        { value: 'grok' as ModelProvider,      label: labelFor('grok', 'Grok 4'),                color: 'orange' }
      ].map((model) => {
        const ready = isModelReady(model.value);
        const isActive = selectedModel === model.value;
        const activeClasses =
          model.color === 'green'  ? 'bg-emerald-500/20 text-emerald-500 border-emerald-500/50 shadow-lg' :
          model.color === 'blue'   ? 'bg-indigo-500/20 text-indigo-500 border-indigo-500/50 shadow-lg' :
          model.color === 'purple' ? 'bg-indigo-400/20 text-indigo-400 border-indigo-400/50 shadow-lg' :
                                     'bg-orange-500/20 text-orange-500 border-orange-500/50 shadow-lg';
        return (
          <button
            key={model.value}
            onClick={() => setSelectedModel(model.value)}
            disabled={!ready}
            title={ready ? `Use ${model.label}` : `${providerForModel(model.value)} key not configured — add it in the Models tab`}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 border backdrop-blur-sm flex items-center gap-2 ${
              isActive
                ? activeClasses
                : 'bg-zinc-900/60 text-zinc-500 hover:bg-zinc-800 hover:text-white border-zinc-800'
            } ${!ready ? 'opacity-50 cursor-not-allowed hover:bg-zinc-900/60 hover:text-zinc-500' : ''}`}
          >
            <span>{model.label}</span>
            {!ready && <span className="text-[10px] uppercase tracking-widest text-amber-400">(no key)</span>}
          </button>
        );
      })}
    </div>
  );

  const handleMainSubmit = (e: any) => {
    e.preventDefault();
    if (!mainChat.input.trim()) return;
    // Route through submitMainMessage so attachments are injected as context.
    submitMainMessage(mainChat.input.trim());
    // Clear the input after sending
    mainChat.setInput('');
  };

  const ChatInput = ({ isThread = false, onSubmit, input, handleInputChange, isLoading, threadChat, showReasoning, setShowReasoning }: any) => {
    const [localInput, setLocalInput] = useState('');

    // Accept externally-driven input (e.g. a seed prompt pushed in from Second
    // Brain via mainChat.setInput). Only mirror when the incoming value is
    // non-empty and differs — never clobber what the user is mid-typing.
    useEffect(() => {
      if (typeof input === 'string' && input.length > 0 && input !== localInput) {
        setLocalInput(input);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [input]);

    const handleSubmit = (e: any) => {
      e.preventDefault();
      if (!localInput.trim()) return;
      
      if (!isThread && mainChat) {
        // Main chat submission — inject any attached research sources as context.
        submitMainMessage(localInput.trim());
        mainChat.setInput?.('');
      } else if (isThread && threadChat) {
        // Thread chat submission - use the thread's chat instance
        threadChat.append({
          role: 'user',
          content: localInput.trim()
        });
        threadChat.setInput?.('');
      }
      setLocalInput('');
    };

    const handleStopGeneration = () => {
      if (!isThread && mainChat && mainChat.stop) {
        mainChat.stop();
      } else if (isThread && threadChat && threadChat.stop) {
        threadChat.stop();
      }
    };

    const handleButtonClick = (e: any) => {
      if (isLoading) {
        e.preventDefault();
        return;
      }
    };

    return (
      <div className="w-full space-y-2">
        {/* Grok Settings - Only show in main chat, not in threads */}
        {selectedModel === 'grok' && !isThread && (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            {/* Response Mode Buttons */}
            <div className="flex gap-2 flex-wrap">
              {['normal', 'fun', 'creative', 'precise'].map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setGrokMode(mode as 'normal' | 'fun' | 'creative' | 'precise')}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 border ${
                    grokMode === mode
                      ? 'bg-indigo-500/20 text-indigo-500 border-indigo-500/50'
                      : 'bg-zinc-900/40 text-zinc-500 hover:bg-zinc-800 hover:text-white border-zinc-800'
                  }`}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            
            {/* Think Mode Toggle */}
            <button
              type="button"
              onClick={() => setShowReasoning(!showReasoning)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-all duration-200 ${
                showReasoning 
                  ? 'bg-indigo-500/20 text-indigo-500 border border-indigo-500/50' 
                  : 'bg-zinc-900/40 text-zinc-500 border border-zinc-800 hover:bg-zinc-900/60'
              }`}
              title="Toggle reasoning mode (like grok.com Think Mode)"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              <span>{showReasoning ? 'Think Mode: ON' : 'Think Mode: OFF'}</span>
            </button>
          </div>
        )}

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="w-full flex gap-3">
          <input 
            type="text"
            value={localInput}
            onChange={(e) => setLocalInput(e.target.value)}
            className="flex-1 px-4 py-3 bg-white text-black border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 transition-all duration-200"
            placeholder={isThread ? "Ask about the selected context..." : "Type a message"}
            disabled={isLoading}
          />
          <button 
            type={isLoading ? "button" : "submit"}
            onClick={handleButtonClick}
            className={`w-12 h-12 rounded-lg flex items-center justify-center transition-all duration-200 ${
              isLoading 
                ? 'bg-orange-500/20 hover:bg-orange-500/30 border-orange-500/50 text-orange-500' 
                : localInput.trim() 
                  ? 'bg-indigo-500/20 hover:bg-indigo-500/30 border-indigo-500/50 text-indigo-500 hover:scale-105' 
                  : 'bg-zinc-900/40 border-zinc-800 text-zinc-500 cursor-not-allowed'
            } border backdrop-blur-sm`}
            disabled={isLoading || !localInput.trim()}
            title={isLoading ? "AI is thinking..." : "Send message"}
          >
            {isLoading ? (
              <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                <circle cx="12" cy="12" r="10" opacity="0.25"/>
                <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" fill="currentColor"/>
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z"/>
              </svg>
            )}
          </button>
        </form>

        {/* Status indicator */}
        {selectedModel === 'grok' && showReasoning && (
          <div className="text-xs text-indigo-500/70 text-center">
            Reasoning mode enabled — AI will show its thinking process.
          </div>
        )}
      </div>
    );
  };

  // Helper function to get action label based on action type
  const getActionLabel = (actionType?: string) => {
    switch (actionType) {
      case 'ask':
        return 'Ask about this';
      case 'details':
        return 'Get more details';
      case 'simplify':
        return 'Simplify this';
      case 'examples':
        return 'Give examples';
      case 'learning':
        return 'Add to learning';
      case 'links':
        return 'Get links';
      case 'videos':
        return 'Get videos';
      default:
        return 'Thread';
    }
  };

  // Helper function to get context source description
  const getContextSource = (thread: Thread) => {
    if (thread.sourceType === 'main') {
      return 'Context from main chat';
    } else if (thread.sourceType === 'thread' && thread.parentThreadId) {
      // Find the parent thread to get its number
      const parentThreadIndex = threads.findIndex(t => t.id === thread.parentThreadId);
      if (parentThreadIndex !== -1) {
        return `Context from thread ${parentThreadIndex + 1}`;
      }
    }
    return 'Context from main chat'; // Default fallback
  };

  // Helper function to get color scheme based on action type
  const getActionColorScheme = (actionType?: string) => {
    switch (actionType) {
      case 'ask':
        return {
          bg: 'bg-indigo-500',
          border: 'border-indigo-500',
          badgeText: 'text-white',
          badgeBg: 'bg-indigo-500',
          badgeBorder: 'border-indigo-500'
        };
      case 'details':
        return {
          bg: 'bg-emerald-500',
          border: 'border-emerald-500',
          badgeText: 'text-white',
          badgeBg: 'bg-emerald-500',
          badgeBorder: 'border-emerald-500'
        };
      case 'simplify':
        return {
          bg: 'bg-amber-400',
          border: 'border-amber-400',
          badgeText: 'text-black',
          badgeBg: 'bg-amber-400',
          badgeBorder: 'border-amber-400'
        };
      case 'examples':
        return {
          bg: 'bg-orange-500',
          border: 'border-orange-500',
          badgeText: 'text-white',
          badgeBg: 'bg-orange-500',
          badgeBorder: 'border-orange-500'
        };
      case 'learning':
        return {
          bg: 'bg-indigo-400',
          border: 'border-indigo-400',
          badgeText: 'text-white',
          badgeBg: 'bg-indigo-400',
          badgeBorder: 'border-indigo-400'
        };
      case 'links':
        return {
          bg: 'bg-red-500',
          border: 'border-red-500',
          badgeText: 'text-white',
          badgeBg: 'bg-red-500',
          badgeBorder: 'border-red-500'
        };
      case 'videos':
        return {
          bg: 'bg-indigo-400',
          border: 'border-indigo-400',
          badgeText: 'text-white',
          badgeBg: 'bg-indigo-400',
          badgeBorder: 'border-indigo-400'
        };
      default:
        return {
          bg: 'bg-zinc-800',
          border: 'border-zinc-800',
          badgeText: 'text-white',
          badgeBg: 'bg-zinc-800',
          badgeBorder: 'border-zinc-800'
        };
    }
  };

  // Utility function to convert URLs in text to clickable links
  const linkifyText = (text: string) => {
    // Regular expression to match URLs
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/g;
    
    const parts = text.split(urlRegex);
    
    return parts.map((part, index) => {
      if (urlRegex.test(part)) {
        // Ensure the URL has a protocol
        let href = part;
        if (!part.startsWith('http://') && !part.startsWith('https://')) {
          href = part.startsWith('www.') ? `https://${part}` : `https://${part}`;
        }
        
        return (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-400 hover:text-indigo-300 underline transition-colors duration-200"
            onClick={(e) => e.stopPropagation()} // Prevent text selection when clicking links
          >
            {part}
          </a>
        );
      }
      return part;
    });
  };

  const MessageContent = React.memo(({ message, isThread = false, threadId }: { message: any, isThread?: boolean, threadId?: string }) => {
    const isUser = message.role === 'user';
    
    const handleMouseUp = React.useCallback(() => {
      if (!isUser && !isMobileDevice) {
        handleTextSelection(message.id, isThread, threadId);
      }
    }, [message.id, isThread, threadId, isUser]);

    const handleTouchStartMessage = React.useCallback((e: React.TouchEvent) => {
      if (!isUser && isMobileDevice) {
        handleTouchStart(e.nativeEvent, message.id, isThread, threadId);
      }
    }, [message.id, isThread, threadId, isUser]);
    
    return (
      <div className={`flex ${isUser ? 'justify-start' : 'justify-end'}`}>
        <div
          className={`max-w-4xl px-4 py-3 rounded-lg border ${
            isUser
              ? 'bg-indigo-500/20 text-white border-indigo-500/30 backdrop-blur-sm'
              : 'bg-zinc-900/80 text-white cursor-text select-text border-zinc-800 backdrop-blur-sm'
          }`}
          onMouseUp={handleMouseUp}
          onTouchStart={handleTouchStartMessage}
          data-role={message.role}
        >
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {linkifyText(message.content)}
          </div>
          {!isUser && (
            <div className="mt-2 text-xs text-zinc-500 opacity-60">
              {isMobileDevice ? 'Double-tap and hold to select text and create a new thread' : 'Select text to create a new thread'}
            </div>
          )}
        </div>
      </div>
    );
  });
  MessageContent.displayName = 'MessageContent';

  const ThreadPanel = ({ thread, rowThreadCount }: { thread: Thread, rowThreadCount?: number }) => {
    // Get initial messages for this thread if available
    const initialMessages = threadMessagesToLoad[thread.id] || thread.messages || [];
    
    // Create a dedicated, isolated chat instance for this specific thread with initial messages
    const threadChat = useThreadChat(selectedModel, thread.id, initialMessages, grokMode, anthropicAuthMode, openaiAuthMode);
    
    // Store the thread chat instance reference for accessing messages during save
    React.useEffect(() => {
      threadChatRefs.current[thread.id] = threadChat;
      
      // Cleanup when thread is unmounted
      return () => {
        delete threadChatRefs.current[thread.id];
      };
    }, [thread.id, threadChat]);
    
    // Clear the messages from loading queue when thread is rendered with initial messages
    React.useEffect(() => {
      if (threadMessagesToLoad[thread.id] && threadMessagesToLoad[thread.id].length > 0) {
        console.log(`✅ Thread ${thread.id} initialized with ${threadMessagesToLoad[thread.id].length} messages`);
        
        // Clear the messages from the loading queue since they're now loaded via initialMessages
        setThreadMessagesToLoad(prev => {
          const updated = { ...prev };
          delete updated[thread.id];
          return updated;
        });
      }
    }, [thread.id]);
    
    // Thread automatically includes context with user messages when they ask questions
    
    // Handle auto-expansion for "Get more details"
    React.useEffect(() => {
      const handleAutoExpand = (event: any) => {
        if (event.detail.threadId === thread.id) {
          const followUpPrompt = `Please provide more details about: "${event.detail.context}"`;
          threadChat.append({
            role: 'user',
            content: followUpPrompt
          });
        }
      };

      window.addEventListener('autoExpandThread', handleAutoExpand);
      return () => window.removeEventListener('autoExpandThread', handleAutoExpand);
    }, [thread.id, threadChat]);
    
    // Handle auto-send for "Simplify this" and "Give examples"
    React.useEffect(() => {
      const handleAutoSend = (event: any) => {
        if (event.detail.threadId === thread.id) {
          console.log(`Auto-sending message to thread ${thread.id}:`, event.detail.message);
          threadChat.append({
            role: 'user',
            content: event.detail.message
          });
        }
      };

      window.addEventListener('autoSendToThread', handleAutoSend);
      return () => window.removeEventListener('autoSendToThread', handleAutoSend);
    }, [thread.id, threadChat]);
    


    // Calculate thread width based on expansion state and fullscreen mode
    const isExpanded = expandedThread === thread.id;
    const isCollapsed = expandedThread && expandedThread !== thread.id && expandedThread !== 'main';
    const isMainExpanded = expandedThread === 'main';
    const isFullscreen = fullscreenThread === thread.id;
    
    const threadPanelWidth = isFullscreen
      ? 'w-full' // Fullscreen thread takes entire thread area
      : isExpanded 
        ? 'flex-1' // Takes most of the thread area
        : isCollapsed 
          ? 'w-80' // Standard size when another thread is expanded
          : isMainExpanded
            ? 'w-80' // Standard size when main is expanded
            : 'flex-1'; // Equal share in balanced view
    
    // Get color scheme based on action type
    const colorScheme = getActionColorScheme(thread.actionType);
    
    return (
      <div 
        className={`${threadPanelWidth} bg-zinc-900/60 backdrop-blur border-l-2 border-indigo-500/40 border-r border-zinc-800 shadow-lg flex flex-col h-full transition-all duration-300 ${isCollapsed || isMainExpanded ? 'min-w-80' : ''} rounded-lg overflow-hidden`}
        data-thread-id={thread.id}
      >
        {/* Thread Header - Improved Readability */}
        <div className={`flex-shrink-0 ${compactThreadHeaders ? 'py-0 px-1' : 'py-0.5 px-1.5'} border-b-2 ${threadHeaderColorsEnabled ? colorScheme.border : 'border-zinc-800'} ${threadHeaderColorsEnabled ? colorScheme.bg : 'bg-zinc-900/80'} shadow-sm transition-all duration-200`}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {/* Thread number badge - always visible */}
              <div className={`${compactThreadHeaders ? 'text-sm font-bold text-white px-2 py-0.5' : `text-lg font-bold ${colorScheme.badgeText} ${colorScheme.badgeBg} px-3 py-1 rounded-lg border-2 ${colorScheme.badgeBorder} shadow-sm`} flex-shrink-0`}>
                #{threads.findIndex(t => t.id === thread.id) + 1}
              </div>
              
              {/* Action and source info - hide in compact mode */}
              {!compactThreadHeaders && (!rowThreadCount || rowThreadCount < 3) && (
                <div className={`flex items-center gap-2 bg-black/20 px-2 py-1 rounded-lg flex-shrink-0 ${isCollapsed ? 'max-w-32' : ''}`}>
                  <span className={`font-semibold text-white ${isCollapsed ? 'text-xs' : 'text-sm'} truncate`}>
                    {getActionLabel(thread.actionType)}
                  </span>
                  {!isCollapsed && (!rowThreadCount || rowThreadCount < 2) && (
                    <>
                      <span className="text-white/60 text-xs">•</span>
                      <span className="text-white/80 text-xs">{getContextSource(thread)}</span>
                    </>
                  )}
                </div>
              )}
              
              {/* Context dropdown - hide in compact mode */}
              {!compactThreadHeaders && thread.selectedContext && !isCollapsed && (!rowThreadCount || rowThreadCount < 4) && (
                <button
                  onClick={() => toggleContextCollapse(thread.id)}
                  className="flex items-center gap-2 bg-amber-400/20 text-amber-400 hover:bg-amber-400/30 px-3 py-1 rounded-lg border border-amber-400/30 transition-all text-sm font-medium flex-shrink-0"
                  title="Toggle context"
                >
                  <span>Context</span>
                  <svg 
                    className={`w-4 h-4 transition-transform duration-200 ${collapsedContexts.has(thread.id) ? 'rotate-180' : 'rotate-0'}`} 
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              )}
            </div>
            
            {/* Control buttons - always visible and prioritized */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => toggleThreadFullscreen(thread.id)}
                className={`${compactThreadHeaders ? 'p-1' : 'p-2'} rounded-lg hover:bg-zinc-800 transition-colors ${
                  fullscreenThread === thread.id ? 'bg-emerald-500/20 text-emerald-500' : 'text-zinc-400 hover:text-white'
                }`}
                title={fullscreenThread === thread.id ? 'Exit fullscreen' : 'Fullscreen thread'}
              >
                {fullscreenThread === thread.id
                  ? <Minimize2 className={compactThreadHeaders ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                  : <Maximize2 className={compactThreadHeaders ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
              </button>
              <button
                onClick={() => rerunThreadContext(thread)}
                className={`${compactThreadHeaders ? 'p-1' : 'p-2'} rounded-lg hover:bg-zinc-800 transition-colors text-zinc-400 hover:text-orange-500`}
                title={`Rerun original ${getActionLabel(thread.actionType)} action`}
              >
                <RotateCw className={compactThreadHeaders ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
              </button>
              <button
                onClick={() => toggleThreadExpansion(thread.id)}
                className={`${compactThreadHeaders ? 'p-1' : 'p-2'} rounded-lg hover:bg-zinc-800 transition-colors ${
                  isExpanded ? 'bg-indigo-500/20 text-indigo-500' : 'text-zinc-400 hover:text-white'
                }`}
                title={isExpanded ? 'Collapse thread' : 'Expand thread'}
              >
                {isExpanded
                  ? <ChevronLeft className={compactThreadHeaders ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                  : <ChevronRight className={compactThreadHeaders ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
              </button>
              <button
                onClick={() => closeThread(thread.id)}
                className={`text-zinc-400 hover:text-red-500 transition-colors p-1`}
                title="Close thread"
              >
                <X className={compactThreadHeaders ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
              </button>
            </div>
          </div>
          
          {/* Context content with better styling */}
          {thread.selectedContext && !collapsedContexts.has(thread.id) && (
            <div className="mt-3 bg-gradient-to-r from-amber-400/10 to-amber-400/5 border-l-4 border-amber-400/50 rounded-r-lg p-3">
              <div className="text-amber-400/90 italic text-sm leading-relaxed">
                &quot;{thread.selectedContext.length > 150 ? thread.selectedContext.substring(0, 150) + '...' : thread.selectedContext}&quot;
              </div>
            </div>
          )}
        </div>

        {/* Thread Messages */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-gradient-to-b from-transparent to-zinc-900/10 min-h-0">
          {/* Verified link/video results for 'links'/'videos' threads */}
          {thread.research && (
            <ResearchResultsPanel
              research={thread.research}
              onRetry={() => runThreadResearch(thread.id, thread.research!.kind, thread.selectedContext || thread.title || '')}
            />
          )}
          {!thread.research && threadChat.messages.length === 0 && (
            <div className="text-center text-zinc-500 text-sm py-8">
              <MessageSquare className="w-5 h-5 mx-auto mb-2 text-zinc-600" />
              <div className="text-white">Ask a question about the selected context above</div>
              <div className="text-xs text-emerald-500 mt-3 bg-emerald-500/10 px-3 py-2 rounded-lg border border-emerald-500/20">
                Context will be automatically included with your questions.
              </div>
            </div>
          )}
          {threadChat.messages.map((message) => (
            <MessageContent 
              key={message.id} 
              message={message} 
              isThread={true}
              threadId={thread.id}
            />
          ))}
        </div>

        {/* Thread Input */}
        <div 
          className={`flex-shrink-0 transition-all duration-300 ease-in-out border-t border-zinc-800 ${
            hideInputFields
              ? hoveredThreadId === thread.id
                ? 'p-3 bg-gradient-to-t from-zinc-900/40 to-transparent h-auto'
                : 'p-1 bg-gradient-to-t from-zinc-900/60 to-zinc-900/20 h-3'
              : 'p-3 bg-gradient-to-t from-zinc-900/40 to-transparent h-auto'
          }`}
        >
          {hideInputFields && hoveredThreadId !== thread.id ? (
            // Collapsed state - thin bar with visual indicator
            <div 
              className="flex items-center justify-center h-full cursor-pointer hover:bg-gradient-to-t hover:from-zinc-900/80 hover:to-zinc-900/40 transition-all duration-200"
              onMouseEnter={() => setHoveredThreadId(thread.id)}
              onMouseLeave={() => setHoveredThreadId(null)}
            >
              <div className="w-12 h-1 bg-orange-500/40 rounded-full transition-all duration-200 hover:bg-orange-500/60 hover:w-16"></div>
            </div>
          ) : (
            // Expanded state - full input area
            <div onMouseLeave={() => hideInputFields && setHoveredThreadId(null)}>
              <ChatInput
                isThread={true}
                input={threadChat.input}
                handleInputChange={threadChat.handleInputChange}
                isLoading={threadChat.isLoading}
                threadChat={threadChat}
                showReasoning={threadChat.showReasoning}
                setShowReasoning={threadChat.setShowReasoning}
              />
            </div>
          )}
        </div>
      </div>
    );
  };

  // Add toggle functions for expansion
  const toggleThreadExpansion = (threadId: string | 'main') => {
    if (expandedThread === threadId) {
      // If clicking the already expanded thread, collapse it to balanced view
      setExpandedThread(null);
    } else {
      // Expand the clicked thread
      setExpandedThread(threadId);
    }
  };

  // Toggle row collapse/expand
  const toggleRowCollapse = (rowIndex: number) => {
    setCollapsedRows(prev => {
      const newCollapsed = new Set(prev);
      if (newCollapsed.has(rowIndex)) {
        newCollapsed.delete(rowIndex);
      } else {
        newCollapsed.add(rowIndex);
      }
      return newCollapsed;
    });
  };

  // Toggle context collapse/expand
  const toggleContextCollapse = (threadId: string) => {
    setCollapsedContexts(prev => {
      const newCollapsed = new Set(prev);
      if (newCollapsed.has(threadId)) {
        newCollapsed.delete(threadId);
      } else {
        newCollapsed.add(threadId);
      }
      return newCollapsed;
    });
  };

  // Toggle all contexts visibility
  const toggleAllContextsVisibility = () => {
    setShowAllContexts(prev => {
      const newShowAll = !prev;
      if (newShowAll) {
        // Show all contexts - clear the collapsed set
        setCollapsedContexts(new Set());
      } else {
        // Hide all contexts - add all thread IDs to collapsed set
        const allThreadIds = threads.map(thread => thread.id);
        setCollapsedContexts(new Set(allThreadIds));
      }
      return newShowAll;
    });
  };

  // Toggle thread fullscreen mode
  const toggleThreadFullscreen = (threadId: string) => {
    setFullscreenThread(prev => prev === threadId ? null : threadId);
  };

  // Rerun the original context for a thread
  const rerunThreadContext = (thread: Thread) => {
    const threadChat = threadChatRefs.current[thread.id];
    if (!threadChat || !thread.selectedContext) return;

    let messageToSend = '';
    
    // Construct the message based on the original action type
    switch (thread.actionType) {
      case 'details':
        messageToSend = `Please provide more details about: "${thread.selectedContext}"`;
        break;
      case 'links':
        messageToSend = `Please provide relevant links and resources related to: "${thread.selectedContext}". Include authoritative sources, documentation, articles, and useful websites that would help someone learn more about this topic.`;
        break;
      case 'videos':
        messageToSend = `Please suggest relevant YouTube videos, tutorials, and video content related to: "${thread.selectedContext}". Include educational videos, tutorials, documentaries, and other video resources that would help understand this topic better.`;
        break;
      case 'examples':
        messageToSend = `Please provide 3-5 concrete, practical examples that illustrate or relate to: "${thread.selectedContext}". Make the examples diverse and easy to understand.`;
        break;
      case 'simplify':
        messageToSend = `Please explain this in the simplest terms possible, as if you're teaching it to someone who is completely new to the topic: "${thread.selectedContext}"`;
        break;
      case 'ask':
      default:
        messageToSend = thread.selectedContext;
        break;
    }

    // Send the message to the thread
    threadChat.append({
      role: 'user',
      content: messageToSend
    });
  };

  // Handle manual resize
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsResizing(true);
    setStartX(e.clientX);
    setStartWidth(manualMainWidth || 50); // Default to 50% if no manual width set
    e.preventDefault();
  };

  const handleMouseMove = React.useCallback((e: MouseEvent) => {
    if (!isResizing) return;
    
    const containerWidth = window.innerWidth;
    const deltaX = e.clientX - startX;
    const deltaPercent = (deltaX / containerWidth) * 100;
    const newWidth = Math.max(20, Math.min(80, startWidth + deltaPercent)); // Constrain between 20% and 80%
    
    setManualMainWidth(newWidth);
  }, [isResizing, startX, startWidth]);

  const handleMouseUp = React.useCallback(() => {
    setIsResizing(false);
  }, []);

  // Add global mouse event listeners for resize
  React.useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  // Calculate widths based on expansion state and manual resize
  const getLayoutWidths = () => {
    const hasThreads = threads.length > 0;
    if (!hasThreads) {
      return { mainWidth: 'w-full', threadWidth: 'w-0', mainWidthPercent: 100, threadWidthPercent: 0 };
    }

    // Split screen mode: equal 50/50 split
    if (isSplitScreenMode) {
      return { mainWidth: 'w-1/2', threadWidth: 'w-1/2', mainWidthPercent: 50, threadWidthPercent: 50 };
    }

    // If user has manually resized, use that width (unless thread is expanded)
    if (manualMainWidth !== null && !expandedThread) {
      const mainPercent = Math.round(manualMainWidth);
      const threadPercent = 100 - mainPercent;
      return { 
        mainWidth: `w-[${mainPercent}%]`, 
        threadWidth: `w-[${threadPercent}%]`,
        mainWidthPercent: mainPercent,
        threadWidthPercent: threadPercent
      };
    }

    if (expandedThread === 'main') {
      // Main expanded: main takes ~75%, threads share ~25%
      return { mainWidth: 'w-[75%]', threadWidth: 'w-[25%]', mainWidthPercent: 75, threadWidthPercent: 25 };
    } else if (expandedThread && expandedThread !== 'main') {
      // Specific thread expanded: main takes ~20%, expanded thread gets most of the remaining ~80%
      return { mainWidth: 'w-[20%]', threadWidth: 'w-[80%]', mainWidthPercent: 20, threadWidthPercent: 80 };
    } else {
      // Default view with threads: main takes minimal space (20%), threads get maximum space (80%)
      return { mainWidth: 'w-1/5', threadWidth: 'w-4/5', mainWidthPercent: 20, threadWidthPercent: 80 };
    }
  };

    const { mainWidth, threadWidth, mainWidthPercent, threadWidthPercent } = getLayoutWidths();
  
  // Organize threads into rows
  const getThreadRows = () => {
    const rows: Thread[][] = [];
    const sortedThreads = [...threads].sort((a, b) => (a.rowId || 0) - (b.rowId || 0));
    
    sortedThreads.forEach(thread => {
      const rowId = thread.rowId || 0;
      if (!rows[rowId]) {
        rows[rowId] = [];
      }
      rows[rowId].push(thread);
    });
    
    return rows.filter(row => row.length > 0); // Remove empty rows
  };

  // Expanded view - full thread panels with collapse button
  const expandRow = (rowIndex: number) => {
    // Get all row indices except the current one
    const allRowIndices = getThreadRows().map((_, index) => index);
    const otherRowIndices = allRowIndices.filter(index => index !== rowIndex);
    
    // Collapse all other rows and expand the current one
    setCollapsedRows(new Set(otherRowIndices));
  };

  const closeRow = (rowThreads: Thread[]) => {
    // Get all thread IDs from the threads passed to this row
    const threadIds = rowThreads.map(t => t.id);
    
    // Close each thread in the row
    threadIds.forEach(threadId => {
      closeThread(threadId);
    });
  };

  // ThreadRow component to handle a single row of threads
  const ThreadRow = ({ threads: rowThreads, rowIndex }: { threads: Thread[], rowIndex: number }) => {
    const isCollapsed = collapsedRows.has(rowIndex);
    const hasFullscreenInThisRow = rowThreads.some(thread => thread.id === fullscreenThread);
    
    if (isCollapsed) {
      // Collapsed view - thin horizontal bar with color indicators and context previews
      return (
        <div className="flex-shrink-0 h-16 bg-zinc-900/40 border border-zinc-800 rounded-lg transition-all duration-300">
          <div className="flex items-center justify-between h-full px-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => toggleRowCollapse(rowIndex)}
                className="text-indigo-500 hover:text-indigo-500/80 transition-colors"
                title="Expand row"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </button>
              <div className="text-sm text-white font-medium">
                Row {rowIndex + 1}
              </div>
              <div className="flex items-center gap-2">
                {rowThreads.map((thread, idx) => {
                  const colorScheme = getActionColorScheme(thread.actionType);
                  const contextPreview = thread.selectedContext 
                    ? thread.selectedContext.substring(0, 30) + (thread.selectedContext.length > 30 ? '...' : '')
                    : 'No context';
                  
                  return (
                    <div key={thread.id} className="flex items-center gap-1">
                      <div className={`px-2 py-1 rounded-lg ${colorScheme.bg} border ${colorScheme.border} flex items-center gap-1`}>
                        <span className="text-xs text-white font-medium">
                          #{threads.findIndex(t => t.id === thread.id) + 1}
                        </span>
                        <span className="text-xs text-white/80 max-w-24 truncate">
                          {contextPreview}
                        </span>
                      </div>
                      {idx < rowThreads.length - 1 && <span className="text-zinc-500">•</span>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="text-xs text-zinc-500">
              {rowThreads.length} thread{rowThreads.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
      );
    }

    // Expanded view - full thread panels with collapse button
    return (
      <div className="h-full flex flex-col relative">
        {/* Row header with collapse button */}
        <div className="flex-shrink-0 flex items-center justify-between p-2 bg-zinc-900/30 backdrop-blur-sm rounded-t-lg border border-zinc-800 mb-2">
          <div className="flex items-center gap-2">
            <button
              onClick={() => toggleRowCollapse(rowIndex)}
              className="text-indigo-500 hover:text-indigo-500/80 transition-colors"
              title="Collapse row"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
            </button>
            <button
              onClick={() => expandRow(rowIndex)}
              className="text-emerald-500 hover:text-emerald-500/80 transition-colors"
              title="Expand this row and collapse others"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            </button>
            <button
              onClick={() => expandAllRows()}
              className="text-amber-400 hover:text-amber-400/80 transition-colors"
              title="Expand all rows"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4H6a2 2 0 00-2 2v2M8 4V2a2 2 0 012 2v2M8 4h2m0 0V2a2 2 0 012 2v2m0 0h2a2 2 0 002-2V4M8 20H6a2 2 0 01-2-2v-2M8 20v2a2 2 0 01-2-2v-2M8 20h2m0 0v2a2 2 0 002 2v2m0 0h2a2 2 0 002-2v-2M16 4v2M16 20v-2M4 16h2M20 16h-2" />
              </svg>
            </button>
            <span className="text-xs text-white font-medium">
              Row {rowIndex + 1}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-xs text-zinc-500">
              {rowThreads.length} thread{rowThreads.length !== 1 ? 's' : ''}
            </div>
            <button
              onClick={() => closeRow(rowThreads)}
              className="text-zinc-400 hover:text-red-500 transition-colors"
              title="Close all threads in this row"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {/* Thread panels container */}
        <div className={`flex-1 flex gap-2 min-h-0 ${hasFullscreenInThisRow ? 'overflow-visible' : 'overflow-hidden'}`}>
          {rowThreads
            .filter(thread => {
              // If any thread in this row is fullscreen, only show that thread
              const hasFullscreenInRow = rowThreads.some(t => fullscreenThread === t.id);
              return hasFullscreenInRow ? fullscreenThread === thread.id : true;
            })
            .map((thread) => (
              <ThreadPanel key={thread.id} thread={thread} rowThreadCount={rowThreads.length} />
            ))}
        </div>
      </div>
    );
  };

  const threadRows = getThreadRows();
  const hasActiveThreads = threads.length > 0;

  // Resizer component
  const Resizer = () => {
    if (!hasActiveThreads || isSplitScreenMode) return null;
    
    return (
      <div
        className={`w-2 bg-indigo-500/20 hover:bg-indigo-500/40 cursor-col-resize transition-colors duration-200 relative group border-l border-r border-indigo-500/30 ${
          isResizing ? 'bg-indigo-500/60' : ''
        }`}
        onMouseDown={handleMouseDown}
      >
        {/* Visual indicator */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-0.5 h-12 bg-indigo-500/60 group-hover:bg-indigo-500 transition-colors duration-200 rounded-full"></div>
        </div>
        {/* Hover area for easier grabbing */}
        <div className="absolute -left-2 -right-2 inset-y-0"></div>
      </div>
    );
  };

  // Add touch event listeners for mobile
  useEffect(() => {
    if (!isMobileDevice) return;

    const handleGlobalTouchMove = (e: TouchEvent) => {
      handleTouchMove(e);
    };

    const handleGlobalTouchEnd = (e: TouchEvent) => {
      handleTouchEnd();
    };

    document.addEventListener('touchmove', handleGlobalTouchMove, { passive: false });
    document.addEventListener('touchend', handleGlobalTouchEnd);

    return () => {
      document.removeEventListener('touchmove', handleGlobalTouchMove);
      document.removeEventListener('touchend', handleGlobalTouchEnd);
    };
  }, [isMobileDevice, handleTouchMove, handleTouchEnd]);

  return (
    <div 
      className="h-full p-4" 
      onClick={(e) => {
        // Only close context menu if clicking outside of it and the preview window
        if (!showContextMenu) return;
        const target = e.target as HTMLElement;
        if (!target.closest('[data-context-menu]') && !target.closest('[data-context-preview]') && !target.closest('[data-mobile-selection]')) {
          setShowContextMenu(false);
          if (isMobileDevice) {
            cancelMobileSelection();
          }
        }
      }}
      style={{
        // Preserve text selection styling
        userSelect: showContextMenu ? 'none' : 'auto'
      }}
    >
      <div className={`mx-auto h-full ${hasActiveThreads ? 'max-w-none w-full' : 'max-w-4xl'} bg-zinc-900/50 backdrop-blur-sm rounded-xl border border-zinc-800/50 shadow-2xl overflow-hidden flex`}>
        {/* Main chat area - dynamic width based on expansion state */}
        <div className={`${hasActiveThreads ? mainWidth : 'w-full'} flex flex-col transition-all duration-300 ${hasActiveThreads ? 'border-r-2 border-indigo-500/30 shadow-lg' : 'border-r border-transparent'} ${!hasActiveThreads ? 'rounded-xl' : 'rounded-l-xl'}`}>
          {/* Header with model selector */}
          <div className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm p-4">
            <div className="mx-auto max-w-full px-4">
              {hasActiveThreads && (
                <div className="flex items-center justify-end gap-2 mb-4">
                  <button
                    onClick={() => setIsSplitScreenMode(!isSplitScreenMode)}
                    className={`p-2 rounded-lg hover:bg-zinc-800 transition-colors ${
                      isSplitScreenMode ? 'bg-emerald-500/20 text-emerald-500' : 'text-zinc-400 hover:text-white'
                    }`}
                    title={isSplitScreenMode ? 'Exit split screen mode' : 'Enter split screen mode (50/50)'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 4v16m6-16v16M4 12h16" />
                    </svg>
                  </button>
                  {!isSplitScreenMode && (
                    <button
                      onClick={() => toggleThreadExpansion('main')}
                      className={`p-2 rounded-lg hover:bg-zinc-800 transition-colors ${
                        expandedThread === 'main' ? 'bg-indigo-500/20 text-indigo-500' : 'text-zinc-400 hover:text-white'
                      }`}
                      title={expandedThread === 'main' ? 'Collapse main chat' : 'Expand main chat'}
                    >
                      {expandedThread === 'main' ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                    </button>
                  )}
                  {!isSplitScreenMode && manualMainWidth !== null && (
                    <button
                      onClick={() => setManualMainWidth(null)}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-orange-500/20 text-orange-500 hover:bg-orange-500/30 rounded-lg transition-colors"
                      title="Reset to automatic sizing"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Reset</span>
                    </button>
                  )}
                </div>
              )}
              
              {/* DeepDive Header */}
              <div className="text-center mb-4 -mt-2">
                <h1 className="text-5xl font-bold text-white tracking-wide">DeepDive</h1>
              </div>
              
                              <ModelSelector />
                {hasActiveThreads && (
                <div className="mt-2 text-sm text-zinc-500 flex items-center justify-center gap-2">
                  <Lightbulb className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Select text in any AI response to create contextual threads — drill deeper into topics.</span>
                </div>
              )}
            </div>
          </div>

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto bg-gradient-to-b from-transparent to-zinc-900/20">
            {mainChat.messages.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <div className="flex items-center justify-center mb-4">
                    <div className="w-20 h-20 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                      <MessageSquare className="w-8 h-8 text-indigo-500" />
                    </div>
                  </div>
                  <h2 className="text-xl font-semibold text-white mb-2">Start a conversation</h2>
                  <p className="text-zinc-500 mb-4">Type a message below to begin chatting with AI</p>
                  <div className="text-sm text-zinc-400 max-w-md bg-zinc-900/40 p-4 rounded-lg border border-zinc-800">
                    <strong className="text-indigo-500">Pro tip:</strong> After getting an AI response, you can select any part of the text and create a new threaded conversation about that specific context!
                  </div>
                </div>
              </div>
            ) : (
              <div className="mx-auto space-y-4 max-w-full p-4">
                {mainChat.messages.map((message) => (
                  <MessageContent key={message.id} message={message} />
                ))}
                {mainChat.isLoading && (
                  <div className="flex justify-start">
                    <div className="bg-zinc-900/80 backdrop-blur-sm p-4 rounded-lg max-w-xs border border-zinc-800">
                      <div className="flex space-x-1">
                        <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce"></div>
                        <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                        <div className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          
          {/* Chat Input */}
          <div className="border-t border-zinc-800 bg-zinc-900/60 backdrop-blur-sm p-6">
            {mainChat.error && (
              <div className="mx-auto max-w-full mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-xs flex items-start gap-2">
                <span className="font-bold uppercase tracking-widest text-[10px] mt-0.5">Error</span>
                <span className="flex-1">{mainChat.error.message || 'Chat request failed.'}</span>
              </div>
            )}
            {/* Research attachments bar */}
            <div className="mx-auto max-w-full mb-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setShowUrlInput(v => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                  title="Attach a web link as research context"
                >
                  <Link2 className="w-3.5 h-3.5" /> Attach link
                </button>
                <button
                  type="button"
                  onClick={handlePickFiles}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                  title="Attach a document, spreadsheet, PDF, or code file as research context"
                >
                  <Paperclip className="w-3.5 h-3.5" /> Attach file
                </button>
                <span className="text-[10px] text-zinc-600">
                  Links are fetched & added as context for any selected model.
                </span>
              </div>

              {showUrlInput && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = urlInputValue.trim();
                    if (!v) return;
                    addUrlAttachment(v.startsWith('http') ? v : `https://${v}`);
                    setUrlInputValue('');
                    setShowUrlInput(false);
                  }}
                >
                  <input
                    type="text"
                    autoFocus
                    value={urlInputValue}
                    onChange={(e) => setUrlInputValue(e.target.value)}
                    placeholder="https://example.com/article"
                    className="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <button type="submit" className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg transition-colors">
                    Add
                  </button>
                  <button type="button" onClick={() => { setShowUrlInput(false); setUrlInputValue(''); }} className="px-2 py-2 text-zinc-500 hover:text-white transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </form>
              )}

              {attachments.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  {attachments.map(att => (
                    <div
                      key={att.id}
                      className={`group flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-lg border text-xs max-w-[260px] ${
                        att.status === 'error'
                          ? 'border-red-500/40 bg-red-500/10 text-red-300'
                          : att.status === 'ready'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                            : 'border-zinc-700 bg-zinc-800/60 text-zinc-300'
                      }`}
                      title={att.status === 'error' ? att.error : att.source}
                    >
                      {att.status === 'extracting'
                        ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                        : att.kind === 'url'
                          ? <Globe className="w-3.5 h-3.5 shrink-0" />
                          : <FileText className="w-3.5 h-3.5 shrink-0" />}
                      <span className="truncate font-medium">{att.label}</span>
                      {att.status === 'ready' && att.charCount != null && (
                        <span className="text-[10px] opacity-70 shrink-0">
                          {(att.charCount / 1000).toFixed(att.charCount >= 1000 ? 0 : 1)}k{att.truncated ? '+' : ''}
                        </span>
                      )}
                      {att.status === 'error' && <span className="text-[10px] opacity-80 shrink-0">failed</span>}
                      <button
                        type="button"
                        onClick={() => removeAttachment(att.id)}
                        className="p-0.5 rounded hover:bg-black/30 text-current opacity-60 hover:opacity-100 transition-opacity shrink-0"
                        title="Remove attachment"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mx-auto max-w-full">
              <ChatInput
                onSubmit={handleMainSubmit}
                input={mainChat.input}
                handleInputChange={mainChat.handleInputChange}
                isLoading={mainChat.isLoading}
                threadChat={mainChat}
                showReasoning={mainShowReasoning}
                setShowReasoning={setMainShowReasoning}
              />
            </div>
          </div>
        </div>

        {/* Resizer handle */}
        <Resizer />

        {/* Thread Container */}
        {hasActiveThreads && (
          <div className={`${threadWidth} bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-900 overflow-hidden flex flex-col transition-all duration-300 rounded-r-xl`}>
            {/* Thread Header */}
            <div className="flex-shrink-0 bg-zinc-900/40 backdrop-blur-sm border-b border-zinc-800">
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-white">Threads</h2>
                  <div className="flex items-center gap-3">
                    {/* 1. Compact Thread Headers Toggle */}
                    <button
                      onClick={() => setCompactThreadHeaders(!compactThreadHeaders)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all duration-200 ${
                        compactThreadHeaders 
                          ? 'bg-emerald-500/20 text-emerald-500 border-emerald-500/50 hover:bg-emerald-500/30' 
                          : 'bg-zinc-900/60 text-zinc-500 border-zinc-800 hover:bg-zinc-800 hover:text-white'
                      }`}
                      title={compactThreadHeaders ? 'Disable compact thread headers' : 'Enable compact thread headers'}
                    >
                      {compactThreadHeaders ? <ChevronsUp className="w-3.5 h-3.5" /> : <ChevronsDown className="w-3.5 h-3.5" />}
                      <div className={`w-8 h-4 rounded-full transition-all duration-200 ${
                        compactThreadHeaders ? 'bg-emerald-500' : 'bg-zinc-700'
                      }`}>
                        <div className={`w-3 h-3 bg-white rounded-full mt-0.5 transition-transform duration-200 ${
                          compactThreadHeaders ? 'translate-x-4' : 'translate-x-0.5'
                        }`}></div>
                      </div>
                    </button>

                    {/* 2. Thread Header Color Toggle */}
                    <button
                      onClick={() => setThreadHeaderColorsEnabled(!threadHeaderColorsEnabled)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all duration-200 ${
                        threadHeaderColorsEnabled 
                          ? 'bg-indigo-400/20 text-indigo-400 border-indigo-400/50 hover:bg-indigo-400/30' 
                          : 'bg-zinc-900/60 text-zinc-500 border-zinc-800 hover:bg-zinc-800 hover:text-white'
                      }`}
                      title={threadHeaderColorsEnabled ? 'Disable thread header colors' : 'Enable thread header colors'}
                    >
                      <Palette className="w-3.5 h-3.5" />
                      <div className={`w-8 h-4 rounded-full transition-all duration-200 ${
                        threadHeaderColorsEnabled ? 'bg-indigo-400' : 'bg-zinc-700'
                      }`}>
                        <div className={`w-3 h-3 bg-white rounded-full mt-0.5 transition-transform duration-200 ${
                          threadHeaderColorsEnabled ? 'translate-x-4' : 'translate-x-0.5'
                        }`}></div>
                      </div>
                    </button>

                    {/* 3. Hide Input Fields Toggle */}
                    <button
                      onClick={() => setHideInputFields(!hideInputFields)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all duration-200 ${
                        hideInputFields 
                          ? 'bg-orange-500/20 text-orange-500 border-orange-500/50 hover:bg-orange-500/30' 
                          : 'bg-zinc-900/60 text-zinc-500 border-zinc-800 hover:bg-zinc-800 hover:text-white'
                      }`}
                      title={hideInputFields ? 'Show input fields by default' : 'Hide input fields (show on hover)'}
                    >
                      {hideInputFields ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      <div className={`w-8 h-4 rounded-full transition-all duration-200 ${
                        hideInputFields ? 'bg-orange-500' : 'bg-zinc-700'
                      }`}>
                        <div className={`w-3 h-3 bg-white rounded-full mt-0.5 transition-transform duration-200 ${
                          hideInputFields ? 'translate-x-4' : 'translate-x-0.5'
                        }`}></div>
                      </div>
                    </button>

                    {/* 4. Context Visibility Toggle */}
                    <button
                      onClick={toggleAllContextsVisibility}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all duration-200 ${
                        showAllContexts 
                          ? 'bg-indigo-500/20 text-indigo-500 border-indigo-500/50 hover:bg-indigo-500/30' 
                          : 'bg-zinc-900/60 text-zinc-500 border-zinc-800 hover:bg-zinc-800 hover:text-white'
                      }`}
                      title={showAllContexts ? 'Hide all thread contexts' : 'Show all thread contexts'}
                    >
                      {showAllContexts ? <ClipboardList className="w-3.5 h-3.5" /> : <FileX2 className="w-3.5 h-3.5" />}
                      <div className={`w-8 h-4 rounded-full transition-all duration-200 ${
                        showAllContexts ? 'bg-indigo-500' : 'bg-zinc-700'
                      }`}>
                        <div className={`w-3 h-3 bg-white rounded-full mt-0.5 transition-transform duration-200 ${
                          showAllContexts ? 'translate-x-4' : 'translate-x-0.5'
                        }`}></div>
                      </div>
                    </button>

                    {/* 5. Learning Snippets Toggle - Far Right */}
                    <button
                      onClick={() => setShowLearningModal(!showLearningModal)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all duration-200 ${
                        learningSnippets.length > 0
                          ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/50 hover:bg-indigo-500/30' 
                          : 'bg-zinc-900/60 text-zinc-500 border-zinc-800 hover:bg-zinc-800 hover:text-white'
                      }`}
                      title={`Learning snippets (${learningSnippets.length})`}
                    >
                      <Brain className="w-3.5 h-3.5" />
                      <span className="text-xs font-medium">{learningSnippets.length}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Thread Rows Container */}
            <div className="flex-1 overflow-hidden p-2">
              <div className="h-full flex flex-col gap-2">
                {threadRows
                  .map((rowThreads, originalRowIndex) => ({ rowThreads, originalRowIndex }))
                  .filter(({ rowThreads, originalRowIndex }) => {
                    // If any thread is fullscreen, only show the row containing that thread
                    if (fullscreenThread) {
                      return rowThreads.some(thread => thread.id === fullscreenThread);
                    }
                    return true;
                  })
                  .map(({ rowThreads, originalRowIndex }) => {
                    const isCollapsed = collapsedRows.has(originalRowIndex);
                    const hasFullscreenInThisRow = rowThreads.some(thread => thread.id === fullscreenThread);
                    
                    // Special handling for fullscreen threads
                    if (hasFullscreenInThisRow && fullscreenThread) {
                      return (
                        <div key={originalRowIndex} className="h-full">
                          <ThreadRow threads={rowThreads} rowIndex={originalRowIndex} />
                        </div>
                      );
                    }
                    
                    // Normal height calculation for non-fullscreen threads
                    const visibleRows = threadRows.filter((_, idx) => {
                      if (fullscreenThread) {
                        return threadRows[idx].some(thread => thread.id === fullscreenThread);
                      }
                      return true;
                    });
                    const expandedRowsCount = visibleRows.length - collapsedRows.size;
                    const heightClass = isCollapsed 
                      ? "flex-shrink-0" 
                      : expandedRowsCount > 0 
                        ? `flex-1 min-h-0` 
                        : "flex-1";
                    
                    return (
                      <div key={originalRowIndex} className={heightClass}>
                        <ThreadRow threads={rowThreads} rowIndex={originalRowIndex} />
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mobile Selection Interface */}
      {isMobileDevice && showMobileSelectionHandles && mobileSelection.isActive && (
        <div 
          data-mobile-selection
          className="fixed inset-0 z-[99998] pointer-events-none"
        >
          {/* Selection Adjustment UI */}
          <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl p-4 pointer-events-auto">
            <div className="text-center mb-3">
              <div className="text-sm text-white font-semibold mb-1">Selected Text</div>
              <div className="text-xs text-zinc-300 max-w-sm overflow-hidden">
                &quot;{mobileSelection.text.length > 100 ? mobileSelection.text.substring(0, 100) + '...' : mobileSelection.text}&quot;
              </div>
            </div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={commitMobileSelection}
                className="px-4 py-2 bg-indigo-500 text-white rounded-lg text-sm font-medium hover:bg-indigo-500/80 transition-colors"
                disabled={mobileSelection.text.length < 10}
              >
                Create Thread
              </button>
              <button
                onClick={cancelMobileSelection}
                className="px-4 py-2 bg-zinc-700 text-white rounded-lg text-sm font-medium hover:bg-zinc-500 transition-colors"
              >
                Cancel
              </button>
            </div>
            {mobileSelection.text.length < 10 && (
              <div className="mt-2 text-xs text-amber-400 text-center">
                Selection too short. Please select at least 10 characters.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Context Preview Window - Shows selected text */}
      {showContextMenu && (
        <div 
          data-context-preview
          className="fixed bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl min-w-[300px] max-w-[500px] z-[100000]"
          style={{ 
            left: '50%',
            top: isMobileDevice ? '20%' : '30%', // Position higher on mobile to avoid keyboard
            transform: 'translate(-50%, -50%)', // Center both horizontally and vertically
            pointerEvents: 'auto' // Ensure it can be clicked
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()} // Prevent text selection from being cleared
        >
          <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">
            Selected Context
          </div>
          <div className="py-2 px-3 max-h-32 overflow-y-auto">
            <div className="text-sm text-white leading-relaxed">
              &quot;{selectedText}&quot;
            </div>
          </div>
          <div className="px-3 py-2 text-xs text-zinc-500 text-center border-t border-zinc-800">
            Choose an action below to create a thread with this context
          </div>
        </div>
      )}

      {/* Context Menu - Always rendered at screen center when active */}
      {showContextMenu && (
        <div 
          data-context-menu
          className="fixed bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl py-2 min-w-[240px] z-[99999]"
          style={{ 
            left: '50%',
            top: isMobileDevice ? '50%' : '60%', // Position higher on mobile to avoid keyboard
            transform: 'translate(-50%, -50%)', // Center both horizontally and vertically
            pointerEvents: 'auto' // Ensure it can be clicked
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()} // Prevent text selection from being cleared
        >
          <div className="px-3 py-2 text-xs text-zinc-500 border-b border-zinc-800">
            Create new thread from selection
          </div>
          <div className="py-1">
            {[
              {
                action: 'ask',
                icon: <MessageSquare className="w-3.5 h-3.5 text-white" />,
                label: 'Ask about this',
                onClick: () => createNewThread(selectedText, false, true, 'ask'),
                colorScheme: getActionColorScheme('ask')
              },
              {
                action: 'details',
                icon: <Search className="w-3.5 h-3.5 text-white" />,
                label: 'Get more details',
                onClick: () => createNewThread(selectedText, true, false, 'details'),
                colorScheme: getActionColorScheme('details')
              },
              {
                action: 'simplify',
                icon: <Target className="w-3.5 h-3.5 text-white" />,
                label: 'Simplify this',
                onClick: () => createNewThread(`Please explain this in the simplest terms possible, as if you're teaching it to someone who is completely new to the topic: &quot;${selectedText}&quot;`, false, true, 'simplify'),
                colorScheme: getActionColorScheme('simplify')
              },
              {
                action: 'examples',
                icon: <FileText className="w-3.5 h-3.5 text-white" />,
                label: 'Give examples',
                onClick: () => createNewThread(`Please provide 3-5 concrete, practical examples that illustrate or relate to: &quot;${selectedText}&quot;. Make the examples diverse and easy to understand.`, false, true, 'examples'),
                colorScheme: getActionColorScheme('examples')
              },
              {
                action: 'links',
                icon: <Link2 className="w-3.5 h-3.5 text-white" />,
                label: 'Get links',
                onClick: () => createNewThread(`Please provide relevant links and resources related to: "${selectedText}". Include authoritative sources, documentation, articles, and useful websites that would help someone learn more about this topic.`, false, true, 'links'),
                colorScheme: getActionColorScheme('links')
              },
              {
                action: 'videos',
                icon: <Video className="w-3.5 h-3.5 text-white" />,
                label: 'Get videos',
                onClick: () => createNewThread(`Please suggest relevant YouTube videos, tutorials, and video content related to: "${selectedText}". Include educational videos, tutorials, documentaries, and other video resources that would help understand this topic better.`, false, true, 'videos'),
                colorScheme: getActionColorScheme('videos')
              },
              {
                action: 'learning',
                icon: <Brain className="w-3.5 h-3.5 text-white" />,
                label: 'Include in Learning Tools',
                onClick: () => addToLearningSnippets(selectedText),
                colorScheme: getActionColorScheme('learning')
              },
              {
                action: 'snippet',
                icon: <Scissors className="w-3.5 h-3.5 text-white" />,
                label: 'Save to Vault',
                onClick: () => saveSelectionAsSnippet(selectedText),
                colorScheme: getActionColorScheme('learning')
              }
            ].map((item) => (
              <button
                key={item.action}
                onClick={item.onClick}
                onTouchStart={(e) => e.stopPropagation()} // Ensure touch events work on mobile
                className={`w-full px-3 py-2 text-left text-sm font-medium transition-all duration-200 flex items-center gap-3 hover:scale-[1.02] ${item.colorScheme.bg}/20 hover:${item.colorScheme.bg}/30 border-l-4 ${item.colorScheme.border} mx-1 my-1 rounded-r-lg ${isMobileDevice ? 'py-3' : ''}`}
              >
                <div className={`w-6 h-6 rounded-full ${item.colorScheme.bg} flex items-center justify-center text-xs`}>
                  {item.icon}
                </div>
                <span className="text-white">{item.label}</span>
                <div className="ml-auto">
                  <div className={`w-3 h-3 rounded-full ${item.colorScheme.bg} opacity-80`}></div>
                </div>
              </button>
            ))}
          </div>
          <div className="border-t border-zinc-800 mt-1 pt-1">
            <button
              onClick={() => setShowContextMenu(false)}
              className="w-full px-4 py-2 text-left hover:bg-zinc-800 text-sm text-zinc-500 font-medium transition-colors duration-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      
      {/* Learning Snippets Modal */}
      {showLearningModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100001]" onClick={() => setShowLearningModal(false)}>
          <div 
            className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl max-w-4xl max-h-[80vh] w-full mx-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-6 border-b border-zinc-800">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-indigo-500 rounded-full flex items-center justify-center">
                  <Brain className="w-4 h-4 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-white">Learning Snippets</h2>
                  <p className="text-sm text-zinc-400">
                    {learningSnippets.length} snippet{learningSnippets.length !== 1 ? 's' : ''} collected for enhanced learning tool generation
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {learningSnippets.length > 0 && (
                  <button
                    onClick={clearLearningSnippets}
                    className="px-3 py-1.5 text-sm bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors"
                  >
                    Clear All
                  </button>
                )}
                <button
                  onClick={() => setShowLearningModal(false)}
                  className="text-zinc-400 hover:text-white transition-colors p-1"
                  title="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {learningSnippets.length === 0 ? (
                <div className="text-center py-12">
                  <div className="flex items-center justify-center mb-4">
                    <div className="w-20 h-20 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
                      <Brain className="w-8 h-8 text-indigo-500" />
                    </div>
                  </div>
                  <h3 className="text-xl font-semibold text-white mb-2">No Learning Snippets Yet</h3>
                  <p className="text-zinc-400 mb-4">
                    Select text in AI responses and choose &quot;Include in Learning Tools&quot; to build your learning collection.
                  </p>
                  <div className="flex items-start gap-2 text-sm text-indigo-400 bg-indigo-500/10 p-4 rounded-lg border border-indigo-500/20 max-w-md mx-auto text-left">
                    <Lightbulb className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
                    <span><strong>Pro tip:</strong> These snippets will be automatically included when generating learning tools to provide more comprehensive and personalized results.</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {learningSnippets.map((snippet, index) => (
                    <div
                      key={snippet.id}
                      className="bg-zinc-800/50 border border-zinc-800 rounded-lg p-4 hover:bg-zinc-800/70 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="text-xs font-medium text-indigo-400 bg-indigo-500/20 px-2 py-1 rounded">
                              #{index + 1}
                            </span>
                            <span className="text-xs text-zinc-400">{snippet.source}</span>
                            <span className="text-xs text-zinc-500">
                              {new Date(snippet.timestamp).toLocaleString()}
                            </span>
                          </div>
                          <div className="text-sm text-white leading-relaxed">
                            &quot;{snippet.text}&quot;
                          </div>
                        </div>
                        <button
                          onClick={() => removeLearningSnippet(snippet.id)}
                          className="text-zinc-400 hover:text-red-400 transition-colors p-1 flex-shrink-0"
                          title="Remove snippet"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            {learningSnippets.length > 0 && (
              <div className="border-t border-zinc-800 p-6">
                <div className="text-center">
                  <div className="text-sm text-zinc-400 mb-2">
                    These snippets will be automatically included in your next learning tool generation
                  </div>
                  <div className="text-xs text-indigo-400">
                    Navigate to <strong>/learn</strong> and generate learning tools to see these snippets in action
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

ThreadedChat.displayName = 'ThreadedChat';

export default ThreadedChat; 