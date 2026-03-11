/**
 * 请求转换器统一导出文件
 * 提供语义化的函数名，明确表示转换的方向
 */

/**
 * 判断请求是否为 Responses API 的请求格式
 */
export const isResponsesRequest = (data: any): boolean => {
  // Responses API 格式的特征：有 input 字段，没有 messages 字段
  return data && typeof data === 'object' &&
         'input' in data &&
         !('messages' in data);
};

/**
 * 判断是否使用developer作为系统提示词角色，而不使用system作为角色
 * @param model
 * @returns
 */
export const shouldUseDeveloperRoleAsSystemRole = (model: string): boolean => {
  const modelsToUseSystemPrefix = `gpt-2,gpt-3,gpt-4`.split(',');
  if (modelsToUseSystemPrefix.some(item => model.toLowerCase().startsWith(item))) {
    return false;
  }

  // gpt-的更高版本模型都是developer
  const modelsToUseDeveloper = `o1,o2,o3,gpt-`.split(',');
  if (modelsToUseDeveloper.some(item => model.toLowerCase().startsWith(item))) {
    return true;
  }

  // 其他非openai的模型都是system
  return false;
}

export const isRequestOpenAIModels = (model: string) => {
  if (!model || typeof model !== 'string') {
    return false;
  }
  const gptModelNames = 'gpt-,o1,o2,o3'.split(',');
  return gptModelNames.some(item => model.toLowerCase().startsWith(item));
};

/**
 * 对模型属性进行覆盖
 * @param data
 * @param realModelName 真正提交到API接口的模型名称
 * @returns
 */
export const applyModelOverride = (data: any, realModelName?: string) => {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (!realModelName) {
    return data;
  }

  return { ...data, model: realModelName };
};

/**
 * 对工具属性进行覆盖
 * @param tools
 * @param realModelName 提交到API的真实模型名称
 */
export const applyToolsOverride = (tools: any[], realModelName: string) => {
  if (!tools) {
    return;
  }
  if (isRequestOpenAIModels(realModelName)) {
    return tools;
  }
  return tools.map((tool) => {
    const { type, parameters, format, description, ...others } = tool;
    if (type === 'custom') {
      return {
        ...others,
        type: 'function',
        description: `${description}${format ? '\n\nFormat: ' + JSON.stringify(format) : ''}`,
        parameters: parameters || {},
      };
    }
    return tool;
  }).filter(item => item.type === 'function');
};

/**
 * 对 payload 进行简单处理
 * @param data
 * @param realModelName 提交到API的真实模型名称
 * @returns
 */
export const applyPayloadOverride = (data: any, realModelName: string) => {
  if (isRequestOpenAIModels(realModelName)) {
    return data;
  }

  const overrided = applyModelOverride(data, realModelName);

  return overrided;

  // const tools = applyToolsOverride(data.tools, realModelName);

  // if (overrided.text) {
  //   delete overrided.text.verbosity;
  // }

  // delete overrided.prompt_cache_key;
  // delete overrided.include;

  // return {
  //   ...overrided,
  //   tools,
  // };
}

const GEMINI_ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
]);

/**
 * Gemini FunctionDeclaration.parameters 仅支持 OpenAPI 子集。
 * 这里将通用 JSON Schema 清洗为 Gemini 可接受的结构，避免 400 Unknown name 错误。
 */
export const sanitizeSchemaForGeminiFunctionDeclaration = (schema: any): any => {
  const sanitize = (value: any): any => {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item)).filter((item) => item !== undefined);
    }

    const result: any = {};
    const sourceType = value.type;

    // JSON Schema type 允许数组（如 ["object", "null"]），Gemini 仅接受字符串
    if (Array.isArray(sourceType)) {
      const nonNullType = sourceType.find((t) => typeof t === 'string' && t !== 'null');
      if (typeof nonNullType === 'string') {
        result.type = nonNullType;
      }
      if (sourceType.includes('null')) {
        result.nullable = true;
      }
    } else if (typeof sourceType === 'string') {
      result.type = sourceType;
    }

    // const 在 Gemini schema 中不被接受，降级为单值 enum
    if (value.const !== undefined) {
      result.enum = [value.const];
    }

    for (const key of Object.keys(value)) {
      if (!GEMINI_ALLOWED_SCHEMA_KEYS.has(key)) {
        continue;
      }

      // type 已在上方做过标准化（string / nullable）
      if (key === 'type') {
        continue;
      }

      if (key === 'properties' && value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
        const cleanedProperties: Record<string, any> = {};
        for (const [propKey, propValue] of Object.entries(value.properties)) {
          const cleanedProperty = sanitize(propValue);
          if (cleanedProperty !== undefined) {
            cleanedProperties[propKey] = cleanedProperty;
          }
        }
        result.properties = cleanedProperties;
        continue;
      }

      if (key === 'items') {
        const cleanedItems = sanitize(value.items);
        if (cleanedItems !== undefined) {
          result.items = cleanedItems;
        }
        continue;
      }

      result[key] = value[key];
    }

    if (!result.type) {
      if (result.properties) {
        result.type = 'object';
      } else if (result.items) {
        result.type = 'array';
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  };

  return sanitize(schema) || { type: 'object', properties: {} };
};

const isValidThinkingBudget = (value: any): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const createGeminiThinkingConfigFromClaudeThinking = (thinking: any): any | undefined => {
  if (!thinking || typeof thinking !== 'object') {
    return undefined;
  }

  const hasBudget = isValidThinkingBudget(thinking.budget_tokens);
  const thinkingConfig: any = {};

  if (thinking.type === 'enabled') {
    thinkingConfig.includeThoughts = true;
    if (hasBudget) {
      thinkingConfig.thinkingBudget = thinking.budget_tokens;
    } else {
      thinkingConfig.thinkingLevel = 'HIGH';
    }
  } else if (thinking.type === 'auto') {
    thinkingConfig.includeThoughts = true;
    if (hasBudget) {
      thinkingConfig.thinkingBudget = thinking.budget_tokens;
    } else {
      thinkingConfig.thinkingLevel = 'LOW';
    }
  } else if (thinking.type === 'disabled') {
    thinkingConfig.includeThoughts = false;
  }

  return Object.keys(thinkingConfig).length > 0 ? thinkingConfig : undefined;
};

