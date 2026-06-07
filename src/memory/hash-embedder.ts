export type EmbeddingResult = {
  model: 'umbra-hash-v1';
  values: number[];
};

const dimensions = 128;

export function embedText(content: string): EmbeddingResult {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = content
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);

  for (const token of tokens) {
    let hash = 2166136261;

    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    const slot = Math.abs(hash) % dimensions;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (magnitude > 0) {
    for (let index = 0; index < vector.length; index += 1) {
      const value = vector[index] ?? 0;
      vector[index] = Number((value / magnitude).toFixed(8));
    }
  }

  return {
    model: 'umbra-hash-v1',
    values: vector,
  };
}
