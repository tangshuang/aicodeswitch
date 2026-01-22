import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const AUTH_CODE = process.env.AUTH || '';
const JWT_SECRET = process.env.JWT_SECRET || (AUTH_CODE ? crypto.createHash('sha256').update(AUTH_CODE).digest('hex') : '');
const TOKEN_EXPIRY = '7d'; // 7天有效期

interface JWTPayload {
  authenticated: boolean;
}

/**
 * 检查是否启用鉴权
 */
export function isAuthEnabled(): boolean {
  return AUTH_CODE.trim().length > 0;
}

/**
 * 验证鉴权码
 */
export function verifyAuthCode(authCode: string): boolean {
  if (!isAuthEnabled()) {
    return true; // 未启用鉴权,直接通过
  }
  return authCode === AUTH_CODE;
}

/**
 * 生成 JWT Token
 */
export function generateToken(): string {
  const payload: JWTPayload = {
    authenticated: true,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

/**
 * 验证 JWT Token
 */
export function verifyToken(token: string): boolean {
  try {
    jwt.verify(token, JWT_SECRET) as JWTPayload;
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
