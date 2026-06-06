import { SourceType, AuthType } from "../../types";

type VendorConfig = {
    [vendorKey: string]: {
        name: string;
        description: string;
        tags?: string[];
        link?: string;
        services: {
            name: string;
            sourceType: SourceType;
            apiUrl: string;
            models?: string;
            modelLimits?: Record<string, number>;
            authType?: AuthType;
        }[];
        sortedGroup?: number;
    };
};

export default {
    aicodingbus: {
        name: 'AICodingBus',
        description: 'AICodingBus 是一个Token共享平台，用户可以在平台上分享和交换Token。',
        tags: ['官方推荐'],
        link: 'https://aicodingbus.24x7.to/',
        services: [
            {
                name: 'Claude 标准接口',
                sourceType: 'claude',
                apiUrl: 'https://aicodingbus.24x7.to/v1',
                models: '',
            },
            {
                name: 'Chat Completions 标准接口',
                sourceType: 'openai-chat',
                apiUrl: 'https://aicodingbus.24x7.to/v1/chat/completions',
                models: '',
            },
            {
                name: 'Responses 标准接口',
                sourceType: 'openai',
                apiUrl: 'https://aicodingbus.24x7.to/v1',
                models: '',
            },
        ],
        sortedGroup: -1,
    },
    minimax: {
        name: 'Minimax',
        description: '国内优秀的大模型',
        link: 'https://platform.minimaxi.com/subscribe/coding-plan?code=G6xKj7L4YN&source=link',
        services: [
            {
                name: 'Claude 标准接口 | Coding Plan',
                sourceType: 'claude',
                apiUrl: 'https://api.minimaxi.com/anthropic',
                models: 'MiniMax-M2.5, MiniMax-M2.7',
            },
            {
                name: 'Chat Completions 标准接口（支持Coding Plan的API Key）',
                sourceType: 'openai-chat',
                apiUrl: 'https://api.minimaxi.com/v1/chat/completions',
                models: 'MiniMax-M2.5, MiniMax-M2.7',
            }
        ]
    },
    glm: {
        name: 'GLM',
        description: '国内优秀的大模型',
        link: 'https://www.bigmodel.cn/invite?icode=kgOTGFRH%2Ftc5Xkyu5N0wHOnfet45IvM%2BqDogImfeLyI%3D',
        services: [
            {
                name: 'Claude 标准接口 | Coding Plan',
                sourceType: 'claude',
                apiUrl: 'https://open.bigmodel.cn/api/anthropic',
                models: 'glm-5.1, glm-5, glm-4.7, glm-4.5-air',
                modelLimits: {
                    'glm-5.1': 131072,
                    'glm-5': 131072,
                    'glm-4.7': 131072,
                    'glm-4.5-air': 98304
                },
            },
            {
                name: 'Chat Completions 标准接口 | Coding Plan',
                sourceType: 'openai-chat',
                apiUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
                models: 'glm-5.1, glm-5, glm-4.7, glm-4.5-air',
                modelLimits: {
                    'glm-5.1': 131072,
                    'glm-5': 131072,
                    'glm-4.7': 131072,
                    'glm-4.5-air': 98304
                },
            },
        ],
    },
    kimi: {
        name: 'Kimi',
        description: '国内优秀大模型',
        link: 'https://www.kimi.ai/',
        services: [
            {
                name: 'Claude 标准接口 | Coding Plan',
                sourceType: 'claude',
                apiUrl: 'https://api.kimi.com/coding',
            },
            {
                name: 'Chat Completions 标准接口 | Coding Plan',
                sourceType: 'openai-chat',
                apiUrl: 'https://api.kimi.com/coding/v1/chat/completions',
                models: 'kimi-for-coding',
                modelLimits: {
                    'kimi-for-coding': 32768
                }
            },
        ]
    },
    doubao: {
        name: '火山方舟（豆包）',
        description: '字节旗下大模型平台。Coding Plan一次性支持GLM、Kimi-K2、Deepseek多个国产模型 邀请码：Y58X463P',
        link: 'https://volcengine.com/L/RcHlm6yxj0w/',
        services: [
            {
                name: 'Claude 标准接口 | Coding Plan',
                sourceType: 'claude',
                apiUrl: 'https://ark.cn-beijing.volces.com/api/coding',
                models: 'ark-code-latest',
            },
            {
                name: 'Responses 标准接口 | Coding Plan',
                sourceType: 'openai',
                apiUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
                models: 'ark-code-latest',
            },
            {
                name: 'Claude 标准接口（付费API）',
                sourceType: 'claude',
                apiUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
                models: 'doubao-seed-2-0-code-preview-260215, doubao-seed-code-preview-251028',
            },
            {
                name: 'Responses 标准接口（付费API）',
                sourceType: 'openai',
                apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
                models: 'doubao-seed-2-0-code-preview-260215, doubao-seed-code-preview-251028',
            },
            {
                name: 'Chat Completions 标准接口（付费API）',
                sourceType: 'openai-chat',
                apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
                models: 'doubao-seed-2-0-code-preview-260215, doubao-seed-code-preview-251028',
            },
        ],
    },
    qwen: {
        name: '阿里云百炼（千问）',
        description: '国内优秀大模型',
        link: 'https://help.aliyun.com/zh/model-studio/coding-plan',
        services: [
            {
                name: 'Claude 标准接口 | Coding Plan',
                sourceType: 'claude',
                apiUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
                models: 'qwen3-max-2026-01-23, qwen3-coder-plus',
            },
            {
                name: 'Responses 标准接口 | Coding Plan',
                sourceType: 'openai-chat',
                apiUrl: 'https://coding.dashscope.aliyuncs.com/v1',
                models: 'qwen3-max-2026-01-23, qwen3-coder-plus',
            },
            {
                name: 'Responses 标准接口（付费API）',
                sourceType: 'openai',
                apiUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1',
                models: 'qwen3-max-2026-01-23, qwen3-coder-plus, kimi-k2.5, glm-4.7, MiniMax-M2.1',
            },
            {
                name: 'Claude 标准接口（付费API）',
                sourceType: 'claude',
                apiUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
                models: 'qwen3-max-2026-01-23, qwen3-coder-plus, kimi-k2.5, glm-4.7, MiniMax-M2.1',
            },
        ]
    },
    deepseek: {
        name: 'DeepSeek',
        description: 'DeepSeek 官方 API',
        link: 'https://platform.deepseek.com',
        services: [
            {
                name: 'Claude 标准接口（付费API）',
                sourceType: 'claude',
                apiUrl: 'https://api.deepseek.com/anthropic',
                models: 'deepseek-v4-flash, deepseek-v4-pro',
            },
            {
                name: 'DeepSeek Reasoning Chat 接口（付费API）',
                sourceType: 'openai-chat',
                apiUrl: 'https://api.deepseek.com/v1/chat/completions',
                models: 'deepseek-v4-flash, deepseek-v4-pro',
            },
        ],
    },
    mimo: {
        name: 'Mimo',
        description: '小米 Mimo 国产大模型',
        link: 'https://platform.xiaomimimo.com?ref=M8BFP3',
        services: [
            {
                name: 'Claude 标准接口 | Coding Plan',
                sourceType: 'claude',
                apiUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
                models: 'mimo-v2.5-pro, mimo-v2-pro, mimo-v2.5, mimo-v2-omni, mimo-v2-flash',
            },
            {
                name: 'Chat Completions 标准接口 | Coding Plan',
                sourceType: 'openai-chat',
                apiUrl: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
                models: 'mimo-v2.5-pro, mimo-v2-pro, mimo-v2.5, mimo-v2-omni, mimo-v2-flash',
            },
            {
                name: 'Chat Completions 标准接口（付费API）',
                sourceType: 'openai-chat',
                apiUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
                models: 'mimo-v2.5-pro, mimo-v2-pro, mimo-v2.5, mimo-v2-omni, mimo-v2-flash',
            },
            {
                name: 'Claude 标准接口（付费API）',
                sourceType: 'claude',
                apiUrl: 'https://api.xiaomimimo.com/anthropic',
                models: 'mimo-v2.5-pro, mimo-v2-pro, mimo-v2.5, mimo-v2-omni, mimo-v2-flash',
            },
        ],
    },
    openai: {
        name: 'OpenAI',
        description: 'OpenAI 官方 API',
        link: 'https://platform.openai.com',
        services: [
            {
                name: 'GPT官方接口',
                sourceType: 'openai',
                apiUrl: 'https://api.openai.com',
            },
        ],
        sortedGroup: 3,
    },
    anthropic: {
        name: 'Anthropic',
        description: 'Anthropic 官方 API',
        link: 'https://www.anthropic.com',
        services: [
            {
                name: 'Claude官方接口',
                sourceType: 'claude',
                apiUrl: 'https://api.anthropic.com',
            },
        ],
        sortedGroup: 3,
    },
    google: {
        name: 'Google AI',
        description: 'Gemini官方接口',
        services: [
            {
                name: 'Gemini',
                sourceType: 'gemini',
                apiUrl: 'https://generativelanguage.googleapis.com',
            }
        ],
        sortedGroup: 3,
    },
    openrouter: {
        name: 'OpenRouter',
        description: '一站式 AI 模型路由平台',
        link: 'https://openrouter.ai',
        services: [
            {
                name: 'Claude Code专属接口',
                sourceType: 'claude',
                apiUrl: 'https://openrouter.ai/api',
                models: 'anthropic/claude-opus-4.6, anthropic/claude-opus-4.5, anthropic/claude-sonnet-4.6, anthropic/claude-sonnet-4.5, anthropic/claude-haiku-4.5',
            },
            {
                name: 'Responses 标准接口 (Beta)',
                sourceType: 'openai',
                apiUrl: 'https://openrouter.ai/api/v1',
                models: 'openai/gpt-5.3-codex, openai/gpt-5.4, openai/gpt-5.5, openai/gpt-5.4-mini',
            },
            {
                name: 'Chat Completions 标准接口',
                sourceType: 'openai-chat',
                apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
                models: 'anthropic/claude-opus-4.6, anthropic/claude-sonnet-4.6, anthropic/claude-haiku-4.6, openai/gpt-5.3-codex, openai/gpt-5.4, openai/gpt-5.5, openai/gpt-5.4-mini, google/gemini-3-flash-preview, google/gemini-3-pro-preview',
            },
            {
                name: 'Claude 标准接口',
                sourceType: 'claude',
                apiUrl: 'https://openrouter.ai/api',
                models: 'anthropic/claude-opus-4.6, anthropic/claude-sonnet-4.6, anthropic/claude-haiku-4.6, openai/gpt-5.3-codex, openai/gpt-5.4, openai/gpt-5.5, openai/gpt-5.4-mini, google/gemini-3-flash-preview, google/gemini-3-pro-preview',
                authType: AuthType.AUTH_TOKEN,
            }
        ],
        sortedGroup: 3,
    },
    agnes: {
        name: 'Agnes',
        description: '优秀的模型厂商，拥有多种模型，提供免费 API 使用',
        tags: ['永久免费'],
        link: 'https://platform.agnes-ai.com',
        services: [
            {
                name: 'Chat Completions 标准接口（免费）',
                sourceType: 'openai-chat',
                apiUrl: 'https://apihub.agnes-ai.com/v1/chat/completions',
                models: 'agnes-2.0-flash, agnes-1.5-flash',
                authType: AuthType.AUTH_TOKEN,
            },
        ],
        sortedGroup: -1,
    },
} as VendorConfig;
