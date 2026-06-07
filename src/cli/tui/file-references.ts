export function parseFileReferences(input: string): string[] {
  const matches = input.match(/@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g) ?? [];

  return matches
    .map((match) => match.slice(1))
    .map(stripQuotes)
    .filter((value) => value.length > 0);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
