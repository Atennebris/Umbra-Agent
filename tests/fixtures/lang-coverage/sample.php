<?php

namespace Umbra\Core;

use Umbra\Contracts\ServiceInterface;

class DaemonService implements ServiceInterface
{
    private string $host;
    private int $port;

    public function __construct(string $host, int $port)
    {
        $this->host = $host;
        $this->port = $port;
    }

    public function start(): void
    {
        echo "Starting on {$this->host}:{$this->port}";
    }

    public function stop(): void
    {
        echo "Stopping";
    }
}

interface ServiceInterface
{
    public function start(): void;
    public function stop(): void;
}

function createService(string $host, int $port): DaemonService
{
    return new DaemonService($host, $port);
}
