/**
 * Server tool use content block transformation.
 *
 * Converts server_tool_use blocks to regular tool_use blocks so that upstream
 * providers which do not recognise the server_tool_use type can still process
 * the conversation history correctly.
 *
 * Conversion is simple: only the `type` field changes from 'server_tool_use'
 * to 'tool_use'. The `id`, `name`, and `input` fields are preserved, and
 * matching `tool_result` blocks (which reference by `tool_use_id`) remain valid.
 */

/**
 * Convert all server_tool_use content blocks in the request body to tool_use.
 *
 * Scans assistant messages in body.messages and replaces the block type.
 * Returns a shallow-cloned body with modified messages; original body is not mutated.
 */
export function convertServerToolUseToToolUse(body: any): any {
  if (!body?.messages || !Array.isArray(body.messages)) {
    return body;
  }

  let modified = false;
  const newMessages = body.messages.map((msg: any) => {
    // server_tool_use only appears in assistant messages
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      return msg;
    }

    let msgModified = false;
    const newContent = msg.content.map((block: any) => {
      if (block?.type === 'server_tool_use') {
        msgModified = true;
        return { ...block, type: 'tool_use' };
      }
      return block;
    });

    if (msgModified) {
      modified = true;
      return { ...msg, content: newContent };
    }
    return msg;
  });

  if (!modified) {
    return body;
  }

  return { ...body, messages: newMessages };
}
