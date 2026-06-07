import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSkill,
  formatSkillsForPrompt,
  loadSkills,
  parseCommandArgs,
  substituteArgs,
} from '../src/skills/skill-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-skill-test-'));
}

function createSkillFile(dir: string, subdir: string, frontmatter: string, body: string): string {
  const skillDir = path.join(dir, subdir);
  fs.mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}`, 'utf8');
  return filePath;
}

let tmpProject: string;
let tmpHome: string;

beforeEach(() => {
  tmpProject = makeTmpDir();
  tmpHome = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadSkills
// ---------------------------------------------------------------------------

describe('loadSkills', () => {
  it('returns empty when no skill directories exist', () => {
    const { skills, diagnostics } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills).toHaveLength(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('loads a valid project-local skill from .umbra/skills/', () => {
    const skillsDir = path.join(tmpProject, '.umbra', 'skills');
    createSkillFile(
      skillsDir,
      'deploy',
      'name: deploy\ndescription: Deploy the application to production.',
      '## Steps\n1. Build\n2. Push',
    );

    const { skills } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('deploy');
    expect(skills[0]?.description).toBe('Deploy the application to production.');
    expect(skills[0]?.source).toBe('project');
    expect(skills[0]?.disableModelInvocation).toBe(false);
  });

  it('loads a valid global skill from ~/.umbra/skills/', () => {
    const skillsDir = path.join(tmpHome, 'skills');
    createSkillFile(
      skillsDir,
      'review',
      'name: review\ndescription: Review the current PR.',
      '## Review process',
    );

    const { skills } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('review');
    expect(skills[0]?.source).toBe('global');
  });

  it('project skill overrides global skill with the same name', () => {
    const globalSkillsDir = path.join(tmpHome, 'skills');
    const projectSkillsDir = path.join(tmpProject, '.umbra', 'skills');

    createSkillFile(
      globalSkillsDir,
      'review',
      'name: review\ndescription: Global review process.',
      'Global body',
    );
    createSkillFile(
      projectSkillsDir,
      'review',
      'name: review\ndescription: Project review process.',
      'Project body',
    );

    const { skills } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('Project review process.');
    expect(skills[0]?.source).toBe('project');
  });

  it('parses disable-model-invocation and argument-hint fields', () => {
    const skillsDir = path.join(tmpProject, '.umbra', 'skills');
    createSkillFile(
      skillsDir,
      'test-cmd',
      'name: test-cmd\ndescription: Test command.\ndisable-model-invocation: true\nargument-hint: "<target>"',
      'Run tests for $1',
    );

    const { skills } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills[0]?.disableModelInvocation).toBe(true);
    expect(skills[0]?.argumentHint).toBe('<target>');
  });

  it('skips a skill with no description and empty body, emits a diagnostic', () => {
    const skillsDir = path.join(tmpProject, '.umbra', 'skills');
    // Empty body means no fallback description — skill must be skipped
    createSkillFile(skillsDir, 'broken', 'name: broken', '');

    const { skills, diagnostics } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills).toHaveLength(0);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toMatch(/description/);
  });

  it('uses first body line as description fallback when frontmatter has no description', () => {
    const skillsDir = path.join(tmpProject, '.umbra', 'skills');
    createSkillFile(skillsDir, 'fallback', 'name: fallback', 'Do something useful here');

    const { skills } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('Do something useful here');
  });

  it('parses SKILL.md with indented frontmatter delimiters (editor-added spaces)', () => {
    const skillsDir = path.join(tmpProject, '.umbra', 'skills');
    const skillDir = path.join(skillsDir, 'greet');
    fs.mkdirSync(skillDir, { recursive: true });
    // Simulate file saved with leading spaces on every line (e.g. from certain editors)
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '  ---\n  name: greet\n  description: Greet someone by name\n  argument-hint: <name>\n  ---\n  Hello, $1!',
      'utf8',
    );

    const { skills } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('greet');
    expect(skills[0]?.description).toBe('Greet someone by name');
    expect(skills[0]?.argumentHint).toBe('<name>');
  });

  it('loads multiple skills from the same directory', () => {
    const skillsDir = path.join(tmpProject, '.umbra', 'skills');
    createSkillFile(skillsDir, 'skill-a', 'name: skill-a\ndescription: Skill A.', 'Body A');
    createSkillFile(skillsDir, 'skill-b', 'name: skill-b\ndescription: Skill B.', 'Body B');

    const { skills } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b']);
  });
});

// ---------------------------------------------------------------------------
// substituteArgs
// ---------------------------------------------------------------------------

describe('substituteArgs', () => {
  it('replaces $1, $2 with positional args', () => {
    expect(substituteArgs('Deploy $1 to $2', ['app', 'prod'])).toBe('Deploy app to prod');
  });

  it('replaces $ARGUMENTS with all args joined', () => {
    expect(substituteArgs('Run: $ARGUMENTS', ['a', 'b', 'c'])).toBe('Run: a b c');
  });

  it('replaces $@ with all args joined', () => {
    expect(substituteArgs('All: $@', ['x', 'y'])).toBe('All: x y');
  });

  it('replaces ${@:N} with slice starting at N', () => {
    expect(substituteArgs('From 2: ${@:2}', ['first', 'second', 'third'])).toBe(
      'From 2: second third',
    );
  });

  it('replaces ${@:N:L} with L items starting at N', () => {
    expect(substituteArgs('Slice: ${@:2:2}', ['a', 'b', 'c', 'd'])).toBe('Slice: b c');
  });

  it('returns empty string for missing positional arg', () => {
    expect(substituteArgs('$3', ['only-one'])).toBe('');
  });

  it('does not recursively substitute values', () => {
    expect(substituteArgs('$ARGUMENTS', ['$1', '$ARGUMENTS'])).toBe('$1 $ARGUMENTS');
  });
});

// ---------------------------------------------------------------------------
// parseCommandArgs
// ---------------------------------------------------------------------------

describe('parseCommandArgs', () => {
  it('splits simple space-separated args', () => {
    expect(parseCommandArgs('foo bar baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('respects double-quoted strings', () => {
    expect(parseCommandArgs('"hello world" single')).toEqual(['hello world', 'single']);
  });

  it('respects single-quoted strings', () => {
    expect(parseCommandArgs("'a b' c")).toEqual(['a b', 'c']);
  });

  it('returns empty array for empty input', () => {
    expect(parseCommandArgs('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatSkillsForPrompt
// ---------------------------------------------------------------------------

describe('formatSkillsForPrompt', () => {
  it('returns empty string when no skills', () => {
    expect(formatSkillsForPrompt([])).toBe('');
  });

  it('omits skills with disableModelInvocation', () => {
    const skills = [
      {
        name: 'visible',
        description: 'Visible skill.',
        content: '',
        filePath: '/skills/visible/SKILL.md',
        disableModelInvocation: false,
        source: 'project' as const,
      },
      {
        name: 'hidden',
        description: 'Hidden skill.',
        content: '',
        filePath: '/skills/hidden/SKILL.md',
        disableModelInvocation: true,
        source: 'project' as const,
      },
    ];

    const output = formatSkillsForPrompt(skills);
    expect(output).toContain('visible');
    expect(output).not.toContain('hidden');
  });

  it('generates valid XML-like output with skill metadata', () => {
    const skills = [
      {
        name: 'deploy',
        description: 'Deploy app.',
        content: '',
        filePath: '/skills/deploy/SKILL.md',
        disableModelInvocation: false,
        source: 'project' as const,
      },
    ];

    const output = formatSkillsForPrompt(skills);
    expect(output).toContain('<available_skills>');
    expect(output).toContain('<name>deploy</name>');
    expect(output).toContain('<description>Deploy app.</description>');
    expect(output).toContain('</available_skills>');
  });
});

// ---------------------------------------------------------------------------
// createSkill
// ---------------------------------------------------------------------------

describe('createSkill', () => {
  it('creates .umbra/skills/<name>/SKILL.md with correct frontmatter', () => {
    const result = createSkill('my-skill "Does something useful"', tmpProject);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.name).toBe('my-skill');
    const filePath = path.join(tmpProject, '.umbra', 'skills', 'my-skill', 'SKILL.md');
    expect(result.filePath).toBe(filePath);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('name: my-skill');
    expect(content).toContain('description: Does something useful');
  });

  it('creates parent directories if they do not exist', () => {
    const result = createSkill('brand-new "Brand new skill"', tmpProject);
    expect(result.ok).toBe(true);
    const dir = path.join(tmpProject, '.umbra', 'skills', 'brand-new');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('uses name as description fallback when description omitted', () => {
    const result = createSkill('quick-cmd', tmpProject);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toContain('description: quick-cmd skill');
  });

  it('returns error when skill with same name already exists', () => {
    createSkill('dupe "First creation"', tmpProject);
    const result = createSkill('dupe "Second creation"', tmpProject);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already exists/);
  });

  it('returns error when no name is provided', () => {
    const result = createSkill('', tmpProject);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Usage/);
  });

  it('returns error when name is invalid', () => {
    const result = createSkill('Invalid_Name "desc"', tmpProject);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Invalid skill name/);
  });

  it('created skill is immediately loadable', () => {
    createSkill('loadable "Loadable skill test"', tmpProject);
    const { skills } = loadSkills({ projectPath: tmpProject, umbraHome: tmpHome });
    expect(skills.some((s) => s.name === 'loadable')).toBe(true);
  });
});
