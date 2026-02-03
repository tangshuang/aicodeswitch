import type { TokenUsage } from '../../types';

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown }
  | { type: 'thinking'; thinking?: string }
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
  [key: string]: unknown;
};

const toTextContent = (content: unknown): string | null => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && (item as any).type === 'text' && typeof (item as any).text === 'string') {
      parts.push((item as any).text);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
};

const mapClaudeToolChoiceToOpenAI = (toolChoice: unknown): unknown => {
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
    return toolChoice;
  }
  if (toolChoice && typeof toolChoice === 'object' && (toolChoice as any).name) {
    return {
      type: 'function',
      function: { name: (toolChoice as any).name },
    };
  }
  return toolChoice;
};

export const convertOpenAIUsageToClaude = (usage: any) => {
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  return {
    input_tokens: (usage?.prompt_tokens || 0) - cached,
    output_tokens: usage?.completion_tokens || 0,
    cache_read_input_tokens: cached,
  };
};

export const mapStopReason = (finishReason?: string | null): string => {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'end_turn';
  }
};

/**
 * 检查模型是否需要使用 developer 角色而不是 system 角色
 * 某些 OpenAI 兼容的 API (如 DeepSeek) 不支持 system 角色，需要使用 developer
 */
const shouldUseDeveloperRole = (model?: string): boolean => {
  if (!model) return false;
  const lowerModel = model.toLowerCase();
  // DeepSeek 模型使用 developer 角色
  if (lowerModel.includes('deepseek')) {
    return true;
  }
  // 其他可能需要 developer 角色的模型可以在这里添加
  // 例如:某些国内的 GPT 兼容 API
  return false;
};

/**
 * 智能修复 messages 数组，确保最后一条消息是 role: user
 * OpenAI Chat API 要求对话必须以用户消息结束
 *
 * 处理场景：
 * 1. 最后是 assistant 消息（带 tool_calls）：添加用户消息请求执行工具
 * 2. 最后是 assistant 消息（不带 tool_calls）：添加用户继续提示
 * 3. 最后是 tool 消息：添加用户消息请求处理工具结果
 * 4. 最后是 system/developer 消息：添加初始用户消息
 * 5. 最后已经是 user 消息：不处理
 */
const ensureLastMessageIsUser = (messages: any[]): void => {
  if (!messages || messages.length === 0) {
    return;
  }

  const lastMessage = messages[messages.length - 1];
  const lastRole = lastMessage?.role;

  // 如果最后一条已经是 user，无需处理
  if (lastRole === 'user') {
    return;
  }

  // 场景1: 最后是 assistant 消息且带有 tool_calls
  // 这种情况下，通常后面应该跟 tool 消息，但如果没有，我们需要添加一个用户消息
  if (lastRole === 'assistant' && lastMessage.tool_calls && Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0) {
    messages.push({
      role: 'user',
      content: 'Please proceed with the tool calls.'
    });
    return;
  }

  // 场景2: 最后是 assistant 消息（不带 tool_calls）
  if (lastRole === 'assistant') {
    messages.push({
      role: 'user',
      content: 'Please continue.'
    });
    return;
  }

  // 场景3: 最后是 tool 消息
  if (lastRole === 'tool') {
    messages.push({
      role: 'user',
      content: 'Please analyze the tool results and continue.'
    });
    return;
  }

  // 场景4: 最后是 system/developer 消息
  if (lastRole === 'system' || lastRole === 'developer') {
    messages.push({
      role: 'user',
      content: 'Hello, I need your assistance.'
    });
    return;
  }

  // 其他未知角色，添加通用用户消息
  messages.push({
    role: 'user',
    content: 'Please continue.'
  });
};

