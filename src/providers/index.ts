import { getPermissionManager } from '../core/permissions.js';
import { type ModelCapabilitiesPayload, ModelsRegistry } from './models-registry.js';
import type {
  ProviderConnectionTestPayload,
  ProviderDefaultsPayload,
  ProviderModelPayload,
  ProviderProfile,
  ProviderProfileCreateInput,
  ProviderProfilePayload,
  ProviderProfileUpdateInput,
  ProviderProfilesListPayload,
} from './profile-types.js';
import { ProviderProfilesStore } from './profiles-store.js';
import { type FetchLike, createProviderClient } from './provider-client.js';
import {
  type ProviderTypePayload,
  type ProviderTypeResolution,
  getProviderSpec,
  providerTypePayloads,
  resolveProviderType,
} from './provider-registry.js';
import type { ProviderCompleteRequest, ProviderCompleteResponse } from './runtime-types.js';
import type { ProviderStreamObserver } from './runtime-types.js';

export interface ProviderCatalog {
  listTypes(): ProviderTypePayload[];
  resolveType(providerType: string): ProviderTypeResolution;
  getModelCapabilities(modelId: string): Promise<ModelCapabilitiesPayload>;
  listProfiles?(): ProviderProfilesListPayload;
  createProfile?(input: ProviderProfileCreateInput): ProviderProfilePayload;
  updateProfile?(profileId: string, input: ProviderProfileUpdateInput): ProviderProfilePayload;
  deleteProfile?(profileId: string): ProviderProfilesListPayload;
  testProfile?(profileId: string): Promise<ProviderConnectionTestPayload>;
  listProfileModels?(profileId: string): Promise<ProviderModelPayload[]>;
  getProfileModelCapabilities?(
    profileId: string,
    modelId: string,
  ): Promise<ModelCapabilitiesPayload>;
  completeProfile?(
    profileId: string,
    request: ProviderCompleteRequest,
  ): Promise<ProviderCompleteResponse>;
  completeProfileStream?(
    profileId: string,
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse>;
  getDefaults?(): ProviderDefaultsPayload;
  listChains?(): import('./profile-types.js').ProviderChain[];
  createChain?(
    input: import('./profile-types.js').ProviderChainCreateInput,
  ): import('./profile-types.js').ProviderChain;
  updateChain?(
    chainId: string,
    input: import('./profile-types.js').ProviderChainUpdateInput,
  ): import('./profile-types.js').ProviderChain;
  deleteChain?(chainId: string): import('./profile-types.js').ProviderChain[];
  listPermissionRules?(): import('../core/permissions.js').PermissionRule[];
  deletePermissionRule?(ruleId: string): boolean;
}

export class DefaultProviderCatalog implements ProviderCatalog {
  #modelsRegistry: ModelsRegistry;
  #profilesStore: ProviderProfilesStore;
  #fetcher: FetchLike;

  constructor({
    modelsRegistry = new ModelsRegistry(),
    profilesStore = new ProviderProfilesStore(),
    fetcher = fetch,
  }: {
    modelsRegistry?: ModelsRegistry;
    profilesStore?: ProviderProfilesStore;
    fetcher?: FetchLike;
  } = {}) {
    this.#modelsRegistry = modelsRegistry;
    this.#profilesStore = profilesStore;
    this.#fetcher = fetcher;
    this.#profilesStore.ensure();
  }

  listTypes(): ProviderTypePayload[] {
    return providerTypePayloads();
  }

  resolveType(providerType: string): ProviderTypeResolution {
    return resolveProviderType(providerType);
  }

  async getModelCapabilities(modelId: string): Promise<ModelCapabilitiesPayload> {
    return this.#modelsRegistry.getModelCapabilities(modelId);
  }

