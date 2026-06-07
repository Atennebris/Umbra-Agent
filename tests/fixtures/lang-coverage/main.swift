import Foundation
import Network

protocol DaemonServiceProtocol {
  func start() async throws
  func stop() async
}

struct Config {
  let host: String
  let port: UInt16
}

enum DaemonError: Error {
  case bindFailed(String)
  case connectionRefused
}

class UmbraDaemon: DaemonServiceProtocol {
  private let config: Config

  init(config: Config) {
    self.config = config
  }

  func start() async throws {
    print("Starting daemon on \(config.host):\(config.port)")
  }

  func stop() async {
    print("Stopping daemon")
  }
}

actor Registry {
  private var services: [DaemonServiceProtocol] = []

  func register(_ service: DaemonServiceProtocol) {
    services.append(service)
  }
}

extension Config {
  static let `default` = Config(host: "127.0.0.1", port: 9876)
}

typealias CompletionHandler = (Result<Void, DaemonError>) -> Void

func buildDaemon(host: String, port: UInt16) -> UmbraDaemon {
  UmbraDaemon(config: Config(host: host, port: port))
}

@main
struct UmbraApp {
  static func main() async throws {
    let daemon = buildDaemon(host: "127.0.0.1", port: 9876)
    try await daemon.start()
  }
}
