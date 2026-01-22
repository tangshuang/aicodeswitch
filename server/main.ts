import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { DatabaseManager } from './database';
import { ProxyServer } from './proxy-server';
import type { AppConfig, LoginRequest, LoginResponse, AuthStatus } from '../types';
import os from 'os';
import { isAuthEnabled, verifyAuthCode, generateToken, authMiddleware } from './auth';

const dotenvPath = path.resolve(os.homedir(), '.aicodeswitch/aicodeswitch.conf');
if (fs.existsSync(dotenvPath)) {
  dotenv.config({ path: dotenvPath });
}

const host = process.env.HOST || '127.0.0.1';
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
const dataDir = process.env.DATA_DIR ? path.resolve(process.cwd(), process.env.DATA_DIR) : path.join(os.homedir(), '.aicodeswitch/data');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

const writeClaudeConfig = async (dbManager: DatabaseManager): Promise<boolean> => {
  try {
    const homeDir = os.homedir();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
    const config = dbManager.getConfig();

    // Claude Code settings.json
    const claudeDir = path.join(homeDir, '.claude');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    const claudeSettingsBakPath = path.join(claudeDir, 'settings.json.bak');
    const claudeJsonBakPath = path.join(homeDir, '.claude.json.bak');

    // Check if any backup file already exists
    if (fs.existsSync(claudeSettingsBakPath) || fs.existsSync(claudeJsonBakPath)) {
      console.error('Claude backup files already exist, refusing to overwrite');
      return false;
    }

    if (fs.existsSync(claudeSettingsPath)) {
      fs.renameSync(claudeSettingsPath, claudeSettingsBakPath);
    }

    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    const claudeSettings = {
      env: {
        ANTHROPIC_AUTH_TOKEN: config.apiKey || "api_key",
        ANTHROPIC_BASE_URL: `http://${host}:${port}/claude-code`,
        API_TIMEOUT_MS: "3000000"
      }
    };

    fs.writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2));

    // Claude Code .claude.json
    const claudeJsonPath = path.join(homeDir, '.claude.json');

    if (fs.existsSync(claudeJsonPath)) {
      fs.renameSync(claudeJsonPath, claudeJsonBakPath);
    }

    let claudeJson: any = {};
    if (fs.existsSync(claudeJsonPath)) {
      claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    }
    claudeJson.hasCompletedOnboarding = true;

    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));

    return true;
  } catch (error) {
    console.error('Failed to write Claude config files:', error);
    return false;
  }
};

const writeCodexConfig = async (dbManager: DatabaseManager): Promise<boolean> => {
  try {
    const homeDir = os.homedir();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4567;
    const config = dbManager.getConfig();

    // Codex config.toml
    const codexDir = path.join(homeDir, '.codex');
    const codexConfigPath = path.join(codexDir, 'config.toml');
    const codexConfigBakPath = path.join(codexDir, 'config.toml.bak');
    const codexAuthBakPath = path.join(codexDir, 'auth.json.bak');

    // Check if any backup file already exists
    if (fs.existsSync(codexConfigBakPath) || fs.existsSync(codexAuthBakPath)) {
      console.error('Codex backup files already exist, refusing to overwrite');
      return false;
    }

    if (fs.existsSync(codexConfigPath)) {
      fs.renameSync(codexConfigPath, codexConfigBakPath);
    }

    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }

    const codexConfig = `model_provider = "aicodeswitch"
model = "gpt-5.1-codex"
model_reasoning_effort = "high"
disable_response_storage = true


[model_providers.aicodeswitch]
name = "aicodeswitch"
base_url = "http://${host}:${port}/codex"
wire_api = "responses"
requires_openai_auth = true
`;

    fs.writeFileSync(codexConfigPath, codexConfig);

    // Codex auth.json
    const codexAuthPath = path.join(codexDir, 'auth.json');

    if (fs.existsSync(codexAuthPath)) {
      fs.renameSync(codexAuthPath, codexAuthBakPath);
    }

    const codexAuth = {
      OPENAI_API_KEY: config.apiKey || "api_key"
    };

    fs.writeFileSync(codexAuthPath, JSON.stringify(codexAuth, null, 2));

    return true;
  } catch (error) {
    console.error('Failed to write Codex config files:', error);
    return false;
  }
};

