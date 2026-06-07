const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Config = struct {
  host: []const u8,
  port: u16,
};

pub const ServerError = enum {
  NotFound,
  Unauthorized,
  InternalError,
};

pub const Response = union(enum) {
  ok: []const u8,
  err: ServerError,
};

pub fn startServer(config: Config, allocator: Allocator) !void {
  _ = allocator;
  std.debug.print("Starting on {s}:{d}\n", .{ config.host, config.port });
}

fn handleRequest(path: []const u8) Response {
  if (std.mem.eql(u8, path, "/health")) {
    return .{ .ok = "OK" };
  }
  return .{ .err = .NotFound };
}

pub const DAEMON_PORT: u16 = 9876;
pub var global_config: ?Config = null;

pub fn main() !void {
  var gpa = std.heap.GeneralPurposeAllocator(.{}){};
  const allocator = gpa.allocator();
  const config = Config{ .host = "127.0.0.1", .port = DAEMON_PORT };
  try startServer(config, allocator);
}
