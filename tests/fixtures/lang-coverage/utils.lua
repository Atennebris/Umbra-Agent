local M = {}

local json = require("dkjson")
local http = require("socket.http")

function M.read_config(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local content = f:read("*a")
  f:close()
  return json.decode(content)
end

function M.write_json(path, data)
  local f = io.open(path, "w")
  if not f then return false end
  f:write(json.encode(data))
  f:close()
  return true
end

local function parse_headers(raw)
  local headers = {}
  for line in raw:gmatch("[^\r\n]+") do
    local k, v = line:match("^(.-):%s*(.+)$")
    if k then headers[k:lower()] = v end
  end
  return headers
end

function M.fetch(url)
  local body, code = http.request(url)
  if code ~= 200 then return nil, code end
  return body
end

Daemon = {}
Daemon.__index = Daemon

function Daemon.new(host, port)
  return setmetatable({ host = host, port = port }, Daemon)
end

function Daemon:start()
  print(string.format("Starting on %s:%d", self.host, self.port))
end

return M
