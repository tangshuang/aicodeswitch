import type { TokenUsage } from '../../types';

// ============================================================================
// Gemini API 类型定义
// ============================================================================

/**
 * Gemini Content 类型
 */
interface GeminiContent {
  role?: 'user' | 'model' | 'function' | 'tool';
  parts: GeminiPart[];
}

/**
 * Gemini Part 类型
 */
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }
  | { thought: boolean };

/**
 * Gemini 请求类型
 */
interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiContent | { parts: GeminiPart[] };
  generationConfig?: GeminiGenerationConfig;
  safetySettings?: GeminiSafetySetting[];
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  cachedContent?: string;
}

/**
 * Gemini 生成配置
 */
interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  candidateCount?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  responseLogprobs?: boolean;
  logprobs?: number;
  responseMimeType?: string;
  responseSchema?: unknown;
  responseModalities?: string[];
  thinkingConfig?: {
    includeThoughts?: boolean;
    thinkingBudget?: number;
    thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  };
  speechConfig?: unknown;
  imageConfig?: unknown;
  mediaResolution?: string;
}

/**
 * Gemini 响应类型
 */
interface GeminiResponse {
  candidates: GeminiCandidate[];
  promptFeedback?: GeminiPromptFeedback;
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Gemini Candidate 类型
 */
interface GeminiCandidate {
  content: GeminiContent;
  finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | 'MALFORMED_FUNCTION_CALL';
  safetyRatings?: GeminiSafetyRating[];
  citationMetadata?: unknown;
  tokenCount?: number;
  groundingMetadata?: unknown;
  avgLogprobs?: number;
  logprobsResult?: unknown;
}

/**
 * Gemini Usage Metadata
 */
interface GeminiUsageMetadata {
  promptTokenCount: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  thoughtsTokenCount?: number;
}

/**
 * Gemini Prompt Feedback
 */
interface GeminiPromptFeedback {
  blockReason?: 'SAFETY' | 'OTHER';
  safetyRatings: GeminiSafetyRating[];
}

/**
 * Gemini Safety Rating
 */
interface GeminiSafetyRating {
  category: string;
  probability: 'NEGLIGIBLE' | 'LOW' | 'MEDIUM' | 'HIGH';
  blocked?: boolean;
}

/**
 * Gemini Safety Setting
 */
interface GeminiSafetySetting {
  category: string;
  threshold: string;
}

/**
 * Gemini Tool 类型
 */
interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  codeExecution?: {};
  googleSearch?: {};
}

/**
 * Gemini Function Declaration
 */
interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required: string[];
  };
}

/**
 * Gemini Tool Config
 */
interface GeminiToolConfig {
  functionCallingConfig?: {
    mode?: 'AUTO' | 'ANY' | 'NONE';
    allowedFunctionNames?: string[];
  };
}

// ============================================================================
// Claude 类型定义 (用于转换)
// ============================================================================

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: string; media_type?: string; data?: string; url?: string } }
  | { type: 'tool_use'; id?: string; name: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: 'thinking'; thinking?: string }
  | { type: 'document'; source: { type: string; file_id?: string; data?: string; media_type?: string }; title?: string }
  | Record<string, any>;

type ClaudeMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ClaudeContentBlock[] | null;
};

type ClaudeRequest = {
  model?: string;
  messages?: ClaudeMessage[];
  system?: string | ClaudeContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: unknown;
  stop_sequences?: string[];
  thinking?: { type: 'enabled' | 'disabled' | 'auto'; budget_tokens?: number };
  [key: string]: unknown;
};

// ============================================================================
// OpenAI Chat 类型定义 (用于转换)
// ============================================================================

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
};

type OpenAIRequest = {
  model?: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: unknown;
    };
  }>;
  tool_choice?: unknown;
  stream?: boolean;
};

// ============================================================================
// Claude → Gemini 转换
// ============================================================================

/**
 * 将 Claude 图像转换为 Gemini inlineData 格式
 */
