#include <iostream>
#include <string>
#include <vector>

namespace umbra {

struct Config {
  std::string name;
  int port;
};

class Server {
public:
  explicit Server(Config cfg) : config_(cfg) {}

  void start() {
    std::cout << "Starting server: " << config_.name << std::endl;
  }

private:
  Config config_;
};

enum class Status { OK, Error, Pending };

template <typename T>
T clamp(T value, T min, T max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

} // namespace umbra

int main() {
  umbra::Config cfg{"umbra", 8080};
  umbra::Server server(cfg);
  server.start();
  return 0;
}
