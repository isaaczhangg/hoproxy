/**
 * Browser Credential Extraction Module
 * Extracts HopGPT credentials by observing authenticated API traffic.
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';

const HOPGPT_URL = 'https://chat.ai.jh.edu';
const USER_PATH = '/api/user';
const CONFIG_PATH = '/api/config';
const REFRESH_PATH = '/api/auth/refresh';

puppeteer.use(StealthPlugin());

async function launchBrowser(options = {}) {
  const launchOptions = {
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  };

  const userDataDir = options.userDataDir || process.env.HOPGPT_PUPPETEER_USER_DATA_DIR;
  if (userDataDir) {
    launchOptions.userDataDir = userDataDir;
  }

  const channel = options.channel || process.env.HOPGPT_PUPPETEER_CHANNEL || 'chrome';

  try {
    return await puppeteer.launch({ ...launchOptions, channel });
  } catch (error) {
    if (!options.channel && !process.env.HOPGPT_PUPPETEER_CHANNEL) {
      console.warn(`Failed to launch Chrome channel (${channel}). Falling back to bundled Chromium.`);
      return await puppeteer.launch(launchOptions);
    }
    throw error;
  }
}

/**
 * Returns true when `response` signals that the user has genuinely authenticated.
 * We need to distinguish "page loaded" from "user completed SSO" — HopGPT's JS
 * hits /api/auth/refresh on every page load, including unauthenticated ones,
 * so that endpoint is NOT a valid login signal.
 *
 * A cookie named openid_user_id in the REQUEST header proves SSO completed
 * (the OIDC issuer set it after password + 2FA). We accept authenticated
 * /api/user or /api/config calls as the signal.
 */
function isLoginSignal(response) {
  const url = response.url();
  const status = response.status();
  if (status < 200 || status >= 400) return false;

  const isUser = url.startsWith(HOPGPT_URL + USER_PATH);
  const isConfig = url.startsWith(HOPGPT_URL + CONFIG_PATH);
  if (!isUser && !isConfig) return false;

  // The request must carry openid_user_id — that's the OIDC-issued cookie that
  // only exists after the user actually authenticated. connect.sid alone is set
  // even for anonymous visitors.
  const request = response.request();
  const cookieHeader = request.headers()['cookie'] || '';
  return /(?:^|;\s*)openid_user_id=/.test(cookieHeader);
}