const restoreClaudeConfig = async (): Promise<boolean> => {
  try {
    const homeDir = os.homedir();

    // Restore Claude Code settings.json
    const claudeDir = path.join(homeDir, '.claude');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    const claudeSettingsBakPath = path.join(claudeDir, 'settings.json.bak');

    if (fs.existsSync(claudeSettingsBakPath)) {
      if (fs.existsSync(claudeSettingsPath)) {
        fs.unlinkSync(claudeSettingsPath);
      }
      fs.renameSync(claudeSettingsBakPath, claudeSettingsPath);
    }

    // Restore Claude Code .claude.json
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const claudeJsonBakPath = path.join(homeDir, '.claude.json.bak');

    if (fs.existsSync(claudeJsonBakPath)) {
      if (fs.existsSync(claudeJsonPath)) {
        fs.unlinkSync(claudeJsonPath);
      }
      fs.renameSync(claudeJsonBakPath, claudeJsonPath);
    }

    return true;
  } catch (error) {
    console.error('Failed to restore Claude config files:', error);
    return false;
  }
};

const restoreCodexConfig = async (): Promise<boolean> => {
  try {
    const homeDir = os.homedir();

    // Restore Codex config.toml
    const codexDir = path.join(homeDir, '.codex');
    const codexConfigPath = path.join(codexDir, 'config.toml');
    const codexConfigBakPath = path.join(codexDir, 'config.toml.bak');

    if (fs.existsSync(codexConfigBakPath)) {
      if (fs.existsSync(codexConfigPath)) {
        fs.unlinkSync(codexConfigPath);
      }
      fs.renameSync(codexConfigBakPath, codexConfigPath);
    }

    // Restore Codex auth.json
    const codexAuthPath = path.join(codexDir, 'auth.json');
    const codexAuthBakPath = path.join(codexDir, 'auth.json.bak');

    if (fs.existsSync(codexAuthBakPath)) {
      if (fs.existsSync(codexAuthPath)) {
        fs.unlinkSync(codexAuthPath);
      }
      fs.renameSync(codexAuthBakPath, codexAuthPath);
    }

    return true;
  } catch (error) {
    console.error('Failed to restore Codex config files:', error);
    return false;
  }
};

const checkClaudeBackupExists = (): boolean => {
  try {
    const homeDir = os.homedir();
    const claudeSettingsBakPath = path.join(homeDir, '.claude', 'settings.json.bak');
    const claudeJsonBakPath = path.join(homeDir, '.claude.json.bak');

    return fs.existsSync(claudeSettingsBakPath) || fs.existsSync(claudeJsonBakPath);
  } catch (error) {
    console.error('Failed to check Claude backup files:', error);
    return false;
  }
};

const checkCodexBackupExists = (): boolean => {
  try {
    const homeDir = os.homedir();
    const codexConfigBakPath = path.join(homeDir, '.codex', 'config.toml.bak');
    const codexAuthBakPath = path.join(homeDir, '.codex', 'auth.json.bak');

    return fs.existsSync(codexConfigBakPath) || fs.existsSync(codexAuthBakPath);
  } catch (error) {
    console.error('Failed to check Codex backup files:', error);
    return false;
  }
};

