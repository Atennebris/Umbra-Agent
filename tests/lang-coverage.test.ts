import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRepoMap } from '../src/context/repo-map.js';

const LANG_FIXTURES = path.resolve(__dirname, 'fixtures/lang-coverage');
const REPO_MAP_FIXTURES = path.resolve(__dirname, 'fixtures/repo-map-project');

describe('Language Coverage — full_ast (tree-sitter)', () => {
  it('parses JavaScript (.js)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.js'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('javascript');
    expect(file?.parser).toBe('tree-sitter');
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('loadConfig');
    expect(names).toContain('ConfigManager');
  }, 15000);

  it('parses TSX (.tsx)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.tsx'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('tsx');
    expect(file?.parser).toBe('tree-sitter');
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('Button');
    expect(names).toContain('WidgetManager');
  }, 15000);

  it('parses Go (.go)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.go'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('go');
    expect(file?.parser).toBe('tree-sitter');
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('NewServer');
    expect(names).toContain('main');
  }, 15000);

  it('parses Shell/Bash (.sh)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.sh'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('bash');
    expect(file?.parser).toBe('tree-sitter');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('build_project');
    expect(names).toContain('run_checks');
    expect(names).toContain('deploy');
  }, 15000);

  it('parses Rust (.rs)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.rs'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('rust');
    expect(file?.parser).toBe('tree-sitter');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('Config');
    expect(names).toContain('load_config');
    expect(names).toContain('AppError');
  }, 15000);

  it('parses Java (.java)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.java'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('java');
    expect(file?.parser).toBe('tree-sitter');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('Sample');
    expect(names).toContain('Status');
  }, 15000);

  it('parses C# (.cs) — full strong support: class/interface/struct/enum/record/delegate + constructor/destructor/property/field/event/operator', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.cs'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('csharp');
    expect(file?.parser).toBe('tree-sitter');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // Core types
    expect(names).toContain('DaemonService');
    expect(names).toContain('IService');
    expect(names).toContain('DaemonState');
    expect(names).toContain('Config');
    // Strong C# support
    expect(kinds).toContain('constructor_declaration');
    expect(kinds).toContain('destructor_declaration');
    expect(kinds).toContain('property_declaration');
    expect(kinds).toContain('field_declaration');
    expect(kinds).toContain('record_declaration');
    expect(kinds).toContain('delegate_declaration');
    expect(kinds).toContain('event_field_declaration');
    // Imports
    expect(file?.imports.length).toBeGreaterThan(0);
    expect(file?.imports).toContain('using System;');
  }, 15000);

  it('parses PHP (.php)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.php'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('php');
    expect(file?.parser).toBe('tree-sitter');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('DaemonService');
  }, 15000);

  it('parses Ruby (.rb)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.rb'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('ruby');
    expect(file?.parser).toBe('tree-sitter');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('DaemonClient');
  }, 15000);

  it('parses CSS (.css)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.css'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('css');
    expect(file?.parser).toBe('tree-sitter');
    expect(file?.symbols.length).toBeGreaterThan(0);
  }, 15000);

  it('parses PowerShell (.ps1)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.ps1'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('powershell');
    expect(file?.parser).toBe('tree-sitter');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('Build-Project');
    expect(names).toContain('Run-Tests');
    expect(names).toContain('Deploy-ToEnvironment');
  }, 15000);

  it('parses INI (.ini)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.ini'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('ini');
    expect(file?.parser).toBe('tree-sitter');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const names = file?.symbols.map((s) => s.name);
    // INI tree-sitter wraps section names in brackets: [daemon], [database]
    expect(names.some((n) => n.includes('daemon'))).toBe(true);
    expect(names.some((n) => n.includes('database'))).toBe(true);
    expect(names.some((n) => n.includes('provider'))).toBe(true);
  }, 15000);

  it('parses TypeScript (.ts) (existing fixture)', async () => {
    const map = await buildRepoMap(REPO_MAP_FIXTURES);
    const tsFiles = map.files.filter((f) => f.language === 'typescript');
    expect(tsFiles.length).toBeGreaterThan(0);
    expect(tsFiles[0]?.parser).toBe('tree-sitter');
  }, 15000);

  it('parses Python (.py) (existing fixture)', async () => {
    const map = await buildRepoMap(REPO_MAP_FIXTURES);
    const pyFile = map.files.find((f) => f.language === 'python');
    expect(pyFile).toBeDefined();
    expect(pyFile?.parser).toBe('tree-sitter');
    expect(pyFile?.symbols.length).toBeGreaterThan(0);
  }, 15000);

  it('parses GML (.gml) (existing fixture)', async () => {
    const map = await buildRepoMap(REPO_MAP_FIXTURES);
    const gmlFile = map.files.find((f) => f.language === 'gml');
    expect(gmlFile).toBeDefined();
    expect(gmlFile?.parser).toBe('gml-parser');
    expect(gmlFile?.symbols.length).toBeGreaterThan(0);
  }, 15000);
});