export async function extractCredentials(options = {}) {
  const envPath = options.envPath || path.join(process.cwd(), '.env');
  const timeout = options.timeout || 5 * 60 * 1000;

  console.log('\n=== HopGPT Browser Credential Extraction ===\n');
  console.log('Opening browser and navigating to HopGPT...');
  console.log('Please complete the login flow in the browser window.\n');

  const browser = await launchBrowser(options);
  let bearerToken = null;

  try {
    const page = await browser.newPage();

    // Capture Authorization headers on any outgoing chat.ai.jh.edu/api/* request.
    // This is not request-intercepting (no request.continue() needed) — we observe
    // via the request event, which does not block the request.
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(HOPGPT_URL + '/api/')) return;
      const auth = request.headers()['authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        bearerToken = auth.slice('Bearer '.length);
      }
    });

    // Primary: resolve when we see a post-login API response.
    const loginDetected = new Promise((resolve) => {
      const handler = (response) => {
        if (isLoginSignal(response)) {
          page.off('response', handler);
          resolve({ reason: 'api-signal', url: response.url() });
        }
      };
      page.on('response', handler);
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(
        `Login not detected within ${timeout / 1000} seconds. Make sure you completed the SSO flow and landed on ${HOPGPT_URL}. Re-run with --timeout 600 if you need more time.`
      )), timeout)
    );

    const disconnectedPromise = new Promise((_, reject) => {
      browser.on('disconnected', () => reject(new Error('Browser was closed before login completed.')));
    });

    await page.goto(HOPGPT_URL, { waitUntil: 'networkidle2' });
    console.log('Waiting for login...');

    const outcome = await Promise.race([loginDetected, timeoutPromise, disconnectedPromise]);
    console.log(`Detected authenticated API call (${new URL(outcome.url).pathname}).`);

    console.log('Validating browser refresh session...');
    bearerToken = await refreshBrowserSession(page);

    // Give the browser a moment to process Set-Cookie from the refresh response.
    await new Promise((r) => setTimeout(r, 1500));

    // Harvest cookies. Prefer browser.cookies() (modern API, sees every tab's jar);
    // fall back to page.cookies(url) on older Puppeteer.
    const cookies = typeof browser.cookies === 'function'
      ? await browser.cookies()
      : await page.cookies(HOPGPT_URL);
    const userAgent = await browser.userAgent().catch(() => null);

    const credentials = {
      bearerToken,
      userAgent,
      cookies: {
        connect_sid: findCookie(cookies, 'connect.sid'),
        openid_user_id: findCookie(cookies, 'openid_user_id'),
        cf_clearance: findCookie(cookies, 'cf_clearance'),
        __cf_bm: findCookie(cookies, '__cf_bm'),
        token_provider: findCookie(cookies, 'token_provider')
      }
    };

    if (!credentials.cookies.openid_user_id) {
      // Diagnostic: dump every cookie we can see, across every domain, and also
      // try the page-scoped API as a fallback in case browser.cookies() missed
      // something set on a different origin during SSO redirects.
      const allByDomain = {};
      for (const c of cookies) {
        const d = c.domain || '<no-domain>';
        if (!allByDomain[d]) allByDomain[d] = [];
        allByDomain[d].push(c.name);
      }
      console.error('\nDiagnostic — all cookies visible to browser.cookies():');
      for (const [d, names] of Object.entries(allByDomain).sort()) {
        console.error(`  ${d}: ${names.sort().join(', ')}`);
      }

      // Fallback: try page.cookies() with several URL candidates (OIDC cookies may
      // be scoped to a login subdomain).
      const urlCandidates = [
        HOPGPT_URL,
        'https://login.jh.edu',
        'https://auth.jh.edu',
        'https://my.jh.edu',
        'https://ai.jh.edu'
      ];
      console.error('\nDiagnostic — page.cookies() per candidate URL:');
      for (const u of urlCandidates) {
        try {
          const scoped = await page.cookies(u);
          const names = scoped.map((c) => c.name).sort().join(', ') || '(none)';
          console.error(`  ${u}: ${names}`);
        } catch (e) {
          console.error(`  ${u}: error — ${e.message}`);
        }
      }

      throw new Error(
        `Logged in but openid_user_id cookie (the refresh credential) was not set. ` +
        `See diagnostic above for visible cookies. ` +
        `Try signing out of HopGPT in all browser tabs and re-running \`npm run extract\`.`
      );
    }

    const envContent = generateEnvContent(credentials);
    writeEnvFile(envPath, envContent);

    console.log('\nExtracted:');
    console.log(`  openid_user_id: ${credentials.cookies.openid_user_id ? 'yes' : 'no'}`);
    console.log(`  connect.sid:    ${credentials.cookies.connect_sid ? 'yes' : 'no'}`);
    console.log(`  cf_clearance:   ${credentials.cookies.cf_clearance ? 'yes' : 'no'}`);
    console.log(`  __cf_bm:        ${credentials.cookies.__cf_bm ? 'yes' : 'no'}`);
    console.log(`  token_provider: ${credentials.cookies.token_provider || '(default: librechat)'}`);
    console.log(`  Bearer Token:   ${credentials.bearerToken ? 'yes' : 'no — will be minted on first request'}`);
    console.log(`  User Agent:     ${credentials.userAgent ? 'yes' : 'no'}`);
    console.log(`\nWrote .env → ${envPath}\n`);

    return credentials;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function refreshBrowserSession(page) {
  const result = await page.evaluate(async (refreshPath) => {
    const response = await fetch(refreshPath, {
      method: 'POST',
      credentials: 'include'
    });
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      contentType,
      body
    };
  }, REFRESH_PATH);

  let parsed = null;
  if (result.contentType.toLowerCase().includes('application/json')) {
    try {
      parsed = JSON.parse(result.body || '{}');
    } catch (error) {
      throw new Error(`Browser refresh returned invalid JSON: ${error.message}`);
    }
  }

  if (!result.ok || !parsed?.token) {
    const message = parsed?.message || parsed?.error?.message || result.body || `HTTP ${result.status}`;
    throw new Error(`Browser refresh failed: ${message}`);
  }

  return parsed.token;
}

