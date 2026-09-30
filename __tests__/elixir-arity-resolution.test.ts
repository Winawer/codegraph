/**
 * Elixir arity-aware extraction and resolution.
 *
 * Arity is part of an Elixir function's identity: `get/1` and `get/2` are
 * unrelated definitions (the same model Erlang uses, #1610). Each arity gets
 * its own node, qualified `Mod::fun/N`; same-arity clauses still merge into one
 * node. Call sites carry the arity Elixir would dispatch on — counting a piped
 * left operand, a trailing keyword list, and a `do … end` block — and resolve
 * only to a definition of that arity, or to a default-argument definition whose
 * declared range covers it. Anything else stays unresolved: a wrong-arity edge
 * is worse than none.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

interface Edge {
  kind: string;
  from: string;
  to: string;
}

describe('Elixir arity-aware resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elixir-arity-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function index(files: Record<string, string>): Promise<{ fns: string[]; edges: Edge[] }> {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const fns = db
      .prepare(`SELECT qualified_name q FROM nodes WHERE kind = 'function' ORDER BY qualified_name`)
      .all()
      .map((r: { q: string }) => r.q);
    const edges = db
      .prepare(
        `SELECT e.kind kind, s.qualified_name "from", t.qualified_name "to"
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind IN ('calls', 'references') AND t.kind = 'function'`
      )
      .all();
    cg.destroy();
    return { fns, edges };
  }

  it('gives each arity its own node and merges same-arity clauses', async () => {
    const { fns } = await index({
      'lib/shapes.ex': `defmodule Shapes do
  def area({:square, s}), do: s * s
  def area({:rect, w, h}), do: w * h
  def area(w, h), do: w * h
  def hello, do: :hi
end
`,
    });
    expect(fns).toEqual(['Shapes::area/1', 'Shapes::area/2', 'Shapes::hello/0']);
  });

  it('links an f/2 -> f/3 delegation as a real edge, not a self-loop', async () => {
    const { edges } = await index({
      'lib/deleg.ex': `defmodule Deleg do
  def header(name, req) do
    header(name, req, nil)
  end

  def header(name, headers, default) do
    Map.get(headers, name, default)
  end
end
`,
    });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Deleg::header/2', to: 'Deleg::header/3' });
    expect(edges.filter((e) => e.from === e.to)).toEqual([]);
  });

  it('resolves remote calls to the called arity when arities are not adjacent', async () => {
    const { edges } = await index({
      'lib/split.ex': `defmodule Split do
  def get(k), do: get(k, nil)

  def other(x), do: x

  def get(k, default), do: {k, default}
end
`,
      'lib/user.ex': `defmodule User do
  def a(k), do: Split.get(k)
  def b(k), do: Split.get(k, 1)
end
`,
    });
    expect(edges).toContainEqual({ kind: 'calls', from: 'User::a/1', to: 'Split::get/1' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'User::b/1', to: 'Split::get/2' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Split::get/1', to: 'Split::get/2' });
    expect(edges).not.toContainEqual({ kind: 'calls', from: 'User::b/1', to: 'Split::get/1' });
  });

  it('refuses a remote call whose arity the module does not define', async () => {
    const { fns, edges } = await index({
      'lib/store.ex': `defmodule Store do
  def get(k), do: {k, nil}
  def get(k, default), do: {k, default}
end
`,
      'lib/client.ex': `defmodule Client do
  def broken(k), do: Store.get(k, nil, :extra)
end
`,
    });
    expect(fns).toContain('Client::broken/1');
    expect(edges.filter((e) => e.from === 'Client::broken/1')).toEqual([]);
  });

  it('resolves shorter calls onto a default-argument definition within its range', async () => {
    const { edges } = await index({
      'lib/opts.ex': `defmodule Opts do
  def get(id, opts \\\\ [], mode \\\\ :fast) do
    {id, opts, mode}
  end

  def one(id), do: get(id)
  def two(id), do: get(id, [])
  def none, do: get()
end
`,
      'lib/remote.ex': `defmodule Remote do
  def run(id), do: Opts.get(id)
end
`,
    });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Opts::one/1', to: 'Opts::get/3' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Opts::two/1', to: 'Opts::get/3' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Remote::run/1', to: 'Opts::get/3' });
    expect(edges.filter((e) => e.from === 'Opts::none/0')).toEqual([]);
  });

  it('prefers an exact-arity definition over a default-argument range', async () => {
    const { edges } = await index({
      'lib/both.ex': `defmodule Both do
  def fetch(id), do: {:exact, id}
  def fetch(id, a, b \\\\ nil), do: {id, a, b}
  def go(id), do: fetch(id)
  def go2(id), do: fetch(id, 1)
end
`,
    });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Both::go/1', to: 'Both::fetch/1' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Both::go2/1', to: 'Both::fetch/3' });
  });

  it('counts the piped operand, keyword lists and do-blocks in call arity', async () => {
    const { edges } = await index({
      'lib/target.ex': `defmodule Target do
  def two(a, b), do: {a, b}
  def opts(a, kw), do: {a, kw}
  def block(a, kw), do: {a, kw}
  def one(a), do: a
end
`,
      'lib/caller.ex': `defmodule Caller do
  def piped(x), do: x |> Target.two(1)
  def local_pipe(x), do: x |> helper()
  def kw(x), do: Target.opts(x, retries: 3, timeout: 5)
  def blk(x) do
    Target.block x do
      :body
    end
  end
  def chained(x), do: x |> Target.one() |> Target.two(:b)
  def helper(a), do: a
end
`,
    });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Caller::piped/1', to: 'Target::two/2' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Caller::local_pipe/1', to: 'Caller::helper/1' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Caller::kw/1', to: 'Target::opts/2' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Caller::blk/1', to: 'Target::block/2' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Caller::chained/1', to: 'Target::one/1' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Caller::chained/1', to: 'Target::two/2' });
  });

  it('counts the piped operand when a comment sits before the pipe', async () => {
    const { edges } = await index({
      'lib/c.ex': `defmodule C do
  def run(conn) do
    fragment(conn)
    # trimmed below
    |> omit("return_to")
  end
  defp fragment(conn), do: conn
  defp omit(query, key), do: {query, key}
end
`,
    });
    expect(edges).toContainEqual({ kind: 'calls', from: 'C::run/1', to: 'C::omit/2' });
  });

  it('resolves a module alias the compiler supplies but the file does not spell out', async () => {
    // `alias` in an outer module applies to nested modules, and `use` can
    // inject one; either way the call site names only the alias's last
    // segment. The single module whose name ends in that segment is the target.
    const { edges } = await index({
      'lib/lib_changeset.ex': `defmodule Lib.Changeset do
  def cast(data, params, permitted, opts \\\\ []), do: {data, params, permitted, opts}
end
`,
      'lib/status.ex': `defmodule App.Domain.Status do
  def pending, do: :pending
end
`,
      'lib/outer.ex': `defmodule Outer do
  alias Lib.Changeset

  defmodule Inner do
    def go(x), do: Changeset.cast(x, %{}, [:a])
    def state, do: Status.pending()
  end
end
`,
    });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Outer.Inner::go/1', to: 'Lib.Changeset::cast/4' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Outer.Inner::state/0', to: 'App.Domain.Status::pending/0' });
  });

  it('does not guess between modules that share a trailing alias segment', async () => {
    const { edges } = await index({
      'lib/a.ex': `defmodule A.Status do
  def pending, do: :a
end
`,
      'lib/b.ex': `defmodule B.Status do
  def pending, do: :b
end
`,
      'lib/my.ex': `defmodule MyStatus do
  def done, do: :done
end
`,
      'lib/caller.ex': `defmodule Caller do
  def s, do: Status.pending()
  def d, do: Status.done()
end
`,
    });
    expect(edges.filter((e) => e.from.startsWith('Caller::'))).toEqual([]);
  });

  it('resolves function captures to the captured arity', async () => {
    const { edges } = await index({
      'lib/cap.ex': `defmodule Cap do
  def helper, do: :zero
  def helper(a, b), do: {a, b}
  def run(list), do: Enum.map(list, &helper/2)
  def run_remote(list), do: Enum.map(list, &Cap.helper/2)
  def run_zero, do: (&helper/0).()
end
`,
    });
    expect(edges).toContainEqual({ kind: 'references', from: 'Cap::run/1', to: 'Cap::helper/2' });
    expect(edges).toContainEqual({ kind: 'references', from: 'Cap::run_remote/1', to: 'Cap::helper/2' });
    expect(edges).toContainEqual({ kind: 'references', from: 'Cap::run_zero/0', to: 'Cap::helper/0' });
    expect(edges).not.toContainEqual({ kind: 'references', from: 'Cap::run/1', to: 'Cap::helper/0' });
    expect(edges.filter((e) => e.kind === 'calls' && e.from.startsWith('Cap::run'))).toEqual([]);
  });

  it('re-resolves calls from other files when a callee changes its default arguments', async () => {
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('lib/remote.ex', `defmodule Remote do
  def run(id), do: Opts.get(id)
end
`);
    write('lib/opts.ex', `defmodule Opts do
  def get(id, opts \\\\ []), do: {id, opts}
end
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const runEdges = (): string[] =>
      db
        .prepare(
          `SELECT t.qualified_name q FROM edges e
           JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
           WHERE e.kind = 'calls' AND s.qualified_name = 'Remote::run/1'`
        )
        .all()
        .map((r: { q: string }) => r.q);
    try {
      expect(runEdges()).toEqual(['Opts::get/2']);

      // The default is removed: `Opts.get/1` no longer exists.
      write('lib/opts.ex', `defmodule Opts do
  def get(id, opts), do: {id, opts}
end
`);
      await cg.sync();
      expect(runEdges()).toEqual([]);

      // An exact `get/1` appears: the call lands on it.
      write('lib/opts.ex', `defmodule Opts do
  def get(id), do: {id, []}
  def get(id, opts), do: {id, opts}
end
`);
      await cg.sync();
      expect(runEdges()).toEqual(['Opts::get/1']);
    } finally {
      cg.destroy();
    }
  });

  it('keeps a cross-file call on its arity when the callee file is edited', async () => {
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('lib/remote.ex', `defmodule Remote do
  def run(id), do: Opts.get(id)
end
`);
    write('lib/opts.ex', `defmodule Opts do
  def get(id), do: {id, []}
  def get(id, opts), do: {id, opts}
end
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const runEdges = (): string[] =>
      db
        .prepare(
          `SELECT t.qualified_name q FROM edges e
           JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
           WHERE e.kind = 'calls' AND s.qualified_name = 'Remote::run/1'`
        )
        .all()
        .map((r: { q: string }) => r.q);
    try {
      expect(runEdges()).toEqual(['Opts::get/1']);
      // An unrelated edit must not move the edge to the other same-named arity.
      write('lib/opts.ex', `defmodule Opts do
  # touched
  def get(id), do: {id, []}
  def get(id, opts), do: {id, opts}
end
`);
      await cg.sync();
      expect(runEdges()).toEqual(['Opts::get/1']);
    } finally {
      cg.destroy();
    }
  });

  it('keeps bare calls inside the caller module when a file defines two modules', async () => {
    const { edges } = await index({
      'lib/pair.ex': `defmodule First do
  def work(x), do: {:first, x}
  def run(x), do: work(x)
end

defmodule Second do
  def work(x), do: {:second, x}
  def run(x), do: work(x)
end
`,
    });
    expect(edges).toContainEqual({ kind: 'calls', from: 'First::run/1', to: 'First::work/1' });
    expect(edges).toContainEqual({ kind: 'calls', from: 'Second::run/1', to: 'Second::work/1' });
    expect(edges).not.toContainEqual({ kind: 'calls', from: 'Second::run/1', to: 'First::work/1' });
    expect(edges).not.toContainEqual({ kind: 'calls', from: 'First::run/1', to: 'Second::work/1' });
  });
});