const convertClaudeImageToGemini = (block: any): { inlineData: { mimeType: string; data: string } } | null => {
  if (!block || typeof block !== 'object' || block.type !== 'image') {
    return null;
  }

  const source = block.source;
  if (!source || typeof source !== 'object') {
    return null;
  }

  // 处理 base64 编码的图像
  if (source.type === 'base64' && source.data && source.media_type) {
    return {
      inlineData: {
        mimeType: source.media_type,
        data: source.data,
      },
    };
  }

  // 处理 URL 格式的图像 - Gemini 需要转为 fileData 或 inlineData
  if (source.type === 'url' && source.url) {
    // 对于 URL，需要先下载再转换为 base64
    // 这里暂时返回 null，实际使用时需要由调用方处理
    return null;
  }

  return null;
};

/**
 * 将 Claude tool_use 转换为 Gemini functionCall
 */
const convertClaudeToolUseToGemini = (block: any): GeminiPart | null => {
  if (!block || typeof block !== 'object' || block.type !== 'tool_use') {
    return null;
  }

  return {
    functionCall: {
      name: block.name || 'tool',
      args: block.input || {},
    },
  };
};

/**
 * 将 Claude tool_result 转换为 Gemini functionResponse
 */
const convertClaudeToolResultToGemini = (block: any): GeminiPart | null => {
  if (!block || typeof block !== 'object' || block.type !== 'tool_result') {
    return null;
  }

  return {
    functionResponse: {
      name: 'function', // Gemini 需要函数名，但 tool_result 可能没有
      response: block.content || {},
    },
  };
};

/**
 * 将 Claude system 指令转换为 Gemini systemInstruction
 */
const convertClaudeSystemToGemini = (system: string | ClaudeContentBlock[] | unknown): GeminiContent | undefined => {
  let systemText = '';

  if (typeof system === 'string') {
    systemText = system;
  } else if (Array.isArray(system)) {
    const textParts: string[] = [];
    for (const block of system) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    systemText = textParts.join('\n\n');
  } else if (system && typeof system === 'object') {
    const blk = system as ClaudeContentBlock;
    if (blk.type === 'text' && 'text' in blk && typeof blk.text === 'string') {
      systemText = blk.text;
    }
  }

  if (!systemText) {
    return undefined;
  }

  return {
    role: 'user',
    parts: [{ text: systemText }],
  };
};

/**
 * 将 Claude tools 转换为 Gemini tools
 */
const convertClaudeToolsToGemini = (tools?: Array<{ name: string; description?: string; input_schema?: unknown }>): GeminiTool[] | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const functionDeclarations: GeminiFunctionDeclaration[] = tools
    .filter(tool => tool.name)
    .map(tool => ({
      name: tool.name,
      description: tool.description || '',
      parameters: (tool.input_schema as any) || { type: 'object', properties: {}, required: [] },
    }));

  if (functionDeclarations.length === 0) {
    return undefined;
  }

  return [{ functionDeclarations }];
};

/**
 * 将 Claude tool_choice 转换为 Gemini toolConfig
 */
const convertClaudeToolChoiceToGemini = (toolChoice: unknown): GeminiToolConfig | undefined => {
  if (!toolChoice) {
    return undefined;
  }

  if (toolChoice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }

  if (toolChoice === 'any' || toolChoice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }

  if (toolChoice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }

  if (typeof toolChoice === 'object') {
    const tc = toolChoice as any;
    if (tc.type === 'tool' && tc.name) {
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.name] } };
    }
    if (tc.type === 'function' && tc.function?.name) {
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.function.name] } };
    }
  }

  return undefined;
};

/**
 * 将 Claude thinking 配置转换为 Gemini thinkingConfig
 */
