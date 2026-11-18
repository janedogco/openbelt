# Caddy with the Cloudflare DNS module, for a wildcard certificate by DNS challenge (OPENBELT_TLS=dns: a stage nothing public can
# reach, such as one on a tailnet). scripts/deploy.ts builds it on the server as openbelt-caddy:2.10.2-cf0.2.4 the first time it's needed.
FROM caddy:2.10.2-builder AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare@v0.2.4

FROM caddy:2.10.2
COPY --from=build /usr/bin/caddy /usr/bin/caddy
