import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/cli/doctor.js';
import * as httpClient from '../src/cli/http-client.js';
import * as pm2Client from '../src/cli/pm2-client.js';
import { resetMemoryManagerForTests } from '../src/memory/index.js';

vi.mock('../src/cli/pm2-client.js', () => ({
  readPm2ProcessList: vi.fn(),
}));

vi.mock('../src/cli/http-client.js', () => ({
  getStatus: vi.fn(),
}));

describe('runDoctor', () => {
  it('returns a stable report structure and handles PM2/daemon mocks', async () => {
    // Mock the PM2 client to return an empty array (no daemon running)
    vi.mocked(pm2Client.readPm2ProcessList).mockResolvedValue([]);
    // Mock getStatus to throw (daemon offline)
    vi.mocked(httpClient.getStatus).mockRejectedValue(new Error('ECONNREFUSED'));

    const originalUmbraHome = process.env.UMBRA_HOME;
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-doctor-'));
    process.env.UMBRA_HOME = tempHome;

    try {
      const report = await runDoctor({ fix: false });

      expect(report.ok).toBeDefined();
      expect(Array.isArray(report.appliedFixes)).toBe(true);
      expect(Array.isArray(report.items)).toBe(true);

      const pm2Item = report.items.find((i) => i.name === 'PM2 process');
      expect(pm2Item).toBeDefined();
      expect(pm2Item?.status).toBe('warn');
      expect(pm2Item?.detail).toContain('PM2 does not currently list umbra-daemon');

      const healthItem = report.items.find((i) => i.name === 'Daemon health');
      expect(healthItem).toBeDefined();
      expect(healthItem?.status).toBe('warn');
      expect(healthItem?.detail).toContain('Daemon health endpoint is not reachable');

      const memRootItem = report.items.find((i) => i.name === 'Umbra memory root');
      expect(memRootItem).toBeDefined();
      expect(['pass', 'fixed', 'warn', 'fail']).toContain(memRootItem?.status);
    } finally {
      resetMemoryManagerForTests();
      process.env.UMBRA_HOME = originalUmbraHome;
      await fs.rm(tempHome, { recursive: true, force: true });
      vi.resetAllMocks();
    }
  });
});
