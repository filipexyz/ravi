import { useState, useEffect, useCallback, useRef } from "react";
import { subscribe, publish } from "../../nats.js";
import { getRecentSessionHistory } from "../../db.js";

export interface ChatMessage {
  id: string;
  type: "chat";
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  timestamp: number;
}

export interface ToolMessage {
  id: string;
  type: "tool";
  toolId: string;
  toolName: string;
  status: "running" | "done";
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  durationMs?: number;
  timestamp: number;
}

export type TimelineEntry = ChatMessage | ToolMessage;

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** input_tokens from the last turn (= current context size) */
  contextTokens: number;
}

export interface UseNatsResult {
  messages: TimelineEntry[];
  sendMessage: (text: string) => void;
  clearMessages: () => void;
  pushMessage: (entry: TimelineEntry) => void;
  isConnected: boolean;
  isTyping: boolean;
  isCompacting: boolean;
  isWorking: boolean;
  stopWorking: () => void;
  totalTokens: TokenUsage;
}

const MAX_MESSAGES = 500;
const STREAMING_ID = "streaming-assistant";

/**
 * React hook that manages NATS connection and message state for a session.
 *
 * Subscribes to:
 *  - ravi.session.{name}.prompt   (user messages)
 *  - ravi.session.{name}.response (complete assistant messages)
 *  - ravi.session.{name}.stream   (text delta chunks for live streaming)
 *  - ravi.session.{name}.tool     (tool start/end events)
 *  - ravi.session.{name}.claude   (SDK events: typing, compacting)
 *
 * Streaming: `.stream` chunks are accumulated into a single in-progress
 * message. A final `.response` event replaces it with the complete text.
 */
