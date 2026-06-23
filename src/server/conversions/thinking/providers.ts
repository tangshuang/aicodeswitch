/**
 * Multi-provider reasoning configuration.
 */

import { ReasoningConfig } from '../types.js';

// streamOptions 语义（决定流式请求是否保留 stream_options.include_usage）：
//   'supported'   → 已知支持 include_usage 的供应商，保留 → 流式可拿到真实 usage
//   'unsupported' → 已知会对 stream_options 报错的供应商，剥离
//   'auto'        → 未明确，由 conversions/index.ts 按 outputFormat 兜底（reasoning_content 剥离，其余保留）
const PROVIDER_CONFIGS: Array<{ patterns: string[]; config: ReasoningConfig }> = [
  { patterns: ['deepseek'], config: { supportsThinking: true, supportsEffort: true, thinkingParam: 'thinking', effortParam: 'reasoning_effort', effortValueMode: 'deepseek', outputFormat: 'reasoning_content', streamOptions: 'supported' } },
  { patterns: ['moonshot', 'kimi'], config: { supportsThinking: true, supportsEffort: false, thinkingParam: 'thinking', effortParam: 'none', effortValueMode: 'passthrough', outputFormat: 'reasoning_content', streamOptions: 'supported' } },
  { patterns: ['qwen', 'dashscope'], config: { supportsThinking: true, supportsEffort: false, thinkingParam: 'enable_thinking', effortParam: 'none', effortValueMode: 'passthrough', outputFormat: 'reasoning_content', streamOptions: 'supported' } },
  { patterns: ['zhipu', 'glm', 'bigmodel'], config: { supportsThinking: true, supportsEffort: false, thinkingParam: 'thinking', effortParam: 'none', effortValueMode: 'passthrough', outputFormat: 'reasoning_content', streamOptions: 'supported' } },
  { patterns: ['minimax'], config: { supportsThinking: true, supportsEffort: false, thinkingParam: 'reasoning_split', effortParam: 'none', effortValueMode: 'passthrough', outputFormat: 'reasoning_details' } },
  { patterns: ['mimo', 'xiaomimimo'], config: { supportsThinking: true, supportsEffort: false, thinkingParam: 'thinking', effortParam: 'none', effortValueMode: 'passthrough', outputFormat: 'reasoning_content', streamOptions: 'auto' } },
  { patterns: ['openrouter'], config: { supportsThinking: false, supportsEffort: true, thinkingParam: 'none', effortParam: 'reasoning.effort', effortValueMode: 'openrouter', outputFormat: 'reasoning' } },
  { patterns: ['siliconflow'], config: { supportsThinking: true, supportsEffort: false, thinkingParam: 'enable_thinking', effortParam: 'none', effortValueMode: 'passthrough', outputFormat: 'reasoning_content', streamOptions: 'supported' } },
  { patterns: ['stepfun', 'step'], config: { supportsThinking: true, supportsEffort: false, thinkingParam: 'none', effortParam: 'reasoning_effort', effortValueMode: 'low_high', outputFormat: 'reasoning' } },
  { patterns: ['agnes'], config: { supportsThinking: true, supportsEffort: false, thinkingParam: 'chat_template_kwargs', effortParam: 'none', effortValueMode: 'passthrough', outputFormat: 'reasoning_content', streamOptions: 'auto' } },
];

const DEFAULT_CONFIG: ReasoningConfig = {
  supportsThinking: false,
  supportsEffort: false,
  thinkingParam: 'none',
  effortParam: 'none',
  effortValueMode: 'passthrough',
  outputFormat: 'reasoning_content',
  streamOptions: 'auto',
};

/** Detect reasoning config for a given provider */
export function getReasoningConfig(providerName: string, baseUrl: string, model: string): ReasoningConfig {
  const haystack = `${providerName} ${baseUrl} ${model}`.toLowerCase();
  for (const { patterns, config } of PROVIDER_CONFIGS) {
    if (patterns.some(p => haystack.includes(p))) {
      return config;
    }
  }
  return DEFAULT_CONFIG;
}

/** Apply reasoning config to a request body */
export function applyReasoningConfig(body: any, config: ReasoningConfig, effort: string | null): any {
  if (!effort) return body;
  const result = { ...body };

  if (config.supportsThinking && config.thinkingParam !== 'none') {
    switch (config.thinkingParam) {
      case 'thinking':
        result.thinking = { type: 'enabled' };
        break;
      case 'enable_thinking':
        result.enable_thinking = true;
        break;
      case 'reasoning_split':
        result.reasoning_split = true;
        break;
      case 'chat_template_kwargs':
        result.chat_template_kwargs = { ...result.chat_template_kwargs, enable_thinking: true };
        break;
    }
  }

  if (config.supportsEffort && config.effortParam !== 'none' && effort) {
    const mappedEffort = mapEffortValue(effort, config.effortValueMode);
    if (config.effortParam === 'reasoning.effort') {
      result.reasoning = result.reasoning || {};
      result.reasoning.effort = mappedEffort;
    } else {
      (result as any)[config.effortParam] = mappedEffort;
    }
  }

  return result;
}

function mapEffortValue(effort: string, mode: string): string {
  switch (mode) {
    case 'deepseek': return 'high'; // DeepSeek only supports high/max
    case 'low_high': return ['low', 'medium'].includes(effort) ? 'low' : 'high';
    case 'openrouter': return ['xhigh', 'max'].includes(effort) ? 'xhigh' : effort;
    default: return effort;
  }
}

export { DEFAULT_CONFIG };
