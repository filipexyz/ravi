import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { notif } from "./notif.js";

interface MessageTarget {
  channel: string;
  accountId: string;
  chatId: string;
}

interface Message {
  sessionKey: string;
  role: "user" | "assistant";
  content: string;
  source?: MessageTarget;
}

// Session name to send messages to (default: main)
const SEND_TO = process.argv[2] || "main";

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const { exit } = useApp();

  useEffect(() => {
    const subscribe = async () => {
      try {
        // Subscribe to ALL sessions
        for await (const event of notif.subscribe("ravi.session.*.prompt", "ravi.session.*.response")) {
          // Extract session name from topic: ravi.session.{name}.prompt
          const parts = event.topic.split(".");
          const sessionKey = parts[2];
          const eventType = parts[parts.length - 1];

          if (eventType === "prompt") {
            const data = event.data as { prompt?: string; source?: MessageTarget };
            const prompt = data.prompt;
            if (prompt) {
              setMessages((prev) => [...prev, { sessionKey, role: "user" as const, content: prompt, source: data.source }]);
              setLoading(sessionKey);
            }
          } else if (eventType === "response") {
            const data = event.data as { response?: string; error?: string };
            const content = data.response || (data.error ? `Error: ${data.error}` : null);
            if (content) {
              setMessages((prev) => [...prev, { sessionKey, role: "assistant" as const, content }]);
            }
            setLoading(null);
          }
        }
      } catch {
        // Subscription closed
      }
    };
    subscribe();
    return () => {};
  }, []);

  useInput((_, key) => {
    if (key.escape) {
      exit();
    }
  });

  const sendMessage = async (prompt: string) => {
    if (!prompt.trim() || loading) return;
    setInput("");
    try {
      await notif.emit(`ravi.session.${SEND_TO}.prompt`, { prompt });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { sessionKey: SEND_TO, role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
      ]);
    }
  };

  // Session names are already human-readable
  const formatSession = (name: string) => name;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Ravi</Text>
        <Text color="gray"> → {SEND_TO} (ESC to quit)</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {messages.map((msg, i) => (
          <Box key={i} marginBottom={1}>
            <Text>
              <Text color="gray">[{formatSession(msg.sessionKey)}]</Text>
              {msg.source && <Text color="magenta"> ({msg.source.channel})</Text>}
              <Text bold color={msg.role === "user" ? "green" : "blue"}>
                {" "}{msg.role === "user" ? ">" : "<"}
              </Text>
              <Text> {msg.content}</Text>
            </Text>
          </Box>
        ))}
        {loading && (
          <Text color="gray">[{formatSession(loading)}] ...</Text>
        )}
      </Box>

      <Box>
        <Text bold color="green">{">"} </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={sendMessage}
          placeholder={loading ? "" : `Send to ${formatSession(SEND_TO)}`}
        />
      </Box>
    </Box>
  );
}

render(<App />);
