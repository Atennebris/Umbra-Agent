import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './project-root.js';

export type UmbraConfig = {
  daemon: {
    host: string;
    port: number;
  };
};

export function loadConfig(): UmbraConfig {
  const configPath = path.join(projectRoot, 'config.json');
  const rawConfig = fs.readFileSync(configPath, 'utf8');
  const parsedConfig = JSON.parse(rawConfig) as unknown;
  const config = assertUmbraConfig(parsedConfig);

  const envHost = process.env.UMBRA_DAEMON_HOST;
  const envPort = process.env.UMBRA_DAEMON_PORT;

  const host = envHost ?? config.daemon.host;
  const port = envPort ? Number(envPort) : config.daemon.port;

  if (!isIpv4Address(host)) {
    throw new Error('Environment variable UMBRA_DAEMON_HOST must be a valid IPv4 address.');
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'Environment variable UMBRA_DAEMON_PORT must be an integer between 1 and 65535.',
    );
  }

  return {
    daemon: {
      host,
      port,
    },
  };
}

function assertUmbraConfig(value: unknown): UmbraConfig {
  if (!isRecord(value)) {
    throw new Error('config.json must be an object.');
  }

  const daemon = value.daemon;

  if (!isRecord(daemon)) {
    throw new Error('config.json must contain a daemon object.');
  }

  if (typeof daemon.host !== 'string' || !isIpv4Address(daemon.host)) {
    throw new Error('config.json daemon.host must be a valid IPv4 address.');
  }

  if (
    typeof daemon.port !== 'number' ||
    !Number.isInteger(daemon.port) ||
    daemon.port < 1 ||
    daemon.port > 65535
  ) {
    throw new Error('config.json daemon.port must be an integer between 1 and 65535.');
  }

  return {
    daemon: {
      host: daemon.host,
      port: daemon.port,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIpv4Address(value: string): boolean {
  const octets = value.split('.');

  if (octets.length !== 4) {
    return false;
  }

  return octets.every((octet) => {
    const number = Number(octet);
    return /^\d+$/.test(octet) && number >= 0 && number <= 255;
  });
}
