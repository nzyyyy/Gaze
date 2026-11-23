import { t } from "../lib/i18n";
import type { TextPosition } from "../lib/types";

export interface AiCompletionConfig {
  protocol: "responses" | "chatCompletions" | "messages";
  url: string;
  model: string;
  apiKey: string;
}

export const AI_PROTOCOLS = [
  { value: "responses", label: "OpenAI Responses", path: "/v1/responses" },
  { value: "chatCompletions", label: "OpenAI Chat Completions", path: "/v1/chat/completions" },
  { value: "messages", label: "Anthropic Messages", path: "/v1/messages" },
] as const;

export interface AiCompletionRequest {
  id: number;
  projectId: string;
  path: string;
  language: string;
  cursor: TextPosition;
  lspVersion?: { session: string; version: number };
  prefix: string;
  suffix: string;
  recentEdits: string[];
  manual: boolean;
}

export type AiCompletionFailure =
  | "configuration"
  | "authentication"
  | "rateLimited"
  | "unavailable"
  | "timeout"
  | "invalidResponse"
  | "backoff";

export type AiCompletionReply =
  | { type: "suggestion"; text: string }
  | { type: "empty" }
  | { type: "error"; kind: AiCompletionFailure };

export function aiCompletionError(error: unknown): string {
  switch (error) {
    case "configuration":
      return t("请检查 AI 补全的 HTTPS 接口、模型 ID 和 API Key。");
    case "authentication":
      return t("AI 补全鉴权失败，请检查 API Key。");
    case "rateLimited":
    case "backoff":
      return t("AI 补全暂时受限，请稍后重试。");
    case "timeout":
      return t("AI 补全请求超时。");
    case "invalidResponse":
      return t("模型没有返回可用的补全。");
    default:
      return t("AI 补全服务暂时无法连接。");
  }
}
