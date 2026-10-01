/**
 * Phoenix router: route nodes bound to the code that serves them, and the
 * pipelines a request passes through on the way.
 *
 * Each route is a `route` node named `METHOD /path` with a `references` edge
 * to its handler — the controller action (`Ctrl::action/2`) or the LiveView's
 * `mount/3` (`render/1` when it has none). A `pipeline :browser do … end`
 * compiles to a function `browser/2` on the router, so it is indexed as one:
 * a route `calls` the pipelines its scope pipes through, and a pipeline
 * `calls` each plug it runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

const ROUTER = `defmodule AppWeb.Router do
  use AppWeb, :router
  import AppWeb.UserAuth

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_current_user
    plug AppWeb.Plugs.Locale
    on_ee(do: plug(AppWeb.Plugs.EeOnly))
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", AppWeb do
    pipe_through :browser

    get "/", PageController, :home
    resources "/users", UserController, only: [:index, :show, :update] do
      resources "/posts", PostController, only: [:index]
    end
    resources "/account", AccountController, singleton: true, only: [:show]

    live_session :default, on_mount: AppWeb.Hooks do
      live "/dashboard", DashboardLive, :index, as: :dash
      live "/static", StaticLive
    end
  end

  scope "/admin", AppWeb.Admin, as: :admin do
    pipe_through [:browser, AppWeb.Plugs.RequireAdmin]
    scope [] do
      post "/reindex", ToolsController, :reindex
    end
  end

  scope path: "/api", alias: AppWeb.Api do
    pipe_through :api
    match :*, "/echo", EchoController, :echo
    forward "/legacy", LegacyRouter
  end

  on_ee do
    scope "/ee", AppWeb do
      get "/billing", BillingController, :show
    end
  end

  get "/health", AppWeb.HealthController, :check
  scope "/v2", AppWeb do
    for prefix <- ["/", "/repos/:repository"] do
      scope prefix do
        get "/pkgs/:name", PageController, :home
      end
    end

    for kind <- ["docs", "readme"] do
      get "/files/#{kind}", PageController, :home
    end

    # Computed at compile time: no static address, so no route.
    for kind <- Files.kinds(), kind != :readme do
      get "/dyn/#{kind}", PageController, :home
      scope kind do
        get "/x", PageController, :home
      end
    end
  end

  get "/spec", AppWeb.Plugs.Locale, []
  get("/docs", AppWeb.Plugs.Locale, path: "/spec")
end
`;

const FILES: Record<string, string> = {
  'mix.exs': `defmodule App.MixProject do
  use Mix.Project
  def project, do: [app: :app, deps: deps()]
  defp deps, do: [{:phoenix, "~> 1.7"}]
end
`,
  'lib/app_web/router.ex': ROUTER,
  'lib/app_web/user_auth.ex': `defmodule AppWeb.UserAuth do
  def fetch_current_user(conn, _opts), do: conn
end
`,
  'lib/app_web/plugs.ex': `defmodule AppWeb.Plugs.Locale do
  def init(opts), do: opts
  def call(conn, _opts), do: conn
end

defmodule AppWeb.Plugs.RequireAdmin do
  def init(opts), do: opts
  def call(conn, _opts), do: conn
end

defmodule AppWeb.Plugs.EeOnly do
  def call(conn, _opts), do: conn
end
`,
  'lib/app_web/controllers.ex': `defmodule AppWeb.PageController do
  def home(conn, _params), do: conn
end

defmodule AppWeb.UserController do
  def index(conn, _params), do: conn
  def show(conn, _params), do: conn
  def update(conn, _params), do: conn
  def delete(conn, _params), do: conn
end

defmodule AppWeb.PostController do
  def index(conn, _params), do: conn
end

defmodule AppWeb.AccountController do
  def show(conn, _params), do: conn
end

defmodule AppWeb.Admin.ToolsController do
  def reindex(conn, _params), do: conn
end

defmodule AppWeb.Api.EchoController do
  def echo(conn, _params), do: conn
end

defmodule AppWeb.Api.LegacyRouter do
  def call(conn, _opts), do: conn
end

defmodule AppWeb.BillingController do
  def show(conn, _params), do: conn
end

defmodule AppWeb.HealthController do
  def check(conn, _params), do: conn
end
`,
  'lib/app_web/live.ex': `defmodule AppWeb.DashboardLive do
  def mount(_params, _session, socket), do: {:ok, socket}
  def render(assigns), do: assigns
end

defmodule AppWeb.StaticLive do
  def render(assigns), do: assigns
end
`,
};

interface Edge {
  kind: string;
  from: string;
  to: string;
}

describe('Phoenix router', () => {
  let dir: string;
  let routes: string[];
  let edges: Edge[];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-router-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    routes = db
      .prepare(`SELECT name FROM nodes WHERE kind = 'route' ORDER BY name`)
      .all()
      .map((r: { name: string }) => r.name);
    edges = db
      .prepare(
        `SELECT e.kind kind,
                CASE WHEN s.kind = 'route' THEN s.name ELSE s.qualified_name END "from",
                t.qualified_name "to"
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind IN ('calls', 'references')
           AND (s.kind = 'route' OR s.qualified_name LIKE 'AppWeb.Router::%')`
      )
      .all();
    cg.destroy();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const handlerOf = (route: string) =>
    edges.filter((e) => e.from === route && e.kind === 'references').map((e) => e.to);
  const pipelinesOf = (route: string) =>
    edges.filter((e) => e.from === route && e.kind === 'calls').map((e) => e.to).sort();

  it('names every route with its method and full scoped path', () => {
    expect(routes).toEqual(
      [
        '* /api/echo',
        '* /api/legacy/*',
        'GET /',
        'GET /account',
        'GET /docs',
        'GET /spec',
        'GET /dashboard',
        'GET /ee/billing',
        'GET /health',
        'GET /static',
        'GET /users',
        'GET /users/:id',
        'GET /users/:user_id/posts',
        'GET /v2/files/docs',
        'GET /v2/files/readme',
        'GET /v2/pkgs/:name',
        'GET /v2/repos/:repository/pkgs/:name',
        'PATCH /users/:id',
        'POST /admin/reindex',
        'PUT /users/:id',
      ].sort()
    );
  });

  it('binds controller routes to the action, through scope aliases', () => {
    expect(handlerOf('GET /')).toEqual(['AppWeb.PageController::home/2']);
    expect(handlerOf('GET /users/:id')).toEqual(['AppWeb.UserController::show/2']);
    expect(handlerOf('PUT /users/:id')).toEqual(['AppWeb.UserController::update/2']);
    expect(handlerOf('GET /users/:user_id/posts')).toEqual(['AppWeb.PostController::index/2']);
    expect(handlerOf('GET /account')).toEqual(['AppWeb.AccountController::show/2']);
    expect(handlerOf('POST /admin/reindex')).toEqual(['AppWeb.Admin.ToolsController::reindex/2']);
    expect(handlerOf('* /api/echo')).toEqual(['AppWeb.Api.EchoController::echo/2']);
    expect(handlerOf('GET /ee/billing')).toEqual(['AppWeb.BillingController::show/2']);
    expect(handlerOf('GET /health')).toEqual(['AppWeb.HealthController::check/2']);
  });

  it('binds LiveView routes to mount/3, or render/1 when there is no mount', () => {
    expect(handlerOf('GET /dashboard')).toEqual(['AppWeb.DashboardLive::mount/3']);
    expect(handlerOf('GET /static')).toEqual(['AppWeb.StaticLive::render/1']);
  });

  it('binds a forward, and a route to a plug, to that plug', () => {
    expect(handlerOf('* /api/legacy/*')).toEqual(['AppWeb.Api.LegacyRouter::call/2']);
    expect(handlerOf('GET /spec')).toEqual(['AppWeb.Plugs.Locale::call/2']);
    expect(handlerOf('GET /docs')).toEqual(['AppWeb.Plugs.Locale::call/2']);
  });

  it('links each route to the pipelines and plugs its scope pipes through', () => {
    expect(pipelinesOf('GET /')).toEqual(['AppWeb.Router::browser/2']);
    expect(pipelinesOf('GET /users/:user_id/posts')).toEqual(['AppWeb.Router::browser/2']);
    expect(pipelinesOf('POST /admin/reindex')).toEqual([
      'AppWeb.Plugs.RequireAdmin::call/2',
      'AppWeb.Router::browser/2',
    ]);
    expect(pipelinesOf('* /api/echo')).toEqual(['AppWeb.Router::api/2']);
    // Outside any pipe_through.
    expect(pipelinesOf('GET /ee/billing')).toEqual([]);
    expect(pipelinesOf('GET /health')).toEqual([]);
  });

  it('indexes a pipeline as a router function that calls its plugs', () => {
    const plugs = edges
      .filter((e) => e.from === 'AppWeb.Router::browser/2' && e.kind === 'calls')
      .map((e) => e.to)
      .sort();
    expect(plugs).toEqual([
      'AppWeb.Plugs.EeOnly::call/2',
      'AppWeb.Plugs.Locale::call/2',
      'AppWeb.UserAuth::fetch_current_user/2',
    ]);
  });
});
