import type { TokenUsage } from '../../types';

type OpenAIInputContentItem = {
  type?: string;
  text?: string;
  image_url?: string | { url?: string };
  [key: string]: unknown;
};

type OpenAIInputMessage = {
  role?: string;
  content?: string | OpenAIInputContentItem[];
};

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'url' | 'base64'; url?: string; media_type?: string; data?: string } }
  | { type: 'tool_use'; id?: string; name: string; input?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown }
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

const decodeDataUrl = (dataUrl: string) => {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
};

const buildClaudeContentFromOpenAIContent = (
  content: string | OpenAIInputContentItem[] | undefined
): string | ClaudeContentBlock[] | null => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) return null;

  const blocks: ClaudeContentBlock[] = [];
  for (const item of content) {
    const itemType = item?.type;
    if (itemType === 'input_text' || itemType === 'output_text' || itemType === 'text') {
      if (typeof item.text === 'string') {
        blocks.push({ type: 'text', text: item.text });
      }
      continue;
    }
    if (itemType === 'input_image' || itemType === 'image_url' || itemType === 'image') {
      const url = typeof item.image_url === 'string' ? item.image_url : item.image_url?.url;
      if (url && url.startsWith('data:')) {
        const decoded = decodeDataUrl(url);
        if (decoded) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: decoded.mediaType, data: decoded.data },
          });
          continue;
        }
      }
      if (url) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
  }

  if (blocks.length === 0) return null;
  return blocks;
};

const extractTextFromOpenAIContent = (content: string | OpenAIInputContentItem[] | undefined) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if ((item?.type === 'input_text' || item?.type === 'output_text' || item?.type === 'text') && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('');
};

const normalizeOpenAIInputMessages = (input: any): OpenAIInputMessage[] => {
  if (!input) return [];
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return input as OpenAIInputMessage[];
  }
  if (typeof input === 'object' && (input as OpenAIInputMessage).role) {
    return [input as OpenAIInputMessage];
  }
  return [];
};

const mapOpenAIToolChoiceToClaude = (toolChoice: any): unknown => {
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
    return toolChoice;
  }
  if (toolChoice && typeof toolChoice === 'object') {
    const functionName = toolChoice.function?.name || toolChoice.name;
    if (functionName) {
      return { type: 'tool', name: functionName };
    }
  }
  return toolChoice;
};

const mapClaudeToolChoiceToOpenAI = (toolChoice: any): unknown => {
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
    return toolChoice;
  }
  if (toolChoice && typeof toolChoice === 'object') {
    const name = (toolChoice as any).name;
    if (name) {
      return { type: 'function', function: { name } };
    }
  }
  return toolChoice;
};

const mapClaudeContentToOpenAIInput = (content: string | ClaudeContentBlock[] | null) => {
  if (typeof content === 'string' || content === null) {
    return content;
  }
  if (!Array.isArray(content)) return null;

  const parts: any[] = [];
  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof (block as any).text === 'string') {
      textParts.push((block as any).text);
      continue;
    }
    if (block.type === 'image' && (block as any).source) {
      const source = (block as any).source;
      if (source.type === 'url' && source.url) {
        parts.push({ type: 'input_image', image_url: source.url });
      }
      if (source.type === 'base64' && source.data) {
        const mediaType = source.media_type || 'application/octet-stream';
        parts.push({ type: 'input_image', image_url: `data:${mediaType};base64,${source.data}` });
      }
    }
    if (block.type === 'tool_result') {
      const toolContent = (block as any).content;
      if (toolContent !== undefined) {
        textParts.push(typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent));
      }
    }
  }

  if (parts.length === 0) {
    return textParts.join('') || null;
  }

  if (textParts.length > 0) {
    parts.unshift({ type: 'input_text', text: textParts.join('') });
  }
  return parts;
};

const extractTextFromClaudeContent = (content: string | ClaudeContentBlock[] | null | undefined) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof (block as any).text === 'string') {
      parts.push((block as any).text);
    }
  }
  return parts.join('');
};

export const transformOpenAIResponsesRequestToClaude = (body: any, targetModel?: string): ClaudeRequest => {
  const inputMessages = normalizeOpenAIInputMessages(body?.input);
  const messages: ClaudeMessage[] = inputMessages.map((message) => {
    const role =
      message.role === 'assistant'
        ? 'assistant'
        : message.role === 'system' || message.role === 'developer'
          ? 'system'
          : message.role === 'tool'
            ? 'tool'
            : 'user';
    const contentBlocks = buildClaudeContentFromOpenAIContent(message.content);
    return {
      role,
      content: contentBlocks ?? extractTextFromOpenAIContent(message.content) ?? null,
    };
  });

  const tools = Array.isArray(body?.tools)
    ? body.tools
        .map((tool: any) => tool?.function ? ({
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters,
        }) : null)
        .filter(Boolean)
    : undefined;

  return {
    model: targetModel || body?.model,
    messages,
    system: body?.instructions,
    max_tokens: body?.max_output_tokens ?? body?.max_tokens,
    temperature: body?.temperature,
    top_p: body?.top_p,
    stream: body?.stream,
    tools,
    tool_choice: body?.tool_choice ? mapOpenAIToolChoiceToClaude(body.tool_choice) : undefined,
    stop_sequences: body?.stop,
  };
};