const convertClaudeThinkingToGemini = (thinking?: { type?: string; budget_tokens?: number }): GeminiGenerationConfig['thinkingConfig'] | undefined => {
  if (!thinking) {
    return undefined;
  }

  const thinkingConfig: GeminiGenerationConfig['thinkingConfig'] = {};

  if (thinking.type === 'enabled') {
    thinkingConfig.includeThoughts = true;
    thinkingConfig.thinkingLevel = 'HIGH';
  } else if (thinking.type === 'disabled') {
    thinkingConfig.includeThoughts = false;
  } else if (thinking.type === 'auto') {
    thinkingConfig.includeThoughts = true;
    thinkingConfig.thinkingLevel = 'LOW';
  }

  if (thinking.budget_tokens) {
    thinkingConfig.thinkingBudget = thinking.budget_tokens;
  }

  if (Object.keys(thinkingConfig).length === 0) {
    return undefined;
  }

  return thinkingConfig;
};

/**
 * 将 Claude 请求转换为 Gemini 请求
 */
export const transformClaudeRequestToGemini = (body: ClaudeRequest): GeminiRequest => {
  const geminiRequest: GeminiRequest = {
    contents: [],
  };

  // 转换 system 指令
  if (body.system) {
    const systemInstruction = convertClaudeSystemToGemini(body.system);
    if (systemInstruction) {
      geminiRequest.systemInstruction = systemInstruction;
    }
  }

  // 转换 messages
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const geminiContent: GeminiContent = {
        role: message.role === 'tool' ? 'function' : message.role === 'assistant' ? 'model' : 'user',
        parts: [],
      };

      // 系统消息在 Gemini 中用 role='user' 但放在 systemInstruction 中
      // 这里跳过 role='system' 的消息
      if (message.role === 'system') {
        continue;
      }

      if (typeof message.content === 'string' || message.content === null) {
        const content: string = message.content === null ? '' : message.content as string;
        geminiContent.parts.push({ text: content });
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!block || typeof block !== 'object') {
            continue;
          }

          const blockType = (block as any).type;

          // 处理文本内容
          if (blockType === 'text' && typeof (block as any).text === 'string') {
            geminiContent.parts.push({ text: (block as any).text });
          }

          // 处理图像内容
          if (blockType === 'image') {
            const imageData = convertClaudeImageToGemini(block);
            if (imageData) {
              geminiContent.parts.push(imageData);
            }
          }

          // 处理工具调用
          if (blockType === 'tool_use') {
            const functionCall = convertClaudeToolUseToGemini(block);
            if (functionCall) {
              geminiContent.parts.push(functionCall);
            }
          }

          // 处理工具结果
          if (blockType === 'tool_result') {
            const functionResponse = convertClaudeToolResultToGemini(block);
            if (functionResponse) {
              geminiContent.parts.push(functionResponse);
            }
          }
        }
      }

      // 确保至少有一个 part
      if (geminiContent.parts.length === 0) {
        geminiContent.parts.push({ text: '' });
      }

      geminiRequest.contents.push(geminiContent);
    }
  }

  // 转换生成配置
  const generationConfig: GeminiGenerationConfig = {};

  if (typeof body.temperature === 'number') {
    generationConfig.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number') {
    generationConfig.topP = body.top_p;
  }
  if (typeof body.max_tokens === 'number') {
    generationConfig.maxOutputTokens = body.max_tokens;
  }
  if (Array.isArray(body.stop_sequences)) {
    generationConfig.stopSequences = body.stop_sequences;
  }

  // 转换 thinking 配置
  const thinkingConfig = convertClaudeThinkingToGemini(body.thinking);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  if (Object.keys(generationConfig).length > 0) {
    geminiRequest.generationConfig = generationConfig;
  }

  // 转换 tools
  const tools = convertClaudeToolsToGemini(body.tools);
  if (tools) {
    geminiRequest.tools = tools;
  }

  // 转换 tool_choice
  const toolConfig = convertClaudeToolChoiceToGemini(body.tool_choice);
  if (toolConfig) {
    geminiRequest.toolConfig = toolConfig;
  }

  return geminiRequest;
};

// ============================================================================
// Gemini → Claude 转换
// ============================================================================

/**
 * 将 Gemini finishReason 映射到 Claude stop_reason
 */
const mapGeminiFinishReasonToClaude = (finishReason?: string): string => {
  switch (finishReason) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
      return 'tool_use';
    default:
      return 'end_turn';
  }
};

/**
 * 将 Gemini usage 转换为 Claude usage
 */
