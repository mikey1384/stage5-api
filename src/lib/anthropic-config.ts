import Anthropic from "@anthropic-ai/sdk";
import { Context } from "hono";

export function makeAnthropic(c: Context<any>) {
  return new Anthropic({
    apiKey: c.env.ANTHROPIC_API_KEY,
    timeout: 600_000,
    maxRetries: 3,
  });
}

export interface ClaudeMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-");
}
