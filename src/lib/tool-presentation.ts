import type { ToolActivity } from './activity';
import { relativeFilePath } from './file-changes';

/** Icons of tool calls, drawn by ToolIcon. */
export type ToolIconKey =
  | 'git'
  | 'pullRequest'
  | 'package'
  | 'test'
  | 'build'
  | 'lint'
  | 'server'
  | 'script'
  | 'container'
  | 'network'
  | 'remote'
  | 'list'
  | 'read'
  | 'search'
  | 'delete'
  | 'create'
  | 'move'
  | 'process'
  | 'wait'
  | 'write'
  | 'agentCli'
  | 'terminal'
  | 'file'
  | 'code'
  | 'image'
  | 'edit'
  | 'newFile'
  | 'notebook'
  | 'component'
  | 'markup'
  | 'style'
  | 'data'
  | 'config'
  | 'shell'
  | 'database'
  | 'spreadsheet'
  | 'font'
  | 'archive'
  | 'lock'
  | 'media'
  | 'binary'
  | 'findFiles'
  | 'grep'
  | 'web'
  | 'page'
  | 'skill'
  | 'agent'
  | 'message'
  | 'directory'
  | 'toolSearch'
  | 'plug'
  | 'browser'
  | 'screenshot'
  | 'monitor'
  | 'waitTasks'
  | 'plan'
  | 'question'
  | 'workflow'
  | 'chart'
  | 'hook'
  | 'background'
  | 'tool';

export type CommandKind = Extract<
  ToolIconKey,
  | 'git'
  | 'pullRequest'
  | 'package'
  | 'test'
  | 'build'
  | 'lint'
  | 'server'
  | 'script'
  | 'container'
  | 'network'
  | 'remote'
  | 'list'
  | 'read'
  | 'search'
  | 'delete'
  | 'create'
  | 'move'
  | 'process'
  | 'wait'
  | 'write'
  | 'agentCli'
  | 'terminal'
>;

// A line a CLI hook put before the model's command: a script under a hooks folder.
const hookLine =
  /^(?:&\s*)?["']?(?:node|python3?|py|pwsh|powershell|bash|sh|deno|bun)(?:\.exe)?["']?\s+["']?[^"'\s]*[\\/]hooks?[\\/]/i;

/**
 * The line that best names a command: its first non-empty line, after lines a CLI hook
 * prepended to run a script from a hooks folder. `more` tells whether other lines follow.
 */
export function primaryCommand(command: string): { line: string; more: boolean } {
  const lines = command.split(/\r?\n/).map((line) => line.trim());
  let index = lines.findIndex((line) => line && !hookLine.test(line));
  if (index < 0) index = lines.findIndex(Boolean);
  if (index < 0) return { line: '', more: false };
  return { line: lines[index], more: lines.slice(index + 1).some(Boolean) };
}

/** Statements of a shell line, split at `;`, `&&`, `||` and `|` outside quotes. */
function statements(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ';' || c === '|' || (c === '&' && line[i + 1] === '&')) {
      if (current.trim()) result.push(current.trim());
      current = '';
      if (line[i + 1] === c) i++;
    } else current += c;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}
