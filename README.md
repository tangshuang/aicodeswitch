# AI Code Switch

## 简介

AI Code Switch 是帮助你在本地管理 AI 编程工具接入大模型的工具。
它可以让你的 Claude Code、Codex 等工具不再局限于官方模型。

**而且它尽可能简单的帮你解决这件事。**

- 视频演示：[https://www.bilibili.com/video/BV1uEznBuEJd/](https://www.bilibili.com/video/BV1uEznBuEJd/?from=github)
- 1分钟让Claude Code接入GLM国产模型：[https://www.bilibili.com/video/BV1a865B8ErA/](https://www.bilibili.com/video/BV1a865B8ErA/)

## 桌面版

桌面端应用下载：[https://github.com/tangshuang/aicodeswitch/releases](https://github.com/tangshuang/aicodeswitch/releases)

## 命令行工具

### 安装

```
npm install -g aicodeswitch
```

**注意：**由于工具依赖sqlite和leveldb作为数据存储，在安装过程中，会执行这两个数据库的编译，如果你是在windows电脑上安装，你需要安装 visual studio 2017 以上版本，才能正常编译数据库，macos 和 linux 系统中一般都自带了编译工具，因此大部分情况下都能正确编译。

### 使用方法

**启动服务**

```
aicos start
```

或者直接运行

```
aicos ui
```

**停止服务**

```
aicos stop
```

**进入管理界面**

```
# 自动启动服务和打开界面
aicos ui
```

```
# 手动在浏览器打开管理界面
http://127.0.0.1:4567
```

## 管理界面

**配置供应商**

*   什么是供应商？
*   供应商配置有什么用？

具体请看下方文档。

**路由配置**

*   什么是路由？
*   什么是路由规则？

具体请看下方文档。

**覆盖配置文件**

在aicodeswitch中，点击“写入Claude Code配置”按钮，它会修改Claude Code的配置文件，让Claude Code开始使用aicocdeswitch提供的模型API，而非直接连到官网的模型API。

你不用太担心，你可以在写入后，点击“恢复Claude Code配置”按钮，将Claude Code的配置文件恢复到原始状态。

Codex的配置覆盖逻辑一模一样。

**设置**

你可以在设置页面，对aicodedeswitch进行配置。

也可以导出配置数据，转移到其他电脑上导入。

## 配置供应商

### 什么是供应商？

所谓供应商，就是提供AI服务的上游服务商。可以是OpenAI、Claude、DeepSeek、GLM 官方服务，也可以是其他中转服务商。

### 供应商配置有什么用？

通过将你所有的AI服务商统一起来管理，可以帮你：

1.  避免频繁修改配置文件，通过aicodeswitch，可以一键切换到不同的供应商的AI服务API
2.  通过aicodeswitch，将不同供应商的接口数据，转换为工具可以正确使用的接口数据格式，也就是说，你可以将Claude Code接入遵循openai的接口数据协议的其他接口
3.  避免你忘记曾经注册过那些供应商
4.  充分榨干不怎么用的供应商的服务，避免充值后不怎么用浪费了

### 什么事API服务的“源类型”

供应商接口返回的数据格式标准类型，目前支持以下几种：

*   OpenAI Chat
*   OpenAI Code
*   OpenAI Responses
*   Claude Chat
*   Claude Code
*   DeepSeek Chat

**有什么用？**

aicodeswitch内部，会根据“源类型”来转换数据。例如，你的供应商API服务接口是OpenAI Chat的数据格式，而你在路由中配置的“客户端工具“是Claude Code，那么就意味着，这个供应商API的数据，需要经过转换之后才能被Claude Code正确使用。

## 路由管理

### 什么是路由？

路由是aicodeswitch的核心功能，它负责将不同的对象（目前指Claude Code和Codex）的请求，路由到不同的供应商API服务上。

### 什么是“客户端工具”？

目前指Claude Code或Codex。

### 什么是“路由规则”？

以Claude Code为例，它的请求实际上并非铁板一块，可以被分为多种。比如它的深度思考、长文对话、图片理解等等，都是可以独立对待的。

路由规则的目的，就是让你的工具发出的请求，可以根据这个区分，发送给不同的服务商来处理。例如，你默认使用glm-4.7作为写代码的模型，但是，你可以把图片识别的请求发给doubao-code来进行，因为doubao-code的图片识别平均价格可以更低。同样的道理，不同目标的请求可以通过不同的规则来处理，以提升编程的质量和效果。

目前，我仅提供了几个比较容易区分的规则，以后，还会添加更多的规则。

### 激活路由

我们可以为Claude Code添加多个路由，但是，我们必须激活一个路由，才能开始使用。
而且，所有以Claude Code为对象的路由，在同一时间，只有一个可以被激活。

### 切换路由

你可以根据你的实际情况来实时切换路由，比如，你可以在发现自己的某个服务商处的余额较少时，立即切换到另外一个服务商。

**智能故障切换机制**

当同一请求类型配置多个规则时,系统会按排序优先使用第一个，如果某个服务报错(4xx/5xx)或请求超时，将自动切换到下一个可用规则，确保你可以正常使用coding工具。

## Skills管理

你可以在 aicodeswitch 中集中统一管理 skills，把skills分发给claude code和codex，随时启用和停用skills。
另外，你可以基于自然语言搜索skills，找到skill之后，支持一键安装。

## 日志

在**日志**页面，您可以查看：

**请求日志**：所有 API 请求的详细记录

*   请求来源和目标
*   请求内容和响应
*   耗时和状态码
*   错误信息（如有）

**错误日志**：错误和异常记录

*   错误类型
*   错误详情
*   发生时间

**会话日志**：按照会话session来汇集日志

**日志筛选**

根据提供的选项进行筛选。

## 配置文件

作为 CLI 工具，你可以在 ~/.aicodeswitch/ 目录下找到工具的相关文件。里面有一个 aicodeswitch.conf 文件，可以进行配置。
目前仅支持以下配置：

```
# aicodeswitch的服务IP
HOST=127.0.0.1
# aicodeswitch的服务端口
PORT=4567

# 如果提供AUTH，你无法直接登录用户界面，必须输入AUTH的值才能进入，相当于是一个登陆鉴权
# 如果你在自己的服务器上使用，通过远程接入接口时，就必须提供这个值
# AUTH=
```

## 常见问题

### 1\. 如何切换供应商？

在路由管理页面修改规则的目标供应商，或调整优先级即可。

### 2\. 如何查看失败的请求？

在请求日志页面，筛选状态码不为 200 的记录。

### 3\. 如何备份配置？

在系统设置页面使用**导出配置**功能，然后将提供的数据保存到本地文件中。

### 4\. 如何设置日志保留时间？

在系统设置页面修改**日志保留天数**配置。

## 我的开源

*   [PCM](https://github.com/tangshuang/pcm): 用户意图识别、精准上下文、多线对话的Agent系统
*   [Lan Transfer](https://github.com/tangshuang/lan-transfer): 免费高效的局域网文件互传工具
*   [MCP Bone](https://github.com/tangshuang/mcp-bone): 远程托管的MCP服管理工具
*   [Anys](https://github.com/tangshuang/anys): 免费前端监控kit
*   [WebCut](https://github.com/tangshuang/webcut): 免费开源的网页端视频剪辑UI框架
*   [indb](https://github.com/tangshuang/indb): 网页端轻量kv数据库操作库
*   [Formast](https://github.com/tangshuang/formast): 复杂业务场景下的企业级JSON驱动表单框架

## 关联资源

*   [Claude Code 深度教程](https://claudecode.tangshuang.net): 100%免费的Claude Code入门到精通教程

## 支持我

![](public/donate-to-me.png)

你的支持是我前进的动力！

## 许可

此项目采用双许可证模式：

*   **开源使用**：项目默认采用 GPL 3.0 许可证，允许个人免费使用、修改和分发，但所有衍生品必须开源。
*   **商业使用**：如果您希望商业化使用而不遵守 GPL 条款（例如闭源销售），请联系我们购买单独的商业许可证。

## 技术支持

如有问题或建议，请访问项目 [GitHub 仓库](https://github.com/tangshuang/aicodeswitch/issues)提交 Issue。
