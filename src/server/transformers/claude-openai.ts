import type { TokenUsage } from '../../types';
import type { SSEEvent } from './streaming';

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

/**
 * 将 Claude 图像 content block 转换为 OpenAI 格式
 * Claude: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "..." } }
 * OpenAI: { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
 */
const convertClaudeImageToOpenAI = (block: any): any | null => {
  if (!block || typeof block !== 'object' || block.type !== 'image') {
    return null;
  }

  const source = block.source;
  if (!source || typeof source !== 'object') {
    return null;
  }

  let imageUrl: string | null = null;

  // 处理 base64 编码的图像
  if (source.type === 'base64' && source.data && source.media_type) {
    imageUrl = `data:${source.media_type};base64,${source.data}`;
  }
  // 处理 URL 格式的图像
  else if (source.type === 'url' && source.url) {
    imageUrl = source.url;
  }
  // 处理 file_id（如果有的话）
  else if (source.type === 'file' && source.file_id) {
    // file_id 需要特殊处理，这里先保留为占位符
    imageUrl = null; // 需要调用方处理 file_id
  }

  if (!imageUrl) {
    return null;
  }

  return {
    type: 'image_url',
    image_url: {
      url: imageUrl,
      detail: 'auto', // 默认使用 auto，可以根据需要调整
    },
  };
};

/**
 * 将 OpenAI 图像 content block 转换为 Claude 格式
 * OpenAI: { type: "image_url", image_url: { url: "..." } }
 * Claude: { type: "image", source: { type: "base64" | "url", media_type: "...", data/ url: "..." } }
 */
const convertOpenAIImageToClaude = (block: any): any | null => {
  if (!block || typeof block !== 'object' || block.type !== 'image_url') {
    return null;
  }

  const imageUrl = block.image_url?.url;
  if (!imageUrl || typeof imageUrl !== 'string') {
    return null;
  }

  // 检查是否是 data URL (base64)
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: match[1],
          data: match[2],
        },
      };
    }
  }

  // 否则作为 URL 处理
  return {
    type: 'image',
    source: {
      type: 'url',
      url: imageUrl,
    },
  };
};

const toTextContent = (content: unknown): string | null => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object') {
      const block = item as ClaudeContentBlock;
      // 只提取文本内容，忽略图像和其他类型
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  return parts.length > 0 ? parts.join('') : null;
};

/**
 * 将 Claude 的 tool_choice 映射到 OpenAI 格式
 * Claude: "auto" | "any" | {type: "tool", name: string}
 * OpenAI: "auto" | "none" | "required" | {type: "function", function: {name: string}}
 */
