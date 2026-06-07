include config.mk

NODE_BIN = node
DIST_DIR = dist
SRC_DIR  = src

.PHONY: build test lint clean install

build:
	pnpm build

test:
	pnpm test

lint:
	pnpm lint

clean:
	rm -rf $(DIST_DIR)

install:
	pnpm install

release: build test lint
	node scripts/release.js
