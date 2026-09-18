#!/usr/bin/env bash
#
# Put the display face on cdn.i10.tech.
#
# ⚠ THE FILES ARE NOT IN THIS REPOSITORY AND MUST NOT BE. A licensed typeface in
# a git history is a redistribution that cannot be undone — history is public to
# everyone who has ever cloned, and `git rm` does not reach them. The face lives
# wherever the licence says it may, and this script is the one-way door between
# there and the CDN.
#
# ⚠ AND THE LICENCE IS THE FIRST THING TO CHECK, NOT THE LAST. Serving a font
# from a public CDN is redistribution in the plain sense: anybody can fetch the
# file. Most commercial webfont licences permit exactly that, from a domain you
# own, up to a pageview count — and most DESKTOP licences do not permit it at
# all. Amazon Ember in particular is Amazon's own corporate face, offered for
# building and marketing on Amazon's platforms, which is not what this is.
# Confirm the grant covers self-hosted web use for i10 before running this.
#
# Usage:
#   infra/scripts/publish-fonts.sh <directory-of-woff2>
#   infra/scripts/publish-fonts.sh <directory-of-woff2> --dry-run
#
# Expects, in the environment or through `doppler run --`:
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
set -euo pipefail

BUCKET="${R2_FONT_BUCKET:-i10}"
PREFIX="fonts"

src="${1:-}"
dry="${2:-}"

if [[ -z "$src" || ! -d "$src" ]]; then
  echo "usage: $0 <directory-of-woff2> [--dry-run]" >&2
  exit 64
fi

for var in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "missing $var — try: doppler run -- $0 $*" >&2
    exit 78
  fi
done

endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# ⚠ THE NAMES ARE FIXED BY packages/ui/src/styles/fonts.css, WHICH IS WHY THEY
# ARE CHECKED HERE RATHER THAN GLOBBED. Uploading `AmazonEmberDisplay_W_Rg.woff2`
# would succeed, serve, and change nothing on the site — the stylesheet asks for
# a different path and gets a 404 it is designed to survive silently. A missing
# font is the hardest kind of deploy to notice, so the only defence is refusing
# to publish a name nothing references.
expected=(i10-display-400.woff2 i10-display-700.woff2)

missing=()
for name in "${expected[@]}"; do
  [[ -f "$src/$name" ]] || missing+=("$name")
done

if (( ${#missing[@]} )); then
  echo "not found in $src:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "Rename the licensed files to these, or change both this list and the" >&2
  echo "@font-face src in packages/ui/src/styles/fonts.css together." >&2
  exit 66
fi

for name in "${expected[@]}"; do
  file="$src/$name"
  size=$(wc -c < "$file" | tr -d ' ')

  # ⚠ A woff2 STARTS WITH THE ASCII BYTES `wOF2`, AND CHECKING IS NOT PARANOIA.
  # The usual way this goes wrong is a .ttf or .otf renamed to .woff2 by hand,
  # which uploads happily and then fails to parse in every browser — with the
  # page still rendering, in the fallback, looking exactly like a font that has
  # not finished loading.
  magic=$(head -c 4 "$file")
  if [[ "$magic" != "wOF2" ]]; then
    echo "$name is not a woff2 file (magic: '$magic')" >&2
    exit 65
  fi

  echo "  $name  ${size} bytes"

  if [[ "$dry" == "--dry-run" ]]; then
    continue
  fi

  # ⚠ IMMUTABLE FOR A YEAR, AND THAT IS SAFE ONLY BECAUSE THE PATH IS STABLE.
  # A font is the most cacheable thing a site serves and the most expensive to
  # re-fetch — but `immutable` means a browser will not revalidate for a year,
  # so REPLACING a file at this path leaves people on the old one until their
  # cache expires. To ship a different cut, publish it under a new name and
  # change the @font-face src; do not overwrite in place and expect it to land.
  #
  # ⚠ AND `font/woff2` IS THE REGISTERED TYPE (RFC 8081). R2 would otherwise
  # infer `application/octet-stream`, which browsers accept for fonts today and
  # which makes a `Content-Type`-based CDN rule or CSP silently not apply.
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION=auto \
  aws s3 cp "$file" "s3://${BUCKET}/${PREFIX}/${name}" \
    --endpoint-url "$endpoint" \
    --content-type font/woff2 \
    --cache-control "public, max-age=31536000, immutable" \
    --only-show-errors
done

if [[ "$dry" == "--dry-run" ]]; then
  echo
  echo "dry run — nothing uploaded"
  exit 0
fi

echo
echo "published to s3://${BUCKET}/${PREFIX}/"
echo "verify:  curl -sI https://cdn.i10.tech/fonts/i10-display-400.woff2"
