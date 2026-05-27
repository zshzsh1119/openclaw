/**
 * OpenClaw Tool Enhancement Module
 *
 * Key design patterns ported from Claude Code v2.1.88:
 * 1. Tool metadata flags (isReadOnly/isDestructive/isConcurrencySafe)
 * 2. Result size auto-control (maxResultSizeChars + disk spill)
 * 3. Input validation (validateInput)
 *
 * @module tool-enhancement
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";

export interface ToolEnhancerOptions {
  workspaceDir?: string;
  enableResultGuard?: boolean;
  enableInputValidation?: boolean;
  defaultMaxResultSize?: number;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

const DEFAULT_MAX_RESULT_SIZE = 100_000;
const TOOL_RESULTS_DIR = ".openclaw/tool-results";

export async function truncateResultIfNeeded(
  resultText: string,
  options: { maxResultSizeChars?: number; toolName?: string; workspaceDir?: string } = {},
): Promise<{ text: string; truncated: boolean; savedPath?: string }> {
  const maxSize = options.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE;
  if (resultText.length <= maxSize) return { text: resultText, truncated: false };

  const workspaceDir = options.workspaceDir ?? process.cwd();
  const resultsDir = path.join(workspaceDir, TOOL_RESULTS_DIR);
  try { await fs.mkdir(resultsDir, { recursive: true }); } catch {}

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const toolName = options.toolName ?? "unknown";
  const filePath = path.join(resultsDir, `${toolName}-${timestamp}.txt`);

  try { await fs.writeFile(filePath, resultText, "utf-8"); } catch {
    const truncated = resultText.slice(0, maxSize);
    return { text: `${truncated}\n\n[Result truncated: ${resultText.length} chars]`, truncated: true };
  }

  const preview = resultText.slice(0, Math.min(500, maxSize));
  return {
    text: [preview, "", "---", `Truncated: ${resultText.length} chars, showing ${preview.length}`, `Saved to: ${filePath}`].join("\n"),
    truncated: true,
    savedPath: filePath,
  };
}

export function enhanceToolExecution<T extends AnyAgentTool>(
  tool: T,
  options: ToolEnhancerOptions = {},
): T {
  const originalExecute = tool.execute;
  return {
    ...tool,
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) {
      if (options.enableInputValidation !== false && tool.validateInput) {
        const err = tool.validateInput(params);
        if (err) {
          options.onLog?.("warn", `Tool ${tool.name} validation failed: ${err}`);
          return { content: [{ type: "text", text: `Validation failed: ${err}` }], details: { status: "failed", error: err } } as AgentToolResult<unknown>;
        }
      }

      const result = await originalExecute.call(tool, toolCallId, params, signal, onUpdate as never);

      if (options.enableResultGuard !== false && result && typeof result === "object" && "content" in result) {
        const maxSize = typeof tool.maxResultSizeChars === "number" ? tool.maxResultSizeChars : options.defaultMaxResultSize;
        if (maxSize !== undefined) {
          const content = (result as { content: unknown[] }).content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && "type" in block && (block as { type: string }).type === "text" && "text" in block) {
                const textBlock = block as { text: string };
                if (textBlock.text.length > maxSize) {
                  const { text, truncated, savedPath } = await truncateResultIfNeeded(textBlock.text, { maxResultSizeChars: maxSize, toolName: tool.name, workspaceDir: options.workspaceDir });
                  textBlock.text = text;
                  if (truncated) options.onLog?.("info", `Tool ${tool.name} truncated, saved: ${savedPath}`);
                }
              }
            }
          }
        }
      }
      return result;
    },
  } as T;
}

export function enhanceTools<T extends AnyAgentTool>(tools: T[], options: ToolEnhancerOptions = {}): T[] {
  return tools.map((tool) => enhanceToolExecution(tool, options));
}

export function getToolSafetyHint(tool: AnyAgentTool, input?: unknown): string | null {
  const hints: string[] = [];
  if (typeof tool.isReadOnly === "function" ? tool.isReadOnly(input) : tool.isReadOnly) hints.push("read-only");
  if (typeof tool.isDestructive === "function" ? tool.isDestructive(input) : tool.isDestructive) hints.push("destructive");
  if (typeof tool.isConcurrencySafe === "function" ? tool.isConcurrencySafe(input) : tool.isConcurrencySafe) hints.push("concurrency-safe");
  if (typeof tool.maxResultSizeChars === "number") hints.push(`max-output: ${tool.maxResultSizeChars}`);
  return hints.length > 0 ? hints.join(" | ") : null;
}
