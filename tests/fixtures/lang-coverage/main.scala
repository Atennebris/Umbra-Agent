import scala.concurrent.Future
import scala.concurrent.ExecutionContext.Implicits.global

case class Config(host: String, port: Int)

sealed abstract class DaemonError
case class BindError(msg: String) extends DaemonError
case object ConnectionRefused extends DaemonError

trait DaemonService {
  def start(): Future[Unit]
  def stop(): Future[Unit]
}

class UmbraDaemon(config: Config) extends DaemonService {
  override def start(): Future[Unit] = Future {
    println(s"Starting on ${config.host}:${config.port}")
  }

  override def stop(): Future[Unit] = Future {
    println("Stopping daemon")
  }
}

object Registry {
  private var services: List[DaemonService] = Nil

  def register(service: DaemonService): Unit = {
    services = service :: services
  }
}

type HostPort = (String, Int)

def buildDaemon(host: String, port: Int): UmbraDaemon =
  UmbraDaemon(Config(host, port))

given defaultConfig: Config = Config("127.0.0.1", 9876)

val DEFAULT_PORT = 9876