const mapClaudeToolChoiceToOpenAI = (toolChoice: unknown): unknown => {
  // 字符串类型直接映射
  if (toolChoice === 'auto' || toolChoice === 'none') {
    return toolChoice;
  }

  // Claude 的 "any" 映射到 OpenAI 的 "required"
  if (toolChoice === 'any' || toolChoice === 'required') {
    return 'required';
  }

  // 对象类型：{type: "tool", name: "tool_name"} -> {type: "function", function: {name: "tool_name"}}
  if (toolChoice && typeof toolChoice === 'object') {
    const tc = toolChoice as any;
    // Claude 格式
    if (tc.type === 'tool' && tc.name) {
      return {
        type: 'function',
        function: { name: tc.name },
      };
    }
    // OpenAI 格式（已经是正确格式）
    if (tc.type === 'function' && tc.function?.name) {
      return toolChoice;
    }
    // 兼容旧的 name 字段格式
    if (tc.name && !tc.type) {
      return {
        type: 'function',
        function: { name: tc.name },
      };
    }
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

/**
 * 将 OpenAI 的 finish_reason 映射到 Claude 的 stop_reason
 * OpenAI: "stop" | "length" | "tool_calls" | "content_filter"
 * Claude: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "max_thinking_length"
 */
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
 * 将 Claude 的 stop_reason 映射到 OpenAI 的 finish_reason
 * Claude: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "max_thinking_length"
 * OpenAI: "stop" | "length" | "tool_calls" | "content_filter"
 */
export const mapClaudeStopReasonToOpenAI = (stopReason?: string | null): string => {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
    case 'max_thinking_length': // Claude 的思考预算用完，映射为 length
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'stop_sequence':
      return 'stop';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
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
    // 处理 system 字段：字符串或数组
    if (typeof body.system === 'string') {
      messages.push({ role: systemRoleName, content: body.system });
    } else if (Array.isArray(body.system)) {
      // system 是数组，提取文本内容
      const systemTexts: string[] = [];
      for (const block of body.system) {
        if (block && typeof block === 'object') {
          const blk = block as any;
          if (blk.type === 'text' && typeof blk.text === 'string') {
            systemTexts.push(blk.text);
          }
          // 注意：OpenAI 的 system 角色不支持图像，忽略图像块
          // 缓存控制块也忽略（OpenAI 不支持）
        }
      }
      if (systemTexts.length > 0) {
        messages.push({ role: systemRoleName, content: systemTexts.join('\n\n') });
      }
    } else if (typeof body.system === 'object') {
      // 单个 system block
      const text = toTextContent([body.system]);
      if (text) {
        messages.push({ role: systemRoleName, content: text });
      }
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
        const imageParts: any[] = []; // OpenAI 格式的图像内容
        const toolCalls: any[] = [];
        const toolResultMessages: any[] = [];
        const thinkingParts: string[] = [];

        for (const block of message.content) {
          if (block && typeof block === 'object') {
            const blockType = (block as any).type;

            // 处理文本内容
            if (blockType === 'text' && typeof (block as any).text === 'string') {
              textParts.push((block as any).text);
            }

            // 处理图像内容 - 转换为 OpenAI 格式
            if (blockType === 'image') {
              const openaiImage = convertClaudeImageToOpenAI(block);
              if (openaiImage) {
                imageParts.push(openaiImage);
              }
            }

            // 处理 thinking content block（转换为文本，因为 OpenAI Chat 不直接支持）
            if (blockType === 'thinking' && typeof (block as any).thinking === 'string') {
              thinkingParts.push((block as any).thinking);
            }

            // 处理工具使用
            if (blockType === 'tool_use') {
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

            // 处理工具结果
            if (blockType === 'tool_result') {
              const toolCallId = (block as any).tool_use_id || (block as any).id;
              const toolContent = (block as any).content;
              const isError = (block as any).is_error;
              toolResultMessages.push({
                role: 'tool',
                tool_call_id: toolCallId,
                content: typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent ?? {}),
                // OpenAI 可能支持 is_error 字段
                ...(isError !== undefined && { is_error: isError }),
              });
            }
          }
        }

        // 构建消息内容
        // 如果有图像，content 必须是数组格式；否则可以是字符串
        let openaiMessage: any;

        if (imageParts.length > 0) {
          // 有图像内容，使用数组格式
          const contentArray: any[] = [];

          // 添加文本部分（如果有）
          if (textParts.length > 0) {
            contentArray.push({
              type: 'text',
              text: textParts.join(''),
            });
          }

          // 添加图像部分
          contentArray.push(...imageParts);

          // 添加 thinking 内容（如果有）
          if (thinkingParts.length > 0) {
            const thinkingText = thinkingParts.join('\n');
            contentArray.push({
              type: 'text',
              text: `<thinking>\n${thinkingText}\n</thinking>`,
            });
          }

          openaiMessage = {
            role: mappedRole,
            content: contentArray,
          };
        } else {
          // 没有图像，使用字符串格式（更简单）
          let content = textParts.length > 0 ? textParts.join('') : '';

          // 如果有 thinking 内容，将其作为前缀添加到文本中（用特殊标记包裹）
          if (thinkingParts.length > 0) {
            const thinkingText = thinkingParts.join('\n');
            content = `<thinking>\n${thinkingText}\n</thinking>\n${content}`;
          }

          openaiMessage = {
            role: mappedRole,
            content: content || '',  // 确保不为 undefined
          };
        }

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

  // 处理 thinking/reasoning 配置的转换
  // Claude: thinking: { type: "enabled" | "disabled" | "auto", budget_tokens?: number }
  // OpenAI Chat: thinking: { type: "enabled" | "disabled" | "auto" }
  // OpenAI Responses: thinking + reasoning (effort)
  // DeepSeek: thinking: { type: "enabled" | "disabled" | "auto" }

  if (body.thinking && typeof body.thinking === 'object') {
    const claudeThinking = body.thinking as { type?: string; budget_tokens?: number };

    // 为所有 OpenAI 兼容 API 添加 thinking 配置
    if (claudeThinking.type) {
      (openaiBody as any).thinking = { type: claudeThinking.type };
    }

    // 为 OpenAI Responses API 添加 reasoning 配置
    // 映射关系：enabled->medium, disabled->minimal, auto->low
    if (claudeThinking.type) {
      const effortMap: Record<string, string> = {
        'enabled': 'medium',
        'disabled': 'minimal',
        'auto': 'low'
      };
      (openaiBody as any).reasoning = {
        effort: (effortMap[claudeThinking.type] || 'medium') as 'minimal' | 'low' | 'medium' | 'high'
      };
    }
  }

  // 处理直接的 reasoning_effort 字段（来自请求体）
  if (body.reasoning_effort || (body.reasoning as any)?.effort) {
    const effort = body.reasoning_effort || (body.reasoning as any)?.effort;
    if (typeof effort === 'string') {
      (openaiBody as any).reasoning = {
        effort: effort as 'minimal' | 'low' | 'medium' | 'high'
      };
    }
  }

  return openaiBody;
};

/**
 * 从 OpenAI 消息内容中提取文本和图像
 * 支持字符串格式和数组格式
 */
const extractOpenAIContent = (content: unknown): { text: string; images: any[] } => {
  const result = { text: '', images: [] as any[] };

  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  if (!Array.isArray(content)) {
    return result;
  }

  for (const item of content) {
    if (item && typeof item === 'object') {
      const block = item as any;

      // 提取文本内容
      if (block.type === 'text' && typeof block.text === 'string') {
        result.text += block.text;
      }

      // 提取图像内容
      if (block.type === 'image_url') {
        const claudeImage = convertOpenAIImageToClaude(block);
        if (claudeImage) {
          result.images.push(claudeImage);
        }
      }
    }
  }

  return result;
};

export const transformOpenAIChatResponseToClaude = (body: any) => {
  const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
  const message = choice?.message || {};
  const contentBlocks: any[] = [];

  // 提取文本和图像内容
  const extractedContent = extractOpenAIContent(message.content);

  // 添加图像内容块
  for (const image of extractedContent.images) {
    contentBlocks.push(image);
  }

  // 添加文本内容块
  if (extractedContent.text) {
    contentBlocks.push({ type: 'text', text: extractedContent.text });
  }

  // 处理 thinking 内容（如果 OpenAI 返回了独立的 thinking 字段）
  // OpenAI Chat Completions API 可能在 message 中包含 thinking
  if (message.thinking && typeof message.thinking === 'string') {
    contentBlocks.unshift({ type: 'thinking', thinking: message.thinking });
  } else if (message.thinking_content) {
    contentBlocks.unshift({ type: 'thinking', thinking: message.thinking_content });
  }

  // 处理 OpenAI Responses API 的 reasoning.summary 和 reasoning content
  // Responses API 可能在 output 数组中包含 reasoning 内容
  if (Array.isArray(body?.output)) {
    for (const outputItem of body.output) {
      // 处理 reasoning summary
      if (outputItem.type === 'reasoning' && outputItem.content) {
        for (const part of outputItem.content) {
          if (part.type === 'summary_text' && part.text) {
            contentBlocks.unshift({ type: 'thinking', thinking: part.text });
          }
        }
      }
      // 处理 message 中的 thinking/reasoning
      if (outputItem.type === 'message' && Array.isArray(outputItem.content)) {
        for (const part of outputItem.content) {
          if (part.type === 'thinking' && part.text) {
            contentBlocks.unshift({ type: 'thinking', thinking: part.text });
          }
        }
      }
    }
  }

  // 处理 reasoning.summary 字段（OpenAI Responses API）
  if (body?.reasoning?.summary && typeof body.reasoning.summary === 'string') {
    contentBlocks.unshift({ type: 'thinking', thinking: body.reasoning.summary });
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
  const imageContents: any[] = []; // OpenAI 格式的图像
  const toolCalls: any[] = [];
  let thinkingContent = '';

  for (const block of content) {
    if (block?.type === 'text') {
      textContent += block.text || '';
    } else if (block?.type === 'image') {
      // 转换 Claude 图像为 OpenAI 格式
      const openaiImage = convertClaudeImageToOpenAI(block);
      if (openaiImage) {
        imageContents.push(openaiImage);
      }
    } else if (block?.type === 'thinking') {
      thinkingContent += block.thinking || '';
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

  // 构建消息内容
  // 如果有图像，使用数组格式；否则使用字符串格式
  let message: any;

  if (imageContents.length > 0) {
    // 有图像，使用数组格式
    const contentArray: any[] = [];

    // 添加文本
    if (textContent) {
      contentArray.push({
        type: 'text',
        text: textContent,
      });
    }

    // 添加图像
    contentArray.push(...imageContents);

    message = {
      role: 'assistant',
      content: contentArray,
    };
  } else {
    // 没有图像，使用字符串格式
    message = {
      role: 'assistant',
      content: textContent,
    };
  }

  // 如果有 thinking 内容，添加到消息中
  if (thinkingContent) {
    message.thinking = thinkingContent;
  }

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
      finish_reason: mapClaudeStopReasonToOpenAI(body?.stop_reason),
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

// ============================================================================
// OpenAI Chat Completions API ↔ OpenAI Responses API 转换
// ============================================================================

/**
 * 将 OpenAI Chat Completions 请求转换为 OpenAI Responses API 请求
 * Chat Completions: {model, messages, tools, temperature, ...}
 * Responses: {model, input, instructions, tools, temperature, ...}
 */
export const transformChatCompletionsToResponses = (body: any) => {
  const responsesBody: any = {
    model: body.model,
  };

  // 转换 messages -> input
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    // 提取最后一条用户消息作为 input
    const lastUserMessage = [...body.messages].reverse().find(m => m.role === 'user');

    if (lastUserMessage) {
      // 处理 content 格式
      if (typeof lastUserMessage.content === 'string') {
        responsesBody.input = lastUserMessage.content;
      } else if (Array.isArray(lastUserMessage.content)) {
        // 保留数组格式（支持图像等）
        responsesBody.input = lastUserMessage.content;
      }
    }

    // 提取 system 消息作为 instructions
    const systemMessage = body.messages.find((m: any) => m.role === 'system' || m.role === 'developer');
    if (systemMessage && typeof systemMessage.content === 'string') {
      responsesBody.instructions = systemMessage.content;
    }

    // 如果有对话历史，可以考虑设置 previous_response_id（需要从之前的响应中获取）
    // 这里暂时不实现，因为需要维护对话状态
  }

  // 转换参数
  if (typeof body.temperature === 'number') {
    responsesBody.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number') {
    responsesBody.top_p = body.top_p;
  }
  if (typeof body.max_tokens === 'number') {
    responsesBody.max_output_tokens = body.max_tokens;
  }

  // 转换 tools
  if (Array.isArray(body.tools)) {
    responsesBody.tools = body.tools;
  }

  if (body.tool_choice) {
    responsesBody.tool_choice = body.tool_choice;
  }

  // 转换流式选项
  if (body.stream === true) {
    responsesBody.stream = true;
  }

  // 转换 reasoning 配置
  if (body.reasoning && typeof body.reasoning === 'object') {
    responsesBody.reasoning = body.reasoning;
  }

  // 转换其他配置
  if (body.metadata) {
    responsesBody.metadata = body.metadata;
  }

  return responsesBody;
};

/**
 * 将 OpenAI Responses API 响应转换为 Chat Completions 格式
 * Responses: {id, object: "response", output: [{type: "message", content: [...]}], usage, ...}
 * Chat Completions: {id, object: "chat.completion", choices: [{message: {content, ...}}], usage, ...}
 */
export const transformResponsesToChatCompletions = (body: any) => {
  if (!body || typeof body !== 'object') {
    return body;
  }

  // 提取消息内容
  let textContent = '';
  const thinkingContent: string[] = [];
  const toolCalls: any[] = [];

  // 遍历 output 数组
  if (Array.isArray(body.output)) {
    for (const outputItem of body.output) {
      if (outputItem.type === 'message' && Array.isArray(outputItem.content)) {
        for (const part of outputItem.content) {
          // 处理文本输出
          if (part.type === 'output_text' && typeof part.text === 'string') {
            textContent += part.text;
          }
          // 处理思考内容
          if (part.type === 'thinking' && typeof part.text === 'string') {
            thinkingContent.push(part.text);
          }
        }
      }
      // 处理 reasoning summary
      if (outputItem.type === 'reasoning' && Array.isArray(outputItem.content)) {
        for (const part of outputItem.content) {
          if (part.type === 'summary_text' && typeof part.text === 'string') {
            thinkingContent.push(part.text);
          }
        }
      }
      // 处理工具调用（如果有）
      if (outputItem.type === 'function_call') {
        toolCalls.push({
          id: outputItem.id || `call_${toolCalls.length}`,
          type: 'function',
          function: {
            name: outputItem.name || 'unknown',
            arguments: outputItem.arguments || '{}',
          },
        });
      }
    }
  }

  // 构建消息对象
  const message: any = {
    role: 'assistant',
    content: textContent,
  };

  // 添加 thinking 内容
  if (thinkingContent.length > 0) {
    message.thinking = thinkingContent.join('\n\n');
  }

  // 添加工具调用
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  // 转换 usage
  const usage = body.usage ? {
    prompt_tokens: body.usage.input_tokens || 0,
    completion_tokens: body.usage.output_tokens || 0,
    total_tokens: (body.usage.input_tokens || 0) + (body.usage.output_tokens || 0),
  } : undefined;

  // 转换 finish_reason
  let finish_reason = 'stop';
  if (body.status === 'incomplete') {
    finish_reason = body.incomplete_details?.reason === 'max_tokens' ? 'length' : 'stop';
  }

  return {
    id: body.id,
    object: 'chat.completion',
    created: body.created_at || Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{
      index: 0,
      message,
      finish_reason,
    }],
    usage,
  };
};

/**
 * 将 OpenAI Chat Completions 流式事件转换为 Responses API 流式事件格式
 * 这主要用于解析不同格式的流式响应
 */
export const normalizeOpenAIStreamEvent = (event: SSEEvent): SSEEvent => {
  const type = event.event;

  // 如果是 Responses API 事件，直接返回
  if (type && type.startsWith('response.')) {
    return event;
  }

  // Chat Completions API 事件
  // 实际的转换在 streaming.ts 的转换器中处理
  return event;
};

