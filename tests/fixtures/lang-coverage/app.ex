defmodule Umbra.Application do
  use Application

  def start(_type, _args) do
    children = [
      Umbra.Daemon,
      Umbra.Registry,
    ]
    opts = [strategy: :one_for_one, name: Umbra.Supervisor]
    Supervisor.start_link(children, opts)
  end
end

defmodule Umbra.Daemon do
  use GenServer

  defstruct host: "127.0.0.1", port: 9876

  defprotocol Service do
    def start(service)
    def stop(service)
  end

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(opts) do
    host = Keyword.get(opts, :host, "127.0.0.1")
    port = Keyword.get(opts, :port, 9876)
    {:ok, %{host: host, port: port}}
  end

  def handle_call(:status, _from, state) do
    {:reply, :ok, state}
  end

  defp connect(host, port) do
    :gen_tcp.connect(String.to_charlist(host), port, [:binary])
  end

  defmacro with_retry(do: block) do
    quote do
      unquote(block)
    end
  end
end
