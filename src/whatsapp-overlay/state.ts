export interface OverlayComponentMatch {
  id: string;
  surface: string;
  selector?: string | null;
  score: number;
  confidence: "high" | "medium" | "low";
  count?: number;
  signals?: string[];
  extracted?: Record<string, string | number | boolean | null>;
}

export interface OverlaySelectorProbe {
  name: string;
  selector: string;
  count: number;
  visibleCount?: number;
  sampleText?: string | null;
  samplePath?: string[];
}

export interface OverlayChatRowState {
  id: string;
  title: string;
  chatIdCandidate?: string | null;
  selected?: boolean;
  unreadCount?: number | null;
  preview?: string | null;
  timeLabel?: string | null;
  text?: string | null;
}

export interface OverlayViewState {
  screen: string;
  title?: string | null;
  selectedChat?: string | null;
  chatIdCandidate?: string | null;
  url?: string | null;
  focus?: string | null;
  hasConversationHeader?: boolean;
  hasComposer?: boolean;
  hasChatList?: boolean;
  hasDrawer?: boolean;
  hasModal?: boolean;
  components?: OverlayComponentMatch[];
  selectorProbes?: OverlaySelectorProbe[];
  chatRows?: OverlayChatRowState[];
}

export interface OverlayPublishedState {
  clientId: string;
  app: "whatsapp-web";
  context: {
    chatId?: string | null;
    title?: string | null;
    session?: string | null;
  };
  view: OverlayViewState;
  postedAt: number;
}
