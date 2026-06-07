# Umbra CLI Notes

## Architecture

The daemon runs as a PM2 process and exposes an HTTP gateway.

### Context Engine

Parses source files via tree-sitter to build a compact repo map.

#### Supported Languages

- JavaScript, TypeScript, TSX
- Python, Go, GML

## Usage

Start the daemon with `umbra start`.

### Commands

Run `/help` to list available commands.
