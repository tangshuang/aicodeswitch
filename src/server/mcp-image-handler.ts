import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { MCPServer, Rule } from '../types';

/**
 * MCP 图像理解处理器
 * 用于处理图像理解类型的请求，通过MCP工具实现
 */

// 临时文件目录
const TEMP_DIR = path.join(os.tmpdir(), 'aicodeswitch-images');

// 确保临时目录存在
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * 从 base64 数据中提取图片信息
 */
function extractBase64Image(dataUrl: string): { mimeType: string; data: string } | null {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) return null;
  return {
    mimeType: matches[1],
    data: matches[2],
  };
}

/**
 * 从 URL 数据中提取图片类型
 */
function getImageTypeFromUrl(url: string): string {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.png')) return 'image/png';
  if (urlLower.includes('.gif')) return 'image/gif';
  if (urlLower.includes('.webp')) return 'image/webp';
  return 'image/jpeg'; // 默认
}

/**
 * 将图片保存到临时文件
 * @param imageData 图片��据（base64 或 URL）
 * @param isBase64 是否为 base64 编码
 * @returns 本地文件路径
 */
export async function saveImageToTempFile(
  imageData: string,
  isBase64: boolean = true
): Promise<{ filePath: string; mimeType: string }> {
  const uniqueId = crypto.randomBytes(16).toString('hex');
  let filePath: string;
  let mimeType: string;

  if (isBase64) {
    // 处理 base64 编码的图片
    const extracted = extractBase64Image(imageData);
    if (!extracted) {
      throw new Error('Invalid base64 image data');
    }

    mimeType = extracted.mimeType;
    const extension = mimeType.split('/')[1] || 'png';
    filePath = path.join(TEMP_DIR, `${uniqueId}.${extension}`);

    // 将 base64 数据写入文件
    const buffer = Buffer.from(extracted.data, 'base64');
    fs.writeFileSync(filePath, buffer);
  } else {
    // 处理 URL 图片 - 需要下载
    throw new Error('URL image downloading not implemented yet');
  }

  return { filePath, mimeType };
}

/**
 * 从请求消息中提取所有图片内容
 * @param messages 请求消息列表
 * @returns 图片信息列表
 */
export async function extractImagesFromMessages(messages: any[]): Promise<Array<{ filePath: string; mimeType: string; index: number }>> {
  const images: Array<{ filePath: string; mimeType: string; index: number }> = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message?.content) continue;

    const content = Array.isArray(message.content) ? message.content : [message.content];

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      // Claude 格式的图片块
      if (block.type === 'image' && block.source?.data) {
        const { filePath, mimeType } = await saveImageToTempFile(block.source.data, true);
        images.push({ filePath, mimeType, index: i });
      }

      // OpenAI 格式的图片块
      if (block.type === 'image_url' && block.image_url?.url) {
        const url = block.image_url.url;
        if (url.startsWith('data:')) {
          const { filePath, mimeType } = await saveImageToTempFile(url, true);
          images.push({ filePath, mimeType, index: i });
        }
      }
    }
  }

  return images;
}

/**
 * 清理临时图片文件
 * @param filePaths 文件路径列表
 */
export function cleanupTempImages(filePaths: string[]): void {
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error(`Failed to cleanup temp file ${filePath}:`, error);
    }
  }
}

/**
 * 构造MCP图像理解请求的消息体
 * 将图片路径替换为本地路径格式，并添加明确的MCP调用指示
 * @param messages 原始消息列表
 * @param imageInfos 图片信息列表
 * @param mcp MCP工具配置（可选）
 * @returns 修改后的消息列表
 */
export function constructMCPMessages(
  messages: any[],
  imageInfos: Array<{ filePath: string; mimeType: string; index: number }>,
  mcp?: MCPServer
): any[] {
  const modifiedMessages = JSON.parse(JSON.stringify(messages));

  // 将图片内容替换为本地路径引用
  for (const imageInfo of imageInfos) {
    const message = modifiedMessages[imageInfo.index];
    if (!message?.content) continue;

    const content = Array.isArray(message.content) ? message.content : [message.content];

    // 找到图片块并替换
    for (const block of content) {
      if (typeof block !== 'object') continue;

      // Claude 格式
      if (block.type === 'image') {
        // 替换为明确的 MCP 调用指示
        block.type = 'text';
        if (mcp) {
          block.text = `[Image File: ${imageInfo.filePath}]\n\n` +
            `请使用 "${mcp.name}" MCP 工具来理解和分析这张图片。` +
            `\n\nMCP 工具信息：\n` +
            `- 名称: ${mcp.name}\n` +
            `- 类型: ${mcp.type}\n` +
            (mcp.description ? `- 说明: ${mcp.description}\n` : '') +
            `\n请主动调用此 MCP 工具来处理图片路径: ${imageInfo.filePath}`;
        } else {
          // 如果没有 MCP 配置，使用简单的路径引用
          block.text = `[Image: ${imageInfo.filePath}]`;
        }
        delete block.source;
      }

      // OpenAI 格式
      if (block.type === 'image_url') {
        block.type = 'text';
        if (mcp) {
          block.text = `[Image File: ${imageInfo.filePath}]\n\n` +
            `请使用 "${mcp.name}" MCP 工具来理解和分析这张图片。` +
            `\n\nMCP 工具信息：\n` +
            `- 名称: ${mcp.name}\n` +
            `- 类型: ${mcp.type}\n` +
            (mcp.description ? `- 说明: ${mcp.description}\n` : '') +
            `\n请主动调用此 MCP 工具来处理图片路径: ${imageInfo.filePath}`;
        } else {
          // 如果没有 MCP 配置，使用简单的路径引用
          block.text = `[Image: ${imageInfo.filePath}]`;
        }
        delete block.image_url;
      }
    }
  }

  return modifiedMessages;
}

/**
 * 获取MCP服务器配置
 * @param mcpId MCP ID
 * @param mcps MCP列表
 * @returns MCP服务器配置
 */
export function getMCPServerConfig(mcpId: string, mcps: MCPServer[]): MCPServer | undefined {
  return mcps.find(mcp => mcp.id === mcpId);
}

/**
 * 检查规则是否使用MCP
 * @param rule 规则
 * @returns 是否使用MCP
 */
export function isRuleUsingMCP(rule: Rule): boolean {
  return rule.contentType === 'image-understanding' && rule.useMCP === true && !!rule.mcpId;
}

/**
 * 检查 MCP 是否可用
 * @param rule 规则
 * @param mcps MCP列表
 * @returns MCP 是否可用
 */
export function isMCPAvailable(rule: Rule, mcps: MCPServer[]): boolean {
  // 基本检查：规则是否配置了 MCP
  if (!isRuleUsingMCP(rule)) {
    return false;
  }

  // 检查 mcpId 是否存在
  if (!rule.mcpId) {
    console.warn('[MCP] Rule configured to use MCP but mcpId is missing');
    return false;
  }

  // 检查 MCP 是否在数据库中注册
  const mcp = mcps.find(m => m.id === rule.mcpId);
  if (!mcp) {
    console.warn(`[MCP] MCP with id ${rule.mcpId} not found in database`);
    return false;
  }

  // MCP 存在且可用
  return true;
}

