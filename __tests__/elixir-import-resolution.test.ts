/**
 * Elixir bare calls into functions brought in by `import` and `use`.
 *
 * A bare `f(x)` can only mean a function of the caller's own module or one an
 * `import` puts in lexical scope — directly, or through the code a `use`
 * injects (ExUnit.CaseTemplate's `using`, `defmacro __using__`, and Phoenix's
 * `use AppWeb, :controller`, which injects the quote `def controller` returns).
 * Calls resolve only when exactly one in-repo function of that arity is in
 * scope; anything ambiguous or out of scope stays unresolved.
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

describe('Elixir import/use resolution', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elixir-import-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
  }

  function edgesOf(cg: CodeGraph): Edge[] {
    return (cg as any).db.db
      .prepare(
        `SELECT e.kind kind, s.qualified_name "from", t.qualified_name "to"
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind IN ('calls', 'references') AND t.kind = 'function'`
      )
      .all();
  }

  async function index(files: Record<string, string>): Promise<Edge[]> {
    write(files);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const edges = edgesOf(cg);
    cg.destroy();
    return edges;
  }

  const from = (edges: Edge[], caller: string) => edges.filter((e) => e.from === caller);

  it('resolves a bare call to a public function of an imported module', async () => {
    const edges = await index({
      'lib/helpers.ex': `defmodule App.Helpers do
  def format(x), do: x
  def format(x, y), do: {x, y}
  defp secret(x), do: x
end
`,
      'lib/user.ex': `defmodule App.User do
  alias App.Helpers
  import Helpers

  def show(x), do: format(x)
  def pair(x), do: format(x, 1)
  def peek(x), do: secret(x)
end
`,
    });
    expect(from(edges, 'App.User::show/1')).toEqual([{ kind: 'calls', from: 'App.User::show/1', to: 'App.Helpers::format/1' }]);
    expect(from(edges, 'App.User::pair/1')).toEqual([{ kind: 'calls', from: 'App.User::pair/1', to: 'App.Helpers::format/2' }]);
    expect(from(edges, 'App.User::peek/1')).toEqual([]);
  });

  it('honours only: and except: lists on an import', async () => {
    const edges = await index({
      'lib/h.ex': `defmodule H do
  def a(x), do: x
  def b(x), do: x
end
`,
      'lib/only.ex': `defmodule OnlyA do
  import H, only: [a: 1]
  def run(x), do: {a(x), b(x)}
end
`,
      'lib/except.ex': `defmodule ExceptA do
  import H, except: [a: 1]
  def run(x), do: {a(x), b(x)}
end
`,
    });
    expect(from(edges, 'OnlyA::run/1').map((e) => e.to)).toEqual(['H::a/1']);
    expect(from(edges, 'ExceptA::run/1').map((e) => e.to)).toEqual(['H::b/1']);
  });

  it('scopes imports lexically: an outer import covers nested modules, not siblings', async () => {
    const edges = await index({
      'lib/h.ex': `defmodule H do
  def a(x), do: x
end
`,
      'lib/outer.ex': `defmodule Outer do
  import H

  defmodule Inner do
    def run(x), do: a(x)
  end
end

defmodule Sibling do
  def run(x), do: a(x)
end
`,
    });
    expect(from(edges, 'Outer.Inner::run/1').map((e) => e.to)).toEqual(['H::a/1']);
    expect(from(edges, 'Sibling::run/1')).toEqual([]);
  });

  it('stays silent when two imported modules define the same function', async () => {
    const edges = await index({
      'lib/a.ex': `defmodule A do
  def go(x), do: x
end
`,
      'lib/b.ex': `defmodule B do
  def go(x), do: x
end
`,
      'lib/c.ex': `defmodule C do
  import A
  import B
  def run(x), do: go(x)
end
`,
    });
    expect(from(edges, 'C::run/1')).toEqual([]);
  });

  it('resolves functions a CaseTemplate injects and the modules its using block imports', async () => {
    const edges = await index({
      'test/support/conn_case.ex': `defmodule App.ConnCase do
  use ExUnit.CaseTemplate

  using do
    quote do
      import Plug.Conn
      import App.ConnCase

      def authenticate(conn), do: conn
    end
  end

  def register_user(attrs), do: attrs
end
`,
      'test/app_test.exs': `defmodule App.AppTest do
  use App.ConnCase, async: true

  test "works" do
    conn = authenticate(build_conn())
    register_user(%{})
  end
end
`,
    });
    const targets = from(edges, 'App.AppTest').map((e) => e.to).sort();
    expect(targets).toEqual(['App.ConnCase::authenticate/1', 'App.ConnCase::register_user/1']);
  });

  it('does not expose a used module’s ordinary functions without an import', async () => {
    const edges = await index({
      'lib/plain.ex': `defmodule Plain do
  defmacro __using__(_opts) do
    quote do
      def injected(x), do: x
    end
  end

  def ordinary(x), do: x
end
`,
      'lib/user.ex': `defmodule User do
  use Plain
  def run(x), do: {injected(x), ordinary(x)}
end
`,
    });
    expect(from(edges, 'User::run/1').map((e) => e.to)).toEqual(['Plain::injected/1']);
  });

  it('follows import unquote(__MODULE__) and nested use inside a __using__ quote', async () => {
    const edges = await index({
      'lib/utils.ex': `defmodule App.TestUtils do
  defmacro __using__(_) do
    quote do
      import unquote(__MODULE__)
    end
  end

  def util(x), do: x
end
`,
      'lib/case.ex': `defmodule App.DataCase do
  defmacro __using__(_) do
    quote do
      use App.TestUtils
    end
  end
end
`,
      'test/t.exs': `defmodule App.T do
  use App.DataCase
  def run(x), do: util(x)
end
`,
    });
    expect(from(edges, 'App.T::run/1').map((e) => e.to)).toEqual(['App.TestUtils::util/1']);
  });

  it("resolves Phoenix's use AppWeb, :which through the quote that function returns", async () => {
    const edges = await index({
      'lib/app_web.ex': `defmodule AppWeb do
  def controller do
    quote do
      import AppWeb.ControllerHelpers
      unquote(shared())
    end
  end

  def live_view do
    quote do
      import AppWeb.LiveHelpers
    end
  end

  defp shared do
    quote do
      import AppWeb.Gettext
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
`,
      'lib/helpers.ex': `defmodule AppWeb.ControllerHelpers do
  def render_json(conn, data), do: {conn, data}
end

defmodule AppWeb.LiveHelpers do
  def live_only(x), do: x
end

defmodule AppWeb.Gettext do
  def t(msg), do: msg
end
`,
      'lib/page_controller.ex': `defmodule AppWeb.PageController do
  use AppWeb, :controller

  def index(conn, _params) do
    render_json(conn, t("hi"))
    live_only(conn)
  end
end
`,
    });
    const targets = from(edges, 'AppWeb.PageController::index/2').map((e) => e.to).sort();
    expect(targets).toEqual(['AppWeb.ControllerHelpers::render_json/2', 'AppWeb.Gettext::t/1']);
  });

  it('does not apply directives inside a quote to the module that defines it', async () => {
    const edges = await index({
      'lib/h.ex': `defmodule H do
  def a(x), do: x
end
`,
      'lib/provider.ex': `defmodule Provider do
  defmacro __using__(_) do
    quote do
      import H
    end
  end

  def own(x), do: a(x)
end
`,
    });
    expect(from(edges, 'Provider::own/1')).toEqual([]);
  });

  it('keeps import-resolved edges when the imported module’s file is edited', async () => {
    write({
      'lib/h.ex': `defmodule H do
  def a(x), do: x
end
`,
      'lib/user.ex': `defmodule User do
  import H
  def run(x), do: a(x)
end
`,
    });
    const cg = await CodeGraph.init(dir, { silent: true });
    try {
      await cg.indexAll();
      expect(from(edgesOf(cg), 'User::run/1').map((e) => e.to)).toEqual(['H::a/1']);
      write({
        'lib/h.ex': `defmodule H do
  # touched
  def a(x), do: x
end
`,
      });
      await cg.sync();
      expect(from(edgesOf(cg), 'User::run/1').map((e) => e.to)).toEqual(['H::a/1']);
    } finally {
      cg.destroy();
    }
  });
});