const createGeminiThinkingConfigFromResponsesReasoning = (reasoning: any): any | undefined => {
  if (!reasoning || typeof reasoning !== 'object') {
    return undefined;
  }

  const hasBudget = isValidThinkingBudget(reasoning.budget_tokens);
  const thinkingConfig: any = {};

  if (reasoning.type === 'enabled' || reasoning.type === 'auto') {
    thinkingConfig.includeThoughts = true;
    if (hasBudget) {
      thinkingConfig.thinkingBudget = reasoning.budget_tokens;
    } else if (reasoning.effort === 'low') {
      thinkingConfig.thinkingLevel = 'LOW';
    } else if (reasoning.effort === 'medium') {
      thinkingConfig.thinkingLevel = 'MEDIUM';
    } else if (reasoning.effort === 'high') {
      thinkingConfig.thinkingLevel = 'HIGH';
    }
  } else if (reasoning.type === 'disabled') {
    thinkingConfig.includeThoughts = false;
  }

  return Object.keys(thinkingConfig).length > 0 ? thinkingConfig : undefined;
};

/**
 * 从 Gemini usage 中提取 TokenUsage
 */
export const extractTokenUsageFromGeminiUsage = (usage?: any) => {
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

export const extractTokenUsageFromOpenAIUsage = (usage: any) => {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens || usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens: usage.cached_tokens,
  };
};

export const extractTokenUsageFromClaudeUsage = (usage: any) => {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: usage.input_tokens !== undefined && usage.output_tokens !== undefined
      ? usage.input_tokens + usage.output_tokens
      : undefined,
    cacheReadInputTokens: usage.cache_read_input_tokens,
  };
};

// ------------------------- codex 发起请求 -------------------------

/**
 * 将 codex 发起的对 Responses API 的请求转换为对 Gemini API 的请求的数据格式
 */
export function transformRequestFromResponsesToGemini(body: any, _targetModel?: string): any {
  const { instructions, input, max_output_tokens, max_tokens, temperature, top_p, stop, tools, tool_choice, reasoning } = body;

  const geminiRequest: any = {
    contents: [],
  };

  // 处理 instructions 字段（系统提示词）
  if (instructions && typeof instructions === 'string') {
    geminiRequest.systemInstruction = {
      role: 'user',
      parts: [{ text: instructions }],
    };
  }

  // 处理 input 字段（消息数组）
  if (Array.isArray(input)) {
    for (const msg of input) {
      if (!msg || msg.type !== 'message') {
        continue;
      }

      // Gemini API 不支持 developer 角色，映射为 user
      const geminiRole = msg.role === 'assistant' ? 'model' : 'user';

      const geminiContent: any = {
        role: geminiRole,
        parts: [],
      };

      // 处理 content 数组
      if (Array.isArray(msg.content)) {
        for (const contentItem of msg.content) {
          if (!contentItem || typeof contentItem !== 'object') {
            continue;
          }

          // 处理文本内容: input_text -> text
          if (contentItem.type === 'input_text' && typeof contentItem.text === 'string') {
            geminiContent.parts.push({ text: contentItem.text });
          }

          // 处理图像内容: input_image -> inlineData
          if (contentItem.type === 'input_image' && contentItem.image_url) {
            const imageUrl = contentItem.image_url.url;
            if (typeof imageUrl === 'string') {
              if (imageUrl.startsWith('data:')) {
                // 处理 base64 格式图像
                const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  geminiContent.parts.push({
                    inlineData: {
                      mimeType: match[1],
                      data: match[2],
                    },
                  });
                }
              }
              // URL 格式需要下载后转换，这里暂时跳过
            }
          }
        }
      }

      // 处理字符串格式 content
      else if (typeof msg.content === 'string') {
        geminiContent.parts.push({ text: msg.content });
      }

      // 确保至少有一个 part
      if (geminiContent.parts.length === 0) {
        geminiContent.parts.push({ text: '' });
      }

      geminiRequest.contents.push(geminiContent);
    }
  }

  // 构建生成配置
  const generationConfig: any = {};

  if (typeof temperature === 'number') {
    generationConfig.temperature = temperature;
  }

  if (typeof top_p === 'number') {
    generationConfig.topP = top_p;
  }

  if (typeof max_output_tokens === 'number') {
    generationConfig.maxOutputTokens = max_output_tokens;
  } else if (typeof max_tokens === 'number') {
    generationConfig.maxOutputTokens = max_tokens;
  }

  // 处理 stop: Responses API 是数组，Gemini 也是数组
  if (Array.isArray(stop)) {
    generationConfig.stopSequences = stop;
  } else if (typeof stop === 'string') {
    generationConfig.stopSequences = [stop];
  }

  // 处理 reasoning -> thinkingConfig
  if (reasoning) {
    const thinkingConfig = createGeminiThinkingConfigFromResponsesReasoning(reasoning);
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig;
    }
  }

  if (Object.keys(generationConfig).length > 0) {
    geminiRequest.generationConfig = generationConfig;
  }

  // 转换 tools
  if (Array.isArray(tools)) {
    const functionDeclarations: any[] = [];
    for (const tool of tools) {
      if (tool && tool.type === 'function' && tool.function) {
        functionDeclarations.push({
          name: tool.function.name,
          description: tool.function.description || '',
          parameters: sanitizeSchemaForGeminiFunctionDeclaration(tool.function.parameters || { type: 'object', properties: {}, required: [] }),
        });
      }
    }

    if (functionDeclarations.length > 0) {
      geminiRequest.tools = [{ functionDeclarations }];
    }
  }

  // 转换 tool_choice -> toolConfig
  if (tool_choice !== undefined) {
    const toolConfig: any = { functionCallingConfig: {} };

    if (tool_choice === 'auto') {
      toolConfig.functionCallingConfig.mode = 'AUTO';
    } else if (tool_choice === 'required' || tool_choice === 'any') {
      toolConfig.functionCallingConfig.mode = 'ANY';
    } else if (tool_choice === 'none') {
      toolConfig.functionCallingConfig.mode = 'NONE';
    } else if (typeof tool_choice === 'object' && tool_choice.type === 'function') {
      const tc = tool_choice;
      if (tc.function?.name) {
        toolConfig.functionCallingConfig.mode = 'ANY';
        toolConfig.functionCallingConfig.allowedFunctionNames = [tc.function.name];
      }
    }

    if (Object.keys(toolConfig.functionCallingConfig).length > 0) {
      geminiRequest.toolConfig = toolConfig;
    }
  }

  return geminiRequest;
}

