#!/usr/bin/env bash
set -euo pipefail

suffix="${1:?usage: backup-production.sh <suffix>}"
package_root="/home/ravi/.nvm/versions/node/v22.22.2/lib/node_modules"
backup_dir="/home/ravi/.ravi/backups"
package_backup="$backup_dir/ravi.bot-3.260817.2-pre-$suffix.tgz"
db_backup="$backup_dir/ravi.db-pre-$suffix.sqlite"

test ! -e "$package_backup"
test ! -e "$db_backup"

tar -czf "$package_backup" -C "$package_root" ravi.bot
sqlite3 /home/ravi/.ravi/ravi.db ".backup '$db_backup'"
chown ravi:ravi "$package_backup" "$db_backup"

sha256sum "$package_backup" "$db_backup"

