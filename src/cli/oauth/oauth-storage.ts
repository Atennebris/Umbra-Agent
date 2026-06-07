import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type OAuthToken = {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

type TokenStore = Record<string, OAuthToken>;

function resolveTokensPath(): string {
  const home = process.env.UMBRA_HOME ?? path.join(os.homedir(), '.umbra');
  return path.join(home, 'oauth-tokens.json');
}

export function readOAuthTokens(): TokenStore {
  try {
    const content = fs.readFileSync(resolveTokensPath(), 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as TokenStore;
  } catch {
    return {};
  }
}

function writeOAuthTokens(store: TokenStore): void {
  const filePath = resolveTokensPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export function saveOAuthToken(profileId: string, token: OAuthToken): void {
  const store = readOAuthTokens();
  store[profileId] = token;
  writeOAuthTokens(store);
}

export function getOAuthToken(profileId: string): OAuthToken | null {
  return readOAuthTokens()[profileId] ?? null;
}

export function deleteOAuthToken(profileId: string): void {
  const store = readOAuthTokens();
  if (profileId in store) {
    delete store[profileId];
    writeOAuthTokens(store);
  }
}
