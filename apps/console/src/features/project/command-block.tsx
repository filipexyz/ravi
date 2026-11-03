"use client";

import { cn } from "@/lib/cn";
import { CopyButton } from "@/ui/copy";

/**
 * A command to copy. Like CodeBlock, but it wraps only between words, so a
 * flag such as `--project` never breaks across lines on a phone.
 */
export function CommandBlock({ className, command }: { className?: string; command: string }) {
  const words = splitWords(command);
  return (
    <div className={cn("relative rounded-md border border-line bg-sunken", className)}>
      <pre className="overflow-x-auto px-3 py-2.5 pr-12 font-mono text-[13px] leading-relaxed whitespace-normal text-ink">
        <code>
          {words.map((word, index) => (
            <span key={index}>
              {index ? " " : null}
              <span className="whitespace-nowrap">{word}</span>
            </span>
          ))}
        </code>
      </pre>
      <CopyButton className="absolute top-1.5 right-1.5" label="Copy command" value={command} />
    </div>
  );
}

/** Splits on spaces outside quotes, so `--title "Home page"` stays together. */
function splitWords(command: string) {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      current += char;
      quote = char;
    } else if (char === " ") {
      if (current) words.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}
