/**
 * Phoenix Framework Resolver (Elixir)
 *
 * Reads a Phoenix router into the graph:
 *
 * - every route (`get`/`post`/… / `match`, `resources` with nesting,
 *   `only:`/`except:`/`singleton:`/`param:`, `live`, `forward`) becomes a
 *   `route` node named `METHOD /path` with its scopes' paths applied, bound by
 *   a `references` edge to the code that serves it: the controller action
 *   `Ctrl::action/2` (scope aliases applied), a LiveView's `mount/3` (or
 *   `render/1` when it has none), a forwarded plug's `call/2`;
 * - every `pipeline :name do … end` becomes the function it compiles to,
 *   `Router::name/2`, which `calls` each plug it runs (a function plug through
 *   the router's own scope, a module plug's `call/2`), and a route `calls` the
 *   pipelines and plugs its scopes `pipe_through`.
 *
 * The router is parsed with the Elixir grammar rather than scanned with
 * regexes, so `do:` keyword bodies, strings and comments cannot unbalance a
 * scope. A call the router does not define (an app's own `on_ee do … end`, an
 * `if Mix.env() …`) is read through, so its routes still count.
 *
 * Builds on the Phoenix resolver in #1229 (thanks @waseigo).
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { getParser } from '../../extraction/grammars';
import { getNodeText, getChildByField } from '../../extraction/tree-sitter-helpers';
import { argsOf, doBlockOf, keywordValue } from '../../extraction/languages/elixir';

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'connect', 'trace']);

/** `resources` actions in Phoenix's order, with the method(s) and the path tail each gets. */
const RESOURCE_ACTIONS: Array<{ action: string; methods: string[]; tail: (member: string) => string; member: boolean }> = [
  { action: 'index', methods: ['GET'], tail: () => '', member: false },
  { action: 'edit', methods: ['GET'], tail: (m) => `${m}/edit`, member: true },
  { action: 'new', methods: ['GET'], tail: () => '/new', member: false },
  { action: 'show', methods: ['GET'], tail: (m) => m, member: true },
  { action: 'create', methods: ['POST'], tail: () => '', member: false },
  { action: 'update', methods: ['PATCH', 'PUT'], tail: (m) => m, member: true },
  { action: 'delete', methods: ['DELETE'], tail: (m) => m, member: true },
];

interface Scope {
  path: string;
  alias: string;
  /** Qualified refs (`Router::browser/2`, `Plug::call/2`) every route here passes through. */
  pipes: string[];
  /**
   * `for` comprehension variables in scope: the literal value of this
   * iteration, or null when the list is computed (no static value).
   */
  vars: Map<string, string | null>;
}

function callName(node: SyntaxNode, source: string): string {
  if (node.type !== 'call') return '';
  const target = getChildByField(node, 'target');
  return target?.type === 'identifier' ? getNodeText(target, source) : '';
}

/** Positional (non-keyword) arguments of a call. */
function positional(node: SyntaxNode): SyntaxNode[] {
  return (argsOf(node)?.namedChildren ?? []).filter((c) => c.type !== 'keywords' && c.type !== 'comment');
}

/**
 * A string literal's content, with each `#{var}` replaced by the bound value of
 * a comprehension variable. Null when it is not a string, or interpolates
 * anything without a static value.
 */
function stringValue(
  node: SyntaxNode | null | undefined,
  source: string,
  vars: Map<string, string | null> = new Map()
): string | null {
  if (node?.type !== 'string') return null;
  const open = getNodeText(node, source).startsWith('"""') ? 3 : 1;
  let out = '';
  let pos = node.startIndex + open;
  for (const part of node.namedChildren) {
    if (part.type !== 'interpolation') continue;
    const expr = part.namedChildren[0];
    const value = expr?.type === 'identifier' ? vars.get(getNodeText(expr, source)) : undefined;
    if (typeof value !== 'string') return null;
    out += source.slice(pos, part.startIndex) + value;
    pos = part.endIndex;
  }
  return out + source.slice(pos, node.endIndex - open);
}

function atomValue(node: SyntaxNode | null | undefined, source: string): string | null {
  if (node?.type !== 'atom') return null;
  return getNodeText(node, source).replace(/^:/, '').replace(/^"(.*)"$/, '$1');
}

function atomList(node: SyntaxNode | null | undefined, source: string): string[] | null {
  if (node?.type !== 'list') return null;
  return node.namedChildren.map((c) => atomValue(c, source)).filter((a): a is string => a !== null);
}

function joinPath(prefix: string, path: string): string {
  const parts = [prefix, path].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return `/${parts.join('/')}`;
}

function joinAlias(prefix: string, alias: string): string {
  return prefix && alias ? `${prefix}.${alias}` : prefix || alias;
}

