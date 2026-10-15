#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly UTIF_URL="https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.min.js"

output="${1:-$SCRIPT_DIR/dist/index.html}"
case "$output" in
  /*) ;;
  *) output="$PWD/$output" ;;
esac

for asset in index.html styles.css config.js colorpicker.js admin.js app.js; do
  if [[ ! -f "$SCRIPT_DIR/$asset" ]]; then
    printf 'Missing required asset: %s\n' "$SCRIPT_DIR/$asset" >&2
    exit 1
  fi
done

temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"' EXIT
utif="$temporary_dir/UTIF.min.js"

curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 "$UTIF_URL" --output "$utif"
if [[ ! -s "$utif" ]]; then
  printf 'Downloaded UTIF runtime is empty.\n' >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$output")"

embed_style() {
  printf '    <style>\n'
  sed 's#</style#<\\/style#gI' "$SCRIPT_DIR/styles.css"
  printf '    </style>\n'
}

embed_script() {
  local asset="$1"
  printf '    <script>\n'
  sed 's#</script#<\\/script#gI' "$asset"
  printf '    </script>\n'
}

while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    '    <link rel="stylesheet" href="styles.css" />')
      embed_style
      ;;
    '    <script src="https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.min.js"></script>')
      embed_script "$utif"
      ;;
    '    <script src="config.js"></script>')
      embed_script "$SCRIPT_DIR/config.js"
      ;;
    '    <script src="colorpicker.js"></script>')
      embed_script "$SCRIPT_DIR/colorpicker.js"
      ;;
    '    <script src="admin.js"></script>')
      embed_script "$SCRIPT_DIR/admin.js"
      ;;
    '    <script src="app.js"></script>')
      embed_script "$SCRIPT_DIR/app.js"
      ;;
    *)
      printf '%s\n' "$line"
      ;;
  esac
done < "$SCRIPT_DIR/index.html" > "$output"

printf 'Bundled standalone HTML: %s\n' "$output"
