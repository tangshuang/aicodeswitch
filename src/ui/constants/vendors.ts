import { SourceType, AuthType } from "../../types";

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
            authType?: AuthType;
        }[];
        is_oversea?: boolean;
    };
};

export default {
    minimax: {
        name: 'Minimax',
        description: '国内优秀的大模型 https://platform.minimaxi.com/subscribe/coding-plan?code=G6xKj7L4YN&source=link',
        services: [
            {
                name: 'Coding Plan Claude Code',
                sourceType: 'claude-code',
                apiUrl: 'https://api.minimaxi.com/anthropic',
                models: 'MiniMax-M2.1',
            },
            {
                name: 'Coding Plan Codex',
                sourceType: 'openai-chat',
                apiUrl: 'https://api.minimaxi.com/v1',
                models: 'codex-MiniMax-M2.1',
            }
        ]
    },
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
                },
            },
        ],
    },
    kimi: {
        name: 'Kimi',
        description: '国内优秀大模型 https://www.kimi.ai/',
        services: [
            {
                name: 'Coding Plan Claude Code',
                sourceType: 'claude-code',
                apiUrl: 'https://api.kimi.com/coding',
            }
        ]
    },
    doubao: {
        name: '火山方舟（豆包）',
        description: '字节旗下大模型平台。Coding Plan一次性支持GLM、Kimi-K2、Deepseek多个国产模型 https://volcengine.com/L/RcHlm6yxj0w/  邀请码：Y58X463P',
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
            {
                name: '付费API兼容Codex',
                sourceType: 'openai-responses',
                apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
                models: 'doubao-seed-code-preview-251028',
            },
        ],
    },
    qwen: {
        name: '阿里云百炼（千问）',
        description: '国内优秀大模型 https://help.aliyun.com/zh/model-studio/coding-plan',
        services: [
            {
                name: 'Coding Plan Claude Code',
                sourceType: 'claude-code',
                apiUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
                models: 'qwen3-max-2026-01-23, qwen3-coder-plus',
            },
            {
                name: 'Coding Plan Codex',
                sourceType: 'openai-chat',
                apiUrl: 'https://coding.dashscope.aliyuncs.com/v1',
                models: 'qwen3-max-2026-01-23, qwen3-coder-plus',
            },
            {
                name: '付费API兼容Codex',
                sourceType: 'openai-responses',
                apiUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1',
                models: 'qwen3-max-2026-01-23, qwen3-coder-plus, kimi-k2.5, glm-4.7, MiniMax-M2.1',
            },
        ]
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
                name: 'Claude Code专属接口',
                sourceType: 'claude-code',
                apiUrl: 'https://openrouter.ai/api',
                models: 'anthropic/claude-opus-4.6, anthropic/claude-opus-4.5, anthropic/claude-sonnet-4.5, anthropic/claude-haiku-4.5',
                authType: AuthType.AUTH_TOKEN,
            },
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
