type VendorConfig = {
    [vendorKey: string]: {
        name: string;
        description: string;
        services: {
            name: string;
            sourceType: 'claude-chat' | 'openai-chat';
            apiUrl: string;
            models?: string;
        }[];
    };
};

export default {
    glm: {
        name: 'GLM',
        description: '国内优秀的大模型 https://www.bigmodel.cn',
        services: [
            {
                name: 'claudecode',
                sourceType: 'claude-chat',
                apiUrl: 'https://open.bigmodel.cn/api/anthropic',
                models: 'glm-4.7, glm-4.5-air',
            },
        ],
    },
    aicodewith: {
        name: 'AICodeWith',
        description: '稳定的第三方中转 https://aicodewith.com',
        services: [
            {
                name: 'claudecode',
                sourceType: 'claude-chat',
                apiUrl: 'https://api.aicodewith.com',
            },
            {
                name: 'codex',
                sourceType: 'openai-chat',
                apiUrl: 'https://api.aicodewith.com/chatgpt',
            },
        ],
    },
    openai: {
        name: 'OpenAI',
        description: 'OpenAI 官方 API https://platform.openai.com',
        services: [
            {
                name: 'codex',
                sourceType: 'openai-chat',
                apiUrl: 'https://api.openai.com',
            },
        ],
    },
    anthropic: {
        name: 'Anthropic',
        description: 'Anthropic 官方 API https://www.anthropic.com',
        services: [
            {
                name: 'claudecode',
                sourceType: 'claude-chat',
                apiUrl: 'https://api.anthropic.com',
            },
        ],
    },
    openrouter: {
        name: 'OpenRouter',
        description: '一站式 AI 模型路由平台 https://openrouter.ai',
        services: [
            {
                name: 'claudecode',
                sourceType: 'claude-chat',
                apiUrl: 'https://openrouter.ai/api/v1',
                models: 'anthropic/claude-3.5-sonnet, anthropic/claude-3.5-haiku',
            },
            {
                name: 'codex',
                sourceType: 'openai-chat',
                apiUrl: 'https://openrouter.ai/api/v1',
                models: 'openai/gpt-4o',
            },
        ],
    },
} as VendorConfig;