describe('Language Coverage — structured parsers (JSON / YAML / Markdown / SQL)', () => {
  it('parses JSON (.json) — extracts top-level keys as symbols', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.json'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('json');
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('name');
    expect(names).toContain('version');
    expect(names).toContain('features');
  }, 15000);

  it('parses YAML (.yaml) — extracts top-level keys as symbols', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.yaml'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('yaml');
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('version');
    expect(names).toContain('services');
    expect(names).toContain('volumes');
  }, 15000);

  it('parses Markdown (.md) — extracts headings as symbols', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.md'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('markdown');
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('Umbra CLI Notes');
    expect(names).toContain('Architecture');
    expect(names).toContain('Context Engine');
  }, 15000);

  it('parses SQL (.sql) — extracts CREATE statements as symbols', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.sql'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('sql');
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('users');
    expect(names).toContain('sessions');
    expect(names).toContain('active_sessions');
    expect(names).toContain('get_user_count');
    const kinds = file?.symbols.map((s) => s.kind);
    expect(kinds).toContain('table');
    expect(kinds).toContain('view');
    expect(kinds).toContain('function');
  }, 15000);
});

describe('Language Coverage — C/C++ full_ast (tree-sitter cpp grammar)', () => {
  it('parses C++ (.cpp) via tree-sitter cpp grammar', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.cpp'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('cpp');
    expect(file?.parser).toBe('tree-sitter');
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('Server');
    expect(names).toContain('Config');
    expect(names).toContain('main');
    expect(names).toContain('clamp');
  }, 15000);
});

