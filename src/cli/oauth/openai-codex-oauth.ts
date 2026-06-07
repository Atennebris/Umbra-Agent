/**
 * OpenAI Codex (ChatGPT OAuth) flow — ported from pi-ai/oauth/openai-codex
 * Official flow used by Codex CLI, OpenClaw, Cline, and other tools.
 * Policy: explicitly allowed by OpenAI, unlike Anthropic which banned equivalent usage.
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const CALLBACK_HOST = '127.0.0.1';

export type CodexOAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

type TokenSuccess = { type: 'success'; access: string; refresh: string; expires: number };
type TokenFailure = { type: 'failed'; message: string; status?: number };
type TokenResult = TokenSuccess | TokenFailure;

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  let binary = '';
  for (const byte of verifierBytes) binary += String.fromCharCode(byte);
  const verifier = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  let hashBinary = '';
  for (const byte of new Uint8Array(hashBuffer)) hashBinary += String.fromCharCode(byte);
  const challenge = btoa(hashBinary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return { verifier, challenge };
}

function createState(): string {
  return randomBytes(16).toString('hex');
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1] ?? '')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(token: string): string | null {
  const payload = decodeJwt(token);
  const auth = payload?.[JWT_CLAIM_PATH];
  if (!auth || typeof auth !== 'object') return null;
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

function parseAuthInput(input: string): { code: string | undefined; state: string | undefined } {
  const value = input.trim();
  if (!value) return { code: undefined, state: undefined };
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    // not a URL
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code: code || undefined, state: state || undefined };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined };
  }
  return { code: value, state: undefined };
}

async function exchangeCode(code: string, verifier: string): Promise<TokenResult> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      type: 'failed',
      status: response.status,
      message: `Token exchange failed (${response.status}): ${text}`,
    };
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    return { type: 'failed', message: `Missing fields in token response: ${JSON.stringify(json)}` };
  }

  return {
    type: 'success',
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

async function doRefresh(refreshToken: string): Promise<TokenResult> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        type: 'failed',
        status: response.status,
        message: `Token refresh failed (${response.status}): ${text}`,
      };
    }

    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
      return {
        type: 'failed',
        message: `Missing fields in refresh response: ${JSON.stringify(json)}`,
      };
    }

    return {
      type: 'success',
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    };
  } catch (error) {
    return { type: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

function startOAuthServer(expectedState: string): Promise<{
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
}> {
  let settle: ((value: { code: string } | null) => void) | undefined;
  const waitPromise = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(oauthHtml(false, 'Callback route not found.'));
        return;
      }
      if (url.searchParams.get('state') !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(oauthHtml(false, 'State mismatch — possible CSRF.'));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(oauthHtml(false, 'Missing authorization code.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(oauthHtml(true, 'Authentication complete. You can close this tab.'));
      settle?.({ code });
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(oauthHtml(false, 'Internal error processing OAuth callback.'));
    }
  });

  return new Promise((resolve) => {
    server
      .listen(1455, CALLBACK_HOST, () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => settle?.(null),
          waitForCode: () => waitPromise,
        });
      })
      .on('error', () => {
        settle?.(null);
        resolve({
          close: () => {
            try {
              server.close();
            } catch {
              /* ignore */
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        });
      });
  });
}

export async function loginOpenAICodex(options: {
  onAuth: (url: string) => void;
  onPrompt: (message: string) => Promise<string>;
  onProgress?: (message: string) => void;
  originator?: string;
}): Promise<CodexOAuthCredentials> {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('id_token_add_organizations', 'true');
  authUrl.searchParams.set('originator', options.originator ?? 'umbra');

  const server = await startOAuthServer(state);

  options.onAuth(authUrl.toString());
  options.onProgress?.('Waiting for browser callback on localhost:1455…');

  let code: string | undefined;

  try {
    const result = await server.waitForCode();

    if (result?.code) {
      code = result.code;
    } else {
      const input = await options.onPrompt(
        'Browser callback timed out. Paste the redirect URL or auth code:',
      );
      const parsed = parseAuthInput(input);
      if (parsed.state && parsed.state !== state) throw new Error('State mismatch');
      code = parsed.code;
    }

    if (!code) throw new Error('Missing authorization code');

    options.onProgress?.('Exchanging code for tokens…');
    const tokenResult = await exchangeCode(code, verifier);

    if (tokenResult.type !== 'success') {
      if (/unsupported_country_region_territory/i.test(tokenResult.message)) {
        throw new Error(
          'OpenAI rejected the token exchange for this region. ' +
            'If you use a proxy, set HTTPS_PROXY or HTTP_PROXY and retry.',
        );
      }
      throw new Error(tokenResult.message);
    }

    const accountId = extractAccountId(tokenResult.access);
    if (!accountId) throw new Error('Failed to extract accountId from token');

    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      accountId,
    };
  } finally {
    server.close();
  }
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
): Promise<CodexOAuthCredentials> {
  const result = await doRefresh(refreshToken);
  if (result.type !== 'success') throw new Error(result.message);

  const accountId = extractAccountId(result.access);
  if (!accountId) throw new Error('Failed to extract accountId from refreshed token');

  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    accountId,
  };
}

function oauthHtml(success: boolean, message: string): string {
  const title = success ? 'Authentication successful' : 'Authentication failed';
  const color = success ? '#22c55e' : '#ef4444';
  const msg = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#09090b;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;margin:0}h1{font-size:1.75rem;color:${color};margin:0 0 .5rem}p{color:#a1a1aa}</style></head>
<body><main><h1>${title}</h1><p>${msg}</p></main></body></html>`;
}
