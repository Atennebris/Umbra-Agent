import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolveRuntimeLayout } from '../memory/runtime-layout.js';
import type {
  ProviderChain,
  ProviderChainCreateInput,
  ProviderChainUpdateInput,
  ProviderProfile,
  ProviderProfileCreateInput,
  ProviderProfileStore,
  ProviderProfileUpdateInput,
} from './profile-types.js';

const DEFAULT_STORE: ProviderProfileStore = {
  version: 1,
  defaultProfileId: null,
  profiles: [],
  chains: [],
};

export class ProviderProfilesStore {
  #providersPath: string;

  constructor() {
    this.#providersPath = resolveRuntimeLayout().providersPath;
  }

  load(): ProviderProfileStore {
    if (!fs.existsSync(this.#providersPath)) {
      return structuredClone(DEFAULT_STORE);
    }

    try {
      const raw = JSON.parse(
        fs.readFileSync(this.#providersPath, 'utf8'),
      ) as Partial<ProviderProfileStore>;
      return sanitizeStore(raw);
    } catch {
      return structuredClone(DEFAULT_STORE);
    }
  }

  save(store: ProviderProfileStore): ProviderProfileStore {
    const normalized = sanitizeStore(store);
    fs.writeFileSync(this.#providersPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    return normalized;
  }

  ensure(): ProviderProfileStore {
    const store = this.load();
    return this.save(store);
  }

  list(): ProviderProfileStore {
    return this.load();
  }

  create(input: ProviderProfileCreateInput): ProviderProfileStore {
    const store = this.load();
    const now = new Date().toISOString();
    const profile: ProviderProfile = {
      id: crypto.randomUUID(),
      type: input.type.trim(),
      label: input.label.trim(),
      baseUrl: input.baseUrl?.trim() ?? '',
      apiKey: input.apiKey ?? '',
      model: normalizeNullableString(input.model),
      enabled: input.enabled ?? true,
      extraHeaders: sanitizeStringMap(input.extraHeaders),
      options: sanitizeUnknownRecord(input.options),
      createdAt: now,
      updatedAt: now,
    };
    const nextStore: ProviderProfileStore = {
      ...store,
      profiles: [...store.profiles, profile],
      defaultProfileId:
        input.makeDefault || !store.defaultProfileId ? profile.id : store.defaultProfileId,
    };
    return this.save(nextStore);
  }

  update(profileId: string, input: ProviderProfileUpdateInput): ProviderProfileStore {
    const store = this.load();
    const profile = store.profiles.find((entry) => entry.id === profileId);

    if (!profile) {
      throw new Error(`Provider profile "${profileId}" was not found.`);
    }

    const updatedProfile: ProviderProfile = {
      ...profile,
      ...(input.type !== undefined ? { type: input.type.trim() } : {}),
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      ...(input.model !== undefined ? { model: normalizeNullableString(input.model) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.extraHeaders !== undefined
        ? { extraHeaders: sanitizeStringMap(input.extraHeaders) }
        : {}),
      ...(input.options !== undefined ? { options: sanitizeUnknownRecord(input.options) } : {}),
      updatedAt: new Date().toISOString(),
    };

    const nextStore: ProviderProfileStore = {
      ...store,
      profiles: store.profiles.map((entry) => (entry.id === profileId ? updatedProfile : entry)),
      defaultProfileId: input.makeDefault ? profileId : store.defaultProfileId,
    };
    return this.save(nextStore);
  }

  delete(profileId: string): ProviderProfileStore {
    const store = this.load();
    const nextProfiles = store.profiles.filter((entry) => entry.id !== profileId);
    const nextDefaultProfileId =
      store.defaultProfileId === profileId ? (nextProfiles[0]?.id ?? null) : store.defaultProfileId;

    if (nextProfiles.length === store.profiles.length) {
      throw new Error(`Provider profile "${profileId}" was not found.`);
    }

    return this.save({
      ...store,
      profiles: nextProfiles,
      defaultProfileId: nextDefaultProfileId,
    });
  }

  createChain(input: ProviderChainCreateInput): ProviderChain {
    const store = this.load();
    const now = new Date().toISOString();
    const chain: ProviderChain = {
      id: crypto.randomUUID(),
      label: input.label.trim(),
      entries: Array.isArray(input.entries) ? input.entries : [],
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.save({
      ...store,
      chains: [...(store.chains ?? []), chain],
    });
    return chain;
  }

  updateChain(chainId: string, input: ProviderChainUpdateInput): ProviderChain {
    const store = this.load();
    const chains = store.chains ?? [];
    const index = chains.findIndex((c) => c.id === chainId);
    if (index === -1) throw new Error(`Chain ${chainId} not found.`);
    const current = chains[index];
    if (!current) throw new Error(`Chain ${chainId} not found.`);

    const updated: ProviderChain = {
      ...current,
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.entries !== undefined ? { entries: input.entries } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: new Date().toISOString(),
    };

    const nextChains = [...chains];
    nextChains[index] = updated;

    this.save({ ...store, chains: nextChains });
    return updated;
  }

  deleteChain(chainId: string): ProviderChain[] {
    const store = this.load();
    const nextChains = (store.chains ?? []).filter((c) => c.id !== chainId);
    this.save({ ...store, chains: nextChains });
    return nextChains;
  }
}

function sanitizeStore(value: Partial<ProviderProfileStore>): ProviderProfileStore {
  const profiles = Array.isArray(value.profiles) ? value.profiles.map(sanitizeProfile) : [];
  const chains = Array.isArray(value.chains) ? value.chains.map(sanitizeChain) : [];
  const defaultProfileId =
    typeof value.defaultProfileId === 'string' &&
    profiles.some((profile) => profile.id === value.defaultProfileId)
      ? value.defaultProfileId
      : null;

  return {
    version: 1,
    defaultProfileId,
    profiles,
    chains,
  };
}

function sanitizeProfile(value: unknown): ProviderProfile {
  const record = isRecord(value) ? value : {};
  const now = new Date().toISOString();

  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : crypto.randomUUID(),
    type: typeof record.type === 'string' ? record.type.trim() : '',
    label: typeof record.label === 'string' ? record.label.trim() : '',
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '',
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
    model: normalizeNullableString(record.model),
    enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
    extraHeaders: sanitizeStringMap(record.extraHeaders),
    options: sanitizeUnknownRecord(record.options),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
  };
}

function sanitizeChain(value: unknown): ProviderChain {
  const record = isRecord(value) ? value : {};
  const now = new Date().toISOString();

  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : crypto.randomUUID(),
    label: typeof record.label === 'string' ? record.label.trim() : 'Unnamed Chain',
    entries: Array.isArray(record.entries) ? record.entries.map(sanitizeChainEntry) : [],
    enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now,
  };
}

function sanitizeChainEntry(value: unknown): { profileId: string; model?: string } {
  const record = isRecord(value) ? value : {};
  return {
    profileId: typeof record.profileId === 'string' ? record.profileId : '',
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
  };
}

function sanitizeStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === 'string' && typeof entry[1] === 'string',
    ),
  );
}

function sanitizeUnknownRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  return { ...value };
}

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return value === null ? null : null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