/** `UserController` → `user` — the resource name Phoenix derives for a nested param. */
function resourceName(controller: string): string {
  const last = controller.split('.').pop() ?? controller;
  return last
    .replace(/Controller$/, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** True for a module body that declares a Phoenix router (`use Phoenix.Router`, `use AppWeb, :router`). */
function isRouterModule(body: SyntaxNode[], source: string): boolean {
  return body.some((stmt) => {
    if (callName(stmt, source) !== 'use') return false;
    const [mod, which] = positional(stmt);
    if (mod?.type !== 'alias') return false;
    return getNodeText(mod, source) === 'Phoenix.Router' || atomValue(which, source) === 'router';
  });
}

function extractRouter(
  filePath: string,
  source: string,
  moduleName: string,
  body: SyntaxNode[],
  nodes: Node[],
  references: UnresolvedRef[],
  now: number
): void {
  // The router's own import/use scope, for function plugs (`plug :fetch_current_user`).
  const candidates: string[] = [];
  for (const stmt of body) {
    const name = callName(stmt, source);
    const [mod, which] = positional(stmt);
    if (mod?.type !== 'alias') continue;
    if (name === 'import') candidates.push(`import:${getNodeText(mod, source)}`);
    if (name === 'use') {
      const atom = atomValue(which, source);
      candidates.push(`use:${getNodeText(mod, source)}${atom ? `@${atom}` : ''}`);
    }
  }

  const ref = (fromNodeId: string, referenceName: string, referenceKind: 'calls' | 'references', at: SyntaxNode, withScope = false): void => {
    references.push({
      fromNodeId,
      referenceName,
      referenceKind,
      line: at.startPosition.row + 1,
      column: at.startPosition.column,
      filePath,
      language: 'elixir',
      ...(withScope && candidates.length ? { candidates } : {}),
    });
  };

  /** A plug named in a pipeline or a `pipe_through`: a function plug of the router, or a module plug's `call/2`. */
  const plugRef = (target: SyntaxNode): { name: string; bare: boolean } | null => {
    const atom = atomValue(target, source);
    if (atom) return { name: `${atom}/2`, bare: true };
    if (target.type === 'alias') return { name: `${getNodeText(target, source)}::call/2`, bare: false };
    return null;
  };

  const addRoute = (at: SyntaxNode, method: string, path: string, handler: string, scope: Scope): void => {
    const line = at.startPosition.row + 1;
    const id = `route:${filePath}:${line}:${method}:${path}`;
    if (nodes.some((n) => n.id === id)) return;
    nodes.push({
      id,
      kind: 'route',
      name: `${method} ${path}`,
      qualifiedName: `${filePath}::route:${method}:${path}`,
      filePath,
      startLine: line,
      endLine: at.endPosition.row + 1,
      startColumn: at.startPosition.column,
      endColumn: at.endPosition.column,
      language: 'elixir',
      updatedAt: now,
    });
    ref(id, handler, 'references', at);
    for (const pipe of scope.pipes) ref(id, pipe, 'calls', at);
  };

  const addPipeline = (stmt: SyntaxNode, name: string): void => {
    const line = stmt.startPosition.row + 1;
    const id = `function:${filePath}:${line}:phoenix-pipeline:${name}`;
    nodes.push({
      id,
      kind: 'function',
      name,
      qualifiedName: `${moduleName}::${name}/2`,
      signature: `pipeline :${name}`,
      filePath,
      startLine: line,
      endLine: stmt.endPosition.row + 1,
      startColumn: stmt.startPosition.column,
      endColumn: stmt.endPosition.column,
      language: 'elixir',
      visibility: 'private',
      updatedAt: now,
    });
    // Every `plug` in the pipeline, including ones behind an app's own
    // conditional macro (`on_ee(do: plug(X))`).
    const visit = (n: SyntaxNode): void => {
      if (callName(n, source) === 'plug') {
        const target = positional(n)[0];
        const plug = target ? plugRef(target) : null;
        if (plug) ref(id, plug.name, 'calls', n, plug.bare);
        return;
      }
      for (const child of n.namedChildren) visit(child);
    };
    const block = doBlockOf(stmt);
    if (block) visit(block);
  };

  const resources = (stmt: SyntaxNode, scope: Scope): void => {
    const [pathNode, ctrlNode] = positional(stmt);
    const path = stringValue(pathNode, source, scope.vars);
    if (path === null || ctrlNode?.type !== 'alias') return;
    const args = argsOf(stmt);
    const controller = joinAlias(scope.alias, getNodeText(ctrlNode, source));
    const singleton = getNodeText(keywordValue(args, 'singleton', source) ?? stmt, source) === 'true';
    const only = atomList(keywordValue(args, 'only', source), source);
    const except = atomList(keywordValue(args, 'except', source), source);
    const param = stringValue(keywordValue(args, 'param', source), source) ?? 'id';
    const base = joinPath(scope.path, path);
    const member = singleton ? '' : `/:${param}`;
    for (const spec of RESOURCE_ACTIONS) {
      if (singleton && spec.action === 'index') continue;
      if (only && !only.includes(spec.action)) continue;
      if (except?.includes(spec.action)) continue;
      const routePath = joinPath(base, spec.tail(member));
      for (const method of spec.methods) addRoute(stmt, method, routePath, `${controller}::${spec.action}/2`, scope);
    }
    // Nested resources hang off one member: `/users/:user_id/posts`.
    const block = doBlockOf(stmt);
    if (block) {
      const name = atomValue(keywordValue(args, 'as', source), source) ?? resourceName(controller);
      const nestedPath = singleton ? base : joinPath(base, `/:${name}_${param}`);
      walk(block.namedChildren, { ...scope, path: nestedPath, pipes: [...scope.pipes] });
    }
  };

  const walk = (statements: SyntaxNode[], scope: Scope): void => {
    for (const stmt of statements) {
      const name = callName(stmt, source);
      if (!name) continue;
      const args = argsOf(stmt);
      const pos = positional(stmt);

      if (HTTP_VERBS.has(name) || name === 'match') {
        const verbArgs = name === 'match' ? pos.slice(1) : pos;
        const method =
          name === 'match' ? (getNodeText(pos[0] ?? stmt, source) === ':*' ? '*' : (atomValue(pos[0], source) ?? '').toUpperCase()) : name.toUpperCase();
        const [pathNode, ctrlNode, actionNode] = verbArgs;
        const path = stringValue(pathNode, source, scope.vars);
        if (!method || path === null || ctrlNode?.type !== 'alias') continue;
        const target = joinAlias(scope.alias, getNodeText(ctrlNode, source));
        // `get "/x", Ctrl, :action` names a controller action; with no action
        // atom (`get "/x", SomePlug, opts`) the route is served by a plug.
        const action = atomValue(actionNode, source);
        addRoute(stmt, method, joinPath(scope.path, path), action ? `${target}::${action}/2` : `${target}::call/2`, scope);
      } else if (name === 'live') {
        const [pathNode, modNode] = pos;
        const path = stringValue(pathNode, source, scope.vars);
        if (path === null || modNode?.type !== 'alias') continue;
        const live = joinAlias(scope.alias, getNodeText(modNode, source));
        addRoute(stmt, 'GET', joinPath(scope.path, path), `${live}::mount/3`, scope);
      } else if (name === 'forward') {
        const [pathNode, plugNode] = pos;
        const path = stringValue(pathNode, source, scope.vars);
        if (path === null || plugNode?.type !== 'alias') continue;
        const plug = joinAlias(scope.alias, getNodeText(plugNode, source));
        addRoute(stmt, '*', `${joinPath(scope.path, path).replace(/\/$/, '')}/*`, `${plug}::call/2`, scope);
      } else if (name === 'resources') {
        resources(stmt, scope);
      } else if (name === 'pipe_through') {
        const target = pos[0];
        const items = target?.type === 'list' ? target.namedChildren : target ? [target] : [];
        for (const item of items) {
          const atom = atomValue(item, source);
          if (atom) scope.pipes.push(`${moduleName}::${atom}/2`);
          else if (item.type === 'alias') scope.pipes.push(`${getNodeText(item, source)}::call/2`);
        }
      } else if (name === 'pipeline') {
        const pipeline = atomValue(pos[0], source);
        if (pipeline) addPipeline(stmt, pipeline);
      } else if (name === 'scope') {
        let path = '';
        let alias = '';
        let aliasOff = false;
        let unknowable = false;
        for (const p of pos) {
          if (p.type === 'alias') {
            alias = getNodeText(p, source);
            continue;
          }
          if (p.type === 'list' && p.namedChildCount === 0) continue; // `scope [] do`
          const str =
            p.type === 'identifier' ? (scope.vars.get(getNodeText(p, source)) ?? null) : stringValue(p, source, scope.vars);
          if (str === null) unknowable = true;
          else path = str;
        }
        // A path computed at compile time has no static address.
        if (unknowable) continue;
        const kwPath = stringValue(keywordValue(args, 'path', source), source);
        if (kwPath !== null) path = kwPath;
        const kwAlias = keywordValue(args, 'alias', source);
        if (kwAlias?.type === 'alias') alias = getNodeText(kwAlias, source);
        else if (kwAlias && getNodeText(kwAlias, source) === 'false') aliasOff = true;
        const block = doBlockOf(stmt);
        if (block) {
          walk(block.namedChildren, {
            path: joinPath(scope.path, path),
            alias: aliasOff ? '' : joinAlias(scope.alias, alias),
            pipes: [...scope.pipes],
            vars: scope.vars,
          });
        }
      } else if (name === 'defmodule' || name === 'def' || name === 'defp' || name === 'defmacro' || name === 'defmacrop') {
        continue;
      } else if (name === 'for') {
        // `for prefix <- ["/", "/repos/:repository"] do … end` registers its
        // routes once per literal value; a computed list (or a filter) has no
        // static values, so its variable stays unknown and its routes unread.
        const generator = pos[0];
        const left = generator ? getChildByField(generator, 'left') : null;
        const right = generator ? getChildByField(generator, 'right') : null;
        const block = doBlockOf(stmt) ?? keywordValue(args, 'do', source);
        if (generator?.type !== 'binary_operator' || left?.type !== 'identifier' || !block) continue;
        const variable = getNodeText(left, source);
        const values =
          right?.type === 'list' && pos.length === 1 ? right.namedChildren.map((v) => stringValue(v, source)) : [null];
        const literal = values.every((v): v is string => v !== null) ? values : [null];
        const statements = block.type === 'do_block' || block.type === 'block' ? block.namedChildren : [block];
        for (const value of literal) {
          walk(statements, { ...scope, vars: new Map(scope.vars).set(variable, value) });
        }
      } else {
        // `live_session`, an app's `on_ee do … end`, `if Mix.env() …`: read
        // through, keeping the scope (none of these open a new one).
        const block = doBlockOf(stmt);
        if (block) {
          walk(block.namedChildren, scope);
          for (const child of block.namedChildren) {
            if (child.type === 'else_block') walk(child.namedChildren, scope);
          }
        }
        for (const key of ['do', 'else']) {
          const value = keywordValue(args, key, source);
          if (value) walk(value.type === 'block' ? value.namedChildren : [value], scope);
        }
      }
    }
  };

  walk(body, { path: '', alias: '', pipes: [], vars: new Map() });
}

export const phoenixResolver: FrameworkResolver = {
  name: 'phoenix',
  languages: ['elixir'],

  detect(context: ResolutionContext): boolean {
    const declares = (mix: string | null) => !!mix && /\{\s*:phoenix\s*,/.test(mix);
    if (declares(context.readFile('mix.exs'))) return true;
    // Umbrella projects declare Phoenix in an app's own mix.exs.
    for (const app of context.listDirectories?.('apps') ?? []) {
      if (declares(context.readFile(`apps/${app}/mix.exs`))) return true;
    }
    for (const dir of context.listDirectories?.('lib') ?? []) {
      if (dir.endsWith('_web') && context.fileExists(`lib/${dir}/router.ex`)) return true;
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // A LiveView route's handler: `mount/3`, or `render/1` for a LiveView
    // that has no mount. Everything else rides the Elixir resolution rules.
    if (!ref.fromNodeId.startsWith('route:') || ref.language !== 'elixir') return null;
    const live = /^(.+)::mount\/3$/.exec(ref.referenceName);
    if (!live) return null;
    for (const name of [`${live[1]}::mount/3`, `${live[1]}::render/1`]) {
      const target = context
        .getNodesByQualifiedName(name)
        .find((n) => n.language === 'elixir' && n.kind === 'function');
      if (target) return { original: ref, targetNodeId: target.id, confidence: 0.95, resolvedBy: 'framework' };
    }
    return null;
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    if (!/\.exs?$/.test(filePath) || !/\bPhoenix\.Router\b|:router\b/.test(content)) return { nodes, references };
    const parser = getParser('elixir');
    if (!parser) return { nodes, references };
    const tree = parser.parse(content);
    if (!tree) return { nodes, references };
    try {
      const now = Date.now();
      const visit = (n: SyntaxNode, prefix: string): void => {
        for (const stmt of n.namedChildren) {
          if (callName(stmt, content) !== 'defmodule') continue;
          const alias = positional(stmt)[0];
          if (alias?.type !== 'alias') continue;
          const moduleName = joinAlias(prefix, getNodeText(alias, content));
          const body = doBlockOf(stmt)?.namedChildren ?? [];
          if (isRouterModule(body, content)) extractRouter(filePath, content, moduleName, body, nodes, references, now);
          const block = doBlockOf(stmt);
          if (block) visit(block, moduleName);
        }
      };
      visit(tree.rootNode, '');
    } finally {
      tree.delete();
    }
    return { nodes, references };
  },
};
