-module(umbra_daemon).
-export([start/0, start/2, stop/1, handle_request/1]).
-export([init/1, handle_call/3, handle_cast/2]).

-record(state, {host, port, socket}).

start() ->
  gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

start(Host, Port) ->
  gen_server:start_link({local, ?MODULE}, ?MODULE, [{host, Host}, {port, Port}], []).

stop(Pid) ->
  gen_server:call(Pid, stop).

handle_request(Path) ->
  case Path of
    "/health" -> {ok, <<"OK">>};
    _ -> {error, not_found}
  end.

init(Opts) ->
  Host = proplists:get_value(host, Opts, "127.0.0.1"),
  Port = proplists:get_value(port, Opts, 9876),
  {ok, #state{host = Host, port = Port}}.

handle_call(stop, _From, State) ->
  {stop, normal, ok, State};
handle_call(_Request, _From, State) ->
  {reply, ok, State}.

handle_cast(_Msg, State) ->
  {noreply, State}.