const registerRoutes = (dbManager: DatabaseManager, proxyServer: ProxyServer) => {
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // 鉴权相关路由 - 公开访问
  app.get('/api/auth/status', (_req, res) => {
    const response: AuthStatus = { enabled: isAuthEnabled() };
    res.json(response);
  });

  app.post('/api/auth/login', (req, res) => {
    const { authCode } = req.body as LoginRequest;

    if (!authCode) {
      res.status(400).json({ error: 'Auth code is required' });
      return;
    }

    if (verifyAuthCode(authCode)) {
      const token = generateToken();
      const response: LoginResponse = { token };
      res.json(response);
    } else {
      res.status(401).json({ error: 'Invalid auth code' });
    }
  });

  // 鉴权中间件 - 保护所有 /api/* 路由 (除了 /api/auth/*)
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) {
      next(); // /api/auth/* 路由不需要鉴权
    } else {
      authMiddleware(req, res, next);
    }
  });

  app.get('/api/vendors', (_req, res) => res.json(dbManager.getVendors()));
  app.post('/api/vendors', (req, res) => res.json(dbManager.createVendor(req.body)));
  app.put('/api/vendors/:id', (req, res) => res.json(dbManager.updateVendor(req.params.id, req.body)));
  app.delete('/api/vendors/:id', (req, res) => res.json(dbManager.deleteVendor(req.params.id)));

  app.get('/api/services', (req, res) => {
    const vendorId = typeof req.query.vendorId === 'string' ? req.query.vendorId : undefined;
    res.json(dbManager.getAPIServices(vendorId));
  });
  app.post('/api/services', (req, res) => res.json(dbManager.createAPIService(req.body)));
  app.put('/api/services/:id', (req, res) => res.json(dbManager.updateAPIService(req.params.id, req.body)));
  app.delete('/api/services/:id', (req, res) => res.json(dbManager.deleteAPIService(req.params.id)));

  app.get('/api/routes', (_req, res) => res.json(dbManager.getRoutes()));
  app.post('/api/routes', (req, res) => res.json(dbManager.createRoute(req.body)));
  app.put('/api/routes/:id', (req, res) => res.json(dbManager.updateRoute(req.params.id, req.body)));
  app.delete('/api/routes/:id', (req, res) => res.json(dbManager.deleteRoute(req.params.id)));
  app.post(
    '/api/routes/:id/activate',
    asyncHandler(async (req, res) => {
      const result = dbManager.activateRoute(req.params.id);
      if (result) {
        await proxyServer.reloadRoutes();
      }
      res.json(result);
    })
  );

  app.post(
    '/api/routes/:id/deactivate',
    asyncHandler(async (req, res) => {
      const result = dbManager.deactivateRoute(req.params.id);
      if (result) {
        await proxyServer.reloadRoutes();
      }
      res.json(result);
    })
  );

  app.get('/api/rules', (req, res) => {
    const routeId = typeof req.query.routeId === 'string' ? req.query.routeId : undefined;
    res.json(dbManager.getRules(routeId));
  });
  app.post('/api/rules', (req, res) => res.json(dbManager.createRule(req.body)));
  app.put('/api/rules/:id', (req, res) => res.json(dbManager.updateRule(req.params.id, req.body)));
  app.delete('/api/rules/:id', (req, res) => res.json(dbManager.deleteRule(req.params.id)));

  app.get(
    '/api/logs',
    asyncHandler(async (req, res) => {
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const rawOffset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const logs = await dbManager.getLogs(limit, offset);
      res.json(logs);
    })
  );
  app.delete(
    '/api/logs',
    asyncHandler(async (_req, res) => {
      await dbManager.clearLogs();
      res.json(true);
    })
  );

  app.get(
    '/api/access-logs',
    asyncHandler(async (req, res) => {
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const rawOffset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const logs = await dbManager.getAccessLogs(limit, offset);
      res.json(logs);
    })
  );
  app.delete(
    '/api/access-logs',
    asyncHandler(async (_req, res) => {
      await dbManager.clearAccessLogs();
      res.json(true);
    })
  );

  app.get(
    '/api/error-logs',
    asyncHandler(async (req, res) => {
      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
      const rawOffset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : NaN;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 100;
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const logs = await dbManager.getErrorLogs(limit, offset);
      res.json(logs);
    })
  );
  app.delete(
    '/api/error-logs',
    asyncHandler(async (_req, res) => {
      await dbManager.clearErrorLogs();
      res.json(true);
    })
  );

  app.get('/api/config', (_req, res) => res.json(dbManager.getConfig()));
  app.put(
    '/api/config',
    asyncHandler(async (req, res) => {
      const config = req.body as AppConfig;
      const result = dbManager.updateConfig(config);
      if (result) {
        await proxyServer.updateConfig(config);
      }
      res.json(result);
    })
  );

  app.post(
    '/api/write-config/claude',
    asyncHandler(async (_req, res) => {
      const result = await writeClaudeConfig(dbManager);
      res.json(result);
    })
  );

  app.post(
    '/api/write-config/codex',
    asyncHandler(async (_req, res) => {
      const result = await writeCodexConfig(dbManager);
      res.json(result);
    })
  );

  app.post(
    '/api/restore-config/claude',
    asyncHandler(async (_req, res) => {
      const result = await restoreClaudeConfig();
      res.json(result);
    })
  );

  app.post(
    '/api/restore-config/codex',
    asyncHandler(async (_req, res) => {
      const result = await restoreCodexConfig();
      res.json(result);
    })
  );

  app.get('/api/check-backup/claude', (_req, res) => {
    res.json({ exists: checkClaudeBackupExists() });
  });

  app.get('/api/check-backup/codex', (_req, res) => {
    res.json({ exists: checkCodexBackupExists() });
  });

  app.post(
    '/api/export',
    asyncHandler(async (req, res) => {
      const { password } = req.body as { password: string };
      const data = await dbManager.exportData(password);
      res.json({ data });
    })
  );
  app.post(
    '/api/import',
    asyncHandler(async (req, res) => {
      const { encryptedData, password } = req.body as { encryptedData: string; password: string };
      const result = await dbManager.importData(encryptedData, password);
      if (result) {
        await proxyServer.reloadRoutes();
      }
      res.json(result);
    })
  );

  app.use(express.static(path.resolve(__dirname, '../ui')));
};

const start = async () => {
  fs.mkdirSync(dataDir, { recursive: true });

  const dbManager = new DatabaseManager(dataDir);
  await dbManager.initialize();

  const proxyServer = new ProxyServer(dbManager, app);

  // Register admin routes first
  registerRoutes(dbManager, proxyServer);

  // Initialize proxy server and register proxy routes last
  await proxyServer.initialize();

  const adminServer = app.listen(port, host, () => {
    console.log(`Admin server running on http://${host}:${port}`);
  });

  const shutdown = async () => {
    console.log('Shutting down server...');
    dbManager.close();
    adminServer.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
