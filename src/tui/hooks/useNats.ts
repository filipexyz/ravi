import { useState, useEffect, useCallback, useRef } from "react";
import { subscribe, publish } from "../../nats.js";

export interface ChatMessage {
  id: string;
  type: "chat";
  role: "user" | "assistant";
  content: string;
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
}

export interface UseNatsResult {
  messages: TimelineEntry[];
  sendMessage: (text: string) => void;
  clearMessages: () => void;
  pushMessage: (entry: TimelineEntry) => void;
  isConnected: boolean;
  isTyping: boolean;
  isCompacting: boolean;
  totalTokens: TokenUsage;
}

const MAX_MESSAGES = 500;

/**
 * React hook that manages NATS connection and message state for a session.
 *
 * Subscribes to:
 *  - ravi.session.{name}.prompt   (user messages)
 *  - ravi.session.{name}.response (assistant messages)
 *  - ravi.session.{name}.tool     (tool start/end events)
 *  - ravi.session.{name}.claude   (SDK events: typing, compacting)
 *
 * Provides sendMessage() to publish to the prompt topic.
 */
export function useNats(sessionName: string): UseNatsResult {
  const [messages, setMessages] = useState<TimelineEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [totalTokens, setTotalTokens] = useState<TokenUsage>({
    input: 0,
    output: 0,
  });
  const abortRef = useRef(false);

  useEffect(() => {
    abortRef.current = false;
    setMessages([]);
    setIsConnected(false);
    setIsTyping(false);
    setIsCompacting(false);
    setTotalTokens({ input: 0, output: 0 });

    const promptTopic = `ravi.session.${sessionName}.prompt`;
    const responseTopic = `ravi.session.${sessionName}.response`;
    const toolTopic = `ravi.session.${sessionName}.tool`;
    const claudeTopic = `ravi.session.${sessionName}.claude`;

    const run = async () => {
      try {
        setIsConnected(true);

        for await (const event of subscribe(
          promptTopic,
          responseTopic,
          toolTopic,
          claudeTopic,
        )) {
          if (abortRef.current) break;

          const { topic, data } = event;

          if (topic === promptTopic) {
            const prompt = (data as { prompt?: string }).prompt;
            if (!prompt) continue;
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
          } else if (topic === responseTopic) {
            const responseData = data as {
              response?: string;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
              };
            };
            const response = responseData.response;
            if (!response) continue;

            // Accumulate token usage if present
            if (responseData.usage) {
              const inputTok = responseData.usage.input_tokens ?? 0;
              const outputTok = responseData.usage.output_tokens ?? 0;
              if (inputTok > 0 || outputTok > 0) {
                setTotalTokens((prev) => ({
                  input: prev.input + inputTok,
                  output: prev.output + outputTok,
                }));
              }
            }

            const msg: ChatMessage = {
              id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: "chat",
              role: "assistant",
              content: response,
              timestamp: Date.now(),
            };
            // Response received means typing is done
            setIsTyping(false);
            setMessages((prev) => {
              const next = [...prev, msg];
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
                const next = [...prev, entry];
                return next.length > MAX_MESSAGES
                  ? next.slice(next.length - MAX_MESSAGES)
                  : next;
              });
            } else if (toolData.event === "end" && toolData.toolId) {
              // Update existing tool entry with output/duration
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
            };

            if (claudeData.type === "assistant") {
              setIsTyping(true);
            } else if (claudeData.type === "result") {
              setIsTyping(false);
              setIsCompacting(false);
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
      publish(topic, { prompt: text }).catch(() => {
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

  return {
    messages,
    sendMessage,
    clearMessages,
    pushMessage,
    isConnected,
    isTyping,
    isCompacting,
    totalTokens,
  };
}
