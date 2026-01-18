/**
 * Centralized logging utility for HoProxy
 * Provides structured, leveled logging with request tracing
 */

import { randomUUID } from 'crypto';

// Log levels in order of severity
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4
};

// ANSI color codes for terminal output
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

// Get configured log level from environment
function getLogLevel() {
  const envLevel = process.env.HOPGPT_LOG_LEVEL?.toLowerCase();
  if (envLevel && LOG_LEVELS[envLevel] !== undefined) {
    return LOG_LEVELS[envLevel];
  }

  const debugEnabled = process.env.HOPGPT_DEBUG === 'true';
  if (debugEnabled) {
    return LOG_LEVELS.debug;
  }

  return LOG_LEVELS.info;
}

// Check if colors should be used
function useColors() {
  const colorsDisabled = process.env.NO_COLOR || process.env.HOPGPT_LOG_NO_COLOR === 'true';
  if (colorsDisabled) {
    return false;
  }

  return process.stdout.isTTY !== false;
}

// Format timestamp
function formatTimestamp() {
  return new Date().toISOString();
}

// Format duration in human-readable form
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// Colorize text if colors are enabled
function colorize(text, color) {
  if (!useColors()) return text;
  return `${COLORS[color] || ''}${text}${COLORS.reset}`;
}

// Format log level with color
function formatLevel(level) {
  const upperLevel = level.toUpperCase().padEnd(5);
  switch (level) {
    case 'debug': return colorize(upperLevel, 'gray');
    case 'info': return colorize(upperLevel, 'blue');
    case 'warn': return colorize(upperLevel, 'yellow');
    case 'error': return colorize(upperLevel, 'red');
    default: return upperLevel;
  }
}

// Format module name
function formatModule(module) {
  return colorize(`[${module}]`, 'cyan');
}

// Truncate long strings for logging
function truncate(str, maxLen = 200) {
  if (typeof str !== 'string') return str;
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

// Safely stringify objects for logging
function safeStringify(obj, maxLen = 500) {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj === 'string') return truncate(obj, maxLen);
  if (typeof obj !== 'object') return String(obj);
  
  try {
    const str = JSON.stringify(obj, (key, value) => {
      // Redact sensitive fields
      if (['token', 'bearer', 'cookie', 'authorization', 'password', 'secret'].some(
        k => key.toLowerCase().includes(k)
      )) {
        return '[REDACTED]';
      }
      return value;
    });
    return truncate(str, maxLen);
  } catch {
    return '[Object]';
  }
}

/**
 * Create a logger instance for a specific module
 * @param {string} module - Module name (e.g., 'HopGPT', 'Messages', 'Transform')
 * @returns {object} Logger instance with debug, info, warn, error methods
 */
export function createLogger(module) {
  const configuredLevel = getLogLevel();
  
  function log(level, message, data = null) {
    if (LOG_LEVELS[level] < configuredLevel) return;
    
    const timestamp = colorize(formatTimestamp(), 'dim');
    const levelStr = formatLevel(level);
    const moduleStr = formatModule(module);
    
    let output = `${timestamp} ${levelStr} ${moduleStr} ${message}`;
    
    if (data !== null && data !== undefined) {
      if (typeof data === 'object' && Object.keys(data).length > 0) {
        output += ` ${colorize(safeStringify(data), 'dim')}`;
      } else if (typeof data !== 'object') {
        output += ` ${colorize(String(data), 'dim')}`;
      }
    }
    
    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }
  
  return {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
    
    /**
     * Log a request start with timing
     * @param {string} action - Action being performed
     * @param {object} details - Request details
     * @returns {function} Function to call when request completes
     */
    startRequest(action, details = {}) {
      const startTime = Date.now();
      const requestId = details.requestId || randomUUID().slice(0, 8);
      
      log('info', `${action} started`, { requestId, ...details });
      
      return {
        requestId,
        success: (message, data = {}) => {
          const duration = formatDuration(Date.now() - startTime);
          log('info', `${action} completed (${duration})`, { requestId, ...data, message });
        },
        failure: (error, data = {}) => {
          const duration = formatDuration(Date.now() - startTime);
          const errorMsg = error instanceof Error ? error.message : String(error);
          log('error', `${action} failed (${duration}): ${errorMsg}`, { requestId, ...data });
        }
      };
    },
    
    /**
     * Log with context from Express request
     * @param {object} req - Express request object
     * @param {string} level - Log level
     * @param {string} message - Log message
     * @param {object} data - Additional data
     */
    withRequest(req, level, message, data = {}) {
      const requestId = req.id || req.headers['x-request-id'] || 'unknown';
      const sessionId = req.headers['x-session-id'] || req.body?.metadata?.session_id || 'unknown';
      log(level, message, { requestId, sessionId, ...data });
    }
  };
}

/**
 * Generate a unique request ID
 * @returns {string} Short unique ID
 */
export function generateRequestId() {
  return randomUUID().slice(0, 8);
}

/**
 * Express middleware to add request ID and logging
 */
export function requestLoggerMiddleware() {
  const logger = createLogger('HTTP');
  
  return (req, res, next) => {
    req.id = req.headers['x-request-id'] || generateRequestId();
    req.startTime = Date.now();
    
    // Log request
    logger.info(`${req.method} ${req.path}`, {
      requestId: req.id,
      query: Object.keys(req.query).length > 0 ? req.query : undefined
    });
    
    // Log response when finished
    res.on('finish', () => {
      const duration = Date.now() - req.startTime;
      logger.debug(`${req.method} ${req.path} -> ${res.statusCode}`, {
        requestId: req.id,
        status: res.statusCode,
        duration: `${duration}ms`
      });
    });
    
    next();
  };
}

// Pre-configured loggers for common modules
export const loggers = {
  hopgpt: createLogger('HopGPT'),
  messages: createLogger('Messages'),
  transform: createLogger('Transform'),
  session: createLogger('Session'),
  auth: createLogger('Auth'),
  tls: createLogger('TLS'),
  model: createLogger('Model')
};

export default createLogger;