function findCookie(cookies, name) {
  const hit = cookies.find((c) => c.name === name);
  return hit ? hit.value : null;
}

/**
 * Build the .env contents from a credentials object. Pure — no I/O.
 */
export function generateEnvContent(credentials) {
  const lines = [
    '# HopGPT Credentials',
    '# Auto-generated by browser credential extraction',
    `# Generated at: ${new Date().toISOString()}`,
    ''
  ];

  if (credentials.bearerToken) {
    lines.push(`HOPGPT_BEARER_TOKEN=${credentials.bearerToken}`);
  } else {
    lines.push('# Bearer token will be minted automatically on first request');
  }

  if (credentials.userAgent) {
    lines.push(`HOPGPT_USER_AGENT="${credentials.userAgent}"`);
  }

  if (credentials.cookies.openid_user_id) {
    lines.push(`HOPGPT_COOKIE_OPENID_USER_ID=${credentials.cookies.openid_user_id}`);
  }
  if (credentials.cookies.connect_sid) {
    lines.push(`HOPGPT_COOKIE_CONNECT_SID=${credentials.cookies.connect_sid}`);
  }
  if (credentials.cookies.cf_clearance) {
    lines.push(`HOPGPT_COOKIE_CF_CLEARANCE=${credentials.cookies.cf_clearance}`);
  }
  if (credentials.cookies.__cf_bm) {
    lines.push(`HOPGPT_COOKIE_CF_BM=${credentials.cookies.__cf_bm}`);
  }
  if (credentials.cookies.token_provider) {
    lines.push(`HOPGPT_COOKIE_TOKEN_PROVIDER=${credentials.cookies.token_provider}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Write or update .env file, preserving non-HopGPT variables.
 * Also strips any stale HOPGPT_COOKIE_REFRESH_TOKEN line from prior versions.
 */
export function writeEnvFile(envPath, newContent) {
  let preservedLines = [];

  if (fs.existsSync(envPath)) {
    const existingContent = fs.readFileSync(envPath, 'utf-8');

    const hopgptVars = [
      'HOPGPT_BEARER_TOKEN',
      'HOPGPT_USER_AGENT',
      'HOPGPT_COOKIE_CF_CLEARANCE',
      'HOPGPT_COOKIE_CONNECT_SID',
      'HOPGPT_COOKIE_OPENID_USER_ID',
      'HOPGPT_COOKIE_CF_BM',
      'HOPGPT_COOKIE_REFRESH_TOKEN', // strip on rewrite
      'HOPGPT_COOKIE_TOKEN_PROVIDER'
    ];

    for (const line of existingContent.split('\n')) {
      const trimmed = line.trim();

      if (trimmed === '' ||
          trimmed.startsWith('# HopGPT') ||
          trimmed.startsWith('# Auto-generated') ||
          trimmed.startsWith('# Generated at')) {
        continue;
      }

      const isHopgptVar = hopgptVars.some(v =>
        trimmed.startsWith(v + '=') || trimmed.startsWith(`# ${v}`)
      );
      if (!isHopgptVar) {
        preservedLines.push(line);
      }
    }
  }

  let finalContent = newContent;
  if (preservedLines.length > 0) {
    finalContent = newContent + '\n# Other configuration\n' + preservedLines.join('\n') + '\n';
  }

  fs.writeFileSync(envPath, finalContent);
}

export default { extractCredentials };
