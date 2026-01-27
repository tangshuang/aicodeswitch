import { SourceType } from "../../types";

type VendorConfig = {
    [vendorKey: string]: {
        name: string;
        description: string;
        services: {
            name: string;
            sourceType: SourceType;
            apiUrl: string;
            models?: string;
            modelLimits?: Record<string, number>;
        }[];
        is_oversea?: boolean;
    };
};

export default {
    glm: {
        name: 'GLM',
        description: '国内优秀的大模型 https://www.bigmodel.cn/glm-coding?ic=5AH7ATEZSC',
        services: [
            {
                name: 'Coding Plan Claude Code',
                sourceType: 'claude-code',
                apiUrl: 'https://open.bigmodel.cn/api/anthropic',
                models: 'glm-4.7, glm-4.5-air',
                modelLimits: {
                    'glm-4.7': 131072,
                    'glm-4.5-air': 98304
                }
            },
        ],
    },
    doubao: {
        name: '豆包',
        description: '字节旗下大模型。Coding Plan一次性支持GLM、Kimi-K2、Deepseek多个国产模型 https://volcengine.com/L/RcHlm6yxj0w/  邀请码：Y58X463P',
        services: [
            {
                name: 'Coding Plan Claude Code',
                sourceType: 'claude-code',
                apiUrl: 'https://ark.cn-beijing.volces.com/api/coding',
                models: 'ark-code-latest',
            },
            {
                name: 'Coding Plan Codex',
                sourceType: 'openai-responses',
                apiUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
                models: 'ark-code-latest',
            },
            {
                name: '付费API兼容Claude Code',
                sourceType: 'claude-code',
                apiUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
                models: 'doubao-seed-code-preview-251028',
            },
        ],
    },
    aicodewith: {
        name: 'AICodeWith',
        description: '稳定的第三方中转 https://aicodewith.com/login?tab=register&invitation=QCA74W',
        services: [
            {
                name: 'claudecode',
                sourceType: 'claude-code',
                apiUrl: 'https://api.aicodewith.com',
            },
            {
                name: 'codex',
                sourceType: 'openai-responses',
                apiUrl: 'https://api.aicodewith.com/chatgpt',
            },
        ],
    },
    openai: {
        name: 'OpenAI',
        description: 'OpenAI 官方 API https://platform.openai.com',
        services: [
            {
                name: 'GPT',
                sourceType: 'openai-responses',
                apiUrl: 'https://api.openai.com',
            },
        ],
        is_oversea: true,
    },
    anthropic: {
        name: 'Anthropic',
        description: 'Anthropic 官方 API https://www.anthropic.com',
        services: [
            {
                name: 'Claude',
                sourceType: 'claude-code',
                apiUrl: 'https://api.anthropic.com',
            },
        ],
        is_oversea: true,
    },
    openrouter: {
        name: 'OpenRouter',
        description: '一站式 AI 模型路由平台 https://openrouter.ai',
        services: [
            {
                name: '通用接口',
                sourceType: 'openai-chat',
                apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
                models: 'anthropic/claude-opus-4.5, anthropic/claude-sonnet-4.5, anthropic/claude-haiku-4.5, openai/gpt-5.2-codex, openai/gpt-5.2-chat, openai/gpt-5.2-pro, openai/gpt-5.2, openai/gpt-5.1-codex-max',
            },
        ],
        is_oversea: true,
    },
} as VendorConfig;
