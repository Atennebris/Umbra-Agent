import type { CliCommandHandler } from '../command-types.js';
import { deletePermissionRule, listPermissionRules } from '../http-client.js';

export const runPermissionCommand: CliCommandHandler = async (input) => {
  const args = Array.isArray(input) ? (input as string[]) : [];
  const subcommand = args[0];

  if (subcommand === 'list') {
    const response = (await listPermissionRules()) as {
      rules?: Array<{ id: string; tool: string; outcome: string; createdAt: string }>;
    };
    const rules = response.rules || [];

    if (rules.length === 0) {
      console.log('No permission rules found.');
      return;
    }

    console.log('Current permission rules:');
    for (const rule of rules) {
      console.log(
        `- [${rule.id.slice(0, 8)}] ${rule.tool}: ${rule.outcome} (created ${rule.createdAt})`,
      );
    }
    return;
  }

  if (subcommand === 'reset') {
    const ruleId = args[1];
    if (ruleId) {
      const response = (await deletePermissionRule(ruleId)) as { success?: boolean };
      if (response.success) {
        console.log(`Rule ${ruleId} has been reset.`);
      } else {
        console.log(`Failed to reset rule ${ruleId}.`);
      }
    } else {
      // Reset all logic
      const response = (await listPermissionRules()) as {
        rules?: Array<{ id: string; tool: string; outcome: string; createdAt: string }>;
      };
      const rules = response.rules || [];
      for (const rule of rules) {
        await deletePermissionRule(rule.id);
      }
      console.log('All permission rules have been reset.');
    }
    return;
  }

  console.log('Usage: umbra permission <list|reset [id]>');
};
