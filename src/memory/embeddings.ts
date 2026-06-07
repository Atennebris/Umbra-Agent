import { resolveRuntimeLayout } from './runtime-layout.js';
import { loadRuntimeSettings } from './settings-store.js';

export type TextEmbedding = {
  model: string;
  dimensions: number;
  values: number[];
};

export type TextEmbedder = {
  getStatus(): {
    backend: 'transformers-js';
    model: string;
    ready: boolean;
    modelDir: string;
    cacheDir: string;
    lastError: string | null;
  };
  startWarmup(): void;
  embedText(content: string): Promise<TextEmbedding>;
};

type FeatureExtractor = (
  text: string,
  options: {
    pooling: 'mean';
    normalize: true;
  },
) => Promise<{
  data: ArrayLike<number>;
}>;

export class TransformersTextEmbedder implements TextEmbedder {
  readonly #layout = resolveRuntimeLayout();
  readonly #settings = loadRuntimeSettings();
  #pipelinePromise: Promise<FeatureExtractor> | null = null;
  #ready = false;
  #lastError: string | null = null;

  getStatus() {
    return {
      backend: 'transformers-js' as const,
      model: this.#settings.embeddings.model,
      ready: this.#ready,
      modelDir: this.#layout.transformersCacheDir,
      cacheDir: this.#layout.transformersCacheDir,
      lastError: this.#lastError,
    };
  }

  startWarmup(): void {
    if (!this.#settings.embeddings.autoDownloadEnabled) {
      return;
    }

    void this.#getPipeline().catch(() => {});
  }

  async embedText(content: string): Promise<TextEmbedding> {
    const extractor = await this.#getPipeline();
    const tensor = await extractor(content, { pooling: 'mean', normalize: true });
    const values = Array.from(tensor.data as Float32Array | Float64Array | number[]);

    return {
      model: this.#settings.embeddings.model,
      dimensions: values.length,
      values,
    };
  }

  async #getPipeline(): Promise<FeatureExtractor> {
    if (!this.#pipelinePromise) {
      this.#pipelinePromise = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
        env.useFS = true;
        env.useFSCache = true;
        env.cacheDir = this.#layout.transformersCacheDir;
        return pipeline(
          'feature-extraction',
          this.#settings.embeddings.model,
        ) as Promise<FeatureExtractor>;
      })();
    }

    try {
      const extractor = await this.#pipelinePromise;
      this.#ready = true;
      this.#lastError = null;
      return extractor;
    } catch (error) {
      this.#ready = false;
      this.#pipelinePromise = null;
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}
