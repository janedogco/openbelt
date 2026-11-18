#!/bin/sh
# A stage's data, copied off the machine once a night with its history kept: `bun run data backup` (consistent while the platform
# runs) in a container of the image the stage runs, tarred and put in an S3-compatible bucket as <stage>/<when>.tar.gz. The
# continuous copy (OPENBELT_BACKUP_URL) keeps only the newest state; this keeps one a night, for as long as the bucket's lifecycle
# rule does. docs/running.md, "Backups".
#
# On the server, as deploy (it runs Docker): /usr/local/bin/openbelt-nightly <stage>, from deploy's crontab, with
# ~/.config/openbelt-nightly.env (mode 600): KEY_ID, SECRET (a token for that bucket alone), ENDPOINT, BUCKET.
#   0 9 * * * /usr/local/bin/openbelt-nightly prod >> /home/deploy/nightly.log 2>&1
#
# Restore: download <stage>/<when>.tar.gz, untar it, and `bun run data restore <dir>/data --data <data>` with the platform stopped.
set -eu
stage="${1:-prod}"
dir="$HOME/openbelt-$stage"
work="$HOME/nightly-$stage"
image=$(sed -n 's/^OPENBELT_IMAGE=//p' "$dir/.env")
when=$(date -u +%Y-%m-%dT%H%MZ)
mkdir -p "$work"
docker run --rm --env-file "$HOME/.config/openbelt-nightly.env" -e KEY="$stage/$when.tar.gz" \
  -v "$dir/data:/data" -v "$work:/work" "$image" sh -ec '
    rm -rf /work/data /work/data.tar.gz
    bun run data backup /work/data --data /data > /dev/null
    tar -C /work -czf /work/data.tar.gz data
    bun -e "
      const c = new Bun.S3Client({ accessKeyId: process.env.KEY_ID, secretAccessKey: process.env.SECRET, bucket: process.env.BUCKET, endpoint: process.env.ENDPOINT })
      const f = Bun.file(\"/work/data.tar.gz\")
      await c.write(process.env.KEY, f)
      console.log(\"nightly: \" + process.env.BUCKET + \"/\" + process.env.KEY, f.size, \"bytes\")
    "
    rm -rf /work/data /work/data.tar.gz'
