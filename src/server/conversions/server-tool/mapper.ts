/**
 * Server tool use content block transformation.
 *
 * Anthropic 提供一类"服务端工具"（Web Search / Web Fetch / Computer Use / Code Execution 等），
 * 其交互在内容块层面会用到 Anthropic 专有的类型：
 *   - `server_tool_use`          （assistant 消息：模型发起的服务端工具调用）
 *   - `web_search_tool_result`   （user 消息：Web Search 结果）
 *   - `server_tool_result`       （user 消息：通用服务端工具结果）
 *   - `advisor_tool_result`      （user 消息：advisor 工具结果）
 * 此外 `tools` 数组里会带上服务端工具定义（如 `{ type: 'web_search_20250305' }`）。
 *
 * 多数第三方 Claude 兼容端点（GLM、MiniMax 等）只实现了客户端 `tool_use`/`tool_result`，
 * 遇到上述任意一种都会以 `Unsupported content type: server_tool_use` 之类报错拒绝。
 *
 * 本模块在转发到"不支持服务端工具"的上游前，彻底清理这些痕迹：
 *   1. assistant 的 `server_tool_use` → 改名 `tool_use`（保留 id/name/input）；
 *   2. user 的 `web_search_tool_result` / `server_tool_result` / `advisor_tool_result`
 *      → 降级为标准 `tool_result`（引用同一 tool_use_id，内容拍平为文本），
 *      以便与上一步改名的 `tool_use` 维持合法配对；
 *   3. 顶层 `tools` 数组中删除所有服务端工具定义，仅保留客户端自定义工具。
 *
 * 返回浅拷贝，不修改传入 body。
 */

/** user 消息里需要降级为 tool_result 的服务端结果块类型 */
const SERVER_RESULT_TYPES = new Set([
  'web_search_tool_result',
  'server_tool_result',
  'advisor_tool_result',
]);

/**
 * 判断 `tools` 数组中的某项是否为 Anthropic 服务端工具定义。
 * 客户端自定义工具的 `type` 为 'custom' 或缺省，且通常带 `input_schema`；
 * 服务端工具 `type` 形如 'web_search_20250305' / 'computer_20250124' / 'bash_20250124'
 * / 'text_editor_20250124' / 'code_execution_20250522' 等，且无 `input_schema`。
 */
function isServerToolDefinition(tool: any): boolean {
  if (!tool || typeof tool !== 'object') return false;
  const type: unknown = tool.type;
  // 自定义工具：type 缺省或 'custom'
  if (type === undefined || type === null || type === 'custom') return false;
  if (typeof type !== 'string') return true;
  // 已知服务端工具类型前缀
  const SERVER_TOOL_PREFIXES = [
    'web_search',
    'computer',
    'bash',
    'text_editor',
    'code_execution',
  ];
  if (SERVER_TOOL_PREFIXES.some((p) => type.startsWith(p))) return true;
  // 兜底：带非 custom 的 type 且没有 input_schema，视为服务端/私有工具
  if (!tool.input_schema) return true;
  return false;
}

/** 把任意值压平为纯文本字符串（用于降级服务端结果块内容） */
function flattenToText(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item || typeof item !== 'object') return String(item);
        // 常见形态：{ type: 'text', text } / { type: 'web_search_tool_result', content: [...] }
        if (typeof item.text === 'string') return item.text;
        if (typeof item.title === 'string') return item.title;
        if (Array.isArray(item.content)) return flattenToText(item.content);
        if (item.url) return `${item.url}`;
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) return flattenToText(value.content);
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * 清理请求体中所有"服务端工具"痕迹（内容块 + tools 定义）。
 *
 * 扫描 body.messages 中所有 role 的内容块，以及顶层 body.tools。
 * 返回浅拷贝；无改动时原样返回原 body。
 */
export function sanitizeServerToolArtifacts(body: any): any {
  if (!body || typeof body !== 'object') return body;

  let modified = false;
  let newBody = body;

  // --- 1 & 2：处理 messages 内容块 ---
  if (Array.isArray(body.messages)) {
    const newMessages = body.messages.map((msg: any) => {
      if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
        return msg;
      }

      let msgModified = false;
      const newContent = msg.content.map((block: any) => {
        if (!block || typeof block !== 'object') return block;

        // assistant: server_tool_use → tool_use
        if (block.type === 'server_tool_use') {
          msgModified = true;
          return { ...block, type: 'tool_use' };
        }
        // user: 服务端结果块 → 标准 tool_result（保持与上面改名的 tool_use 配对）
        if (SERVER_RESULT_TYPES.has(block.type)) {
          msgModified = true;
          const text = flattenToText(block.content);
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: text || '[server tool result omitted]',
          };
        }
        return block;
      });

      if (msgModified) {
        modified = true;
        return { ...msg, content: newContent };
      }
      return msg;
    });

    if (modified) {
      newBody = { ...newBody, messages: newMessages };
    }
  }

  // --- 3：清理 tools 数组中的服务端工具定义 ---
  if (Array.isArray(newBody.tools) && newBody.tools.length > 0) {
    const filteredTools = newBody.tools.filter((tool: any) => !isServerToolDefinition(tool));
    if (filteredTools.length !== newBody.tools.length) {
      modified = true;
      newBody = { ...newBody, tools: filteredTools };
    }
  }

  return modified ? newBody : body;
}

/**
 * @deprecated 别名，等价于 {@link sanitizeServerToolArtifacts}。
 * 保留旧名以兼容既有导入；新代码请使用 sanitizeServerToolArtifacts。
 */
export function convertServerToolUseToToolUse(body: any): any {
  return sanitizeServerToolArtifacts(body);
}
