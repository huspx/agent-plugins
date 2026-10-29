import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(repo, 'plugins/omp-magpie');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const inside = (base, target) => {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const confined = async (relative) => {
  assert.equal(typeof relative, 'string', '路径必须为字符串');
  assert(relative.length > 0 && !path.isAbsolute(relative), `路径必须相对插件根: ${relative}`);
  const target = path.resolve(root, relative);
  assert(inside(root, target), `路径逃出插件根: ${relative}`);
  assert(inside(await realpath(root), await realpath(target)), `symlink 逃出插件根: ${relative}`);
  return target;
};

const catalog = await json(path.join(repo, '.omp-plugin/marketplace.json'));
const pkg = await json(path.join(root, 'package.json'));
assert.equal(catalog.name, 'huspx-agent-plugins');
assert.equal(catalog.owner?.name, 'huspx');
const entries = catalog.plugins.filter((entry) => entry.name === 'omp-magpie');
assert.equal(entries.length, 1, 'catalog 必须恰好收录一个 omp-magpie');
const entry = entries[0];
assert.equal(pkg.name, 'omp-magpie');
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(entry.version, pkg.version, 'catalog/package 版本必须同步');
assert.equal(entry.source, './plugins/omp-magpie');
assert.equal(await realpath(path.resolve(repo, entry.source)), await realpath(root));
assert.equal(pkg.type, 'module');
assert.equal(pkg.license, 'MIT');
assert.deepEqual(pkg.omp?.extensions, ['./src/index.ts']);
assert.deepEqual(Object.keys(pkg.omp.settings).sort(), ['autoAttach', 'connections']);
assert.equal(pkg.omp.settings.autoAttach.type, 'boolean');
assert.equal(pkg.omp.settings.autoAttach.default, true);
assert.equal(pkg.omp.settings.connections.type, 'string');
assert.equal(pkg.omp.settings.connections.default, '[]');
assert.deepEqual(JSON.parse(pkg.omp.settings.connections.default), []);
assert(Array.isArray(pkg.files) && pkg.files.length > 0, '必须声明 files');
for (const file of pkg.files) await confined(file);
for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE', ...pkg.omp.extensions]) await confined(file);
assert(!Object.keys(pkg.dependencies ?? {}).length, '生产包不得依赖外部运行时包');
assert(!Object.keys(pkg.optionalDependencies ?? {}).length, '生产包不得通过 optionalDependencies 安装运行时包');
for (const sdk of ['@oh-my-pi/pi-coding-agent', '@oh-my-pi/pi-ai']) {
  assert.equal(pkg.peerDependencies?.[sdk], '>=18.4.4', `${sdk} peer 必须声明最低 OMP 18.4.4`);
  assert.equal(pkg.peerDependenciesMeta?.[sdk]?.optional, true, `${sdk} peer 必须为 optional，由宿主提供`);
}

const files = [];
async function walk(relative) {
  const absolute = await confined(relative);
  const info = await lstat(path.join(root, relative));
  // npm pack 与 marketplace copy 对 symlink 的处理不同；生产包统一拒绝 symlink。
  assert(!info.isSymbolicLink(), `生产包不能包含 symlink: ${relative}`);
  if ((await stat(absolute)).isDirectory()) {
    for (const child of await readdir(absolute)) await walk(path.posix.join(relative, child));
  } else {
    files.push(relative);
  }
}
for (const child of await readdir(root)) await walk(child);
const allowedTop = new Set(['src', 'package.json', 'README.md', 'CHANGELOG.md', 'LICENSE']);
for (const file of files) assert(allowedTop.has(file.split('/')[0]), `非生产文件进入插件目录: ${file}`);

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const allowedHost = new Set([
  '@oh-my-pi/pi-coding-agent',
  '@oh-my-pi/pi-coding-agent/extensibility/plugins',
  '@oh-my-pi/pi-coding-agent/config/resolve-config-value',
  '@oh-my-pi/pi-ai',
  '@oh-my-pi/pi-ai/usage/registry',
  '@oh-my-pi/pi-utils',
]);
const relativeTargets = new Set();
const api = new API({ cwd: repo });
const snapshot = api.updateSnapshot({ openProjects: [path.join(repo, 'tsconfig.json')] });
try {
  const program = snapshot.getProject(path.join(repo, 'tsconfig.json')).program;
  for (const file of files.filter((name) => /\.[cm]?[jt]sx?$/.test(name))) {
    const source = program.getSourceFile(path.join(root, file));
    assert(source, `源码未被 TypeScript 项目覆盖: ${file}`);
    const imports = [];
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        imports.push({ specifier: node.moduleSpecifier, typeOnly: node.isTypeOnly || node.importClause?.isTypeOnly });
      }
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        imports.push({ specifier: node.argument.literal, typeOnly: true });
      }
      if (ts.isExternalModuleReference(node)) imports.push({ specifier: node.expression, typeOnly: false });
      if (
        ts.isCallExpression(node)
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        assert.equal(node.arguments.length, 1, `无法静态检查 import: ${file}`);
        imports.push({ specifier: node.arguments[0], typeOnly: false });
      }
      node.forEachChild(visit);
    }
    visit(source);
    for (const { specifier, typeOnly } of imports) {
      assert(ts.isStringLiteralLikeNode(specifier), `禁止动态计算模块路径: ${file}`);
      const name = specifier.text;
      if (name.startsWith('.')) {
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), name));
        const target = await confined(relative);
        assert((await stat(target)).isFile(), `import 必须指向实际文件: ${file}: ${name}`);
        relativeTargets.add(relative);
      } else {
        const hostType = typeOnly && /^@oh-my-pi\/(?:pi-ai|pi-coding-agent)(?:\/|$)/.test(name);
        assert(builtins.has(name) || allowedHost.has(name) || hostType, `不允许的生产 import: ${file}: ${name}`);
      }
    }
  }
} finally {
  snapshot.dispose();
  api.close();
}

// --dry-run 计算 npm 实际发布内容，不产生 tarball；忽略生命周期脚本，避免发布检查产生副作用。
const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}));
assert.equal(result.length, 1);
assert.equal(result[0].name, pkg.name);
assert.equal(result[0].version, pkg.version);
const packed = new Set(result[0].files.map((file) => file.path));
for (const file of files) assert(packed.has(file), `npm 发布列表遗漏生产文件: ${file}`);
for (const file of packed) {
  await confined(file);
  assert(files.includes(file), `npm 发布列表包含意外文件: ${file}`);
}
for (const file of relativeTargets) assert(packed.has(file), `import 目标未发布: ${file}`);
for (const file of pkg.omp.extensions) assert(packed.has(file.replace(/^\.\//, '')), `入口未发布: ${file}`);
console.log(
  `package 检查通过: ${pkg.name}@${pkg.version}，${packed.size} 个发布文件；marketplace 安装副本边界由 smoke 检查。`,
);
