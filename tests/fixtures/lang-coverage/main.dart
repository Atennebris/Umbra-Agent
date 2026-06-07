import 'dart:async';
import 'dart:io';

abstract class BaseService {
  Future<void> start();
  Future<void> stop();
}

class DaemonService extends BaseService {
  final String host;
  final int port;

  DaemonService({required this.host, required this.port});

  @override
  Future<void> start() async {
    print('Starting daemon on $host:$port');
  }

  @override
  Future<void> stop() async {
    print('Stopping daemon');
  }
}

mixin LogMixin {
  void log(String message) => print('[LOG] $message');
}

extension StringExtension on String {
  bool get isBlank => trim().isEmpty;
}

enum DaemonStatus { running, stopped, error }

void runDaemon(String host, int port) async {
  final service = DaemonService(host: host, port: port);
  await service.start();
}

Future<void> main() async {
  await runDaemon('127.0.0.1', 9876);
}
