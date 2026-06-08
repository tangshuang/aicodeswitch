/**
 * Request body sanitizer for AICodeSwitch proxy.
 *
 * Defensively cleans incoming request bodies before format transformation
 * and upstream forwarding. Catches issues that originate from client bugs
 * (e.g. Codex sending improperly escaped content) so that upstream APIs
 * receive well-formed JSON.
 *
 * Sanitization steps:
 * 1. Strip illegal C0 control characters from string values
 * 2. Fix `function_call.arguments` that are not valid JSON strings
 * 3. Remove `undefined` values from the object tree
 * 4. Guard against circular references and excessive depth
 */

// C0 control characters except TAB (0x09), LF (0x0A), CR (0x0D).
// These are the only three control chars allowed in JSON strings (RFC 8259 §7).
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

const MAX_DEPTH = 64;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  body: any;
  changes: string[];
}

/**
 * Deep-sanitize a request body object.
 *
 * @param body - The parsed request body (a plain JS object).
 * @returns A new object with fixes applied and a list of human-readable
 *          change descriptions (empty when nothing was modified).
 */
export function sanitizeRequestBody(body: any): SanitizeResult {
  if (body === null || body === undefined || typeof body !== 'object') {
    return { body, changes: [] };
  }

  const changes: string[] = [];
  const seen = new WeakSet<object>();
  const result = sanitizeValue(body, '', changes, seen, 0);
  return { body: result, changes };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sanitizeValue(
  value: any,
  path: string,
  changes: string[],
  seen: WeakSet<object>,
  depth: number,
): any {
  // Primitive types ----------------------------------------------------------
  if (value === null) return null;

  if (value === undefined) {
    changes.push(`removed undefined at ${path || '$'}`);
    return null; // replaced with null rather than silently dropped
  }

  if (typeof value === 'string') {
    return sanitizeString(value, path, changes);
  }

  if (typeof value !== 'object') {
    return value; // numbers, booleans — pass through
  }

  // Guard: depth -------------------------------------------------------------
  if (depth >= MAX_DEPTH) {
    changes.push(`max depth exceeded at ${path || '$'}`);
    return value;
  }

  // Guard: circular reference ------------------------------------------------
  if (seen.has(value)) {
    changes.push(`circular reference at ${path || '$'}`);
    return '[Circular]';
  }
  seen.add(value);

  // Arrays -------------------------------------------------------------------
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      const itemPath = `${path}[${i}]`;
      const sanitized = sanitizeValue(item, itemPath, changes, seen, depth + 1);
      // Fix function_call.arguments inside Responses API input arrays
      if (
        sanitized !== null &&
        typeof sanitized === 'object' &&
        !Array.isArray(sanitized) &&
        sanitized.type === 'function_call'
      ) {
        fixFunctionCallArguments(sanitized, itemPath, changes);
      }
      return sanitized;
    });
  }

  // Plain objects ------------------------------------------------------------
  const result: any = {};
  for (const [key, val] of Object.entries(value)) {
    // Remove undefined values entirely
    if (val === undefined) {
      changes.push(`removed undefined key ${path}.${key}`);
      continue;
    }
    const childPath = path ? `${path}.${key}` : key;
    result[key] = sanitizeValue(val, childPath, changes, seen, depth + 1);
  }

  // Post-process: fix function_call.arguments in input arrays
  if (Array.isArray(result.input)) {
    for (let i = 0; i < result.input.length; i++) {
      const item = result.input[i];
      if (
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        item.type === 'function_call'
      ) {
        fixFunctionCallArguments(item, `${path}.input[${i}]`, changes);
      }
    }
  }

  return result;
}

/**
 * Strip illegal control characters from a string value.
 */
function sanitizeString(str: string, path: string, changes: string[]): string {
  if (!CONTROL_CHAR_REGEX.test(str)) return str;
  const cleaned = str.replace(CONTROL_CHAR_REGEX, '');
  changes.push(`stripped control chars at ${path || '$'}`);
  return cleaned;
}

/**
 * Ensure `arguments` on a function_call item is a valid JSON string.
 *
 * The Responses API spec requires `arguments` to be a JSON-encoded string.
 * If Codex sends a malformed string (e.g. containing raw unescaped content),
 * we wrap it so downstream code can safely `JSON.parse` it.
 */
function fixFunctionCallArguments(
  item: any,
  path: string,
  changes: string[],
): void {
  const args = item.arguments;
  if (typeof args !== 'string' || args === '') return;

  // Already valid JSON — nothing to do
  try {
    JSON.parse(args);
    return;
  } catch {
    // Malformed — wrap it
  }

  // Wrap the raw string so JSON.parse will succeed downstream
  item.arguments = JSON.stringify({ _raw: args });
  changes.push(`fixed invalid arguments at ${path}`);
}
