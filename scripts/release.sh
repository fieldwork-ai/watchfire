#!/usr/bin/env bash
#
# Publish the version currently on main, and tag it.
#
# The version bump is NOT this script's job. It rides the pull request that
# makes the change, so the diff that alters behavior is the diff that declares
# the new version and reviewers see both together. By the time this runs, main
# already says what it is; the script's job is to get that onto npm and into a
# tag without the two drifting apart.
#
# That drift is the reason it exists. Tagging used to be a side effect of
# `npm version`, so when the bump moved into the pull request the tags stopped
# and nobody noticed for nine releases. Anything a human has to remember after
# a merge will eventually not happen, so the tag is created here, in the same
# run as the publish, and a failure to tag fails the release.
#
# Everything before the publish is a refusal rather than a repair. A release
# script that fixes up your working tree is one that can publish something you
# did not review.
#
#   ./scripts/release.sh            publish what main says
#   ./scripts/release.sh --dry-run  run every check, publish nothing
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

cd "$(dirname "${BASH_SOURCE[0]}")/.."

die() { echo "release: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
PKG="$(node -p "require('./package.json').name")"

echo "${PKG} ${VERSION}${DRY_RUN:+}"
$DRY_RUN && echo "(dry run: nothing will be published or pushed)"

# ---------------------------------------------------------------- preflight

step "Checking the tree"

[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] ||
  die "not on main. Releases come from main so the tag lands in mainline history."

[[ -z "$(git status --porcelain)" ]] ||
  die "working tree is dirty. Publishing would ship files nobody reviewed."

git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
[[ "$LOCAL" == "$REMOTE" ]] ||
  die "main is not in sync with origin (local ${LOCAL:0:9}, origin ${REMOTE:0:9}). Pull first."

step "Checking the version is releasable"

# Published versions are immutable, so a repeat is always a forgotten bump.
if curl -fsS "https://registry.npmjs.org/${PKG}" |
     node -e "
       let raw = '';
       process.stdin.on('data', (d) => (raw += d));
       process.stdin.on('end', () => {
         const versions = Object.keys(JSON.parse(raw).versions);
         process.exit(versions.includes(process.argv[1]) ? 0 : 1);
       });
     " "$VERSION"; then
  die "${VERSION} is already on npm. Bump the version in a pull request first."
fi

git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null &&
  die "${TAG} already exists locally. Delete it or bump the version."
git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null 2>&1 &&
  die "${TAG} already exists on origin. The release may have half-completed."

step "Checking CI passed on this commit"

# The gates that matter run on three browser engines against a real build, and
# `error.stack` is not standardized: the engine matrix is the whole point of
# this library's test suite. Re-running it here would be slower and no better
# than reading the verdict CI already reached on this exact commit.
if command -v gh >/dev/null 2>&1; then
  STATE="$(gh api "repos/{owner}/{repo}/commits/${LOCAL}/check-runs" \
    --jq '[.check_runs[] | select(.status == "completed") | .conclusion] as $c
          | if ($c | length) == 0 then "none"
            elif ($c | map(select(. != "success" and . != "neutral" and . != "skipped")) | length) > 0 then "failing"
            else "passing" end' 2>/dev/null || echo "unknown")"
  case "$STATE" in
    passing) echo "    CI green on ${LOCAL:0:9}" ;;
    failing) die "CI is not green on ${LOCAL:0:9}." ;;
    none)    die "CI has not reported on ${LOCAL:0:9} yet. Wait for it." ;;
    *)       echo "    could not read CI status; falling back to local gates" ;;
  esac
else
  echo "    gh not installed; falling back to local gates"
fi

# `npm publish` runs prepublishOnly (build && test), which is what stops a
# stale dist/ shipping — 1.2.0 went out without flush() that way, from a dist/
# that was gitignored and never rebuilt. Running typecheck here as well is
# cheap and fails before anything irreversible happens.
step "Typechecking"
npm run typecheck

if $DRY_RUN; then
  step "Dry run complete"
  echo "Would publish ${PKG}@${VERSION} and tag ${TAG} at ${LOCAL:0:9}."
  exit 0
fi

# ------------------------------------------------------------------ release

step "Publishing to npm"
npm whoami >/dev/null 2>&1 || die "not logged in to npm. Run 'npm login'."
npm publish --access public

# After the publish, deliberately: a tag pointing at something that was never
# released is a worse lie than a missing tag. Everything below this line is
# recovery from a partial release, so each step says what to do by hand.
step "Tagging ${TAG}"
git tag -a "$TAG" -m "${PKG} ${VERSION}

Published to npm from ${LOCAL:0:9} by scripts/release.sh." ||
  die "publish SUCCEEDED but tagging failed. Tag ${LOCAL:0:9} as ${TAG} by hand."

git push --quiet origin "$TAG" ||
  die "publish SUCCEEDED and ${TAG} exists locally but did not push. Push it by hand."

step "Verifying the published package"

# registry.npmjs.org rather than `npm view`, which serves the previous version
# for minutes after a publish and would report success for the wrong build.
for attempt in 1 2 3 4 5 6; do
  LATEST="$(curl -fsS "https://registry.npmjs.org/${PKG}" |
    node -e "let r='';process.stdin.on('data',d=>r+=d).on('end',()=>console.log(JSON.parse(r)['dist-tags'].latest))" 2>/dev/null || echo "")"
  [[ "$LATEST" == "$VERSION" ]] && break
  echo "    registry still reports ${LATEST:-nothing} (attempt ${attempt})"
  sleep 5
done
[[ "$LATEST" == "$VERSION" ]] ||
  die "published, but the registry still reports '${LATEST}'. Check npmjs.com before assuming failure."

# The tarball is the artifact consumers actually install, and it is built from
# a gitignored dist/. Confirming it is not empty catches the whole class of
# packaging failure that shipped 1.1.3 and 1.2.0 as their predecessors' output.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$(curl -fsS "https://registry.npmjs.org/${PKG}/${VERSION}" |
  node -e "let r='';process.stdin.on('data',d=>r+=d).on('end',()=>console.log(JSON.parse(r).dist.tarball))")"
curl -fsSL "$TARBALL" -o "$TMP/pkg.tgz"
tar xzf "$TMP/pkg.tgz" -C "$TMP"
FILES="$(find "$TMP/package/dist" -name '*.js' 2>/dev/null | wc -l | tr -d ' ')"
[[ "$FILES" -gt 0 ]] || die "the published tarball contains no compiled output."
echo "    ${FILES} compiled files in the published tarball"

step "Released ${PKG}@${VERSION}"
echo "    tag:  ${TAG} -> ${LOCAL:0:9}"
echo "    npm:  https://www.npmjs.com/package/${PKG}/v/${VERSION}"
