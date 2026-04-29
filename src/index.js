#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import messagesRouter from './routes/messages.js';
import modelsRouter from './routes/models.js';
import refreshTokenRouter from './routes/refreshToken.js';
import { requestLoggerMiddleware, createLogger } from './utils/logger.js';
import { getDefaultClient, getTokenExpiryInfo } from './services/hopgptClient.js';

const log = createLogger('Server');

/**
 * Mask a token for safe logging (show first 10 and last 10 chars)
 * @param {string} token - Token to mask
 * @returns {string} Masked token
 */
function maskToken(token) {
  if (!token) return '<not set>';
  if (token.length <= 24) return '<too short to mask>';
  return `${token.substring(0, 10)}...${token.substring(token.length - 10)}`;
}

/**
 * Log startup token diagnostics to help debug auth issues
 */
function logStartupTokenDiagnostics() {
  const client = getDefaultClient();
  const envPath = path.join(process.cwd(), '.env');

  log.info('=== Token Diagnostics on Startup ===');

  const bearerToken = client.bearerToken;
  const bearerInfo = getTokenExpiryInfo(bearerToken);
  if (bearerToken) {
    log.info('Bearer token', {
      present: true,
      masked: maskToken(bearerToken),
      isValidJWT: !!bearerInfo,
      expiresIn: bearerInfo ? `${Math.round(bearerInfo.expiresInSeconds / 60)}min` : 'N/A',
      isExpired: bearerInfo?.isExpired ?? 'unknown'
    });
  } else {
    log.warn('Bearer token: NOT SET (will attempt refresh on first request)');
  }

  const openidId = client.cookies?.openid_user_id;
  const openidInfo = getTokenExpiryInfo(openidId);
  if (openidId) {
    log.info('Refresh credential (openid_user_id)', {
      present: true,
      masked: maskToken(openidId),
      isValidJWT: !!openidInfo,
      expiresIn: openidInfo ? `${Math.round(openidInfo.expiresInSeconds / 3600)}h` : 'N/A',
      isExpired: openidInfo?.isExpired ?? 'unknown'
    });
    if (openidInfo?.isExpired) {
      log.error('Refresh credential is EXPIRED — re-authentication required (run: npm run extract)');
    }
  } else {
    log.error('Refresh credential (openid_user_id): NOT SET — auth will fail (run: npm run extract)');
  }

  const sid = client.cookies?.connect_sid;
  if (sid) {
    log.info('Session cookie (connect.sid)', {
      present: true,
      masked: maskToken(sid),
      length: sid.length
    });
  } else {
    log.warn('Session cookie (connect.sid): NOT SET — auth may be rejected (run: npm run extract)');
  }

  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const envOpenidMatch = envContent.match(/^HOPGPT_COOKIE_OPENID_USER_ID=(.+)$/m);
      const envOpenidId = envOpenidMatch ? envOpenidMatch[1].trim() : null;
      const envSidMatch = envContent.match(/^HOPGPT_COOKIE_CONNECT_SID=(.+)$/m);
      const envSid = envSidMatch ? envSidMatch[1].trim() : null;

      if (envOpenidId && openidId && envOpenidId !== openidId) {
        log.debug('.env refresh credential differs from memory — will be reconciled on next refresh');
      }
      if (envSid && sid && envSid !== sid) {
        log.debug('.env session cookie differs from memory — will be reconciled on next refresh');
      }
    }
  } catch (err) {
    log.debug('Could not verify .env file', { error: err.message });
  }

  const cfClearance = client.cookies?.cf_clearance;
  const cfBm = client.cookies?.__cf_bm;
  if (!cfClearance || !cfBm) {
    log.warn('Cloudflare cookies missing', {
      cf_clearance: cfClearance ? 'set' : 'NOT SET',
      __cf_bm: cfBm ? 'set' : 'NOT SET',
      note: 'This may cause Cloudflare blocks, but TLS fingerprinting should help bypass'
    });
  }

  log.info('=== End Token Diagnostics ===');
}

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json({ limit: '10mb' }));

// CORS headers for API access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, x-session-id, x-sessionid, x-conversation-reset, x-mcp-passthrough');
  res.header('Access-Control-Expose-Headers', 'x-session-id');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Request logging with tracing
app.use(requestLoggerMiddleware());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount Anthropic-compatible API routes
app.use('/v1', messagesRouter);
app.use('/v1', modelsRouter);
app.use(refreshTokenRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    type: 'error',
    error: {
      type: 'not_found_error',
      message: `Not found: ${req.method} ${req.path}`
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  log.error('Unhandled error', {
    requestId: req.id,
    error: err.message,
    stack: process.env.HOPGPT_DEBUG === 'true' ? err.stack : undefined
  });
  res.status(500).json({
    type: 'error',
    error: {
      type: 'api_error',
      message: 'Internal server error'
    }
  });
});

// Start server
app.listen(PORT, () => {
  log.info(`Server started on port ${PORT}`);
  
  // Log token diagnostics on startup
  logStartupTokenDiagnostics();
  
  console.log(`
╔════════════════════════════════════════════════════════════╗
║          HopGPT Anthropic API Proxy                        ║
╠════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                   ║
║                                                            ║
║  Endpoints:                                                ║
║    POST /v1/messages  - Anthropic Messages API             ║
║    GET  /v1/models    - List available models              ║
║    POST /refresh-token - Refresh HopGPT session token      ║
║    GET  /token-status  - Check token expiry status         ║
║    GET  /token-debug   - Detailed token diagnostics        ║
║    GET  /health       - Health check                       ║
║                                                            ║
║  Usage with Anthropic SDK:                                 ║
║    export ANTHROPIC_BASE_URL=http://localhost:${PORT}         ║
╚════════════════════════════════════════════════════════════╝
  `);
});