/**
 * 将 codex 发起的对 Responses API 的请求转换为对 Claude API 的请求的数据格式
 */
export function transformRequestFromResponsesToClaude(body: any, targetModel?: string): any {
  const { model, instructions, input, max_output_tokens, max_tokens, temperature, top_p, stop, tools, tool_choice } = body;

  const messages: any[] = [];

  // 1. 处理 instructions 字段（系统提示词）
  // Claude API 使用 system 字段，不在 messages 中
  let system = '';
  if (instructions && typeof instructions === 'string') {
    system = instructions;
  }

  // 2. 处理 input 字段（消息数组）
  if (Array.isArray(input)) {
    for (const msg of input) {
      if (!msg || msg.type !== 'message') {
        continue;
      }

      // 提取 content 数组中的内容
      const contentBlocks: any[] = [];

      if (Array.isArray(msg.content)) {
        for (const contentItem of msg.content) {
          if (!contentItem || typeof contentItem !== 'object') {
            continue;
          }

          // input_text -> text
          if (contentItem.type === 'input_text' && typeof contentItem.text === 'string') {
            contentBlocks.push({ type: 'text', text: contentItem.text });
          }

          // input_image -> image（Claude 格式）
          if (contentItem.type === 'input_image' && contentItem.image_url) {
            const imageUrl = contentItem.image_url.url;
            if (typeof imageUrl === 'string') {
              if (imageUrl.startsWith('data:')) {
                const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (match) {
                  contentBlocks.push({
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: match[1],
                      data: match[2],
                    },
                  });
                }
              } else {
                // URL 格式
                contentBlocks.push({
                  type: 'image',
                  source: {
                    type: 'url',
                    url: imageUrl,
                  },
                });
              }
            }
          }
        }
      } else if (typeof msg.content === 'string') {
        contentBlocks.push({ type: 'text', text: msg.content });
      }

      // 映射角色: developer -> user
      const role = msg.role === 'developer' ? 'user' : msg.role;

      // 添加到 messages 数组
      if (contentBlocks.length > 0) {
        messages.push({
          role,
          content: contentBlocks,
        });
      }
    }
  }

  // 3. 构建转换后的请求
  const transformed: any = {
    model: targetModel || model,
    max_tokens: max_output_tokens || max_tokens,
  };

  // 添加 messages
  if (messages.length > 0) {
    transformed.messages = messages;
  }

  // 添加 system
  if (system) {
    transformed.system = system;
  }

  // 4. 处理工具定义转换
  // Responses API: { type: "function", function: { name, description, parameters } }
  // Claude: { name, description, input_schema: parameters }
  if (Array.isArray(tools)) {
    transformed.tools = tools.map((tool: any) => {
      if (tool && tool.type === 'function' && tool.function) {
        return {
          name: tool.function.name,
          description: tool.function.description || '',
          input_schema: tool.function.parameters || { type: 'object', properties: {}, required: [] },
        };
      }
      return null;
    }).filter(Boolean);
  }

  // 5. 处理 tool_choice 映射
  // Responses API: "auto" | "required" | "none" | { type: "function", function: { name } }
  // Claude: "auto" | "any" | "none" | { type: "tool", name: string }
  if (tool_choice !== undefined) {
    if (tool_choice === 'auto') {
      transformed.tool_choice = 'auto';
    } else if (tool_choice === 'required') {
      transformed.tool_choice = 'any';
    } else if (tool_choice === 'none') {
      transformed.tool_choice = 'none';
    } else if (typeof tool_choice === 'object' && tool_choice.type === 'function') {
      const tc = tool_choice;
      if (tc.function?.name) {
        transformed.tool_choice = {
          type: 'tool',
          name: tc.function.name,
        };
      }
    }
  }

  // 6. 处理其他参数
  if (typeof temperature === 'number') {
    transformed.temperature = temperature;
  }

  if (typeof top_p === 'number') {
    transformed.top_p = top_p;
  }

  if (body.stream !== undefined) {
    transformed.stream = body.stream;
  }

  // 处理 stop: Responses API 是数组，Claude 是 stop_sequences
  if (Array.isArray(stop)) {
    transformed.stop_sequences = stop;
  } else if (typeof stop === 'string') {
    transformed.stop_sequences = [stop];
  }

  return transformed;
}

/**
 * 将 codex 发起的对 Responses API 的请求转换为对 Chat Completions API 的请求的数据格式
 * @param body Responses API 格式的请求体
 * @param targetModel 目标模型名称（可选）
 * @returns Chat Completions API 格式的请求体
 */
