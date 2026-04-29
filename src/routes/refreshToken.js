import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { getDefaultClient, getTokenExpiryInfo } from '../services/hopgptClient.js';
import {
  AuthError,
  RefreshTokenExpiredError,
  TokenRefreshError,
  CloudflareBlockedError,
  NetworkError
} from '../errors/authErrors.js';
import { loggers } from '../utils/logger.js';

const log = loggers.auth;
const router = Router();

/**
 * Mask a token for safe display (show first 10 and last 10 chars)
 */
function maskToken(token) {
  if (!token) return '<not set>';
  if (token.length <= 24) return '<too short to mask>';
  return `${token.substring(0, 10)}...${token.substring(token.length - 10)}`;
}

/**
 * GET /token-status
 * Get current token expiry status without triggering a refresh
 */
router.get('/token-status', (req, res) => {
  const client = getDefaultClient();
  log.debug('Checking token status');

  const bearerTokenInfo = getTokenExpiryInfo(client.bearerToken);

  const status = {
    bearerToken: bearerTokenInfo ? {
      ...bearerTokenInfo,
      present: true
    } : {
      present: !!client.bearerToken,
      isExpired: null,
      note: client.bearerToken ? 'Token is not a decodable JWT' : 'No bearer token configured'
    },
    session: {
      present: !!client.cookies?.connect_sid
    },
    autoRefresh: client.autoRefresh,
    timestamp: new Date().toISOString()
  };

  res.json(status);
});

/**
 * POST /refresh-token
 * Manually refresh HopGPT session tokens
 */
router.post('/refresh-token', async (req, res) => {
  const client = getDefaultClient();
  log.info('Manual token refresh requested');

  if (!client.cookies?.connect_sid) {
    log.warn('Token refresh failed: no session cookie configured');
    return res.status(400).json({
      success: false,
      error: {
        message: 'Missing session cookie (HOPGPT_COOKIE_CONNECT_SID). Run: npm run extract'
      }
    });
  }

  try {
    const refreshed = await client.refreshTokens();
    const tokenExpiry = refreshed ? getTokenExpiryInfo(client.bearerToken) : null;

    if (refreshed) {
      log.info('Token refresh successful', {
        expiresIn: tokenExpiry?.expiresInSeconds ? `${Math.floor(tokenExpiry.expiresInSeconds / 60)}m` : 'unknown'
      });
    } else {
      log.error('Token refresh failed');
    }

    return res.status(refreshed ? 200 : 502).json({
      success: refreshed,
      tokenExpiry: tokenExpiry || undefined
    });
  } catch (error) {
    if (error instanceof AuthError) {
      const { statusCode, errorType } = mapAuthErrorStatus(error);
      log.warn('Token refresh failed', { error: error.message, type: error.constructor.name });
      return res.status(statusCode).json({
        success: false,
        error: {
          type: errorType,
          message: error.message
        }
      });
    }

    log.error('Token refresh error', { error: error.message });
    return res.status(502).json({
      success: false,
      error: {
        type: 'api_error',
        message: error.message || 'Token refresh failed'
      }
    });
  }
});

export default router;

/**
 * GET /token-debug
 * Detailed token diagnostics for debugging auth issues
 * Compares in-memory state with .env file
 */
router.get('/token-debug', (req, res) => {
  const client = getDefaultClient();
  const envPath = path.join(process.cwd(), '.env');
  log.debug('Token debug requested');

  const memoryBearerToken = client.bearerToken;
  const memorySid = client.cookies?.connect_sid;
  const memoryBearerInfo = getTokenExpiryInfo(memoryBearerToken);

  let envBearerToken = null;
  let envSid = null;
  let envReadError = null;

  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const bearerMatch = envContent.match(/^HOPGPT_BEARER_TOKEN=(.+)$/m);
      const sidMatch = envContent.match(/^HOPGPT_COOKIE_CONNECT_SID=(.+)$/m);
      envBearerToken = bearerMatch ? bearerMatch[1].trim() : null;
      envSid = sidMatch ? sidMatch[1].trim() : null;
    }
  } catch (err) {
    envReadError = err.message;
  }

  const envBearerInfo = getTokenExpiryInfo(envBearerToken);

  const debug = {
    timestamp: new Date().toISOString(),
    memory: {
      bearerToken: {
        present: !!memoryBearerToken,
        masked: maskToken(memoryBearerToken),
        length: memoryBearerToken?.length || 0,
        isValidJWT: !!memoryBearerInfo,
        expiresIn: memoryBearerInfo ? `${Math.round(memoryBearerInfo.expiresInSeconds / 60)}min` : null,
        isExpired: memoryBearerInfo?.isExpired ?? null
      },
      session: {
        present: !!memorySid,
        masked: maskToken(memorySid),
        length: memorySid?.length || 0
      }
    },
    envFile: {
      path: envPath,
      readError: envReadError,
      bearerToken: {
        present: !!envBearerToken,
        masked: maskToken(envBearerToken),
        length: envBearerToken?.length || 0,
        isValidJWT: !!envBearerInfo,
        matchesMemory: envBearerToken === memoryBearerToken
      },
      session: {
        present: !!envSid,
        masked: maskToken(envSid),
        length: envSid?.length || 0,
        matchesMemory: envSid === memorySid
      }
    },
    cloudflare: {
      cf_clearance: client.cookies?.cf_clearance ? 'set' : 'NOT SET',
      __cf_bm: client.cookies?.__cf_bm ? 'set' : 'NOT SET'
    },
    config: {
      autoRefresh: client.autoRefresh,
      autoPersist: client.autoPersist,
      proactiveRefreshBufferSec: client.proactiveRefreshBufferSec
    },
    diagnosis: []
  };

  if (!memorySid) {
    debug.diagnosis.push('CRITICAL: No session cookie (connect.sid) in memory — run: npm run extract');
  }

  if (envSid && memorySid && envSid !== memorySid) {
    debug.diagnosis.push('INFO: .env session cookie differs from memory — session may have been rotated; next refresh will re-persist');
  }

  if (!envSid && memorySid) {
    debug.diagnosis.push('WARNING: Session cookie in memory but not in .env — persistence may have failed');
  }

  if (debug.diagnosis.length === 0) {
    debug.diagnosis.push('OK: Token state appears healthy');
  }

  res.json(debug);
});

function mapAuthErrorStatus(error) {
  if (error instanceof RefreshTokenExpiredError || error instanceof TokenRefreshError) {
    return { statusCode: 401, errorType: 'authentication_error' };
  }
  if (error instanceof CloudflareBlockedError) {
    return { statusCode: 503, errorType: 'api_error' };
  }
  if (error instanceof NetworkError) {
    return { statusCode: 502, errorType: 'api_error' };
  }
  return { statusCode: 500, errorType: 'api_error' };
}
