export type LazyValueLoader<T> = () => Promise<T>;

export function createLazyValue<T>(factory: () => Promise<T> | T): LazyValueLoader<T> {
  let cachedPromise: Promise<T> | null = null;

  return async () => {
    if (!cachedPromise) {
      cachedPromise = Promise.resolve(factory());
    }

    return cachedPromise;
  };
}