const convertGeminiUsageToClaude = (usage?: GeminiUsageMetadata): TokenUsage | undefined => {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
    cacheReadInputTokens: usage.cachedContentTokenCount,
  };
};

/**
 * 将 Gemini functionCall 转换为 Claude tool_use
 */
const convertGeminiFunctionCallToClaude = (part: any, index: number): ClaudeContentBlock | null => {
  if (!part.functionCall) {
    return null;
  }

  return {
    type: 'tool_use',
    id: `tool_${index}_${Date.now()}`,
    name: part.functionCall.name || 'tool',
    input: part.functionCall.args || {},
  };
};

/**
 * 将 Gemini functionResponse 转换为 Claude tool_result
 */
const convertGeminiFunctionResponseToClaude = (part: any): ClaudeContentBlock | null => {
  if (!part.functionResponse) {
    return null;
  }

  return {
    type: 'tool_result',
    tool_use_id: `tool_${Date.now()}`, // Gemini 没有对应的 tool_use_id
    content: part.functionResponse.response || {},
  };
};

/**
 * 将 Gemini 响应转换为 Claude 响应
 */
export const transformGeminiResponseToClaude = (body: GeminiResponse, model?: string) => {
  const candidate = Array.isArray(body.candidates) && body.candidates.length > 0 ? body.candidates[0] : null;
  const contentBlocks: ClaudeContentBlock[] = [];

  // 转换 content parts
  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      const p = part as any;
      // 文本内容
      if (p.text && typeof p.text === 'string') {
        contentBlocks.push({ type: 'text', text: p.text });
      }

      // functionCall -> tool_use
      if (p.functionCall) {
        const toolUse = convertGeminiFunctionCallToClaude(p, contentBlocks.length);
        if (toolUse) {
          contentBlocks.push(toolUse);
        }
      }

      // functionResponse -> tool_result (通常不会在响应中出现)
      if (p.functionResponse) {
        const toolResult = convertGeminiFunctionResponseToClaude(p);
        if (toolResult) {
          contentBlocks.push(toolResult);
        }
      }

      // inlineData (图像输出，罕见)
      if (p.inlineData) {
        // Gemini 可能生成图像，转换为 Claude 图像格式
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: p.inlineData.mimeType,
            data: p.inlineData.data,
          },
        });
      }
    }
  }

  // 如果没有内容块，添加空文本
  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: 'text', text: '' });
  }

  const usage = convertGeminiUsageToClaude(body.usageMetadata);

  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    type: 'message',
    role: 'assistant',
    model: model || 'gemini',
    content: contentBlocks,
    stop_reason: mapGeminiFinishReasonToClaude(candidate?.finishReason),
    stop_sequence: null,
    usage: usage || {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
};

// ============================================================================
// OpenAI Chat → Gemini 转换
// ============================================================================

/**
 * 将 OpenAI Chat 请求转换为 Gemini 请求
 */
