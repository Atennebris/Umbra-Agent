/**
 * Notification channel (§8.10)
 * Writes structured notifications to ~/.umbra/notifications.jsonl
 * Minimum viable implementation: local file log + optional webhook stub.
 */

import fs from 'node:fs';
import path from 'node:path';

export type NotificationLevel = 'info' | 'success' | 'warn' | 'error';

export type NotificationEntry = {
  timestamp: string;
  level: NotificationLevel;
  source: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
};

function resolveNotificationPath(): string {
  const home =
    process.env.UMBRA_HOME ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.umbra');
  return path.join(home, 'notifications.jsonl');
}

/**
 * Write a notification entry to ~/.umbra/notifications.jsonl.
 * Non-blocking: errors are silently ignored so the daemon never crashes
 * due to a failing notification write.
 */
export function writeNotification(entry: Omit<NotificationEntry, 'timestamp'>): void {
  try {
    const record: NotificationEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    const notifPath = resolveNotificationPath();
    const dir = path.dirname(notifPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(notifPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // best-effort
  }
}

/**
 * Read the last N notification entries from ~/.umbra/notifications.jsonl.
 * Returns an empty array if the file does not exist or cannot be read.
 */
export function readRecentNotifications(limit = 50): NotificationEntry[] {
  try {
    const notifPath = resolveNotificationPath();
    if (!fs.existsSync(notifPath)) return [];
    const raw = fs.readFileSync(notifPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as NotificationEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is NotificationEntry => e !== null);
  } catch {
    return [];
  }
}
