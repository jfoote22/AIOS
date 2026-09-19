import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type ChangeEvent, type FormEvent } from 'react';
import { ChatSessions, type ChatMessage, type ChatOptions } from './chatSession.ts';

const SessionsContext = createContext<ChatSessions | null>(null);
export function ChatSessionProvider({ children }: { children: ReactNode }) {
  const [sessions] = useState(() => new ChatSessions());
  useEffect(() => () => sessions.stopAll(), [sessions]);
  return <SessionsContext.Provider value={sessions}>{children}</SessionsContext.Provider>;
}
export function useChatSessions() {
  const sessions = useContext(SessionsContext);
  if (!sessions) throw new Error('ChatSessionProvider is required.');
  return sessions;
}
export function useChat(options: ChatOptions & { id?: string; initialMessages?: ChatMessage[] }) {
  const sessions = useChatSessions();
  const session = sessions.get(options.id || 'main', options.initialMessages);
  const latest = useRef(options); latest.current = options;
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const append = (message: { role: 'user'; content: string; id?: string }) => session.append(message, latest.current);
  return {
    ...snapshot, append, stop: session.stop, setInput: session.setInput, setMessages: session.setMessages,
    handleInputChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => session.setInput(event.target.value),
    handleSubmit: (event?: FormEvent) => {
      event?.preventDefault();
      if (session.getSnapshot().isLoading || !session.getSnapshot().input.trim()) return;
      const content = session.getSnapshot().input;
      session.setInput(''); void append({ role: 'user', content });
    },
  };
}
