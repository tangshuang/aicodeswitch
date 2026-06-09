/**
 * Tool result content block utilities.
 */

/**
 * 为所有缺少 id 的 tool_result 块补上 id。
 *
 * 部分 Claude 兼容端点（如 GLM）要求 tool_result 内容块必须包含 id 字段，
 * 但标准 Claude API 的 tool_result 块仅有 tool_use_id 而不带 id。
 *
 * id 取值策略：优先使用 tool_use_id（与对应的 tool_use.id 保持一致），
 * 若 tool_use_id 也不存在则生成唯一 id。
 */
export function ensureToolResultIds(messages: any[]): { messages: any[]; patchedCount: number } {
  let totalPatched = 0;
  const result = messages.map(msg => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;
    let patched = false;
    const newContent = msg.content.map((b: any) => {
      if (b.type === 'tool_result' && !b.id) {
        patched = true;
        totalPatched++;
        // 使用 tool_use_id 作为 id，保持与对应 tool_use 块的 id 一致
        const id = b.tool_use_id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        return { ...b, id };
      }
      return b;
    });
    return patched ? { ...msg, content: newContent } : msg;
  });
  return { messages: result, patchedCount: totalPatched };
}