function words(statement: string): string[] {
  return [...statement.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}
const executable = (word: string) =>
  (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

// Statements that only prepare the next one, like changing folder or setting a variable.
const setup = new Set([
  'cd',
  'set-location',
  'sl',
  'chdir',
  'pushd',
  'popd',
  'export',
  'set',
  'source',
  '.',
  'clear',
  'cls',
]);
const printing = new Set(['echo', 'write-host', 'write-output', 'printf']);

function scriptKind(name = ''): CommandKind {
  const script = name.toLowerCase();
  if (/^(test|e2e|spec|vitest|jest|playwright|cypress)/.test(script)) return 'test';
  if (/^(build|compile|check|verify|typecheck|type-check|tsc|svelte-check|bundle)/.test(script))
    return 'build';
  if (/^(lint|format|fmt|prettier|eslint|stylelint)/.test(script)) return 'lint';
  if (/^(dev|start|serve|preview|watch)/.test(script)) return 'server';
  return 'script';
}
function toolKind(tool: string, rest: string[]): CommandKind {
  switch (executable(tool)) {
    case 'vitest':
    case 'jest':
    case 'mocha':
    case 'pytest':
    case 'ava':
    case 'cypress':
      return 'test';
    case 'playwright':
      return rest[0] === 'test' ? 'test' : 'script';
    case 'tsc':
    case 'svelte-check':
    case 'svelte-kit':
    case 'webpack':
    case 'rollup':
    case 'esbuild':
    case 'turbo':
      return 'build';
    case 'vite':
      return rest[0] === 'build' ? 'build' : 'server';
    case 'eslint':
    case 'prettier':
    case 'stylelint':
    case 'biome':
      return 'lint';
    case 'tauri':
      return rest[0] === 'dev' ? 'server' : 'build';
    default:
      return 'script';
  }
}

const assignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

/** What a shell command does, judged from its first meaningful program and arguments. */
export function commandKind(command: string): CommandKind {
  // Live replies re-render their group rows on every streamed event.
  let kind = classified.get(command);
  if (!kind) {
    kind = classify(command);
    if (classified.size >= 500) classified.delete(classified.keys().next().value!);
    classified.set(command, kind);
  }
  return kind;
}
const classified = new Map<string, CommandKind>();
function classify(command: string): CommandKind {
  const all = statements(primaryCommand(command).line);
  let list = all.filter((s) => {
    const parts = words(s);
    return (
      !setup.has(executable(parts[0] ?? '')) &&
      !parts[0]?.startsWith('$env:') &&
      !parts.every(assignment)
    );
  });
  if (list.length > 1) list = list.filter((s) => !printing.has(executable(words(s)[0] ?? '')));
  let args = words(list[0] ?? all[0] ?? '');
  // Wrappers that run the command that follows them.
  for (;;) {
    const first = executable(args[0] ?? '');
    if (['&', 'sudo', 'time', 'env', 'nohup', 'exec', 'command'].includes(first))
      args = args.slice(1);
    else if (first === 'timeout' && /^\d+[smh]?$/.test(args[1] ?? '')) args = args.slice(2);
    else if (assignment(args[0] ?? '')) args = args.slice(1);
    else break;
  }
  const program = executable(args[0] ?? '');
  const [, sub, third] = args.map((a) => a.toLowerCase());
  switch (program) {
    case '':
      return 'terminal';
    case 'git':
      return sub === 'grep' ? 'search' : 'git';
    case 'gh':
      return 'pullRequest';
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      if (sub === undefined) return 'package';
      if (['run', 'run-script'].includes(sub)) return scriptKind(third);
      if (['test', 't', 'tst'].includes(sub)) return 'test';
      if (['start'].includes(sub)) return 'server';
      if (['exec', 'dlx', 'x'].includes(sub))
        return toolKind(args.slice(2).find((a) => !a.startsWith('-')) ?? '', args.slice(3));
      if (
        [
          'install',
          'i',
          'ci',
          'add',
          'remove',
          'rm',
          'uninstall',
          'update',
          'upgrade',
          'up',
          'outdated',
          'audit',
          'ls',
          'list',
          'why',
          'rebuild',
          'dedupe',
          'prune',
          'link',
          'pack',
          'publish',
          'version',
          'view',
          'info',
        ].includes(sub)
      )
        return 'package';
      // `yarn build` and `pnpm lint` run package scripts directly.
      return program === 'npm' ? 'package' : scriptKind(sub);
    }
    case 'npx':
    case 'bunx':
    case 'pnpx': {
      const index = args.findIndex((a, i) => i > 0 && !a.startsWith('-'));
      return index < 0 ? 'script' : toolKind(args[index], args.slice(index + 1));
    }
    case 'node':
    case 'deno':
    case 'tsx':
    case 'ts-node':
      return args.includes('--test') || sub === 'test' ? 'test' : 'script';
    case 'python':
    case 'python3':
    case 'py':
      if (sub === '-m' && third === 'pytest') return 'test';
      if (sub === '-m' && third === 'pip') return 'package';
      if (sub === '-m' && third === 'http.server') return 'server';
      return 'script';
    case 'pip':
    case 'pip3':
    case 'pipx':
    case 'poetry':
    case 'conda':
    case 'winget':
    case 'choco':
    case 'scoop':
    case 'brew':
    case 'apt':
    case 'apt-get':
    case 'rustup':
      return 'package';
    case 'uv':
      return sub === 'run' ? toolKind(third ?? '', args.slice(3)) : 'package';
    case 'cargo':
      if (['test', 'nextest', 'bench'].includes(sub)) return 'test';
      if (['clippy', 'fmt'].includes(sub)) return 'lint';
      if (['add', 'install', 'remove', 'update', 'uninstall'].includes(sub)) return 'package';
      if (sub === 'run') return 'script';
      return 'build';
    case 'go':
      if (sub === 'test') return 'test';
      if (['mod', 'get', 'install'].includes(sub)) return 'package';
      if (sub === 'run') return 'script';
      return 'build';
    case 'dotnet':
      if (sub === 'test') return 'test';
      if (sub === 'run') return 'script';
      if (sub === 'add') return 'package';
      return 'build';
    case 'mvn':
    case 'gradle':
    case 'gradlew':
      return args.includes('test') ? 'test' : 'build';
    case 'make':
    case 'cmake':
    case 'ninja':
    case 'msbuild':
    case 'rustc':
    case 'gcc':
    case 'g++':
    case 'clang':
    case 'javac':
      return 'build';
    case 'ruff':
    case 'black':
    case 'rustfmt':
    case 'clang-format':
    case 'gofmt':
      return 'lint';
    case 'docker':
    case 'docker-compose':
    case 'podman':
    case 'kubectl':
    case 'helm':
      return 'container';
    case 'curl':
    case 'wget':
    case 'invoke-webrequest':
    case 'iwr':
    case 'invoke-restmethod':
    case 'irm':
    case 'http':
    case 'xh':
      return 'network';
    case 'ssh':
    case 'scp':
    case 'rsync':
    case 'sftp':
      return 'remote';
    case 'ls':
    case 'dir':
    case 'll':
    case 'get-childitem':
    case 'gci':
    case 'tree':
    case 'du':
    case 'stat':
    case 'get-item':
    case 'gi':
    case 'get-itemproperty':
    case 'test-path':
    case 'pwd':
    case 'get-location':
    case 'which':
    case 'where':
    case 'get-command':
    case 'gcm':
    case 'resolve-path':
    case 'realpath':
    case 'wc':
    case 'file':
      return 'list';
    case 'cat':
    case 'type':
    case 'get-content':
    case 'gc':
    case 'head':
    case 'tail':
    case 'less':
    case 'more':
    case 'bat':
    case 'nl':
    case 'awk':
    case 'jq':
      return 'read';
    case 'sed':
      return args.some((a) => /^-i/.test(a)) ? 'write' : 'read';
    case 'grep':
    case 'egrep':
    case 'rg':
    case 'findstr':
    case 'select-string':
    case 'sls':
    case 'ag':
    case 'ack':
    case 'find':
    case 'fd':
    case 'locate':
      return 'search';
    case 'rm':
    case 'del':
    case 'erase':
    case 'rmdir':
    case 'rd':
    case 'remove-item':
    case 'ri':
      return 'delete';
    case 'mkdir':
    case 'md':
    case 'new-item':
    case 'ni':
    case 'touch':
      return 'create';
    case 'cp':
    case 'copy':
    case 'copy-item':
    case 'cpi':
    case 'xcopy':
    case 'robocopy':
    case 'mv':
    case 'move':
    case 'move-item':
    case 'mi':
    case 'rename-item':
    case 'ren':
    case 'rni':
    case 'ln':
      return 'move';
    case 'set-content':
    case 'sc':
    case 'add-content':
    case 'ac':
    case 'out-file':
    case 'tee':
    case 'tee-object':
      return 'write';
    case 'ps':
    case 'get-process':
    case 'gps':
    case 'tasklist':
    case 'kill':
    case 'taskkill':
    case 'stop-process':
    case 'spps':
    case 'pkill':
    case 'killall':
    case 'top':
    case 'htop':
    case 'lsof':
    case 'netstat':
    case 'get-nettcpconnection':
    case 'start-process':
      return 'process';
    case 'sleep':
    case 'start-sleep':
    case 'timeout':
    case 'wait':
      return 'wait';
    case 'claude':
    case 'codex':
    case 'gemini':
    case 'agy':
      return 'agentCli';
    case 'vitest':
    case 'jest':
    case 'mocha':
    case 'pytest':
    case 'playwright':
    case 'tsc':
    case 'vite':
    case 'eslint':
    case 'prettier':
    case 'tauri':
    case 'svelte-check':
    case 'svelte-kit':
      return toolKind(program, args.slice(1));
    default:
      return 'terminal';
  }
}

/** The server and tool of a connected (MCP) tool call, if it is one. */
export function connectedTool(tool: ToolActivity): { server?: string; name: string } | undefined {
  const claude = tool.name.match(/^mcp__(.+?)__(.+)$/);
  if (claude) return { server: claude[1], name: claude[2] };
  const codex = tool.name.match(/^Connected tool: (.+)$/);
  if (codex)
    return { server: tool.facts?.find((f) => f.label === 'Connection')?.value, name: codex[1] };
}

const imageExtension = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
const codeExtension =
  /\.(ts|tsx|js|jsx|mjs|cjs|svelte|vue|rs|py|go|java|kt|swift|c|h|cc|cpp|hpp|cs|rb|php|lua|sh|ps1|sql|css|scss|less|html|xml|json|toml|ya?ml)$/i;

/** The highlight.js language of a file path, when highlighting it is supported. */
export function fileLanguage(path?: string): string | undefined {
  const extension = path?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  return extension
    ? (
        {
          ts: 'typescript',
          tsx: 'typescript',
          mts: 'typescript',
          cts: 'typescript',
          js: 'javascript',
          jsx: 'javascript',
          mjs: 'javascript',
          cjs: 'javascript',
          svelte: 'xml',
          vue: 'xml',
          html: 'xml',
          htm: 'xml',
          xml: 'xml',
          svg: 'xml',
          rs: 'rust',
          py: 'python',
          go: 'go',
          java: 'java',
          kt: 'kotlin',
          swift: 'swift',
          c: 'c',
          h: 'c',
          cc: 'cpp',
          cpp: 'cpp',
          hpp: 'cpp',
          cs: 'csharp',
          rb: 'ruby',
          php: 'php',
          lua: 'lua',
          sh: 'bash',
          bash: 'bash',
          zsh: 'bash',
          ps1: 'powershell',
          psm1: 'powershell',
          sql: 'sql',
          css: 'css',
          scss: 'scss',
          less: 'less',
          json: 'json',
          jsonc: 'json',
          toml: 'ini',
          ini: 'ini',
          yml: 'yaml',
          yaml: 'yaml',
          md: 'markdown',
          markdown: 'markdown',
          diff: 'diff',
          patch: 'diff',
          graphql: 'graphql',
          r: 'r',
          pl: 'perl',
          mk: 'makefile',
        } as Record<string, string>
      )[extension]
    : /(^|[\\/])makefile$/i.test(path ?? '')
      ? 'makefile'
      : undefined;
}

// The icon of each kind of file, by extension: a stylesheet, markup and a component
// are told apart at a glance, and languages without an icon of their own share `code`.
const extensionIcons: Record<string, ToolIconKey> = {
  svelte: 'component',
  vue: 'component',
  astro: 'component',
  tsx: 'component',
  jsx: 'component',
  html: 'markup',
  htm: 'markup',
  xhtml: 'markup',
  xml: 'markup',
  xsl: 'markup',
  hbs: 'markup',
  handlebars: 'markup',
  ejs: 'markup',
  pug: 'markup',
  njk: 'markup',
  liquid: 'markup',
  css: 'style',
  scss: 'style',
  sass: 'style',
  less: 'style',
  styl: 'style',
  pcss: 'style',
  postcss: 'style',
  json: 'data',
  jsonc: 'data',
  json5: 'data',
  ndjson: 'data',
  geojson: 'data',
  graphql: 'data',
  gql: 'data',
  proto: 'data',
  toml: 'config',
  ini: 'config',
  cfg: 'config',
  conf: 'config',
  env: 'config',
  properties: 'config',
  plist: 'config',
  yml: 'config',
  yaml: 'config',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'shell',
  psm1: 'shell',
  psd1: 'shell',
  bat: 'shell',
  cmd: 'shell',
  sql: 'database',
  sqlite: 'database',
  db: 'database',
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  xlsx: 'spreadsheet',
  xls: 'spreadsheet',
  ods: 'spreadsheet',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  eot: 'font',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  ico: 'image',
  avif: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  mp4: 'media',
  webm: 'media',
  mov: 'media',
  mkv: 'media',
  avi: 'media',
  mp3: 'media',
  wav: 'media',
  ogg: 'media',
  flac: 'media',
  m4a: 'media',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  '7z': 'archive',
  rar: 'archive',
  zst: 'archive',
  exe: 'binary',
  dll: 'binary',
  so: 'binary',
  dylib: 'binary',
  wasm: 'binary',
  bin: 'binary',
  ipynb: 'notebook',
  ts: 'code',
  mts: 'code',
  cts: 'code',
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  rs: 'code',
  py: 'code',
  go: 'code',
  java: 'code',
  kt: 'code',
  kts: 'code',
  swift: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  rb: 'code',
  php: 'code',
  lua: 'code',
  dart: 'code',
  ex: 'code',
  exs: 'code',
  erl: 'code',
  hs: 'code',
  scala: 'code',
  groovy: 'code',
  zig: 'code',
  nim: 'code',
  clj: 'code',
  jl: 'code',
  sol: 'code',
  r: 'code',
  pl: 'code',
  pm: 'code',
  vb: 'code',
  prisma: 'code',
};

/**
 * The icon of a file's type, for the rows of Files edited: its name decides first, so a
 * lock file, a Dockerfile, a Git file, a build file and a test keep their own icon.
 */
export function fileTypeIcon(path: string): ToolIconKey {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  if (/[-.]lock(?:b|\.json|\.ya?ml|\.toml)?$/.test(name)) return 'lock';
  if (
    /^(?:docker|container)file/.test(name) ||
    /\.(?:docker|container)file$/.test(name) ||
    /^(?:docker-)?compose\.ya?ml$/.test(name) ||
    name === '.dockerignore'
  )
    return 'container';
  if (/^\.git[a-z]*$/.test(name)) return 'git';
  if (
    /^(?:makefile|gnumakefile|cmakelists\.txt)$/.test(name) ||
    /\.(?:mk|make|gradle|bazel|bzl)$/.test(name)
  )
    return 'build';
  if (/[.\-_](?:test|spec)\.[a-z0-9]+$/.test(name) || /^test_.+\.py$/.test(name)) return 'test';
  if (/^\.(?:env|editorconfig|[a-z]+rc)(?:\.|$)/.test(name)) return 'config';
  return extensionIcons[name.match(/\.([a-z0-9]+)$/)?.[1] ?? ''] ?? 'file';
}

export type ToolVisual = {
  icon: ToolIconKey;
  /** The primary label; shown as code when `code` is set. */
  title: string;
  code?: boolean;
  /** Secondary code text below the title, such as a command, path or pattern. */
  detail?: string;
  /** The full text of a shortened title or detail, for hover. */
  hint?: string;
};

function browserTool(server = '', name: string) {
  return /browser|chrome|playwright|puppeteer|devtools/i.test(server + ' ' + name);
}

/** The icon and labels of one tool call's row. */
export function toolVisual(
  tool: ToolActivity,
  options: { folder?: string; newFile?: boolean } = {},
): ToolVisual {
  const path = tool.path ? relativeFilePath(tool.path, options.folder) : undefined;
  const commandish =
    tool.commandRun || tool.operation === 'command' || ['Run command', 'Bash'].includes(tool.name);
  if (tool.id === 'activity-limit') return { icon: 'tool', title: tool.name };
  if (tool.category === 'hook')
    return {
      icon: 'hook',
      title: tool.name,
      detail: tool.path || tool.facts?.find((fact) => fact.label === 'Hook')?.value,
    };
  if (tool.category === 'agent') return { icon: 'agent', title: tool.name };
  if (tool.operation === 'viewImage' || ['View image', 'view_image'].includes(tool.name))
    return { icon: 'image', title: tool.name, detail: path, hint: tool.path };
  if (tool.category === 'skill')
    return { icon: 'skill', title: tool.name, detail: path ?? tool.detail, hint: tool.path };
  // A shell read Codex reported without a path is still shown by its command.
  if (
    (tool.operation === 'read' || ['Read', 'Read file'].includes(tool.name)) &&
    !(tool.command && !tool.path)
  ) {
    const code = codeExtension.test(tool.path ?? '');
    return {
      icon: imageExtension.test(tool.path ?? '') ? 'image' : code ? 'code' : 'file',
      title: tool.name,
      detail: path,
      hint: tool.path,
    };
  }
  if (tool.operation === 'monitor') {
    const command = tool.command ? primaryCommand(tool.command) : undefined;
    return {
      icon: 'monitor',
      title: tool.detail ?? tool.name,
      detail: command ? command.line + (command.more ? ' …' : '') : undefined,
      hint: tool.command,
    };
  }
  if (commandish) {
    if (!tool.command) return { icon: 'terminal', title: tool.detail ?? tool.name };
    const { line, more } = primaryCommand(tool.command);
    const text = line + (more ? ' …' : '');
    return tool.detail
      ? { icon: commandKind(tool.command), title: tool.detail, detail: text, hint: tool.command }
      : { icon: commandKind(tool.command), title: text, code: true, hint: tool.command };
  }
  if (
    tool.operation === 'edit' ||
    ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Edit files'].includes(tool.name)
  ) {
    const files = tool.facts?.find((fact) => fact.label === 'Files')?.value.split('\n') ?? [];
    return {
      icon:
        tool.name === 'NotebookEdit'
          ? 'notebook'
          : options.newFile || tool.name === 'Write'
            ? 'newFile'
            : 'edit',
      title: tool.name,
      detail:
        path ??
        (files.length
          ? relativeFilePath(files[0], options.folder) +
            (files.length > 1 ? ` and ${files.length - 1} more` : '')
          : undefined),
      hint: tool.path ?? (files.join('\n') || undefined),
    };
  }
  if (tool.operation === 'glob' || tool.operation === 'grep')
    return {
      icon: tool.operation === 'glob' ? 'findFiles' : 'grep',
      title: tool.name,
      detail: tool.query,
      hint: [tool.query, tool.path && `in ${tool.path}`].filter(Boolean).join(' '),
    };
  if (tool.category === 'search')
    return tool.name === 'Open web page'
      ? { icon: 'page', title: tool.name, detail: tool.sources[0]?.url ?? tool.query }
      : { icon: 'web', title: tool.name, detail: tool.query };
  if (tool.operation === 'sendMessage')
    return { icon: 'message', title: tool.name, detail: tool.detail };
  if (tool.operation === 'listAgents')
    return { icon: 'directory', title: tool.name, detail: tool.detail };
  if (tool.operation === 'toolSearch')
    return { icon: 'toolSearch', title: tool.name, detail: tool.query };
  if (tool.name === 'Wait for background tasks') return { icon: 'waitTasks', title: tool.name };
  if (['TodoWrite', 'TaskCreate', 'TaskUpdate', 'studio_update_plan'].includes(tool.name))
    return { icon: 'plan', title: tool.name };
  if (['EnterPlanMode', 'ExitPlanMode'].includes(tool.name))
    return { icon: 'plan', title: tool.name };
  if (
    ['AskUserQuestion', 'studio_ask_user', 'mcp__agent_studio__studio_ask_user'].includes(tool.name)
  )
    return { icon: 'question', title: tool.name };
  if (tool.name === 'Workflow') return { icon: 'workflow', title: tool.name, detail: tool.detail };
  if (['visualize', 'mcp__agent_studio__visualize'].includes(tool.name))
    return { icon: 'chart', title: 'Visualize' };
  const connected = connectedTool(tool);
  if (connected) {
    const browser = browserTool(connected.server, connected.name);
    return {
      icon: /screenshot/i.test(connected.name) ? 'screenshot' : browser ? 'browser' : 'plug',
      title: connected.name,
      detail: connected.server,
    };
  }
  return { icon: 'tool', title: tool.name, detail: tool.query || path || tool.detail };
}