export function transformRequestFromResponsesToChatCompletions(body: any, targetModel?: string): any {
  const { model, instructions, input, max_output_tokens, reasoning, tools, tool_choice, parallel_tool_calls, max_tool_calls, ...others } = body;

  /**
   * 将 Responses API 的 content item 转换为 Chat Completions 格式
   * Responses API: { type: "input_text", text: "..." }
   * Chat Completions: { type: "text", text: "..." }
   * Responses API: { type: "input_image", image_url: { url: "..." } }
   * Chat Completions: { type: "image_url", image_url: { url: "..." } }
   */
  const transformResponsesContentItemToChatCompletionContentItem = (item: any): any => {
    if (!item || typeof item !== 'object') {
      return null;
    }

    if (item.type === 'input_text') {
      return { type: 'text', text: item.text };
    }

    if (item.type === 'input_image' && item.image_url) {
      return { type: 'image_url', image_url: item.image_url };
    }

    // 其他类型直接返回
    return item;
  };

  // 输入验证：检查 input 是否为数组
  if (!Array.isArray(input)) {
    // 如果 input 不是数组，尝试处理字符串格式
    const messages: any[] = [];
    const systemRole = shouldUseDeveloperRoleAsSystemRole(targetModel || model) ? 'developer' : 'system';

    // 处理 instructions
    if (instructions && typeof instructions === 'string') {
      messages.push({
        role: systemRole,
        content: instructions,
      });
    }

    // 处理 input（如果是字符串）
    if (typeof input === 'string' && input) {
      messages.push({
        role: 'user',
        content: input,
      });
    }

    // 构建转换后的请求
    const result: any = {
      model: targetModel || model,
      messages,
    };

    // 处理 max_tokens（Responses API 使用 max_output_tokens）
    if (typeof max_output_tokens === 'number') {
      result.max_tokens = max_output_tokens;
    } else if (typeof others.max_tokens === 'number') {
      result.max_tokens = others.max_tokens;
    }

    // 处理 tools
    if (Array.isArray(tools)) {
      result.tools = tools;
    }

    // 处理 tool_choice
    if (tool_choice !== undefined) {
      result.tool_choice = tool_choice;
    }

    // 处理 parallel_tool_calls
    if (parallel_tool_calls !== undefined) {
      result.parallel_tool_calls = parallel_tool_calls;
    }

    // 处理 reasoning（Chat Completions API 可能不直接支持，但保留用于兼容）
    if (reasoning) {
      result.reasoning = reasoning;
    }

    // 添加其他兼容的字段（temperature, top_p, stream 等）
    const compatibleFields = ['temperature', 'top_p', 'stream', 'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'user', 'response_format'];
    for (const field of compatibleFields) {
      if (others[field] !== undefined) {
        result[field] = others[field];
      }
    }

    return result;
  }

  // 提取 developer 消息和普通消息
  const developerItems = input.filter((item: any) => item.type === 'message' && item.role === 'developer');
  const nonDeveloperItems = input.filter((item: any) => item.type === 'message' && item.role !== 'developer');

  // 构建 messages 数组
  const messages: any[] = [];

  // 处理系统/developer 消息
  const systemRole = shouldUseDeveloperRoleAsSystemRole(targetModel || model) ? 'developer' : 'system';
  const systemContentItems: any[] = [];

  // 添加 instructions
  if (instructions && typeof instructions === 'string') {
    systemContentItems.push({ type: 'text', text: instructions });
  }

  // 添加 developer 消息中的内容
  for (const item of developerItems) {
    if (!item) continue;
    const itemContent = Array.isArray(item.content)
      ? item.content.map(transformResponsesContentItemToChatCompletionContentItem).filter(Boolean)
      : (typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : []);
    systemContentItems.push(...itemContent);
  }

  // 只有当有系统内容时才添加系统消息
  if (systemContentItems.length > 0) {
    messages.push({
      role: systemRole,
      content: systemContentItems,
    });
  }

  // 处理非 developer 消息
  for (const item of nonDeveloperItems) {
    if (!item || item.type !== 'message') continue;

    const messageContent = Array.isArray(item.content)
      ? item.content.map(transformResponsesContentItemToChatCompletionContentItem).filter(Boolean)
      : (typeof item.content === 'string' ? item.content : []);

    messages.push({
      role: item.role,
      content: messageContent,
    });
  }

  // 构建转换后的请求
  const result: any = {
    model: targetModel || model,
    messages,
  };

  // 处理 max_tokens（Responses API 使用 max_output_tokens）
  if (typeof max_output_tokens === 'number') {
    result.max_tokens = max_output_tokens;
  } else if (typeof others.max_tokens === 'number') {
    result.max_tokens = others.max_tokens;
  }

  // 处理 tools：需要确保格式正确且不包含空函数
  if (Array.isArray(tools) && tools.length > 0) {
    const validTools = tools.map((tool: any) => {
      if (tool && tool.type === 'function' && tool.function) {
        const fn = tool.function;
        // 验证必需字段
        if (!fn.name || typeof fn.name !== 'string') {
          return null;
        }
        // 确保参数格式正确
        const params = fn.parameters || { type: 'object', properties: {}, required: [] };
        if (typeof params !== 'object' || params.type !== 'object') {
          return null;
        }
        return {
          type: 'function',
          function: {
            name: fn.name,
            description: fn.description || '',
            parameters: params,
            ...(fn.strict !== undefined && { strict: fn.strict })
          }
        };
      }
      return null;
    }).filter(Boolean);

    // 只有当有有效工具时才添加 tools 字段
    if (validTools.length > 0) {
      result.tools = validTools;
    }
  }

  // 处理 tool_choice
  if (tool_choice !== undefined) {
    // 验证 tool_choice 格式
    if (typeof tool_choice === 'string' && ['auto', 'none', 'required'].includes(tool_choice)) {
      result.tool_choice = tool_choice;
    } else if (typeof tool_choice === 'object' && tool_choice.type === 'function' && tool_choice.function?.name) {
      result.tool_choice = {
        type: 'function',
        function: { name: tool_choice.function.name }
      };
    }
  }

  // 处理 parallel_tool_calls
  if (parallel_tool_calls !== undefined) {
    result.parallel_tool_calls = parallel_tool_calls;
  }

  // 处理 reasoning（Chat Completions API 可能不直接支持，但保留用于兼容）
  if (reasoning) {
    result.reasoning = reasoning;
  }

  // 添加其他兼容的字段（temperature, top_p, stream 等）
  const compatibleFields = ['temperature', 'top_p', 'stream', 'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'user', 'response_format'];
  for (const field of compatibleFields) {
    if (others[field] !== undefined) {
      result[field] = others[field];
    }
  }

  return result;
}

// ----------------------- claude code 发起的请求转换 -----------------------

/**
 * 将 claude code 发起的请求转换成对 gemini API 的请求
 * @param body
 * @param _model
 */
export function transformRequestFromClaudeToGemini(body: any, _model: string): any {
  const { system, messages, max_tokens, temperature, top_p, stop_sequences, tools, tool_choice, thinking } = body;

  const geminiRequest: any = {
    contents: [],
  };

  // 处理 system 指令
  if (system) {
    let systemText = '';
    if (typeof system === 'string') {
      systemText = system;
    } else if (Array.isArray(system)) {
      const textParts: string[] = [];
      for (const block of system) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
      systemText = textParts.join('\n\n');
    } else if (system && typeof system === 'object' && system.type === 'text') {
      systemText = system.text;
    }

    if (systemText) {
      geminiRequest.systemInstruction = {
        role: 'user',
        parts: [{ text: systemText }]
      };
    }
  }

  // 转换 messages
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const geminiRole = msg.role === 'assistant' ? 'model' :
                        msg.role === 'tool' ? 'function' : 'user';

      const geminiContent: any = {
        role: geminiRole,
        parts: [],
      };

      if (typeof msg.content === 'string') {
        geminiContent.parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;

          // text → text
          if (block.type === 'text' && typeof block.text === 'string') {
            geminiContent.parts.push({ text: block.text });
          }

          // image → inlineData
          if (block.type === 'image' && block.source) {
            const source = block.source;
            if (source.type === 'base64' && source.data && source.media_type) {
              geminiContent.parts.push({
                inlineData: {
                  mimeType: source.media_type,
                  data: source.data
                }
              });
            } else if (source.type === 'url' && source.url) {
              // URL 格式需要特殊处理，这里暂时跳过
            }
          }

          // tool_use → functionCall
          if (block.type === 'tool_use') {
            geminiContent.parts.push({
              functionCall: {
                name: block.name || 'tool',
                args: block.input || {}
              }
            });
          }

          // tool_result → functionResponse
          if (block.type === 'tool_result') {
            // Claude 的 tool_result 包含 tool_use_id，但 Gemini 需要的是函数名
            // 这里暂时使用 'tool' 作为函数名，实际应该从上下文中获取正确的函数名
            geminiContent.parts.push({
              functionResponse: {
                name: 'tool', // TODO: 应该从之前的 tool_use 中获取正确的函数名
                response: typeof msg.content === 'string' ? msg.content : msg.content || {}
              }
            });
          }
        }
      } else if (typeof msg.content === 'string') {
        // tool 消息的处理
        geminiContent.parts.push({
          functionResponse: {
            name: 'tool', // TODO: 应该从 tool_use_id 对应的函数中获取
            response: msg.content || {}
          }
        });
      }

      // 确保至少有一个 part
      if (geminiContent.parts.length === 0) {
        geminiContent.parts.push({ text: '' });
      }

      geminiRequest.contents.push(geminiContent);
    }
  }

  // 构建生成配置
  const generationConfig: any = {};

  if (typeof temperature === 'number') {
    generationConfig.temperature = temperature;
  }

  if (typeof top_p === 'number') {
    generationConfig.topP = top_p;
  }

  if (typeof max_tokens === 'number') {
    generationConfig.maxOutputTokens = max_tokens;
  }

  // 处理 stop_sequences -> stopSequences
  if (Array.isArray(stop_sequences)) {
    generationConfig.stopSequences = stop_sequences;
  }

  // 转换 thinking → thinkingConfig
  if (thinking) {
    const thinkingConfig = createGeminiThinkingConfigFromClaudeThinking(thinking);
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig;
    }
  }

  if (Object.keys(generationConfig).length > 0) {
    geminiRequest.generationConfig = generationConfig;
  }

  // 转换 tools
  // Claude: { name, description, input_schema }
  // Gemini: { functionDeclarations: [{ name, description, parameters }] }
  if (Array.isArray(tools)) {
    const functionDeclarations: any[] = [];
    for (const tool of tools) {
      if (tool && tool.name) {
        functionDeclarations.push({
          name: tool.name,
          description: tool.description || '',
          parameters: sanitizeSchemaForGeminiFunctionDeclaration(tool.input_schema || { type: 'object', properties: {}, required: [] })
        });
      }
    }

    if (functionDeclarations.length > 0) {
      geminiRequest.tools = [{ functionDeclarations }];
    }
  }

  // 转换 tool_choice
  if (tool_choice) {
    const toolConfig: any = { functionCallingConfig: {} };

    if (tool_choice === 'auto') {
      toolConfig.functionCallingConfig.mode = 'AUTO';
    } else if (tool_choice === 'any' || tool_choice === 'required') {
      toolConfig.functionCallingConfig.mode = 'ANY';
    } else if (tool_choice === 'none') {
      toolConfig.functionCallingConfig.mode = 'NONE';
    } else if (typeof tool_choice === 'object') {
      const tc = tool_choice;
      if (tc.type === 'tool' && tc.name) {
        toolConfig.functionCallingConfig.mode = 'ANY';
        toolConfig.functionCallingConfig.allowedFunctionNames = [tc.name];
      }
    }

    if (Object.keys(toolConfig.functionCallingConfig).length > 0) {
      geminiRequest.toolConfig = toolConfig;
    }
  }

  return geminiRequest;
}