describe('Language Coverage — new structured parsers', () => {
  it('parses TOML (.toml) — sections and keys', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.toml'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('toml');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names?.some((n) => n.includes('daemon'))).toBe(true);
    expect(kinds).toContain('section');
  }, 10000);

  it('parses Dockerfile — stages, ports, args', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.includes('Dockerfile'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('dockerfile');
    const kinds = file?.symbols.map((s) => s.kind);
    expect(kinds).toContain('port');
    expect(kinds).toContain('arg');
  }, 10000);

  it('parses Makefile — targets and variables', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.includes('Makefile'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('makefile');
    const names = file?.symbols.map((s) => s.name);
    expect(names).toContain('build');
    expect(names).toContain('test');
    expect(names).toContain('clean');
  }, 10000);

  it('parses CMakeLists.txt — executables, libraries, functions', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.includes('CMakeLists.txt'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('cmake');
    const kinds = file?.symbols.map((s) => s.kind);
    expect(kinds).toContain('executable');
    expect(kinds).toContain('library');
    expect(kinds).toContain('function');
  }, 10000);

  it('parses GraphQL (.graphql) — types, queries, mutations', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.graphql'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('graphql');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('User');
    expect(names).toContain('Query');
    expect(names).toContain('Mutation');
    expect(kinds).toContain('type');
    expect(kinds).toContain('enum');
  }, 10000);

  it('parses Protobuf (.proto) — messages, services, rpcs', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.proto'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('protobuf');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('Session');
    expect(names).toContain('SessionService');
    expect(kinds).toContain('message');
    expect(kinds).toContain('service');
    expect(kinds).toContain('rpc');
  }, 10000);

  it('parses Terraform (.tf) — resources, variables, outputs', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.tf'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('terraform');
    const kinds = file?.symbols.map((s) => s.kind);
    expect(kinds).toContain('resource');
    expect(kinds).toContain('variable');
    expect(kinds).toContain('output');
    expect(kinds).toContain('module');
  }, 10000);

  it('parses Prisma (.prisma) — models, enums, datasource', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.prisma'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('prisma');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('User');
    expect(names).toContain('Session');
    expect(names).toContain('Message');
    expect(kinds).toContain('model');
    expect(kinds).toContain('enum');
  }, 10000);

  it('parses Solidity (.sol) — contracts, functions, events', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.sol'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('solidity');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('UmbraToken');
    expect(kinds).toContain('contract');
    expect(kinds).toContain('function');
    expect(kinds).toContain('event');
  }, 10000);

  it('parses Zig (.zig) — functions, structs, enums', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.zig'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('zig');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('startServer');
    expect(names).toContain('Config');
    expect(kinds).toContain('function');
    expect(kinds).toContain('struct');
  }, 10000);

  it('parses Dart (.dart) — classes, functions, imports', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.dart'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('dart');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('DaemonService');
    expect(kinds).toContain('class');
    expect(file?.imports.length).toBeGreaterThan(0);
  }, 10000);

  it('parses Kotlin (.kt) — classes, functions, interfaces', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.kt'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('kotlin');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('Config');
    expect(names).toContain('UmbraDaemon');
    expect(kinds).toContain('class');
    expect(file?.imports.length).toBeGreaterThan(0);
  }, 10000);

  it('parses Swift (.swift) — classes, structs, protocols', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.swift'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('swift');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('UmbraDaemon');
    expect(names).toContain('Config');
    expect(kinds).toContain('class');
    expect(kinds).toContain('struct');
    expect(file?.imports.length).toBeGreaterThan(0);
  }, 10000);

  it('parses Lua (.lua) — functions, modules', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.lua'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('lua');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('M.read_config');
    expect(kinds).toContain('function');
  }, 10000);

  it('parses Scala (.scala) — classes, objects, traits', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.scala'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('scala');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('Config');
    expect(names).toContain('UmbraDaemon');
    expect(kinds).toContain('class');
    expect(kinds).toContain('trait');
    expect(file?.imports.length).toBeGreaterThan(0);
  }, 10000);

  it('parses Elixir (.ex) — defmodule, def, defp', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.ex'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('elixir');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names?.some((n) => n.includes('Umbra'))).toBe(true);
    expect(kinds).toContain('module');
  }, 10000);

  it('parses Erlang (.erl) — module, functions, exports', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.erl'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('erlang');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('umbra_daemon');
    expect(kinds).toContain('module');
    expect(kinds).toContain('function');
  }, 10000);

  it('parses Haskell (.hs) — module, data types, functions', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.hs'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('haskell');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names?.some((n) => n.includes('Umbra'))).toBe(true);
    expect(kinds).toContain('module');
    expect(kinds).toContain('data');
    expect(file?.imports.length).toBeGreaterThan(0);
  }, 10000);

  it('parses Perl (.pl) — packages, subs', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.pl'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('perl');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names?.some((n) => n.includes('Umbra'))).toBe(true);
    expect(kinds).toContain('package');
    expect(kinds).toContain('sub');
    expect(file?.imports.length).toBeGreaterThan(0);
  }, 10000);

  it('parses R (.r) — functions, classes', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.r'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('r');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('load_session_data');
    expect(names).toContain('compute_stats');
    expect(kinds).toContain('function');
    expect(file?.imports.length).toBeGreaterThan(0);
  }, 10000);

  it('parses Clojure (.clj) — ns, defn, def', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.clj'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('clojure');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names?.some((n) => n.includes('umbra'))).toBe(true);
    expect(kinds).toContain('namespace');
    expect(kinds).toContain('function');
  }, 10000);

  it('parses Vue (.vue) — component name from filename', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.vue'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('vue');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('App');
    expect(kinds).toContain('component');
  }, 10000);

  it('parses Svelte (.svelte) — component name and exports', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.svelte'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('svelte');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('App');
    expect(kinds).toContain('component');
  }, 10000);

  it('parses Astro (.astro) — component name and frontmatter', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.astro'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('astro');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('Page');
    expect(kinds).toContain('component');
  }, 10000);

  it('parses XML (.xml) — element tags and id attributes', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.xml'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('xml');
    const kinds = file?.symbols.map((s) => s.kind);
    expect(kinds).toContain('element');
  }, 10000);

  it('parses Gradle (.gradle) — tasks, plugins, dependencies', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.gradle'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('gradle');
    const kinds = file?.symbols.map((s) => s.kind);
    expect(kinds).toContain('task');
  }, 10000);

  it('parses .env files — config keys (values redacted)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.env'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('env');
    const names = file?.symbols.map((s) => s.name);
    const sigs = file?.symbols.map((s) => s.signature);
    expect(names).toContain('UMBRA_HOST');
    expect(names).toContain('UMBRA_PORT');
    expect(sigs?.every((sig) => !sig.includes('placeholder'))).toBe(true);
  }, 10000);

  it('parses .log files — extracts errors and warnings', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.log'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('log');
    const kinds = file?.symbols.map((s) => s.kind);
    expect(kinds).toContain('error');
    expect(kinds).toContain('warn');
  }, 10000);

  it('parses GML (.gml) — full GML 2.3 support: function, constructor, macro, enum, globalvar', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.gml'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('gml');
    expect(file?.parser).toBe('gml-parser');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // Regular functions
    expect(names).toContain('scr_init_game');
    expect(names).toContain('get_high_score');
    expect(kinds).toContain('function');
    // GML 2.3 constructors (OOP)
    expect(names).toContain('Entity');
    expect(names).toContain('Player');
    expect(kinds).toContain('constructor');
    // Macros
    expect(names).toContain('SCREEN_WIDTH');
    expect(kinds).toContain('macro');
    // Enums
    expect(names).toContain('GameState');
    expect(names).toContain('Direction');
    expect(kinds).toContain('enum');
    // Globalvar declarations
    expect(names).toContain('global_debug_mode');
    expect(kinds).toContain('globalvar');
  }, 15000);

  it('parses MATLAB (.m) — classdef, function, section, properties/methods blocks', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.m'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('matlab');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // classdef
    expect(names).toContain('UmbraAnalytics');
    expect(kinds).toContain('class');
    // functions (both class methods and script-level)
    expect(names).toContain('load_session_data');
    expect(names).toContain('compute_stats');
    expect(names).toContain('normalize_data');
    expect(names).toContain('compute_distribution');
    expect(kinds).toContain('function');
    // section markers (%%)
    expect(kinds).toContain('section');
    // class blocks
    expect(kinds).toContain('block');
  }, 10000);

  it('parses GDScript (.gd) — class_name, func, signal, enum, const, var', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.gd'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('gdscript');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // class_name
    expect(names).toContain('UmbraPlayer');
    expect(kinds).toContain('class');
    // func
    expect(names).toContain('jump');
    expect(names).toContain('die');
    expect(kinds).toContain('function');
    // signal (Godot-specific)
    expect(names).toContain('player_died');
    expect(kinds).toContain('signal');
    // enum
    expect(names).toContain('State');
    expect(kinds).toContain('enum');
    // const
    expect(names).toContain('MAX_SPEED');
    expect(kinds).toContain('const');
    // extends → import
    expect(file?.imports).toContain('CharacterBody2D');
  }, 10000);

  it('parses WebAssembly Text Format (.wat) — func, global, memory, table, export, import, type', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.wat'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('webassembly');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // Named functions
    expect(names).toContain('$add');
    expect(names).toContain('$factorial');
    expect(names).toContain('$counter');
    expect(kinds).toContain('func');
    // Globals
    expect(names).toContain('$counter');
    expect(kinds).toContain('global');
    // Module resources
    expect(kinds).toContain('memory');
    expect(kinds).toContain('table');
    // Exports
    expect(kinds).toContain('export');
    // Types
    expect(names).toContain('$fn_unary');
    expect(kinds).toContain('type');
    // Imports
    expect(file?.imports.length).toBeGreaterThan(0);
    expect(file?.imports.some((imp) => imp.includes('env'))).toBe(true);
  }, 10000);

  it('parses x86-64 Assembly (.asm) — global labels, sections, macros, constants, externs', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.asm'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('asm');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // Exported global labels
    expect(names).toContain('_start');
    expect(names).toContain('umbra_init');
    expect(names).toContain('umbra_run');
    expect(names).toContain('task_push');
    expect(names).toContain('task_pop');
    expect(kinds).toContain('global');
    // Section markers
    expect(kinds).toContain('section');
    // NASM macros
    expect(names).toContain('PUSH_CALLEE_SAVED');
    expect(names).toContain('POP_CALLEE_SAVED');
    expect(kinds).toContain('macro');
    // Constants
    expect(kinds).toContain('const');
    // Labels (function bodies)
    expect(kinds).toContain('label');
    // Extern imports
    expect(file?.imports.length).toBeGreaterThan(0);
    expect(file?.imports).toContain('malloc');
  }, 10000);
});

