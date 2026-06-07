import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { CliCommandHandler } from '../command-types.js';
import {
  createProviderProfile,
  deleteProviderProfile,
  getProviderModelCatalog,
  listProviderModels,
  listProviderProfiles,
  testProviderProfile,
  updateProviderProfile,
} from '../http-client.js';
import { saveOAuthToken } from '../oauth/oauth-storage.js';
import { loginOpenAICodex } from '../oauth/openai-codex-oauth.js';
import { renderKeyValueCard } from '../tui/frame.js';

type ProvidersCommandInput =
  | { action: 'list'; json: boolean }
  | {
      action: 'add';
      type: string;
      label: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      makeDefault: boolean;
      headers: string[];
    }
  | { action: 'use'; id: string; model?: string }
  | { action: 'models'; id?: string }
  | { action: 'catalog'; json: boolean }
  | { action: 'test'; id: string }
  | { action: 'remove'; id: string }
  | { action: 'connect'; provider?: string }
  | { action: 'interactive' };

export const runProvidersCommand: CliCommandHandler = async (input) => {
  const command = input as ProvidersCommandInput;

  switch (command.action) {
    case 'list': {
      const payload = (await listProviderProfiles()) as {
        profiles: Array<{
          id: string;
          label: string;
          type: string;
          status: string;
          model: string | null;
          reason: string | null;
        }>;
        defaultProfileId: string | null;
        activeProfileId: string | null;
      };

      if (command.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (payload.profiles.length === 0) {
        console.log('No provider profiles configured.');
        return;
      }

      for (const profile of payload.profiles) {
        console.log(
          renderKeyValueCard(profile.label, [
            ['ID', profile.id],
            ['Type', profile.type],
            ['Status', profile.status],
            ['Model', profile.model ?? 'none'],
            ['Default', payload.defaultProfileId === profile.id ? 'yes' : 'no'],
            ['Active', payload.activeProfileId === profile.id ? 'yes' : 'no'],
            ['Reason', profile.reason ?? 'ok'],
          ]),
        );
      }
      return;
    }

    case 'add': {
      const created = await createProviderProfile({
        type: command.type,
        label: command.label,
        ...(command.baseUrl ? { baseUrl: command.baseUrl } : {}),
        ...(command.apiKey ? { apiKey: command.apiKey } : {}),
        ...(command.model ? { model: command.model } : {}),
        makeDefault: command.makeDefault,
        extraHeaders: parseHeaders(command.headers),
      });
      console.log(JSON.stringify(created, null, 2));
      return;
    }

    case 'use': {
      const updated = await updateProviderProfile(command.id, {
        makeDefault: true,
        ...(command.model ? { model: command.model } : {}),
      });
      console.log(JSON.stringify(updated, null, 2));
      return;
    }

    case 'models': {
      const providerId = command.id ?? (await resolveActiveProviderId());
      if (!providerId) {
        console.log('No active provider. Connect one first with: umbra providers connect');
        return;
      }
      const payload = (await listProviderModels(providerId)) as {
        models: Array<{ id: string; name: string; contextWindow: number | null; tags?: string[] }>;
      };
      if (payload.models.length === 0) {
        console.log('No models reported by the provider.');
        return;
      }
      for (const model of payload.models) {
        console.log(
          renderKeyValueCard(model.name, [
            ['ID', model.id],
            ['Context', model.contextWindow === null ? 'unknown' : String(model.contextWindow)],
            ['Tags', model.tags?.join(', ') || 'none'],
          ]),
        );
      }
      return;
    }

    case 'catalog': {
      const response = (await getProviderModelCatalog()) as {
        catalog?: Record<
          string,
          { id: string; provider: string; name?: string; limit?: { context?: number } }
        >;
      };
      const catalog = response.catalog || {};
      const grouped = Object.values(catalog).reduce<
        Record<string, Array<{ id: string; contextWindow: number | null }>>
      >((acc, model) => {
        const provider = model.provider || 'unknown';
        const entries = acc[provider] ?? [];
        entries.push({
          id: model.id,
          contextWindow: typeof model.limit?.context === 'number' ? model.limit.context : null,
        });
        acc[provider] = entries;
        return acc;
      }, {});

      if (command.json) {
        console.log(JSON.stringify(grouped, null, 2));
        return;
      }
      console.log('--- Model Catalog (from models.dev) ---');
      for (const [provider, models] of Object.entries(grouped)) {
        if (models.length === 0) continue;
        console.log(`\n[${provider}]`);
        for (const model of models)
          console.log(`  - ${model.id} (${model.contextWindow ?? '?'} tokens)`);
      }
      return;
    }

    case 'test': {
      const payload = (await testProviderProfile(command.id)) as { ok: boolean; message: string };
      console.log(
        renderKeyValueCard('Provider Test', [
          ['OK', payload.ok ? 'yes' : 'no'],
          ['Message', payload.message],
        ]),
      );
      return;
    }

    case 'remove': {
      const payload = await deleteProviderProfile(command.id);
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    case 'connect': {
      await runConnectFlow(command.provider);
      return;
    }

    case 'interactive': {
      await runInteractiveMenu();
      return;
    }
  }
};

// ---------------------------------------------------------------------------
// OAuth connect flow
// ---------------------------------------------------------------------------

const CONNECT_PROVIDERS = [
  {
    id: 'openai-codex',
    label: 'ChatGPT Plus/Pro',
    hint: 'Uses your $20/$200/mo subscription via OAuth',
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    hint: 'Free models included; API key unlocks paid models',
  },
] as const;

async function runConnectFlow(providerType?: string): Promise<void> {
  let selectedProvider = providerType;

  if (!selectedProvider) {
    const idx = await pickFromList(
      'Connect provider:',
      CONNECT_PROVIDERS.map((p) => ({ label: p.label, hint: p.hint })),
    );
    if (idx === null) {
      console.log('Cancelled.');
      return;
    }
    selectedProvider = CONNECT_PROVIDERS[idx]?.id;
  }

  if (selectedProvider === 'opencode-zen') {
    await runOpencodeZenConnect();
    return;
  }

  if (selectedProvider !== 'openai-codex') {
    console.log(`Unknown OAuth provider: ${selectedProvider}`);
    return;
  }

  console.log('\n  ChatGPT Plus/Pro OAuth\n');
  console.log('  A browser will open for you to sign in with your ChatGPT account.');
  console.log('  Your subscription limits will be used instead of pay-per-token API credits.\n');

  try {
    const creds = await loginOpenAICodex({
      onAuth: (url) => {
        console.log(`  Opening browser: ${url}\n`);
        openBrowser(url);
      },
      onPrompt: async (message) => {
        return await promptText(`  ${message} `);
      },
      onProgress: (msg) => {
        process.stdout.write(`  ${msg}\r`);
      },
      originator: 'umbra',
    });

    process.stdout.write('\n');
    console.log('  Authentication successful!\n');
    console.log(`  Account ID: ${creds.accountId.slice(0, 8)}…`);
    console.log(`  Token expires: ${new Date(creds.expires).toLocaleString()}\n`);

    // Check if profile already exists
    const profilesPayload = (await listProviderProfiles()) as {
      profiles: Array<{ id: string; type: string }>;
    };
    const existing = profilesPayload.profiles.find((p) => p.type === 'openai-codex');

    let profileId: string;

    if (existing) {
      profileId = existing.id;
      await updateProviderProfile(existing.id, { makeDefault: true });
      console.log(`  Updated existing profile: ${existing.id}`);
    } else {
      const created = (await createProviderProfile({
        type: 'openai-codex',
        label: 'ChatGPT Plus/Pro',
        baseUrl: 'https://chatgpt.com/backend-api',
        model: 'codex-mini-latest',
        makeDefault: true,
      })) as { id: string };
      profileId = created.id;
      console.log(`  Created provider profile: ${profileId}`);
    }

    saveOAuthToken(profileId, {
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
      accountId: creds.accountId,
    });

    console.log('\n  Done! ChatGPT Plus/Pro is now your active provider.\n');
    console.log('  Run: umbra providers list  — to verify');
    console.log('  Run: umbra providers test  — to test the connection\n');
  } catch (error) {
    process.stdout.write('\n');
    console.error(`  OAuth failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

const MENU_ITEMS = [
  { label: 'list', hint: 'List configured provider profiles' },
  { label: 'connect', hint: 'Sign in with ChatGPT subscription (OAuth)' },
  { label: 'add', hint: 'Add provider with an API key' },
  { label: 'use', hint: 'Set default provider' },
  { label: 'test', hint: 'Test a provider connection' },
  { label: 'models', hint: 'List available models' },
  { label: 'catalog', hint: 'Browse model catalog' },
  { label: 'remove', hint: 'Remove a provider profile' },
];

async function runInteractiveMenu(): Promise<void> {
  console.log('');
  const idx = await pickFromList('  Providers', MENU_ITEMS);
  if (idx === null) {
    console.log('  Cancelled.');
    return;
  }

  const action = MENU_ITEMS[idx]?.label;
  console.log('');

  switch (action) {
    case 'list':
      await runProvidersCommand({ action: 'list', json: false });
      break;

    case 'connect':
      await runConnectFlow();
      break;

    case 'add':
      await runInteractiveAdd();
      break;

    case 'use': {
      const id = await pickProfile('Set as default:');
      if (id) await runProvidersCommand({ action: 'use', id });
      break;
    }

    case 'test': {
      const id = await pickProfile('Test connection:');
      if (id) await runProvidersCommand({ action: 'test', id });
      break;
    }

    case 'models': {
      const id = await pickProfile('List models for:');
      if (id) await runProvidersCommand({ action: 'models', id });
      break;
    }

    case 'catalog':
      await runProvidersCommand({ action: 'catalog', json: false });
      break;

    case 'remove': {
      const id = await pickProfile('Remove profile:');
      if (id) {
        const confirm = await promptText(`  Remove profile "${id}"? Type YES to confirm: `);
        if (confirm.trim() === 'YES') {
          await runProvidersCommand({ action: 'remove', id });
          console.log('  Profile removed.');
        } else {
          console.log('  Cancelled.');
        }
      }
      break;
    }
  }
}

async function runInteractiveAdd(): Promise<void> {
  const PROVIDER_TYPES = [
    { label: 'openai', hint: 'OpenAI (api.openai.com)' },
    { label: 'anthropic', hint: 'Anthropic / Claude' },
    { label: 'openrouter', hint: 'OpenRouter' },
    { label: 'mistral', hint: 'Mistral AI' },
    { label: 'ollama', hint: 'Ollama (local)' },
    { label: 'lmstudio', hint: 'LM Studio (local)' },
    { label: 'openai_compatible', hint: 'Custom OpenAI-compatible endpoint' },
    { label: 'opencode-zen', hint: 'OpenCode Zen (free + paid models)' },
  ];

  const typeIdx = await pickFromList('  Provider type:', PROVIDER_TYPES);
  if (typeIdx === null) {
    console.log('  Cancelled.');
    return;
  }
  const type = PROVIDER_TYPES[typeIdx]?.label ?? 'openai';

  const label = await promptText('  Label (e.g. "My OpenAI"): ');
  if (!label.trim()) {
    console.log('  Cancelled.');
    return;
  }

  const apiKey = await promptText('  API key: ');
  const model = await promptText('  Default model (leave blank to skip): ');
  const baseUrl = await promptText('  Base URL (leave blank for default): ');

  await runProvidersCommand({
    action: 'add',
    type,
    label: label.trim(),
    apiKey: apiKey.trim() || undefined,
    model: model.trim() || undefined,
    baseUrl: baseUrl.trim() || undefined,
    makeDefault: false,
    headers: [],
  });
  console.log('  Profile created.');
}

async function pickProfile(title: string): Promise<string | null> {
  const payload = (await listProviderProfiles()) as {
    profiles: Array<{ id: string; label: string; type: string }>;
    defaultProfileId: string | null;
  };

  if (payload.profiles.length === 0) {
    console.log('  No provider profiles configured.');
    return null;
  }

  const items = payload.profiles.map((p) => ({
    label: p.label,
    hint: `${p.type}  ${payload.defaultProfileId === p.id ? '[default]' : ''}`.trim(),
  }));

  const idx = await pickFromList(`  ${title}`, items);
  if (idx === null) {
    console.log('  Cancelled.');
    return null;
  }
  return payload.profiles[idx]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Terminal UI helpers
// ---------------------------------------------------------------------------

async function pickFromList(
  title: string,
  items: Array<{ label: string; hint?: string }>,
): Promise<number | null> {
  if (!process.stdin.isTTY || items.length === 0) return null;

  return new Promise((resolve) => {
    let selected = 0;
    const count = items.length;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdout.write(`${title}\n\n`);
    for (const item of items) process.stdout.write('\n');

    function render() {
      process.stdout.write(`\x1b[${count}A`);
      for (let i = 0; i < count; i++) {
        const item = items[i];
        if (!item) continue;
        const cursor = i === selected ? '\x1b[36m›\x1b[0m' : ' ';
        const label = i === selected ? `\x1b[1m\x1b[36m${item.label}\x1b[0m` : item.label;
        const hint = item.hint ? `  \x1b[90m${item.hint}\x1b[0m` : '';
        process.stdout.write(`\r  ${cursor} ${label}${hint}\x1b[K\n`);
      }
    }

    render();

    function cleanup() {
      process.stdout.write('\n');
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    }

    function onData(key: string) {
      if (key === '\x1b[A') {
        selected = Math.max(0, selected - 1);
        render();
      } else if (key === '\x1b[B') {
        selected = Math.min(count - 1, selected + 1);
        render();
      } else if (key === '\r' || key === '\n') {
        cleanup();
        resolve(selected);
      } else if (key === '\x03' || key === 'q' || key === '\x1b') {
        cleanup();
        resolve(null);
      }
    }

    process.stdin.on('data', onData);
  });
}

async function promptText(message: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn(`start "" "${url}"`, [], { detached: true, shell: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolveActiveProviderId(): Promise<string | null> {
  const payload = (await listProviderProfiles()) as {
    activeProfileId: string | null;
    defaultProfileId: string | null;
    fallbackProfileId: string | null;
  };
  return payload.activeProfileId ?? payload.defaultProfileId ?? payload.fallbackProfileId;
}

async function runOpencodeZenConnect(): Promise<void> {
  console.log('\n  OpenCode Zen\n');
  console.log(
    '  Free models (big-pickle, minimax-m2.5-free, gpt-5-nano, etc.) work without a key.',
  );
  console.log('  For paid models, get an API key at: https://opencode.ai/zen\n');

  const useKey = await promptText('  Do you have an API key? (y/N): ');
  const hasKey = useKey.trim().toLowerCase() === 'y';

  let apiKey: string | undefined;
  if (hasKey) {
    const key = await promptText('  Paste your OpenCode Zen API key: ');
    apiKey = key.trim() || undefined;
    if (!apiKey) {
      console.log('  No key entered — connecting without key (free models only).\n');
    }
  } else {
    console.log('  Connecting without a key — free models only.\n');
    openBrowser('https://opencode.ai/zen');
  }

  try {
    const profilesPayload = (await listProviderProfiles()) as {
      profiles: Array<{ id: string; type: string }>;
    };
    const existing = profilesPayload.profiles.find((p) => p.type === 'opencode-zen');

    if (existing) {
      await updateProviderProfile(existing.id, {
        makeDefault: true,
        ...(apiKey ? { apiKey } : {}),
      });
      console.log(`  Updated existing profile: ${existing.id}`);
    } else {
      const created = (await createProviderProfile({
        type: 'opencode-zen',
        label: 'OpenCode Zen',
        baseUrl: 'https://opencode.ai/zen/v1',
        model: 'big-pickle',
        makeDefault: true,
        ...(apiKey ? { apiKey } : {}),
      })) as { id: string };
      console.log(`  Created provider profile: ${created.id}`);
    }

    console.log('\n  Done! OpenCode Zen is now your active provider.');
    console.log('  Default model: big-pickle (free, unlimited)');
    console.log('  Run: umbra providers models  — to see all available models\n');
  } catch (error) {
    console.error(`  Setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function parseHeaders(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values) {
    const sepIdx = value.indexOf(':');
    if (sepIdx <= 0) continue;
    const key = value.slice(0, sepIdx).trim();
    const headerValue = value.slice(sepIdx + 1).trim();
    if (key && headerValue) headers[key] = headerValue;
  }
  return headers;
}