/**
 * 将 claude code 发起的请求转换成对 responses API 的请求
 * @param body
 * @param model
 */
export function transformRequestFromClaudeToResponses(body: any, model: string): any {
  const { system, messages, max_tokens, temperature, top_p, stop_sequences, tools, tool_choice } = body;

  const input: any[] = [];
  let instructions = '';

  // 处理 system 指令
  if (system) {
    if (typeof system === 'string') {
      instructions = system;
    } else if (Array.isArray(system)) {
      const textParts: string[] = [];
      for (const block of system) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
      instructions = textParts.join('\n\n');
    } else if (system && typeof system === 'object' && system.type === 'text') {
      instructions = system.text;
    }
  }

  // 转换 messages
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const content: any[] = [];

      if (typeof msg.content === 'string') {
        content.push({
          type: 'input_text',
          text: msg.content
        });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;

          // text → input_text
          if (block.type === 'text' && typeof block.text === 'string') {
            content.push({
              type: 'input_text',
              text: block.text
            });
          }

          // image → input_image
          if (block.type === 'image' && block.source) {
            const source = block.source;
            if (source.type === 'base64' && source.data && source.media_type) {
              const dataUrl = `data:${source.media_type};base64,${source.data}`;
              content.push({
                type: 'input_image',
                image_url: { url: dataUrl }
              });
            } else if (source.type === 'url' && source.url) {
              content.push({
                type: 'input_image',
                image_url: { url: source.url }
              });
            }
          }

          // tool_use → function_call (Responses API 格式）
          if (block.type === 'tool_use') {
            // Responses API 在 output 中包含 function_call，不是在 input 中
            // 所以这里不转换 tool_use，只保留文本和图像
          }
        }
      }

      input.push({
        type: 'message',
        role: msg.role,
        content: content
      });
    }
  }

  const result: any = {
    model: model || body.model,
    input,
  };

  if (instructions) {
    result.instructions = instructions;
  }

  if (typeof temperature === 'number') {
    result.temperature = temperature;
  }

  if (typeof top_p === 'number') {
    result.top_p = top_p;
  }

  if (typeof max_tokens === 'number') {
    result.max_output_tokens = max_tokens;
  }

  // 处理 stop_sequences -> stop
  if (Array.isArray(stop_sequences)) {
    result.stop = stop_sequences;
  } else if (typeof stop_sequences === 'string') {
    result.stop = [stop_sequences];
  }

  // 处理 tools: Claude 格式 → Responses API 格式
  // Claude: { name, description, input_schema }
  // Responses: { type: "function", function: { name, description, parameters } }
  if (Array.isArray(tools)) {
    result.tools = tools.map((tool: any) => {
      if (tool && tool.name) {
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || { type: 'object', properties: {}, required: [] },
          },
        };
      }
      return null;
    }).filter(Boolean);
  }

  // 处理 tool_choice
  // Claude: "auto" | "any" | "none" | { type: "tool", name }
  // Responses: "auto" | "required" | "none" | { type: "function", function: { name } }
  if (tool_choice !== undefined) {
    if (tool_choice === 'auto') {
      result.tool_choice = 'auto';
    } else if (tool_choice === 'any') {
      result.tool_choice = 'required';
    } else if (tool_choice === 'none') {
      result.tool_choice = 'none';
    } else if (typeof tool_choice === 'object' && tool_choice.type === 'tool') {
      const tc = tool_choice;
      if (tc.name) {
        result.tool_choice = {
          type: 'function',
          function: { name: tc.name },
        };
      }
    }
  }

  return result;
}