export function useNats(sessionName: string): UseNatsResult {
  const [messages, setMessages] = useState<TimelineEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [totalTokens, setTotalTokens] = useState<TokenUsage>({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    contextTokens: 0,
  });
  const abortRef = useRef(false);
  // Accumulate streaming text in a ref to avoid stale closures
  const streamBuf = useRef("");
  const streamDone = useRef(false);

  useEffect(() => {
    abortRef.current = false;
    streamBuf.current = "";
    streamDone.current = false;
    setIsConnected(false);
    setIsTyping(false);
    setIsCompacting(false);
    setIsWorking(false);
    setTotalTokens({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, contextTokens: 0 });

    // Load recent chat history from SQLite
    try {
      const history = getRecentSessionHistory(sessionName, 50);
      const restored: TimelineEntry[] = history.map((msg, i) => ({
        id: `history-${msg.id}-${i}`,
        type: "chat" as const,
        role: msg.role,
        content: msg.content,
        timestamp: new Date(msg.created_at).getTime(),
      }));
      setMessages(restored);
    } catch {
      setMessages([]);
    }

    const promptTopic = `ravi.session.${sessionName}.prompt`;
    const responseTopic = `ravi.session.${sessionName}.response`;
    const streamTopic = `ravi.session.${sessionName}.stream`;
    const toolTopic = `ravi.session.${sessionName}.tool`;
    const claudeTopic = `ravi.session.${sessionName}.claude`;

    const run = async () => {
      try {
        setIsConnected(true);

        for await (const event of subscribe(
          promptTopic,
          responseTopic,
          streamTopic,
          toolTopic,
          claudeTopic,
        )) {
          if (abortRef.current) break;

          const { topic, data } = event;

          if (topic === promptTopic) {
            const prompt = (data as { prompt?: string }).prompt;
            if (!prompt) continue;
            // New turn — allow streaming again
            streamDone.current = false;
            streamBuf.current = "";
            setIsWorking(true);
            const msg: ChatMessage = {
              id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: "chat",
              role: "user",
              content: prompt,
              timestamp: Date.now(),
            };
            setMessages((prev) => {
              const next = [...prev, msg];
              return next.length > MAX_MESSAGES
                ? next.slice(next.length - MAX_MESSAGES)
                : next;
            });

          } else if (topic === streamTopic) {
            // Streaming text delta chunk — ignore stale chunks after response
            if (streamDone.current) continue;
            const chunk = (data as { chunk?: string }).chunk;
            if (!chunk) continue;
            streamBuf.current += chunk;
            const text = streamBuf.current;
            setIsTyping(true);
            setMessages((prev) => {
              const existing = prev.findIndex((m) => m.id === STREAMING_ID);
              const entry: ChatMessage = {
                id: STREAMING_ID,
                type: "chat",
                role: "assistant",
                content: text,
                streaming: true,
                timestamp: Date.now(),
              };
              if (existing >= 0) {
                const next = [...prev];
                next[existing] = entry;
                return next;
              }
              const next = [...prev, entry];
              return next.length > MAX_MESSAGES
                ? next.slice(next.length - MAX_MESSAGES)
                : next;
            });

          } else if (topic === responseTopic) {
            const responseData = data as { response?: string };
            const response = responseData.response;
            if (!response) continue;

            // Replace streaming placeholder with final message
            streamBuf.current = "";
            streamDone.current = true;
            const finalMsg: ChatMessage = {
              id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: "chat",
              role: "assistant",
              content: response,
              timestamp: Date.now(),
            };
            setIsTyping(false);
            setIsWorking(false);
            setMessages((prev) => {
              const filtered = prev.filter((m) => m.id !== STREAMING_ID);
              const next = [...filtered, finalMsg];
              return next.length > MAX_MESSAGES
                ? next.slice(next.length - MAX_MESSAGES)
                : next;
            });

          } else if (topic === toolTopic) {
            const toolData = data as {
              event?: string;
              toolId?: string;
              toolName?: string;
              input?: unknown;
              output?: unknown;
              isError?: boolean;
              durationMs?: number;
            };

            if (toolData.event === "start" && toolData.toolId) {
              // Tool starting — clear any streaming message and buffer
              streamBuf.current = "";
              const entry: ToolMessage = {
                id: `tool-${toolData.toolId}`,
                type: "tool",
                toolId: toolData.toolId,
                toolName: toolData.toolName ?? "unknown",
                status: "running",
                input: toolData.input,
                timestamp: Date.now(),
              };
              setMessages((prev) => {
                const filtered = prev.filter((m) => m.id !== STREAMING_ID);
                const next = [...filtered, entry];
                return next.length > MAX_MESSAGES
                  ? next.slice(next.length - MAX_MESSAGES)
                  : next;
              });
            } else if (toolData.event === "end" && toolData.toolId) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.type === "tool" && m.toolId === toolData.toolId) {
                    return {
                      ...m,
                      status: "done" as const,
                      output: toolData.output,
                      isError: toolData.isError,
                      durationMs: toolData.durationMs,
                    };
                  }
                  return m;
                }),
              );
            }

          } else if (topic === claudeTopic) {
            const claudeData = data as {
              type?: string;
              subtype?: string;
              status?: string;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };

            if (claudeData.type === "assistant") {
              streamDone.current = false;
              setIsTyping(true);
            } else if (claudeData.type === "result") {
              setIsTyping(false);
              setIsCompacting(false);

              // Extract token usage from SDK result
              if (claudeData.usage) {
                const inp = claudeData.usage.input_tokens ?? 0;
                const out = claudeData.usage.output_tokens ?? 0;
                const cr = claudeData.usage.cache_read_input_tokens ?? 0;
                const cc = claudeData.usage.cache_creation_input_tokens ?? 0;
                setTotalTokens((prev) => ({
                  input: prev.input + inp,
                  output: prev.output + out,
                  cacheRead: prev.cacheRead + cr,
                  cacheCreation: prev.cacheCreation + cc,
                  contextTokens: inp + cr + cc,
                }));
              }
            } else if (
              claudeData.type === "system" &&
              claudeData.subtype === "status"
            ) {
              if (claudeData.status === "compacting") {
                setIsCompacting(true);
              } else if (claudeData.status === "idle") {
                setIsCompacting(false);
              }
            }
          }
        }
      } catch {
        // subscription ended or failed
      } finally {
        if (!abortRef.current) {
          setIsConnected(false);
        }
      }
    };

    run();

    return () => {
      abortRef.current = true;
      setIsConnected(false);
    };
  }, [sessionName]);

  const sendMessage = useCallback(
    (text: string) => {
      const topic = `ravi.session.${sessionName}.prompt`;
      publish(topic, { prompt: text, source: { channel: "tui", accountId: "", chatId: "" } }).catch(() => {
        // publish failed silently
      });
    },
    [sessionName],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const pushMessage = useCallback((entry: TimelineEntry) => {
    setMessages((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_MESSAGES
        ? next.slice(next.length - MAX_MESSAGES)
        : next;
    });
  }, []);

  const stopWorking = useCallback(() => {
    setIsWorking(false);
    setIsTyping(false);
    // Remove in-progress streaming message
    setMessages((prev) => prev.filter((m) => m.id !== STREAMING_ID));
  }, []);

  return {
    messages,
    sendMessage,
    clearMessages,
    pushMessage,
    isConnected,
    isTyping,
    isCompacting,
    isWorking,
    stopWorking,
    totalTokens,
  };
}
