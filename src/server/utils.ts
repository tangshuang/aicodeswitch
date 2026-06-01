const net = require('net');

export function checkPortUsable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createConnection({ port });
    server.on('connect', () => {
      server.end();
      resolve(false);
    });
    server.on('error', () => {
      resolve(true);
    });
  });
}

/**
 * 检测消息是否为 Claude Code 的 compact 命令请求
 *
 * Compact 命令触发时，Claude Code 会在 messages 末尾插入一条特殊指令：
 * - role 为 "user"
 * - content 为数组，包含一个 text 块
 * - text 内容以 "CRITICAL: Respond with TEXT ONLY" 开头
 * - 包含对话摘要生成指令，要求输出 <analysis> 和 <summary> 结构
 *
 * @param message - 单条消息对象（Claude API 格式）
 * @returns 是否为 compact 命令请求
 */
export function isCompactRequest(message: any): boolean {
  if (!message || message.role !== 'user') {
    return false;
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }

  // 遍历 content 数组，查找包含 compact 指令的文本块
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text;
      // Compact 命令的核心特征组合
      if (
        text.includes('CRITICAL: Respond with TEXT ONLY') &&
        text.includes('create a detailed summary of the conversation') &&
        text.includes('<analysis>') &&
        text.includes('<summary>')
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 检测消息列表中的最后一条消息是否为 compact 命令请求
 *
 * @param messages - 消息数组（Claude API 格式）
 * @returns 最后一条消息是否为 compact 命令
 */
export function isLastMessageCompact(messages: any[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  return isCompactRequest(messages[messages.length - 1]);
}

/**
 * 检测请求是否为 Codex 的 compact（压缩）请求
 *
 * Codex 基于 OpenAI Responses API，compact 操作走独立端点：
 * - POST /v1/responses/compact
 *
 * 注意：这与普通 /v1/responses 请求中携带 compaction item（继续对话）不同，
 * 这里仅识别“发起压缩”这个动作本身。
 */
export function isCodexCompactRequest(path?: string): boolean {
  if (!path || typeof path !== 'string') {
    return false;
  }
  const normalizedPath = path.split('?')[0];
  return /\/v1\/responses\/compact\/?$/.test(normalizedPath);
}