/**
 * 将 claude code 发起的请求转换成对 chat-completions API 的请求
 * @param body
 * @param model
 */
export function transformRequestFromClaudeToChatCompletions(body: any, model: string): any {
  const { system, messages, max_tokens, temperature, top_p, stop_sequences, tools, tool_choice, thinking } = body;

  const transformedMessages: any[] = [];
  let systemText = '';

  // 处理 system 指令
  if (system) {
    if (typeof system === 'string') {
      systemText = system;
    } else if (Array.isArray(system)) {
      const textParts: string[] = [];
      for (const block of system) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
      systemText = textParts.join('\n\n');
    } else if (system && typeof system === 'object' && system.type === 'text') {
      systemText = system.text;
    }
  }

  // 转换 messages
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;

      const transformedMsg: any = {
        role: msg.role,
      };

      if (typeof msg.content === 'string') {
        transformedMsg.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const content: any[] = [];

        for (const block of msg.content) {
          if (!block || typeof block !== 'object') continue;

          // text → text
          if (block.type === 'text' && typeof block.text === 'string') {
            content.push({ type: 'text', text: block.text });
          }

          // image → image_url
          if (block.type === 'image' && block.source) {
            const source = block.source;
            if (source.type === 'base64' && source.data && source.media_type) {
              const dataUrl = `data:${source.media_type};base64,${source.data}`;
              content.push({
                type: 'image_url',
                image_url: { url: dataUrl }
              });
            } else if (source.type === 'url' && source.url) {
              content.push({
                type: 'image_url',
                image_url: { url: source.url }
              });
            }
          }

          // tool_use → tool_calls
          if (block.type === 'tool_use') {
            if (!transformedMsg.tool_calls) {
              transformedMsg.tool_calls = [];
            }
            transformedMsg.tool_calls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name || 'tool',
                arguments: JSON.stringify(block.input || {})
              }
            });
          }

          // thinking → thinking（Chat Completions API 可能不支持，但保留）
          if (block.type === 'thinking') {
            content.push({
              type: 'thinking',
              thinking: block.thinking
            });
          }
        }

        if (content.length > 0 || !transformedMsg.tool_calls) {
          transformedMsg.content = content.length > 0 ? content : '';
        }
      }

      // tool_result → tool 消息
      if (msg.role === 'tool') {
        if (typeof msg.content === 'string') {
          transformedMsg.content = msg.content;
        } else if (Array.isArray(msg.content)) {
          const toolContent: string[] = [];
          for (const block of msg.content) {
            if (block && block.type === 'text' && typeof block.text === 'string') {
              toolContent.push(block.text);
            }
          }
          transformedMsg.content = toolContent.join('\n');
        }
        transformedMsg.tool_call_id = msg.tool_use_id || '';
      }

      transformedMessages.push(transformedMsg);
    }
  }

  const result: any = {
    model: model || body.model,
    messages: transformedMessages,
  };

  // 处理 system
  if (systemText) {
    result.system = systemText;
  }

  // 处理 max_tokens
  if (typeof max_tokens === 'number') {
    result.max_tokens = max_tokens;
  }

  // 处理 temperature
  if (typeof temperature === 'number') {
    result.temperature = temperature;
  }

  // 处理 top_p
  if (typeof top_p === 'number') {
    result.top_p = top_p;
  }

  // 处理 stop_sequences -> stop
  if (Array.isArray(stop_sequences)) {
    result.stop = stop_sequences;
  } else if (typeof stop_sequences === 'string') {
    result.stop = [stop_sequences];
  }

  // 转换 tools: Claude 格式 → Chat Completions 格式
  // Claude: { name, description, input_schema }
  // Chat Completions: { type: "function", function: { name, description, parameters } }
  if (Array.isArray(tools)) {
    result.tools = tools.map((tool: any) => {
      if (tool && tool.name) {
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || { type: 'object', properties: {}, required: [] }
          }
        };
      }
      return null;
    }).filter(Boolean);
  }

  // 转换 tool_choice
  // Claude: "auto" | "any" | "none" | { type: "tool", name }
  // Chat Completions: "auto" | "required" | "none" | { type: "function", function: { name } }
  if (tool_choice !== undefined) {
    if (tool_choice === 'auto') {
      result.tool_choice = 'auto';
    } else if (tool_choice === 'any') {
      result.tool_choice = 'required';
    } else if (tool_choice === 'none') {
      result.tool_choice = 'none';
    } else if (typeof tool_choice === 'object' && tool_choice.type === 'tool') {
      const tc = tool_choice;
      if (tc.name) {
        result.tool_choice = {
          type: 'function',
          function: { name: tc.name }
        };
      }
    }
  }

  // 转换 thinking → reasoning
  if (thinking) {
    result.reasoning = thinking;
  }

  return result;
}

