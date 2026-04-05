import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// 延迟读取 process.env.AUTH，避免模块加载时 dotenv 尚未执行导致值始终为空
function getAuthCode(): string {
  return process.env.AUTH || '';
}

function getJwtSecret(): string {
  const authCode = getAuthCode();
  return process.env.JWT_SECRET || (authCode ? crypto.createHash('sha256').update(authCode).digest('hex') : '');
}

const TOKEN_EXPIRY = '7d'; // 7天有效期

interface JWTPayload {
  authenticated: boolean;
}

/**
 * 检查是否启用鉴权
 */
export function isAuthEnabled(): boolean {
  return getAuthCode().trim().length > 0;
}

/**
 * 验证鉴权码
 */
export function verifyAuthCode(authCode: string): boolean {
  if (!isAuthEnabled()) {
    return true; // 未启用鉴权,直接通过
  }
  return authCode === getAuthCode();
}

/**
 * 生成 JWT Token
 */
export function generateToken(): string {
  const payload: JWTPayload = {
    authenticated: true,
  };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_EXPIRY });
}

/**
 * 验证 JWT Token
 */
export function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, getJwtSecret()) as JWTPayload;
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Express 中间件: 验证 JWT Token
 *
 * 如果未启用鉴权,直接放行
 * 如果启用鉴权但 token 无效,返回 401
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 如果未启用鉴权,直接放行
  if (!isAuthEnabled()) {
    next();
    return;
  }

  // 从 Authorization header 中提取 token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    return;
  }

  const token = authHeader.substring(7); // 移除 "Bearer " 前缀

  if (verifyToken(token)) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
}
