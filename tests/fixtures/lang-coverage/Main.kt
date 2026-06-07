import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.launch

data class Config(val host: String, val port: Int)

sealed class Result<out T> {
  data class Success<T>(val value: T) : Result<T>()
  data class Error(val message: String) : Result<Nothing>()
}

interface DaemonService {
  suspend fun start()
  suspend fun stop()
}

class UmbraDaemon(private val config: Config) : DaemonService {
  override suspend fun start() {
    println("Starting on ${config.host}:${config.port}")
  }

  override suspend fun stop() {
    println("Stopping daemon")
  }
}

object Registry {
  private val services = mutableListOf<DaemonService>()

  fun register(service: DaemonService) {
    services.add(service)
  }
}

enum class Phase { SEED, PUBLIC, CLOSED }

typealias HostPort = Pair<String, Int>

fun buildConfig(host: String, port: Int): Config = Config(host, port)

val DEFAULT_PORT = 9876
var activeConfig: Config? = null

fun main() = runBlocking {
  val config = buildConfig("127.0.0.1", DEFAULT_PORT)
  val daemon = UmbraDaemon(config)
  launch { daemon.start() }
}
