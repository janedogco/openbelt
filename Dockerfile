# OpenBelt: the platform (the gateway and its Durable Objects, each a SQLite file in OPENBELT_DATA) in one image, and
# `bun scripts/data.ts` for its backups. Chrome is for check_app. The openbelt CLI is built first, for every platform it hands
# out (/install, /_cli/*; docs/cli.md), so each image serves the CLI that matches it.

# cargo-zigbuild's image: zig to link for other platforms, and the macOS SDK; its Rust (1.87) is older than the CLI's
# dependencies take, so a pinned toolchain with every target goes in a layer of its own.
FROM ghcr.io/rust-cross/cargo-zigbuild:0.20.1 AS cli
ENV TARGETS="aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-pc-windows-gnu"
# Windows' import libraries need mingw's dlltool.
RUN apt-get update && apt-get install -y --no-install-recommends binutils-mingw-w64-x86-64 && rm -rf /var/lib/apt/lists/*
RUN rustup toolchain install 1.91.1 --profile minimal --no-self-update $(for t in $TARGETS; do echo --target $t; done) \
  && rustup default 1.91.1
WORKDIR /cli
# The dependencies first, against an empty main, so a change to the CLI's own code rebuilds only that (a layer of its own,
# cached by CI's buildx cache while Cargo.toml and Cargo.lock stay the same).
COPY cli/Cargo.toml cli/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
  && for t in $TARGETS; do cargo zigbuild --release --locked --quiet --target $t; done \
  && rm -rf src
COPY cli/src src
RUN touch src/main.rs && mkdir dist \
  && for t in $TARGETS; do \
       cargo zigbuild --release --locked --quiet --target $t \
       && ext=$(case $t in *windows*) echo .exe;; esac) \
       && cp target/$t/release/openbelt$ext dist/openbelt-$t$ext; \
     done

FROM oven/bun:1.4.0-debian

# check_app's pages reach the network only through the platform's proxy (runtime/egress.ts); WebRTC sends UDP around a proxy
# unless a managed policy forbids it (the command-line flag alone didn't stop it).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /etc/opt/chrome_for_testing/policies/managed \
  && echo '{"WebRtcIPHandling":"disable_non_proxied_udp"}' > /etc/opt/chrome_for_testing/policies/managed/openbelt.json

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/platform/package.json packages/platform/package.json
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bun install --frozen-lockfile --production --ignore-scripts \
  && bun packages/platform/node_modules/playwright-core/cli.js install --with-deps --no-shell chromium

COPY packages packages
COPY scripts/data.ts scripts/data.ts
COPY docs docs
COPY brand brand
# The marketing pages the base host serves under email sign-in (welcome.ts).
COPY www www
COPY VISION.md ./
COPY --from=cli /cli/dist cli/dist

ENV OPENBELT_DATA=/data \
    OPENBELT_PORT=1337

EXPOSE 1337

CMD ["bun", "packages/platform/src/server.ts"]
