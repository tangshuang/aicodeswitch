/**
 * 验证 GPT-5+/o系列 system → developer 角色兼容修复
 *
 * 背景：GPT-5.6 等新模型不再接受 role:'system'，上游报
 * "Invalid value: 'system'. Value must be 'developer'"。
 * 两条触发路径：
 *   1. Claude Code（claude 格式）→ openai-chat 上游：claude-completions 转换把顶层
 *      system 字段产出为 messages 头部的 role:'system' 消息；
 *   2. Codex（responses 格式）→ 第三方 Responses 上游：降级兼容 downgradeResponsesRequest
 *      把 developer 改写成 system（为老 Lite 提供商设计），新模型随即拒绝。
 *
 * 修复：proxy-server 在两条转发路径的最终请求体上调用 applyDeveloperRoleCompat——
 * 按目标模型名（gpt-5* / o1/o3/o4 等独立 o 系列 / codex*）命中时，把 messages /
 * input 载体中的 system 角色消息改写为 developer。
 *
 * 本脚本用真实转换管线复现「产出 system → 改写 developer」全链路并校验门控边界。
 *
 * 运行：npx tsx scripts/verify-developer-role-compat.ts
 */
import { ProxyServer } from '../src/server/proxy-server';
// 代理实际调用的转换管线 API（transformRequestToUpstream → transformRequest）
import { transformRequest as convertRequest } from 'aitoken-conversions';

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗ FAIL'} ${name}${ok ? '' : `\n      ${detail}`}`);
};

// applyDeveloperRoleCompat 内部经 this 调用 modelRequiresDeveloperRole（两者均不依赖实例状态），
// 用剥离的 prototype 方法拼一个最小调用上下文
const proto = ProxyServer.prototype as any;
const applyDevCompat = (body: any, effectiveModel?: string) =>
  proto.applyDeveloperRoleCompat.call({ modelRequiresDeveloperRole: proto.modelRequiresDeveloperRole }, body, effectiveModel);
const requiresDeveloper = (model?: string) => proto.modelRequiresDeveloperRole.call(null, model);

// Claude Code 的典型请求体（顶层 system 字段）
const claudeBody = (): any => ({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  system: 'You are a coding assistant.',
  messages: [{ role: 'user', content: 'hi' }],
});

// Codex 的典型请求体（原生 developer 角色）
const codexBody = (): any => ({
  model: 'gpt-5.6',
  stream: true,
  instructions: 'You are Codex.',
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev guide' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ],
});

console.log('===== 1. 复现根因：转换管线产出 role:\'system\' =====');
{
  // 路径 A：claude → completions（Claude Code → openai-chat 上游）
  const converted = convertRequest({ fromFormat: 'claude', toFormat: 'completions', body: claudeBody() }).body;
  check(
    'claude→completions 产出 system 头消息（即上游报错的直接原因）',
    Array.isArray(converted?.messages) && converted.messages[0]?.role === 'system',
    JSON.stringify(converted?.messages?.[0])
  );

  // 路径 B：responses → responses 降级（Codex → 第三方 Responses 上游）
  const downgraded = convertRequest({ fromFormat: 'responses', toFormat: 'responses', body: codexBody(), sanitizeBody: true }).body;
  const devItem = downgraded?.input?.find((i: any) => i.role === 'developer');
  const sysItem = downgraded?.input?.find((i: any) => i.role === 'system');
  check(
    'responses 降级把 developer 改写成 system',
    !devItem && !!sysItem,
    JSON.stringify(downgraded?.input?.map((i: any) => i.role))
  );
}

console.log('\n===== 2. 修复生效：目标模型命中 → system 改写为 developer =====');
{
  // 路径 A 修复：gpt-5.6-sol 模型（用户实测报错模型）
  const converted = convertRequest({ fromFormat: 'claude', toFormat: 'completions', body: claudeBody() }).body;
  const fixed = applyDevCompat(converted, 'gpt-5.6-sol');
  check(
    'completions messages 头消息改写为 developer',
    fixed?.messages?.[0]?.role === 'developer',
    JSON.stringify(fixed?.messages?.[0])
  );

  // 路径 B 修复：降级后的 system 还原为 developer，user 消息不动
  const downgraded = convertRequest({ fromFormat: 'responses', toFormat: 'responses', body: codexBody(), sanitizeBody: true }).body;
  const restored = applyDevCompat(downgraded, 'gpt-5.6');
  const roles = restored?.input?.map((i: any) => i.role);
  check(
    'responses input 的 system 还原为 developer（user 不动）',
    roles?.[0] === 'developer' && roles?.[1] === 'user',
    JSON.stringify(roles)
  );

  // effectiveModel 缺省时回退请求体自带 model
  const bodyFallback = applyDevCompat({ model: 'gpt-5.6', messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }] });
  check(
    '未传 effectiveModel 时按 body.model 判定',
    bodyFallback?.messages?.[0]?.role === 'developer' && bodyFallback?.messages?.[1]?.role === 'user',
    JSON.stringify(bodyFallback?.messages)
  );
}

console.log('\n===== 3. 门控：不影响其他场景 =====');
{
  // 非 OpenAI 新模型：system 角色保持原样（DeepSeek/Qwen 等只认 system）
  const completionsBody = { model: 'deepseek-chat', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] };
  const untouched = applyDevCompat(completionsBody, 'deepseek-chat');
  check(
    'deepseek-chat 的 system 不改写（这些供应商不认 developer）',
    untouched?.messages?.[0]?.role === 'system',
    JSON.stringify(untouched?.messages)
  );

  // gpt-4o 等旧模型同样不改写
  const gpt4o = applyDevCompat({ model: 'gpt-4o', messages: [{ role: 'system', content: 's' }] }, 'gpt-4o');
  check('gpt-4o 的 system 不改写', gpt4o?.messages?.[0]?.role === 'system', JSON.stringify(gpt4o?.messages));

  // claude 目标格式：system 是顶层字段、messages 内无 system 角色，天然不受影响
  const claudeTarget = applyDevCompat({ model: 'gpt-5.6', system: 's', messages: [{ role: 'user', content: 'u' }] }, 'gpt-5.6');
  check(
    'claude 格式顶层 system 字段不被改写',
    claudeTarget?.system === 's' && claudeTarget?.messages?.[0]?.role === 'user',
    JSON.stringify(claudeTarget)
  );

  // 非对象请求体原样返回
  check('非对象请求体原样返回', applyDevCompat(null, 'gpt-5.6') === null, 'null');
  check('数组请求体原样返回', Array.isArray(applyDevCompat([1, 2], 'gpt-5.6')), 'array');

  // 模型名判定正反例
  const positive = ['gpt-5.6-sol', 'gpt-5', 'gpt-5.1', 'gpt-5-codex', 'openai/gpt-5.6', 'o1', 'o3-mini', 'o4-mini', 'openai/o3', 'codex-mini-latest'];
  const negative = ['gpt-4o', 'gpt-4.1', 'claude-sonnet-4-5', 'deepseek-chat', 'qwen3-coder', 'kimi-o3', 'glm-4.5', 'hunyuan-o1'];
  check('正例全部命中', positive.every(m => requiresDeveloper(m) === true), positive.filter(m => !requiresDeveloper(m)).join(','));
  check('反例全部不命中', negative.every(m => requiresDeveloper(m) === false), negative.filter(m => requiresDeveloper(m)).join(','));
}

console.log(failed === 0 ? '\n全部通过 ✓' : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
