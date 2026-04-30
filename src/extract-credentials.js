#!/usr/bin/env node
/**
 * CLI script to extract HopGPT credentials from browser session
 * Usage: node src/extract-credentials.js [--env-path <path>] [--timeout <seconds>]
 */
import { extractCredentials } from './services/browserCredentials.js';
import path from 'path';

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--env-path' && args[i + 1]) {
    options.envPath = path.resolve(args[i + 1]);
    i++;
  } else if (args[i] === '--timeout' && args[i + 1]) {
    options.timeout = parseInt(args[i + 1], 10) * 1000; // Convert seconds to ms
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
HopGPT Credential Extraction

Extracts credentials from a live browser session by observing the post-login
/api/auth/refresh or /api/config call. Writes them to .env.

Usage: npm run extract [-- options]

Options:
  --env-path <path>    Path to .env file (default: .env in project root)
  --timeout <seconds>  Timeout to wait for login (default: 300 seconds)
  --help, -h           Show this help message

Environment:
  HOPGPT_PUPPETEER_CHANNEL       Chrome channel for Puppeteer (default: chrome)
  HOPGPT_PUPPETEER_USER_DATA_DIR Chrome user data directory (optional)

Example:
  npm run extract
  npm run extract -- --timeout 600
  npm run extract -- --env-path /path/to/.env
`);
    process.exit(0);
  }
}

// Run extraction
extractCredentials(options)
  .then(() => {
    console.log('\nYou can now start the proxy server with: npm start\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nError:', error.message);
    process.exit(1);
  });
