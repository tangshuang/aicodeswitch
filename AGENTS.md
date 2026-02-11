* 在每次任务开始前，你需要阅读 CLAUDE.md 文件，以了解本项目详细细节。
* 使用yarn作为包管理器，请使用yarn安装依赖，使用yarn来运行脚本。
* 前端依赖库安装在devDependencies中，请使用yarn install --dev安装。
* 所有对话请使用中文。生成代码中的文案及相关注释根据代码原本的语言生成。
* 在服务端，直接使用 __dirname 来获取当前目录，不要使用 process.cwd()
* 每次有新的变化时，你需要更新 AGENTS.md 来让文档保持最新，并且以非常简单的概述，将变化内容记录到 CHANGELOG.md 中。
* 禁止在ui中使用依赖GPU的css样式。
* 禁止运行 dev:ui, dev:server, tauri:dev 等命令来进行测试。
* 如果你需要创建文档，必须将文档放在 documents 目录下
* 如果你需要创建测试脚本，必须将脚本文件放在 scripts 目录下