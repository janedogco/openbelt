// The CLI routes (docs/cli.md): /install, the script `curl -fsSL <host>/install | sh` runs, and
// /_cli/openbelt-<target>[.exe] with its .sha256, the builds this platform has (runtime/cli.ts). Public: a CLI is
// what someone fetches before they're signed in, and it holds nothing of the workspace's. On a workspace's host the script
// signs in there; on the platform's own address (no workspace in it) it lets openbelt install ask which workspace.
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { CLI_TARGETS, type CliTarget, cliBuild, cliFile } from "./runtime/cli.ts"

export const CLI_ROUTE = /^\/(install|_cli\/openbelt-[a-z0-9_-]+(\.exe)?(\.sha256)?)$/

const targetOf = (file: string): CliTarget | undefined =>
  CLI_TARGETS.find((t) => cliFile(t) === file)

/** Where an install script downloads from, and the workspace it signs in to (none on the platform's own address). */
export type InstallFrom =
  | { readonly kind: "workspace"; readonly origin: string }
  | { readonly kind: "platform"; readonly origin: string }

/** The binary for this machine, checked, then openbelt install: at the workspace, or asking which. */
const script = (from: InstallFrom) => {
  const { origin } = from
  const signIn = from.kind === "workspace" ? '"$ORIGIN" "$@"' : '"$@"'

  return `#!/bin/sh
# Installs the openbelt CLI from ${origin} and ${from.kind === "workspace" ? "signs you in there" : "signs you in to your workspace (openbelt install asks which)"}: curl -fsSL ${origin}/install | sh
# OPENBELT_INSTALL_DIR picks where it goes (default ~/.local/bin); arguments go on to openbelt install.
set -eu
ORIGIN='${origin}'
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) T=aarch64-apple-darwin ;;
  Darwin-x86_64) T=x86_64-apple-darwin ;;
  Linux-x86_64 | Linux-amd64) T=x86_64-unknown-linux-musl ;;
  Linux-aarch64 | Linux-arm64) T=aarch64-unknown-linux-musl ;;
  *)
    echo "openbelt: there's no build for $(uname -s) $(uname -m) here. On Windows, download $ORIGIN/_cli/openbelt-x86_64-pc-windows-gnu.exe" >&2
    exit 1 ;;
esac
DIR="\${OPENBELT_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$DIR"
TMP="$(mktemp "$DIR/.openbelt.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$ORIGIN/_cli/openbelt-$T" -o "$TMP"
WANT="$(curl -fsSL "$ORIGIN/_cli/openbelt-$T.sha256")"
if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP" | cut -d' ' -f1)"; else GOT="$(shasum -a 256 "$TMP" | cut -d' ' -f1)"; fi
if [ "$GOT" != "$WANT" ]; then
  echo "openbelt: the download doesn't match its sha256 ($GOT, not $WANT); nothing was installed" >&2
  exit 1
fi
chmod 755 "$TMP"
mv "$TMP" "$DIR/openbelt"
trap - EXIT
echo "openbelt is in $DIR/openbelt"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Add it to your PATH: export PATH=\\"$DIR:\\$PATH\\"" ;;
esac
if [ -t 1 ] && (exec </dev/tty) 2>/dev/null; then
  OPENBELT_FROM="$ORIGIN" exec "$DIR/openbelt" install ${signIn} </dev/tty
else
  OPENBELT_FROM="$ORIGIN" exec "$DIR/openbelt" install ${signIn}
fi
`
}

/** An origin that is only a scheme, a host's letters, digits, dots and dashes, and a port: safe inside the script's quotes. */
const PLAIN_ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i

/** /install and /_cli/*, or undefined for any other path. */
export const cliResponse = (path: string, from: InstallFrom) => {
  // The platform's own address comes from the request's Host, which a script piped to sh mustn't carry anything else of.
  if (path === "/install" && !PLAIN_ORIGIN.test(from.origin))
    return HttpServerResponse.text(
      `No install script for ${JSON.stringify(from.origin)}: not a plain host name.\n`,
      {
        status: 400,
      },
    )

  if (path === "/install")
    return HttpServerResponse.text(script(from), {
      contentType: "text/x-shellscript; charset=utf-8",
      headers: { "cache-control": "no-cache" },
    })

  const file = path.slice("/_cli/".length)
  const sha = file.endsWith(".sha256")
  const target = targetOf(sha ? file.slice(0, -".sha256".length) : file)
  const build = target === undefined ? undefined : cliBuild(target)

  if (build === undefined)
    return HttpServerResponse.text(
      `This OpenBelt has no ${file}: its builds are openbelt-<target> for ${CLI_TARGETS.join(", ")}, when it has them (docs/cli.md).\n`,
      { status: 404 },
    )

  if (sha)
    return HttpServerResponse.text(`${build.sha256}\n`, {
      headers: { "cache-control": "no-cache" },
    })

  return HttpServerResponse.uint8Array(build.bytes, {
    contentType: "application/octet-stream",
    headers: {
      "cache-control": "no-cache",
      etag: `"${build.sha256}"`,
      "content-disposition": `attachment; filename="${build.file}"`,
    },
  })
}
