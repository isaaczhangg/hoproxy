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
  const openidInfo = getTokenExpiryInfo(client.cookies?.openid_user_id);

  const status = {
    bearerToken: bearerTokenInfo ? {
      ...bearerTokenInfo,
      present: true
    } : {
      present: !!client.bearerToken,
      isExpired: null,
      note: client.bearerToken ? 'Token is not a decodable JWT' : 'No bearer token configured'
    },
    refreshCredential: openidInfo ? {
      ...openidInfo,
      present: true
    } : {
      present: !!client.cookies?.openid_user_id,
      isExpired: null,
      note: client.cookies?.openid_user_id ? 'openid_user_id is not a decodable JWT' : 'No refresh credential configured'
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

  if (!client.cookies?.openid_user_id) {
    log.warn('Token refresh failed: no refresh credential configured');
    return res.status(400).json({
      success: false,
      error: {
        message: 'Missing refresh credential (HOPGPT_COOKIE_OPENID_USER_ID). Run: npm run extract'
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
  const memoryOpenidId = client.cookies?.openid_user_id;
  const memoryBearerInfo = getTokenExpiryInfo(memoryBearerToken);
  const memoryOpenidInfo = getTokenExpiryInfo(memoryOpenidId);

  let envBearerToken = null;
  let envSid = null;
  let envOpenidId = null;
  let envReadError = null;

  try {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      const bearerMatch = envContent.match(/^HOPGPT_BEARER_TOKEN=(.+)$/m);
      const sidMatch = envContent.match(/^HOPGPT_COOKIE_CONNECT_SID=(.+)$/m);
      const openidMatch = envContent.match(/^HOPGPT_COOKIE_OPENID_USER_ID=(.+)$/m);
      envBearerToken = bearerMatch ? bearerMatch[1].trim() : null;
      envSid = sidMatch ? sidMatch[1].trim() : null;
      envOpenidId = openidMatch ? openidMatch[1].trim() : null;
    }
  } catch (err) {
    envReadError = err.message;
  }

  const envBearerInfo = getTokenExpiryInfo(envBearerToken);
  const envOpenidInfo = getTokenExpiryInfo(envOpenidId);

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
      refreshCredential: {
        present: !!memoryOpenidId,
        masked: maskToken(memoryOpenidId),
        length: memoryOpenidId?.length || 0,
        isValidJWT: !!memoryOpenidInfo,
        expiresIn: memoryOpenidInfo ? `${Math.round(memoryOpenidInfo.expiresInSeconds / 3600)}h` : null,
        isExpired: memoryOpenidInfo?.isExpired ?? null
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
      refreshCredential: {
        present: !!envOpenidId,
        masked: maskToken(envOpenidId),
        length: envOpenidId?.length || 0,
        isValidJWT: !!envOpenidInfo,
        matchesMemory: envOpenidId === memoryOpenidId
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

  if (!memoryOpenidId) {
    debug.diagnosis.push('CRITICAL: No refresh credential (openid_user_id) in memory — run: npm run extract');
  } else if (memoryOpenidInfo?.isExpired) {
    debug.diagnosis.push('CRITICAL: Refresh credential (openid_user_id) is expired — run: npm run extract');
  }

  if (!memorySid) {
    debug.diagnosis.push('WARNING: No session cookie (connect.sid) in memory; auth may be rejected');
  }

  if (envOpenidId && memoryOpenidId && envOpenidId !== memoryOpenidId) {
    debug.diagnosis.push('INFO: .env refresh credential differs from memory — may have been rotated; next refresh will re-persist');
  }

  if (!envOpenidId && memoryOpenidId) {
    debug.diagnosis.push('WARNING: Refresh credential in memory but not in .env — persistence may have failed');
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