export const transformOpenAIChatRequestToGemini = (body: OpenAIRequest): GeminiRequest => {
  const geminiRequest: GeminiRequest = {
    contents: [],
  };

  // 转换 messages
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const geminiContent: GeminiContent = {
        role: message.role === 'tool' ? 'function' : message.role === 'assistant' ? 'model' : 'user',
        parts: [],
      };

      // 处理 system 消息
      if (message.role === 'system') {
        const systemText = typeof message.content === 'string' ? message.content : '';
        if (systemText) {
          geminiRequest.systemInstruction = {
            role: 'user',
            parts: [{ text: systemText }],
          };
        }
        continue;
      }

      // 处理 content
      if (typeof message.content === 'string') {
        geminiContent.parts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === 'text' && item.text) {
            geminiContent.parts.push({ text: item.text });
          } else if (item.type === 'image_url' && item.image_url?.url) {
            // 处理图像 URL
            const url = item.image_url.url;
            if (url.startsWith('data:')) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                geminiContent.parts.push({
                  inlineData: {
                    mimeType: match[1],
                    data: match[2],
                  },
                });
              }
            } else {
              // URL 需要特殊处理，暂时跳过
              // 实际需要下载并转换为 base64
            }
          }
        }
      }

      // 处理 tool_calls
      if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          geminiContent.parts.push({
            functionCall: {
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments || '{}'),
            },
          });
        }
      }

      // 处理 tool 结果
      if (message.tool_call_id && typeof message.content === 'string') {
        geminiContent.parts.push({
          functionResponse: {
            name: 'function',
            response: { result: message.content },
          },
        });
      }

      // 确保至少有一个 part
      if (geminiContent.parts.length === 0) {
        geminiContent.parts.push({ text: '' });
      }

      geminiRequest.contents.push(geminiContent);
    }
  }

  // 转换生成配置
  const generationConfig: GeminiGenerationConfig = {};

  if (typeof body.temperature === 'number') {
    generationConfig.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number') {
    generationConfig.topP = body.top_p;
  }
  if (typeof body.max_tokens === 'number') {
    generationConfig.maxOutputTokens = body.max_tokens;
  }
  if (Array.isArray(body.stop)) {
    generationConfig.stopSequences = body.stop;
  }

  if (Object.keys(generationConfig).length > 0) {
    geminiRequest.generationConfig = generationConfig;
  }

  // 转换 tools
  if (Array.isArray(body.tools)) {
    const functionDeclarations: GeminiFunctionDeclaration[] = body.tools
      .filter(tool => tool.type === 'function' && tool.function)
      .map(tool => ({
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: (tool.function.parameters as any) || { type: 'object', properties: {}, required: [] },
      }));

    if (functionDeclarations.length > 0) {
      geminiRequest.tools = [{ functionDeclarations }];
    }
  }

  return geminiRequest;
};

// ============================================================================
// Gemini → OpenAI Chat 转换
// ============================================================================

/**
 * 将 Gemini finishReason 映射到 OpenAI finish_reason
 */
const mapGeminiFinishReasonToOpenAI = (finishReason?: string): string => {
  switch (finishReason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
      return 'tool_calls';
    default:
      return 'stop';
  }
};

/**
 * 将 Gemini 响应转换为 OpenAI Chat 响应
 */
export const transformGeminiResponseToOpenAIChat = (body: GeminiResponse, model?: string) => {
  const candidate = Array.isArray(body.candidates) && body.candidates.length > 0 ? body.candidates[0] : null;
  const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }> = [];

  // 转换 content parts
  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      const p = part as any;
      // 文本内容
      if (p.text && typeof p.text === 'string') {
        contentParts.push({ type: 'text', text: p.text });
      }

      // functionCall -> tool_calls
      if (p.functionCall) {
        toolCalls.push({
          id: `call_${toolCalls.length}_${Date.now()}`,
          type: 'function',
          function: {
            name: p.functionCall.name || 'tool',
            arguments: JSON.stringify(p.functionCall.args || {}),
          },
        });
      }

      // inlineData (图像输出)
      if (p.inlineData) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
          },
        });
      }
    }
  }

  // 构建消息内容
  let messageContent: string | typeof contentParts;
  if (contentParts.length === 0 && toolCalls.length === 0) {
    messageContent = '';
  } else if (contentParts.length === 1 && contentParts[0].type === 'text' && toolCalls.length === 0) {
    messageContent = contentParts[0].text || '';
  } else {
    messageContent = contentParts;
  }

  const usage = body.usageMetadata ? {
    prompt_tokens: body.usageMetadata.promptTokenCount,
    completion_tokens: body.usageMetadata.candidatesTokenCount,
    total_tokens: body.usageMetadata.totalTokenCount,
  } : undefined;

  return {
    id: `chatcmpl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'gemini',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: messageContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason: mapGeminiFinishReasonToOpenAI(candidate?.finishReason),
    }],
    usage,
  };
};

/**
 * 从 Gemini usage 中提取 TokenUsage
 */
export const extractTokenUsageFromGeminiUsage = (usage?: GeminiUsageMetadata): TokenUsage | undefined => {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
    cacheReadInputTokens: usage.cachedContentTokenCount,
  };
};