export const transformClaudeRequestToOpenAIChat = (body: ClaudeRequest, targetModel?: string) => {
  const messages: any[] = [];
  const useDeveloperRole = shouldUseDeveloperRole(targetModel);
  const systemRoleName = useDeveloperRole ? 'developer' : 'system';

  if (body.system) {
    const systemText = toTextContent(body.system);
    if (systemText) {
      messages.push({ role: systemRoleName, content: systemText });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      // 映射 system 角色到 developer (如果需要)
      const mappedRole = (message.role === 'system' && useDeveloperRole) ? 'developer' : message.role;

      if (typeof message.content === 'string' || message.content === null) {
        // 处理 content 为 null 的情况，使用空字符串替代
        const content = message.content === null ? '' : message.content;
        messages.push({ role: mappedRole, content });
        continue;
      }

      if (Array.isArray(message.content)) {
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        const toolResultMessages: any[] = [];

        for (const block of message.content) {
          if (block && typeof block === 'object') {
            if (block.type === 'text' && typeof (block as any).text === 'string') {
              textParts.push((block as any).text);
            }
            if (block.type === 'tool_use') {
              const toolId = (block as any).id || `tool_${toolCalls.length + 1}`;
              const toolName = (block as any).name || 'tool';
              const input = (block as any).input ?? {};
              toolCalls.push({
                id: toolId,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify(input),
                },
              });
            }
            if (block.type === 'tool_result') {
              const toolCallId = (block as any).tool_use_id || (block as any).id;
              const toolContent = (block as any).content;
              toolResultMessages.push({
                role: 'tool',
                tool_call_id: toolCallId,
                content: typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent ?? {}),
              });
            }
          }
        }

        // 避免 content 为 null，使用空字符串替代
        const content = textParts.length > 0 ? textParts.join('') : '';
        const openaiMessage: any = {
          role: mappedRole,
          content,
        };

        if (toolCalls.length > 0) {
          openaiMessage.tool_calls = toolCalls;
        }
        messages.push(openaiMessage);
        toolResultMessages.forEach((toolMessage) => messages.push(toolMessage));
      }
    }
  }

  // 智能修复：确保最后一条消息是 role: user
  // OpenAI API 要求对话必须以用户消息结束
  ensureLastMessageIsUser(messages);

  const openaiBody: any = {
    model: targetModel || body.model,
    messages,
  };

  if (typeof body.temperature === 'number') openaiBody.temperature = body.temperature;
  if (typeof body.top_p === 'number') openaiBody.top_p = body.top_p;
  if (typeof body.max_tokens === 'number') openaiBody.max_tokens = body.max_tokens;
  if (Array.isArray(body.stop_sequences)) openaiBody.stop = body.stop_sequences;

  if (body.tools) {
    openaiBody.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  if (body.tool_choice) {
    openaiBody.tool_choice = mapClaudeToolChoiceToOpenAI(body.tool_choice);
  }

  if (body.stream === true) {
    openaiBody.stream = true;
    openaiBody.stream_options = { include_usage: true };
  }

  return openaiBody;
};

const extractOpenAIText = (content: unknown): string | null => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && typeof (item as any).text === 'string') {
      parts.push((item as any).text);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
};

export const transformOpenAIChatResponseToClaude = (body: any) => {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  const message = choice?.message || {};
  const contentBlocks: any[] = [];

  const contentText = extractOpenAIText(message.content);
  if (contentText) {
    contentBlocks.push({ type: 'text', text: contentText });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const toolName = toolCall?.function?.name || 'tool';
      let input: unknown = {};
      if (toolCall?.function?.arguments) {
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          input = toolCall.function.arguments;
        }
      }
      contentBlocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolName,
        input,
      });
    }
  }

  const usage = body?.usage ? convertOpenAIUsageToClaude(body.usage) : null;

  return {
    id: body?.id,
    type: 'message',
    role: 'assistant',
    model: body?.model,
    content: contentBlocks,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: usage || {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
};

export const transformClaudeResponseToOpenAIChat = (body: any) => {
  const content = body?.content || [];
  let textContent = '';
  const toolCalls: any[] = [];

  for (const block of content) {
    if (block?.type === 'text') {
      textContent += block.text || '';
    } else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name || 'tool',
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
        },
      });
    }
  }

  const message: any = {
    role: 'assistant',
    content: textContent,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const usage = body?.usage ? {
    prompt_tokens: body.usage.input_tokens || 0,
    completion_tokens: body.usage.output_tokens || 0,
    total_tokens: (body.usage.input_tokens || 0) + (body.usage.output_tokens || 0),
  } : undefined;

  return {
    id: body?.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body?.model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapStopReason(body?.stop_reason),
    }],
    usage,
  };
};

export const extractTokenUsageFromOpenAIUsage = (usage: any): TokenUsage | undefined => {
  if (!usage) return undefined;
  const converted = convertOpenAIUsageToClaude(usage);
  return {
    inputTokens: converted.input_tokens,
    outputTokens: converted.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens: converted.cache_read_input_tokens,
  };
};

export const extractTokenUsageFromClaudeUsage = (usage: any): TokenUsage | undefined => {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: usage.input_tokens !== undefined && usage.output_tokens !== undefined
      ? usage.input_tokens + usage.output_tokens
      : undefined,
    cacheReadInputTokens: usage.cache_read_input_tokens,
  };
};
