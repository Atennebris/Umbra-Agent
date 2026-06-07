export type ProviderProfile = {
  id: string;
  type: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string | null;
  enabled: boolean;
  extraHeaders: Record<string, string>;
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ProviderProfileStore = {
  version: 1;
  defaultProfileId: string | null;
  profiles: ProviderProfile[];
  chains?: ProviderChain[];
};

export type ProviderProfileStatus = 'connected' | 'available' | 'unavailable';

export type ProviderProfilePayload = {
  id: string;
  type: string;
  normalizedType: string;
  label: string;
  baseUrl: string;
  model: string | null;
  enabled: boolean;
  extraHeaders: Record<string, string>;
  options: Record<string, unknown>;
  hasApiKey: boolean;
  needsKey: boolean;
  keyOptional: boolean;
  keyHint: string;
  cloud: boolean;
  available: boolean;
  status: ProviderProfileStatus;
  fallbackType: string | null;
  fallbackProfileId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderProfilesListPayload = {
  profiles: ProviderProfilePayload[];
  defaultProfileId: string | null;
  fallbackProfileId: string | null;
  activeProfileId: string | null;
};

export type ProviderProfileCreateInput = {
  type: string;
  label: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string | null;
  enabled?: boolean;
  extraHeaders?: Record<string, string>;
  options?: Record<string, unknown>;
  makeDefault?: boolean;
};

export type ProviderProfileUpdateInput = {
  type?: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string | null;
  enabled?: boolean;
  extraHeaders?: Record<string, string>;
  options?: Record<string, unknown>;
  makeDefault?: boolean;
};

export type ProviderConnectionTestPayload = {
  ok: boolean;
  message: string;
};

export type ProviderModelPayload = {
  id: string;
  name: string;
  contextWindow: number | null;
  tags?: string[];
};

export type ProviderDefaultsPayload = {
  defaultProfileId: string | null;
  fallbackProfileId: string | null;
  activeProfileId: string | null;
  profiles: Array<{
    id: string;
    model: string | null;
    enabled: boolean;
  }>;
};

export type ProviderChainEntry = {
  profileId: string;
  model?: string;
};

export type ProviderChain = {
  id: string;
  label: string;
  entries: ProviderChainEntry[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProviderChainCreateInput = {
  label: string;
  entries: ProviderChainEntry[];
  enabled?: boolean;
};

export type ProviderChainUpdateInput = {
  label?: string;
  entries?: ProviderChainEntry[];
  enabled?: boolean;
};