export const transformOpenAIResponsesRequestToOpenAIChat = (body: any, targetModel?: string) => {
  const inputMessages = normalizeOpenAIInputMessages(body?.input);
  const messages = inputMessages.map((message) => ({
    role: message.role || 'user',
    content: extractTextFromOpenAIContent(message.content),
  }));

  if (typeof body?.instructions === 'string' && body.instructions.trim().length > 0) {
    messages.unshift({ role: 'system', content: body.instructions });
  }

  const openaiBody: any = {
    model: targetModel || body?.model,
    messages,
  };

  if (typeof body?.temperature === 'number') openaiBody.temperature = body.temperature;
  if (typeof body?.top_p === 'number') openaiBody.top_p = body.top_p;
  if (typeof body?.max_output_tokens === 'number') openaiBody.max_tokens = body.max_output_tokens;
  if (typeof body?.max_tokens === 'number' && openaiBody.max_tokens === undefined) openaiBody.max_tokens = body.max_tokens;
  if (Array.isArray(body?.stop)) openaiBody.stop = body.stop;

  if (body?.tools) {
    openaiBody.tools = body.tools;
  }
  if (body?.tool_choice) {
    openaiBody.tool_choice = body.tool_choice;
  }
  if (body?.stream === true) {
    openaiBody.stream = true;
    openaiBody.stream_options = { include_usage: true };
  }

  return openaiBody;
};

export const transformClaudeRequestToOpenAIResponses = (body: ClaudeRequest, targetModel?: string) => {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = messages.map((message) => ({
    role: message.role,
    content: mapClaudeContentToOpenAIInput(message.content),
  }));

  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }))
    : undefined;

  const openaiBody: any = {
    model: targetModel || body.model,
    input,
    instructions: extractTextFromClaudeContent(body.system),
    stream: body.stream,
    tools,
    tool_choice: body.tool_choice ? mapClaudeToolChoiceToOpenAI(body.tool_choice) : undefined,
    temperature: body.temperature,
    top_p: body.top_p,
    max_output_tokens: body.max_tokens,
  };

  if (Array.isArray(body.stop_sequences)) {
    openaiBody.stop = body.stop_sequences;
  }

  return openaiBody;
};

const extractOutputItems = (body: any) => {
  const outputItems = Array.isArray(body?.output) ? body.output : [];
  const contentBlocks: ClaudeContentBlock[] = [];

  for (const item of outputItems) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message') {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          contentBlocks.push({ type: 'text', text: part.text });
        }
      }
    }

    if (item.type === 'output_text' && typeof item.text === 'string') {
      contentBlocks.push({ type: 'text', text: item.text });
    }

    if (item.type === 'tool_call' || item.type === 'function_call' || item?.name) {
      let parsedArgs: unknown = item.arguments ?? item.input;
      if (typeof parsedArgs === 'string') {
        try {
          parsedArgs = JSON.parse(parsedArgs);
        } catch {
          // keep string
        }
      }
      contentBlocks.push({
        type: 'tool_use',
        id: item.id || item.tool_call_id,
        name: item.name || item.function?.name || 'tool',
        input: parsedArgs,
      });
    }
  }

  return contentBlocks;
};

export const transformOpenAIResponsesToClaude = (body: any) => {
  const responseBody = body?.response ?? body;
  const contentBlocks = extractOutputItems(responseBody);
  const usage = responseBody?.usage;
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    id: responseBody?.id,
    type: 'message',
    role: 'assistant',
    model: responseBody?.model,
    content: contentBlocks,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
    },
  };
};

export const transformClaudeResponseToOpenAIResponses = (body: any) => {
  const contentBlocks = Array.isArray(body?.content) ? body.content : [];
  const outputTextParts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof (block as any).text === 'string') {
      outputTextParts.push((block as any).text);
    }
    if (block.type === 'tool_use') {
      const args = (block as any).input ?? {};
      toolCalls.push({
        id: (block as any).id || `tool_${toolCalls.length + 1}`,
        name: (block as any).name || 'tool',
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      });
    }
  }

  const outputText = outputTextParts.join('');
  const outputItems: any[] = [];
  if (outputText) {
    outputItems.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText }],
    });
  }

  for (const toolCall of toolCalls) {
    outputItems.push({
      type: 'tool_call',
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    });
  }

  const inputTokens = body?.usage?.input_tokens ?? 0;
  const cacheRead = body?.usage?.cache_read_input_tokens ?? 0;
  const outputTokens = body?.usage?.output_tokens ?? 0;
  const usage = {
    input_tokens: inputTokens + cacheRead,
    output_tokens: outputTokens,
    total_tokens: inputTokens + cacheRead + outputTokens,
  };

  return {
    id: body?.id,
    object: 'response',
    model: body?.model,
    output: outputItems,
    output_text: outputText,
    status: 'completed',
    usage,
  };
};

export const extractTokenUsageFromOpenAIResponsesUsage = (usage: any): TokenUsage | undefined => {
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
};
