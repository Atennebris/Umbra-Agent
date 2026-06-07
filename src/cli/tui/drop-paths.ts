export function parseDroppedPaths(input: string): string[] {
  const matches =
    input.match(/"[^"\r\n]+"|'[^'\r\n]+'|\.\/[^\s]+|[A-Za-z]:\\[^\s]+|\/[^\s]+/g) ?? [];

  return matches.map((match) => stripQuotes(match.trim())).filter((match) => isProbablyPath(match));
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

function isProbablyPath(value: string): boolean {
  return /^[A-Za-z]:\\/.test(value) || value.startsWith('/') || value.startsWith('./');
}
