export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export class TokenRefreshError extends AuthError {
  constructor(message = 'Failed to refresh authentication token') {
    super(message, 'TOKEN_REFRESH_FAILED');
    this.name = 'TokenRefreshError';
  }
}

export class RefreshTokenExpiredError extends AuthError {
  constructor() {
    super('Refresh token expired, re-authentication required', 'REFRESH_EXPIRED');
    this.name = 'RefreshTokenExpiredError';
  }
}

export class CloudflareBlockedError extends AuthError {
  constructor() {
    super('Request blocked by Cloudflare, may need new cf_clearance cookie', 'CF_BLOCKED');
    this.name = 'CloudflareBlockedError';
  }
}

export class NetworkError extends AuthError {
  constructor(originalError) {
    super(
      `Network error during token refresh: ${originalError?.message || 'Unknown error'}`,
      'NETWORK_ERROR',
    );
    this.name = 'NetworkError';
    this.originalError = originalError;
  }
}