  listProfiles(): ProviderProfilesListPayload {
    const store = this.#profilesStore.list();
    const payloads = store.profiles.map((profile) => this.#toProfilePayload(profile.id));
    const fallbackProfileId =
      payloads.find((profile) => profile.status === 'connected')?.id ?? null;
    const activeProfileId =
      payloads.find(
        (profile) => profile.id === store.defaultProfileId && profile.status !== 'unavailable',
      )?.id ?? fallbackProfileId;

    return {
      profiles: payloads,
      defaultProfileId: store.defaultProfileId,
      fallbackProfileId,
      activeProfileId,
    };
  }

  createProfile(input: ProviderProfileCreateInput): ProviderProfilePayload {
    validateProfileInput(input, false);
    const resolution = resolveProviderType(input.type);

    if (!resolution.available) {
      throw new Error(resolution.reason ?? `Provider type "${input.type}" is unavailable.`);
    }

    const spec = getProviderSpec(resolution.resolvedType);

    if (!spec) {
      throw new Error(`Provider type "${input.type}" is unavailable.`);
    }

    const baseUrl = input.baseUrl?.trim() || spec.defaultUrl;

    if (!baseUrl) {
      throw new Error(`Provider type "${spec.value}" requires an explicit baseUrl.`);
    }

    const store = this.#profilesStore.create({
      ...input,
      type: spec.value,
      baseUrl,
    });
    return this.#toProfilePayload(store.profiles.at(-1)?.id ?? '');
  }

