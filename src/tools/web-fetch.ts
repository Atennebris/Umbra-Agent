import { z } from 'zod';
import { writeDebugEvent } from '../debug/runtime-debug.js';
import type { ToolExecutionContext } from './types.js';

export const webFetchInputSchema = z.object({
  url: z.string().url(),
  /**
   * 'reader' uses Jina Reader (r.jina.ai) to extract clean LLM-friendly markdown.
   * 'raw' fetches the page directly and strips HTML tags.
   * Defaults to 'reader'.
   */
  mode: z.enum(['reader', 'raw']).default('reader'),
  maxChars: z.number().int().min(500).max(100_000).default(20_000),
});

export const webFetchOutputSchema = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  mode: z.enum(['reader', 'raw']),
  truncated: z.boolean(),
  statusCode: z.number().int().optional(),
  error: z.string().optional(),
});

const JINA_READER_BASE = 'https://r.jina.ai';
type WebFetchOutput = z.infer<typeof webFetchOutputSchema>;

export async function executeWebFetch(
  input: z.infer<typeof webFetchInputSchema>,
  context: ToolExecutionContext,
): Promise<z.infer<typeof webFetchOutputSchema>> {
  const { url, mode, maxChars } = input;

  if (mode === 'reader') {
    return fetchViaJinaReader(url, maxChars, context.signal);
  }
  return fetchRaw(url, maxChars, context.signal);
}

async function fetchViaJinaReader(
  url: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<WebFetchOutput> {
  const jinaUrl = `${JINA_READER_BASE}/${url}`;
  const apiKey = process.env.JINA_API_KEY?.trim();

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Return-Format': 'markdown',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(jinaUrl, { headers, ...(signal ? { signal } : {}) });
  } catch (err) {
    return fetchRaw(url, maxChars, signal);
  }

  if (!response.ok) {
    return fetchRaw(url, maxChars, signal);
  }

  const payload = (await response.json()) as {
    code?: number;
    data?: { title?: string; content?: string; url?: string };
  };

  if (typeof payload.code === 'number' && payload.code >= 400) {
    return fetchRaw(url, maxChars, signal);
  }

  const title = payload.data?.title ?? '';
  const raw = payload.data?.content ?? '';
  const truncated = raw.length > maxChars;
  const content = truncated ? `${raw.slice(0, maxChars)}\n\n[...truncated]` : raw;

  return { url, title, content, mode: 'reader', truncated };
}

async function fetchRaw(
  url: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<WebFetchOutput> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UmbraBot/1.0)' },
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    return createHttpMissResult(url, 'raw', response.status, response.statusText);
  }

  const html = await response.text();
  const title = extractHtmlTitle(html);
  const text = stripHtml(html);
  const truncated = text.length > maxChars;
  const content = truncated ? `${text.slice(0, maxChars)}\n\n[...truncated]` : text;

  return { url, title, content, mode: 'raw', truncated };
}

function createHttpMissResult(
  url: string,
  mode: WebFetchOutput['mode'],
  statusCode: number,
  statusText: string,
): WebFetchOutput {
  const label = statusText ? `HTTP ${statusCode} ${statusText}` : `HTTP ${statusCode}`;
  writeDebugEvent({
    component: 'runner',
    level: 'warn',
    message: 'web.fetch non-ok response',
    data: { url, statusCode, statusText, mode },
  });

  return {
    url,
    title: '',
    content: `Unable to fetch this URL: ${label}. The page may be missing, moved, blocked, or stale. Search for another source or fetch a different result URL.`,
    mode,
    truncated: false,
    statusCode,
    error: label,
  };
}

function extractHtmlTitle(html: string): string {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? (m[1]?.trim() ?? '') : '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
