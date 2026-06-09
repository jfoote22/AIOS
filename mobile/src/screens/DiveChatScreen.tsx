import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { Dives, type ChatMessage } from '../api/client';
import { ChatView } from '../components/ChatView';
import { ResearchPanel } from '../components/ResearchPanel';
import { DeepResearchPanel } from '../components/DeepResearchPanel';
import { Loading, ErrorBanner } from '../components/ui';
import type { ContextAction } from '../components/SelectionMenu';
import { theme } from '../theme';
import type { RootStackParamList } from '../navigation/types';

type R = RouteProp<RootStackParamList, 'DiveChat'>;

type Tab =
  | { id: string; kind: 'chat'; title: string; seed: ChatMessage[]; autoSend: boolean; model: string; mode: string }
  | { id: string; kind: 'links' | 'videos'; title: string; context: string }
  | { id: string; kind: 'deep'; title: string; query: string };

let counter = 0;
const newId = () => `tab-${Date.now().toString(36)}-${counter++}`;

const snippet = (s: string, n = 18) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// Mirror the desktop "create new thread from selection" prompts.
function chatPrompt(action: ContextAction, text: string): string {
  switch (action) {
    case 'details': return `Tell me more, and go deeper on: "${text}"`;
    case 'examples': return `Provide 3-5 concrete, diverse, easy-to-understand examples that illustrate: "${text}"`;
    case 'simplify': return `Explain this in the simplest possible terms, as if to a complete beginner: "${text}"`;
    default: return text; // 'ask'
  }
}
function chatTitle(action: ContextAction, text: string): string {
  const label = action === 'ask' ? 'Ask' : action === 'details' ? 'Details' : action === 'examples' ? 'Examples' : 'Simplify';
  return `${label}: ${snippet(text, 12)}`;
}

function toChatMessages(thread: any, messages: any[]): ChatMessage[] {
  const fromThread = Array.isArray(thread?.mainMessages) ? thread.mainMessages : [];
  const src = fromThread.length ? fromThread : messages;
  return (src || [])
    .map((m: any) => ({
      role: m.role === 'assistant' || m.role === 'system' ? m.role : 'user',
      content: typeof m.content === 'string' ? m.content : (m.text || ''),
    }))
    .filter((m: ChatMessage) => m.content);
}

export default function DiveChatScreen() {
  const { params } = useRoute<R>();
  const [tabs, setTabs] = useState<Tab[] | null>(params.id ? null : [
    { id: newId(), kind: 'chat', title: 'Main', seed: [], autoSend: false, model: 'claude', mode: 'normal' },
  ]);
  const [activeId, setActiveId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Load the saved thread into tab 0 (when opened from the DeepDives list).
  useEffect(() => {
    if (!params.id) { if (tabs && !activeId) setActiveId(tabs[0].id); return; }
    (async () => {
      try {
        const { thread, messages } = await Dives.get(params.id!);
        const model = ['claude', 'openai', 'grok'].includes(thread?.selectedModel) ? thread.selectedModel : 'claude';
        const id = newId();
        setTabs([{ id, kind: 'chat', title: snippet(thread?.title || 'Main', 14), seed: toChatMessages(thread, messages), autoSend: false, model, mode: 'normal' }]);
        setActiveId(id);
      } catch (e: any) {
        setError(e?.message || 'Failed to load thread.');
        const id = newId();
        setTabs([{ id, kind: 'chat', title: 'Main', seed: [], autoSend: false, model: 'claude', mode: 'normal' }]);
        setActiveId(id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  const spawnFromAction = useCallback((action: ContextAction, text: string, ctx: { model: string; mode: string }) => {
    if (!text) return;
    const id = newId();
    let tab: Tab;
    if (action === 'links' || action === 'videos') {
      tab = { id, kind: action, title: `${action === 'links' ? '🔗' : '🎬'} ${snippet(text, 12)}`, context: text };
    } else if (action === 'deep') {
      tab = { id, kind: 'deep', title: `🔬 ${snippet(text, 12)}`, query: text };
    } else {
      // Inherit the current thread's model + Grok persona instead of forcing Claude.
      tab = { id, kind: 'chat', title: chatTitle(action, text), seed: [{ role: 'user', content: chatPrompt(action, text) }], autoSend: true, model: ctx.model, mode: ctx.mode };
    }
    setTabs((prev) => [...(prev || []), tab]);
    setActiveId(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      if (!prev || prev.length <= 1) return prev;
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      setActiveId((cur) => (cur === id ? next[Math.max(0, idx - 1)].id : cur));
      return next;
    });
  }, []);

  const activeTabs = tabs;
  if (!activeTabs) return <Loading text="Loading conversation…" />;

  return (
    <View style={styles.screen}>
      <ErrorBanner text={error} />

      {/* Top tab bar — tap to switch, ✕ to close. */}
      <View style={styles.tabBarWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabBar}>
          {activeTabs.map((t) => {
            const active = t.id === activeId;
            return (
              <Pressable key={t.id} onPress={() => setActiveId(t.id)} style={[styles.tab, active && styles.tabActive]}>
                <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>{t.title}</Text>
                {activeTabs.length > 1 ? (
                  <Pressable hitSlop={8} onPress={() => closeTab(t.id)}>
                    <Text style={[styles.tabClose, active && { color: '#fff' }]}>✕</Text>
                  </Pressable>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Keep every tab mounted (state + live streams persist); show the active one. */}
      <View style={styles.body}>
        {activeTabs.map((t) => (
          <View key={t.id} style={[styles.panel, { display: t.id === activeId ? 'flex' : 'none' }]}>
            {t.kind === 'chat' ? (
              <ChatView
                initialMessages={t.seed}
                initialModel={t.model}
                initialMode={t.mode}
                autoSend={t.autoSend}
                onContextAction={spawnFromAction}
                placeholder="Continue the DeepDive…"
              />
            ) : t.kind === 'deep' ? (
              <DeepResearchPanel query={t.query} />
            ) : (
              <ResearchPanel kind={t.kind} context={t.context} />
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  tabBarWrap: { borderBottomColor: theme.border, borderBottomWidth: 1, backgroundColor: theme.surface },
  tabBar: { paddingHorizontal: 8, paddingVertical: 8, gap: 8, alignItems: 'center' },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 180, backgroundColor: theme.bg, borderColor: theme.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  tabActive: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  tabText: { color: theme.textDim, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  tabTextActive: { color: '#fff' },
  tabClose: { color: theme.textFaint, fontSize: 12, fontWeight: '700' },
  body: { flex: 1 },
  panel: { flex: 1 },
});