describe('Language Coverage — HTML (audit gap fix)', () => {
  it('parses HTML (.html) — IDs, landmarks, script/style blocks', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.html'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('html');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // IDs
    expect(names).toContain('site-header');
    expect(names).toContain('app-root');
    expect(names).toContain('prompt-form');
    expect(kinds).toContain('id');
    // Landmarks
    expect(kinds).toContain('landmark');
    // Script/style blocks (kind: 'block' per parser)
    expect(kinds).toContain('block');
  }, 10000);
});

describe('Language Coverage — new format parsers (GitHub Actions / Nix / Jupyter / Lockfiles)', () => {
  it('parses GitHub Actions YAML (ci.yml) — workflow, triggers, jobs, action imports', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('ci.yml'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('github-actions');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // Workflow name
    expect(names).toContain('Umbra CI');
    expect(kinds).toContain('workflow');
    // Triggers
    expect(kinds).toContain('trigger');
    expect(names).toContain('push');
    expect(names).toContain('pull_request');
    // Jobs
    expect(kinds).toContain('job');
    expect(names).toContain('lint');
    expect(names).toContain('test');
    // Action imports (uses: actions/checkout@v4 → actions/checkout)
    expect(file?.imports.length).toBeGreaterThan(0);
    expect(file?.imports.some((imp) => imp.includes('actions/checkout'))).toBe(true);
  }, 10000);

  it('parses Nix (.nix) — derivations, top-level attrs, imports', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.nix'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('nix');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // Top-level attrs
    expect(names).toContain('umbraCli');
    expect(names).toContain('devShell');
    expect(names).toContain('testRunner');
    // mkDerivation entries get 'derivation' or 'attr' kind
    expect(kinds.some((k) => k === 'derivation' || k === 'attr')).toBe(true);
    // import <nixpkgs>
    expect(file?.imports.length).toBeGreaterThan(0);
    expect(file?.imports.some((imp) => imp.includes('nixpkgs'))).toBe(true);
  }, 10000);

  it('parses Jupyter Notebook (.ipynb) — kernel, headings, functions, classes, imports', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.ipynb'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('jupyter');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    // Kernel
    expect(kinds).toContain('kernel');
    expect(names).toContain('Python 3');
    // Markdown headings
    expect(names).toContain('Umbra Session Analysis');
    expect(names).toContain('Data Loading');
    // Code: functions and classes
    expect(names).toContain('load_sessions');
    expect(names).toContain('compute_token_stats');
    expect(names).toContain('ModelUsageAnalyzer');
    expect(kinds).toContain('function');
    expect(kinds).toContain('class');
    // Python imports
    expect(file?.imports).toContain('numpy');
    expect(file?.imports).toContain('pandas');
  }, 10000);

  it('parses yarn.lock — package names + versions', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('yarn.lock'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('yarn-lock');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('better-sqlite3');
    expect(names).toContain('react');
    expect(names).toContain('typescript');
    expect(kinds.every((k) => k === 'package')).toBe(true);
    expect(file?.symbols.length).toBeGreaterThan(3);
  }, 10000);

  it('parses Cargo.lock — Rust crate names + versions', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('Cargo.lock'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('cargo-lock');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('umbra-core');
    expect(names).toContain('anyhow');
    expect(names).toContain('serde');
    expect(names).toContain('tokio');
    expect(kinds.every((k) => k === 'crate')).toBe(true);
  }, 10000);

  it('parses Gemfile.lock — Ruby gem names + versions', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('Gemfile.lock'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('gemfile-lock');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('rails');
    expect(names).toContain('devise');
    expect(names).toContain('pg');
    expect(names).toContain('sidekiq');
    expect(kinds.every((k) => k === 'gem')).toBe(true);
  }, 10000);

  it('parses composer.lock — PHP package names + versions (JSON format)', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('composer.lock'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('composer-lock');
    const names = file?.symbols.map((s) => s.name);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(names).toContain('laravel/framework');
    expect(names).toContain('guzzlehttp/guzzle');
    expect(names).toContain('phpunit/phpunit');
    expect(kinds.every((k) => k === 'package')).toBe(true);
  }, 10000);
});

describe('Language Coverage — Documents (PDF / DOCX)', () => {
  it('parses PDF (.pdf) — extracts text and headings via pdf-parse', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.pdf'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('pdf');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(kinds?.some((k) => k === 'heading' || k === 'paragraph')).toBe(true);
  }, 15000);

  it('parses DOCX (.docx) — extracts headings and paragraphs from word/document.xml', async () => {
    const map = await buildRepoMap(LANG_FIXTURES);
    const file = map.files.find((f) => f.path.endsWith('.docx'));
    expect(file).toBeDefined();
    expect(file?.language).toBe('docx');
    expect(file?.symbols.length).toBeGreaterThan(0);
    const kinds = file?.symbols.map((s) => s.kind);
    expect(kinds).toContain('heading');
    expect(kinds).toContain('paragraph');
  }, 10000);
});