// ===================== codex 得到 responses 数据 =======================

export function transformResponseFromChatCompletionsToResponses(response: any): any {
  if (!response || typeof response !== 'object') {
    return response;
  }

  const choice = Array.isArray(response.choices) && response.choices.length > 0 ? response.choices[0] : null;
  const output: any[] = [];

  // 转换消息内容
  if (choice?.message) {
    const message = choice.message;
    const messageContent: any[] = [];

    // 处理文本内容
    if (typeof message.content === 'string') {
      messageContent.push({
        type: 'output_text',
        text: message.content
      });
    } else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!item || typeof item !== 'object') continue;

        if (item.type === 'text' && typeof item.text === 'string') {
          messageContent.push({
            type: 'output_text',
            text: item.text
          });
        }

        if (item.type === 'image_url' && item.image_url) {
          messageContent.push({
            type: 'image',
            source: {
              type: 'url',
              url: item.image_url.url
            }
          });
        }
      }
    }

    if (messageContent.length > 0) {
      output.push({
        type: 'message',
        role: 'assistant',
        content: messageContent
      });
    }

    // 处理工具调用
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall && toolCall.type === 'function') {
          output.push({
            type: 'function_call',
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments || '{}'
          });
        }
      }
    }
  }

  // 如果没有内容，添加空消息
  if (output.length === 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: ''
      }]
    });
  }

  // 映射 finish reason 到 status
  // Chat Completions: "stop" | "length" | "tool_calls" | "content_filter"
  // Responses: "completed" | "incomplete"
  let status = 'completed';
  if (choice?.finish_reason === 'length' || choice?.finish_reason === 'max_tokens') {
    status = 'incomplete';
  }

  return {
    id: response.id || `response_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    object: 'response',
    created_at: response.created || Math.floor(Date.now() / 1000),
    model: response.model,
    output,
    status,
    incomplete_details: status === 'incomplete' ? { reason: 'max_tokens' } : undefined,
    usage: response.usage ? {
      input_tokens: response.usage.prompt_tokens,
      output_tokens: response.usage.completion_tokens,
      total_tokens: response.usage.total_tokens,
      // 处理 cached_tokens（可能在不同字段）
      ...(response.usage.cached_tokens && { input_tokens_details: { cached_tokens: response.usage.cached_tokens } }),
    } : undefined
  };
}

export function transformResponseFromClaudeToResponses(response: any): any {
  if (!response || typeof response !== 'object') {
    return response;
  }

  const output: any[] = [];

  // 转换 content blocks
  if (Array.isArray(response.content)) {
    const messageContent: any[] = [];

    for (const block of response.content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text' && typeof block.text === 'string') {
        messageContent.push({
          type: 'output_text',
          text: block.text
        });
      }

      if (block.type === 'image' && block.source) {
        messageContent.push({
          type: 'image',
          source: block.source
        });
      }

      if (block.type === 'tool_use') {
        output.push({
          type: 'function_call',
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        });
      }
    }

    if (messageContent.length > 0) {
      output.push({
        type: 'message',
        role: 'assistant',
        content: messageContent
      });
    }
  }

  // 如果没有内容，添加空消息
  if (output.length === 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: ''
      }]
    });
  }

  // 映射 stop_reason 为 status
  // Claude: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "max_thinking_length"
  // Responses: "completed" | "incomplete"
  let status = 'completed';
  if (response.stop_reason === 'max_tokens' || response.stop_reason === 'max_thinking_length') {
    status = 'incomplete';
  }

  return {
    id: response.id || `response_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: response.model,
    output,
    status,
    incomplete_details: status === 'incomplete' ? { reason: 'max_tokens' } : undefined,
    usage: response.usage ? {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      total_tokens: response.usage.total_tokens
    } : undefined
  };
}

