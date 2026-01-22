export default {
    glm: {
        name: 'GLM',
        description: '国内优秀的大模型 https://www.bigmodel.cn',
        services: [
            {
                name: 'claudecode',
                sourceType: 'claude-code',
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
                sourceType: 'claude-code',
                apiUrl: 'https://api.aicodewith.com',
                models: '',
            },
            {
                name: 'codex',
                sourceType: 'openai-responses',
                apiUrl: 'https://api.aicodewith.com/chatgpt/v1',
                models: '',
            },
        ],
    },
} as const;
