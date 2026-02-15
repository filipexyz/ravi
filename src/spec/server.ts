/**
 * Spec Mode — MCP Server
 *
 * In-process MCP server that provides 3 tools for collaborative specification:
 * - enter_spec_mode: Activate spec mode, load prompt, block destructive tools
 * - update_spec: Register progress (free % + summary)
 * - exit_spec_mode: Generate final spec, request approval
 *
 * State is tracked per session via a Map.
 * The spec prompt follows the compact pattern: SPEC_INSTRUCTIONS.md override or default.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { DEFAULT_SPEC_PROMPT } from "./default-prompt.js";

const log = logger.child("spec");

// --- State management ---

export interface SpecState {
  active: boolean;
  progress: number;
  summary: string;
  history: Array<{ progress: number; summary: string; timestamp: string }>;
}

const specStates = new Map<string, SpecState>();

export function isSpecModeActive(sessionId: string): boolean {
  return specStates.get(sessionId)?.active ?? false;
}

export function getSpecState(sessionId: string): SpecState | undefined {
  return specStates.get(sessionId);
}

export function clearSpecState(sessionId: string): void {
  specStates.delete(sessionId);
}

// --- Prompt loading ---

function loadSpecPrompt(cwd: string): string {
  const specPath = join(cwd, "SPEC_INSTRUCTIONS.md");
  if (existsSync(specPath)) {
    const content = readFileSync(specPath, "utf-8");
    log.info("Loaded SPEC_INSTRUCTIONS.md", { path: specPath, size: content.length });
    return content;
  }
  log.info("Using default spec prompt");
  return DEFAULT_SPEC_PROMPT;
}

// --- MCP Server factory ---

export function createSpecServer(sessionId: string, cwd: string) {
  return createSdkMcpServer({
    name: "spec",
    version: "1.0.0",
    tools: [
      tool(
        "enter_spec_mode",
        "Enter spec mode to collaboratively build a specification before implementing. " +
        "Use this when you receive a complex task that needs requirements gathering. " +
        "While in spec mode, destructive tools (Edit, Write, Bash) are blocked — " +
        "you can only explore code and ask questions. " +
        "Call update_spec to register progress, then exit_spec_mode when the spec is complete.",
        { reason: z.string().optional().describe("Why you're entering spec mode") },
        async (args) => {
          if (isSpecModeActive(sessionId)) {
            return {
              content: [{ type: "text" as const, text: "Already in spec mode. Use update_spec to register progress or exit_spec_mode to finish." }],
            };
          }

          const prompt = loadSpecPrompt(cwd);
          specStates.set(sessionId, {
            active: true,
            progress: 0,
            summary: "",
            history: [],
          });

          log.info("Spec mode activated", { sessionId, reason: args.reason });

          return {
            content: [{ type: "text" as const, text: prompt }],
          };
        },
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        "update_spec",
        "Update spec progress. Call this as you gather information to show the user your progress. " +
        "Set progress (0-100) based on how well you understand the task — this is your judgment call. " +
        "The summary should describe what you know and what you still need to find out.",
        {
          progress: z.number().min(0).max(100).describe("How complete the spec is (0-100), based on your understanding"),
          summary: z.string().describe("What you know so far and what's still missing"),
        },
        async (args) => {
          const state = specStates.get(sessionId);
          if (!state || !state.active) {
            return {
              content: [{ type: "text" as const, text: "Not in spec mode. Call enter_spec_mode first." }],
              isError: true,
            };
          }

          state.progress = args.progress;
          state.summary = args.summary;
          state.history.push({
            progress: args.progress,
            summary: args.summary,
            timestamp: new Date().toISOString(),
          });

          log.info("Spec progress updated", { sessionId, progress: args.progress });

          const stateReport = {
            progress: state.progress,
            summary: state.summary,
            historyLength: state.history.length,
            history: state.history,
          };

          return {
            content: [{ type: "text" as const, text: JSON.stringify(stateReport, null, 2) }],
          };
        },
        { annotations: { readOnlyHint: true } },
      ),

      tool(
        "exit_spec_mode",
        "Exit spec mode and submit the final specification for user approval. " +
        "The spec will be sent to the user for review. If approved, destructive tools are unblocked " +
        "and you can begin implementation. If rejected, you stay in spec mode to adjust.",
        {
          spec: z.string().describe("The complete specification document in markdown format"),
        },
        async (args) => {
          const state = specStates.get(sessionId);
          if (!state || !state.active) {
            return {
              content: [{ type: "text" as const, text: "Not in spec mode." }],
              isError: true,
            };
          }

          // Don't deactivate here — the PreToolUse hook handles approval first.
          // If approved, the hook deactivates spec mode before this handler runs.
          // If rejected, the hook denies and this handler never executes.
          log.info("exit_spec_mode called, approval handled by hook", { sessionId });

          return {
            content: [{ type: "text" as const, text: "Spec approved. You can now begin implementation following the specification." }],
          };
        },
      ),
    ],
  });
}
