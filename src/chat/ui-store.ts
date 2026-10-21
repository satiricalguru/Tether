import { create } from 'zustand';
import type { ChatStatus } from '@/background/chat';

/** Transient side-panel state. Durable data lives in IndexedDB. */
interface ChatUiState {
  view: 'chat' | 'history';
  conversationId: string | null;
  /** Send the next message as a browsing-agent task. */
  agentMode: boolean;
  setAgentMode: (on: boolean) => void;
  /** Live status of in-flight replies, by assistant message id. */
  live: Record<string, ChatStatus>;
  setView: (view: ChatUiState['view']) => void;
  openConversation: (id: string | null) => void;
  setLive: (messageId: string, status: ChatStatus | null) => void;
}

export const useChatUi = create<ChatUiState>((set) => ({
  view: 'chat',
  conversationId: null,
  agentMode: false,
  setAgentMode: (agentMode) => {
    set({ agentMode });
  },
  live: {},
  setView: (view) => {
    set({ view });
  },
  openConversation: (conversationId) => {
    set({ conversationId, view: 'chat' });
  },
  setLive: (messageId, status) => {
    set((s) => ({
      live: status
        ? { ...s.live, [messageId]: status }
        : Object.fromEntries(Object.entries(s.live).filter(([id]) => id !== messageId)),
    }));
  },
}));