export function transformResponseFromGeminiToResponses(response: any): any {
  if (!response || typeof response !== 'object') {
    return response;
  }

  const candidate = Array.isArray(response.candidates) && response.candidates.length > 0 ? response.candidates[0] : null;
  const output: any[] = [];

  // 转换 content parts
  if (candidate?.content?.parts) {
    const messageContent: any[] = [];

    for (const part of candidate.content.parts) {
      const p = part as any;

      if (p.text && typeof p.text === 'string') {
        messageContent.push({
          type: 'output_text',
          text: p.text
        });
      }

      if (p.inlineData) {
        messageContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: p.inlineData.mimeType,
            data: p.inlineData.data
          }
        });
      }

      if (p.functionCall) {
        output.push({
          type: 'function_call',
          id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          name: p.functionCall.name || 'tool',
          arguments: JSON.stringify(p.functionCall.args || {})
        });
      }
    }

    if (messageContent.length > 0) {
      output.push({
        type: 'message',
        role: 'assistant',
        content: messageContent
      });
    }
  }

  // 如果没有内容，添加空消息
  if (output.length === 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: ''
      }]
    });
  }

  // 映射 finishReason 为 status
  // Gemini: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER" | "MALFORMED_FUNCTION_CALL"
  // Responses: "completed" | "incomplete"
  let status = 'completed';
  if (candidate?.finishReason === 'MAX_TOKENS') {
    status = 'incomplete';
  }

  return {
    id: `response_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: response.model || 'gemini',
    output,
    status,
    incomplete_details: status === 'incomplete' ? { reason: 'max_tokens' } : undefined,
    usage: response.usageMetadata ? {
      input_tokens: response.usageMetadata.promptTokenCount,
      output_tokens: response.usageMetadata.candidatesTokenCount,
      total_tokens: response.usageMetadata.totalTokenCount
    } : undefined
  };
}

// ===================== claude code 得到 claude 数据 =======================

export function transformResponseFromChatCompletionsToClaude(response: any): any {
  if (!response || typeof response !== 'object') {
    return response;
  }

  const choice = Array.isArray(response.choices) && response.choices.length > 0 ? response.choices[0] : null;
  const contentBlocks: any[] = [];

  // 转换消息内容
  if (choice?.message) {
    const message = choice.message;

    if (typeof message.content === 'string') {
      contentBlocks.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!item || typeof item !== 'object') continue;

        if (item.type === 'text' && typeof item.text === 'string') {
          contentBlocks.push({ type: 'text', text: item.text });
        }

        if (item.type === 'image_url' && item.image_url) {
          const url = item.image_url.url;
          if (typeof url === 'string') {
            if (url.startsWith('data:')) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                contentBlocks.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: match[1],
                    data: match[2]
                  }
                });
              }
            } else {
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'url',
                  url: url
                }
              });
            }
          }
        }
      }
    }

    // 处理工具调用
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (toolCall && toolCall.type === 'function') {
          contentBlocks.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments || '{}')
          });
        }
      }
    }
  }

  // 如果没有内容，添加空文本
  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: 'text', text: '' });
  }

  // 转换 usage
  const usage = response.usage ? {
    input_tokens: response.usage.prompt_tokens,
    output_tokens: response.usage.completion_tokens,
    total_tokens: response.usage.total_tokens,
  } : undefined;

  // 映射 finish reason
  const stopReasonMap: Record<string, string> = {
    'stop': 'end_turn',
    'length': 'max_tokens',
    'content_filter': 'content_filter',
  };

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: contentBlocks,
    stop_reason: stopReasonMap[choice?.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: usage || {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

export function transformResponseFromResponsesToClaude(response: any): any {
  if (!response || typeof response !== 'object') {
    return response;
  }

  const contentBlocks: any[] = [];

  // 遍历 output 数组
  if (Array.isArray(response.output)) {
    for (const outputItem of response.output) {
      if (outputItem.type === 'message' && Array.isArray(outputItem.content)) {
        for (const part of outputItem.content) {
          if (part.type === 'output_text' && typeof part.text === 'string') {
            contentBlocks.push({ type: 'text', text: part.text });
          }

          if (part.type === 'image' && part.source) {
            contentBlocks.push({ type: 'image', source: part.source });
          }
        }
      }

      if (outputItem.type === 'function_call') {
        contentBlocks.push({
          type: 'tool_use',
          id: outputItem.id,
          name: outputItem.name,
          input: JSON.parse(outputItem.arguments || '{}')
        });
      }
    }
  }

  // 如果没有内容，添加空文本
  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: 'text', text: '' });
  }

  // 转换 usage
  const usage = response.usage ? {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    total_tokens: response.usage.total_tokens,
  } : undefined;

  // 转换 stop_reason
  let stop_reason = 'end_turn';
  if (response.status === 'incomplete') {
    stop_reason = response.incomplete_details?.reason === 'max_tokens' ? 'max_tokens' : 'end_turn';
  }

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: contentBlocks,
    stop_reason,
    stop_sequence: null,
    usage: usage || {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

export function transformResponseFromGeminiToClaude(response: any): any {
  if (!response || typeof response !== 'object') {
    return response;
  }

  const candidate = Array.isArray(response.candidates) && response.candidates.length > 0 ? response.candidates[0] : null;
  const contentBlocks: any[] = [];

  // 转换 content parts
  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      const p = part as any;

      if (p.text && typeof p.text === 'string') {
        contentBlocks.push({ type: 'text', text: p.text });
      }

      if (p.inlineData) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: p.inlineData.mimeType,
            data: p.inlineData.data
          }
        });
      }

      if (p.functionCall) {
        contentBlocks.push({
          type: 'tool_use',
          id: `tool_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
          name: p.functionCall.name || 'tool',
          input: p.functionCall.args || {}
        });
      }
    }
  }

  // 如果没有内容，添加空文本
  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: 'text', text: '' });
  }

  // 转换 usage
  const usage = response.usageMetadata ? {
    input_tokens: response.usageMetadata.promptTokenCount,
    output_tokens: response.usageMetadata.candidatesTokenCount,
    total_tokens: response.usageMetadata.totalTokenCount,
    cache_read_input_tokens: response.usageMetadata.cachedContentTokenCount,
  } : undefined;

  // 映射 finish reason
  const stopReasonMap: Record<string, string> = {
    'STOP': 'end_turn',
    'MAX_TOKENS': 'max_tokens',
    'SAFETY': 'content_filter',
    'RECITATION': 'content_filter',
  };

  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    type: 'message',
    role: 'assistant',
    model: 'gemini',
    content: contentBlocks,
    stop_reason: stopReasonMap[candidate?.finishReason] || 'end_turn',
    stop_sequence: null,
    usage: usage || {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
