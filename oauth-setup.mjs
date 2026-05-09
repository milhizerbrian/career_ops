// Run once to get your Gmail refresh token: node oauth-setup.mjs
// Opens a browser for Google authorization, captures the code automatically,
// then prints the refresh token to add to .env as GMAIL_REFRESH_TOKEN.
import './lib/env.mjs';
import { google } from 'googleapis';
import { createServer } from 'http';
import { exec } from 'child_process';
import { randomBytes } from 'crypto';

export function createOAuthState() {
  return randomBytes(32).toString('base64url');
}

export function parseOAuthCallback(reqUrl, baseUrl, expectedState) {
  const url = new URL(reqUrl, baseUrl);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state');

  if (error) return { type: 'error', error };
  if (!code) return { type: 'redirect' };
  if (!state) throw new Error('Missing OAuth state. Please restart OAuth setup and try again.');
  if (state !== expectedState) throw new Error('OAuth state mismatch. Please restart OAuth setup and try again.');
  return { type: 'code', code };
}

export function buildAuthUrl(oAuth2Client, state) {
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.readonly'],
    prompt: 'consent', // force refresh_token to be returned every time
    state,
  });
}

export function main() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
    console.error('GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env first.');
    process.exit(1);
  }

  // Pick a random high port for the local callback server
  const PORT = 49152 + Math.floor(Math.random() * 16383);
  const REDIRECT_URI = `http://localhost:${PORT}`;

  const oAuth2Client = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, REDIRECT_URI);
  const expectedState = createOAuthState();
  const authUrl = buildAuthUrl(oAuth2Client, expectedState);

  // Start a temporary local server to catch Google's redirect
  const server = createServer(async (req, res) => {
    let callback;
    try {
      callback = parseOAuthCallback(req.url, `http://localhost:${PORT}`, expectedState);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h2>Authorization failed.</h2><p>${err.message}</p><p>You can close this tab.</p>`);
      console.error('\n' + err.message);
      server.close();
      process.exit(1);
    }

    if (callback.type === 'error') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authorization denied.</h2><p>You can close this tab.</p>');
      console.error('\nAuthorization denied:', callback.error);
      server.close();
      process.exit(1);
    }

    if (callback.type === 'redirect') {
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>');

    try {
      const { tokens } = await oAuth2Client.getToken(callback.code);
      server.close();
      console.log('\nSuccess! Add this to your .env:\n');
      console.log('GMAIL_REFRESH_TOKEN=' + tokens.refresh_token);
      console.log('\nThen run: npm run gmail-sync -- --dry-run\n');
    } catch (err) {
      server.close();
      console.error('\nFailed to exchange code for token:', err.message);
      process.exit(1);
    }
  });

  server.listen(PORT, () => {
    console.log(`\nOpening browser for Google authorization...`);
    // Open browser cross-platform
    const open = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    exec(`${open} "${authUrl}"`);
    console.log(`\nIf the browser did not open, visit this URL manually:\n${authUrl}\n`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
