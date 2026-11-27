import { invoke } from "../lib/platform/ipc";
import type {
  AiCompletionConfig,
  AiCompletionReply,
  AiCompletionRequest,
} from "./ai-completion-config";

export const aiCompletionApi = {
  requestAiCompletion: (request: AiCompletionRequest) =>
    invoke<AiCompletionReply>("request_ai_completion", { request }),
  cancelAiCompletion: (id: number) => invoke<void>("cancel_ai_completion", { id }),
  testAiCompletion: (config: AiCompletionConfig) => invoke<void>("test_ai_completion", { config }),
};