  updateProfile(profileId: string, input: ProviderProfileUpdateInput): ProviderProfilePayload {
    validateProfileInput(input, true);
    const typeResolution = input.type ? resolveProviderType(input.type) : null;

    if (typeResolution && !typeResolution.available) {
      throw new Error(typeResolution.reason ?? `Provider type "${input.type}" is unavailable.`);
    }

    const nextType = typeResolution?.resolvedType;
    const spec = nextType ? getProviderSpec(nextType) : null;
    const current = this.#requireProfile(profileId);
    const store = this.#profilesStore.update(profileId, {
      ...input,
      ...(nextType ? { type: nextType } : {}),
      ...(input.baseUrl !== undefined
        ? { baseUrl: input.baseUrl }
        : nextType && current.type !== nextType && spec?.defaultUrl
          ? { baseUrl: spec.defaultUrl }
          : {}),
    });
    const updated = store.profiles.find((profile) => profile.id === profileId);

    if (!updated) {
      throw new Error(`Provider profile "${profileId}" was not found.`);
    }

    return this.#toProfilePayload(profileId);
  }

  deleteProfile(profileId: string): ProviderProfilesListPayload {
    this.#profilesStore.delete(profileId);
    return this.listProfiles();
  }

  async testProfile(profileId: string): Promise<ProviderConnectionTestPayload> {
    const profile = this.#requireProfile(profileId);
    const validationIssue = getProfileValidationIssue(profile);

    if (validationIssue) {
      return {
        ok: false,
        message: validationIssue,
      };
    }

    const resolution = resolveProviderType(profile.type);
    const client = createProviderClient(profile, resolution.resolvedType, this.#fetcher);
    return client.testConnection();
  }

  async listProfileModels(profileId: string): Promise<ProviderModelPayload[]> {
    const profile = this.#requireProfile(profileId);
    const resolution = requireUsableProfile(profile);

    const client = createProviderClient(profile, resolution.resolvedType, this.#fetcher);
    return client.listModels();
  }

  async getProfileModelCapabilities(
    profileId: string,
    modelId: string,
  ): Promise<ModelCapabilitiesPayload> {
    requireUsableProfile(this.#requireProfile(profileId));
    return this.getModelCapabilities(modelId);
  }

  async completeProfile(
    profileId: string,
    request: ProviderCompleteRequest,
  ): Promise<ProviderCompleteResponse> {
    const profile = this.#requireProfile(profileId);
    const resolution = requireUsableProfile(profile);
    const client = createProviderClient(profile, resolution.resolvedType, this.#fetcher);
    return client.complete(request);
  }

  async completeProfileStream(
    profileId: string,
    request: ProviderCompleteRequest,
    observer: ProviderStreamObserver,
  ): Promise<ProviderCompleteResponse> {
    const profile = this.#requireProfile(profileId);
    const resolution = requireUsableProfile(profile);
    const client = createProviderClient(profile, resolution.resolvedType, this.#fetcher);

    if (!('completeStream' in client) || typeof client.completeStream !== 'function') {
      return client.complete(request);
    }

    return client.completeStream(request, observer);
  }

  getDefaults(): ProviderDefaultsPayload {
    const profiles = this.listProfiles();
    return {
      defaultProfileId: profiles.defaultProfileId,
      fallbackProfileId: profiles.fallbackProfileId,
      activeProfileId: profiles.activeProfileId,
      profiles: profiles.profiles.map((profile) => ({
        id: profile.id,
        model: profile.model,
        enabled: profile.enabled,
      })),
    };
  }

  listChains(): import('./profile-types.js').ProviderChain[] {
    return this.#profilesStore.list().chains ?? [];
  }

  createChain(
    input: import('./profile-types.js').ProviderChainCreateInput,
  ): import('./profile-types.js').ProviderChain {
    return this.#profilesStore.createChain(input);
  }

  updateChain(
    chainId: string,
    input: import('./profile-types.js').ProviderChainUpdateInput,
  ): import('./profile-types.js').ProviderChain {
    return this.#profilesStore.updateChain(chainId, input);
  }

  deleteChain(chainId: string): import('./profile-types.js').ProviderChain[] {
    return this.#profilesStore.deleteChain(chainId);
  }

  listPermissionRules(): import('../core/permissions.js').PermissionRule[] {
    return getPermissionManager().listRules();
  }

  deletePermissionRule(ruleId: string): boolean {
    return getPermissionManager().removeRule(ruleId);
  }

  #toProfilePayload(profileId: string): ProviderProfilePayload {
    const store = this.#profilesStore.list();
    const profile = store.profiles.find((entry) => entry.id === profileId);

    if (!profile) {
      throw new Error(`Provider profile "${profileId}" was not found.`);
    }

    const resolution = resolveProviderType(profile.type);
    const spec =
      getProviderSpec(resolution.normalizedType) ?? getProviderSpec(resolution.resolvedType);
    const listPayload = this.#profilesStore.list();
    const fallbackProfileId =
      listPayload.profiles.find((entry) => {
        const entryResolution = resolveProviderType(entry.type);
        return entry.enabled && entryResolution.available;
      })?.id ?? null;

    const validationIssue = getProfileValidationIssue(profile);
    const available = resolution.available && validationIssue === null;

    return {
      id: profile.id,
      type: profile.type,
      normalizedType: resolution.normalizedType,
      label: profile.label,
      baseUrl: profile.baseUrl,
      model: profile.model,
      enabled: profile.enabled,
      extraHeaders: { ...profile.extraHeaders },
      options: { ...profile.options },
      hasApiKey: profile.apiKey.trim().length > 0,
      needsKey: spec?.needsKey ?? true,
      keyOptional: spec?.keyOptional ?? false,
      keyHint: spec?.keyHint ?? '',
      cloud: spec?.cloud ?? true,
      available,
      status: !available ? 'unavailable' : profile.enabled ? 'connected' : 'available',
      fallbackType: resolution.fallbackType,
      fallbackProfileId,
      reason: validationIssue ?? resolution.reason,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }

  #requireProfile(profileId: string) {
    const profile = this.#profilesStore.list().profiles.find((entry) => entry.id === profileId);

    if (!profile) {
      throw new Error(`Provider profile "${profileId}" was not found.`);
    }

    return profile;
  }
}

let providerCatalogForTests: ProviderCatalog | null = null;

export function getProviderCatalog(): ProviderCatalog {
  return providerCatalogForTests ?? new DefaultProviderCatalog();
}

export function setProviderCatalogForTests(providerCatalog: ProviderCatalog): void {
  providerCatalogForTests = providerCatalog;
}

export function resetProviderCatalogForTests(): void {
  providerCatalogForTests = null;
}

export {
  ModelsRegistry,
  normalizeModelId,
  flattenModelsDevDataset,
  findModelInDataset,
  buildModelsDevCapabilities,
  buildHeuristicCapabilities,
  type ModelCapabilitiesPayload,
} from './models-registry.js';
export {
  getProviderSpec,
  normalizeProviderType,
  providerSpecs,
  providerTypePayloads,
  resolveProviderType,
  type ProviderTypePayload,
  type ProviderTypeResolution,
  type ProviderTypeSpec,
} from './provider-registry.js';
export type {
  ProviderConnectionTestPayload,
  ProviderDefaultsPayload,
  ProviderProfile,
  ProviderModelPayload,
  ProviderProfileCreateInput,
  ProviderProfilePayload,
  ProviderProfilesListPayload,
  ProviderProfileUpdateInput,
} from './profile-types.js';
export { ProviderProfilesStore } from './profiles-store.js';
export {
  DefaultProviderGateway,
  type ProviderGateway,
  type GatewayRequest,
} from './provider-gateway.js';
export type {
  ProviderChatMessage,
  ProviderCompleteRequest,
  ProviderCompleteResponse,
  ProviderResponseFormat,
  ProviderStreamObserver,
  ProviderToolCall,
  ProviderToolDefinition,
} from './runtime-types.js';
export {
  providerChatMessageSchema,
  providerCompleteRequestSchema,
  providerCompleteResponseSchema,
  providerResponseFormatSchema,
  providerToolCallSchema,
  providerToolDefinitionSchema,
} from './runtime-types.js';

function validateProfileInput(
  input: ProviderProfileCreateInput | ProviderProfileUpdateInput,
  partial: boolean,
): void {
  if (!partial) {
    if (typeof input.type !== 'string' || input.type.trim().length === 0) {
      throw new Error('Provider profile field "type" must be a non-empty string.');
    }

    if (typeof input.label !== 'string' || input.label.trim().length === 0) {
      throw new Error('Provider profile field "label" must be a non-empty string.');
    }
  }

  if (input.baseUrl !== undefined && typeof input.baseUrl !== 'string') {
    throw new Error('Provider profile field "baseUrl" must be a string when provided.');
  }

  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') {
    throw new Error('Provider profile field "apiKey" must be a string when provided.');
  }

  if (input.model !== undefined && input.model !== null && typeof input.model !== 'string') {
    throw new Error('Provider profile field "model" must be a string or null when provided.');
  }

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('Provider profile field "enabled" must be a boolean when provided.');
  }

  if (input.makeDefault !== undefined && typeof input.makeDefault !== 'boolean') {
    throw new Error('Provider profile field "makeDefault" must be a boolean when provided.');
  }

  if (input.extraHeaders !== undefined && !isStringRecord(input.extraHeaders)) {
    throw new Error('Provider profile field "extraHeaders" must be an object of string values.');
  }

  if (input.options !== undefined && !isUnknownRecord(input.options)) {
    throw new Error('Provider profile field "options" must be a JSON object when provided.');
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isUnknownRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getProfileValidationIssue(profile: ProviderProfile): string | null {
  const resolution = resolveProviderType(profile.type);

  if (!resolution.available) {
    return resolution.reason ?? `Provider type "${profile.type}" is unavailable.`;
  }

  const spec = getProviderSpec(resolution.resolvedType);

  if (!spec) {
    return `Provider type "${profile.type}" is unavailable.`;
  }

  if (profile.baseUrl.trim().length === 0) {
    return `Provider profile "${profile.label}" is missing baseUrl.`;
  }

  if (spec.needsKey && !spec.keyOptional && profile.apiKey.trim().length === 0) {
    return `Provider profile "${profile.label}" is missing apiKey.`;
  }

  return null;
}

function requireUsableProfile(profile: ProviderProfile): ProviderTypeResolution {
  const resolution = resolveProviderType(profile.type);
  const validationIssue = getProfileValidationIssue(profile);

  if (validationIssue) {
    throw new Error(validationIssue);
  }

  return resolution;
}
