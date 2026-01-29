import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { Notif } from "notif.sh";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const SESSION = process.argv[2] || "main";

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [notif] = useState(() => new Notif());
  const { exit } = useApp();

  useEffect(() => {
    // Subscribe to prompts and responses
    const subscribe = async () => {
      try {
        for await (const event of notif.subscribe(
          `ravi.${SESSION}.prompt`,
          `ravi.${SESSION}.response`
        )) {
          if (event.topic.endsWith(".prompt")) {
            const data = event.data as { prompt?: string };
            const content = data.prompt;
            if (content) {
              setMessages((prev) => [
                ...prev,
                { role: "user" as const, content },
              ]);
              setLoading(true);
            }
          } else if (event.topic.endsWith(".response")) {
            const data = event.data as { response?: string; error?: string };
            const content = data.response || (data.error ? `Error: ${data.error}` : null);
            if (content) {
              setMessages((prev) => [
                ...prev,
                { role: "assistant" as const, content },
              ]);
            }
            setLoading(false);
          }
        }
      } catch (err) {
        // Subscription closed
      }
    };
    subscribe();

    return () => {
      notif.close();
    };
  }, [notif]);

  useInput((_, key) => {
    if (key.escape) {
      notif.close();
      exit();
    }
  });

  const sendMessage = async (prompt: string) => {
    if (!prompt.trim() || loading) return;
    setInput("");

    try {
      await notif.emit(`ravi.${SESSION}.prompt`, { prompt });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant" as const, content: `Error: ${err instanceof Error ? err.message : "Unknown"}` },
      ]);
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Ravi
        </Text>
        <Text color="gray"> session:{SESSION} (ESC to quit)</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {messages.map((msg, i) => (
          <Box key={i} marginBottom={1}>
            <Text>
              <Text bold color={msg.role === "user" ? "green" : "blue"}>
                {msg.role === "user" ? "You" : "Ravi"}:{" "}
              </Text>
              <Text>{msg.content}</Text>
            </Text>
          </Box>
        ))}
        {loading && (
          <Box>
            <Text color="gray">...</Text>
          </Box>
        )}
      </Box>

      <Box>
        <Text bold color="green">{">"} </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={sendMessage}
          placeholder={loading ? "" : "Type a message"}
        />
      </Box>
    </Box>
  );
}

render(<App />);
