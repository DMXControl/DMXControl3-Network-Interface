#!/usr/bin/env bash
# Determines the package version for a release workflow.
#
# Usage: release-version.sh npm|pypi|nuget
#
# The version is read from VERSION_INPUT (manual run) or GITHUB_REF_NAME (tag push); a
# leading "v" is removed. Accepted formats:
#
#   3.3.3          DMXControl release           -> 3.3.3 everywhere
#   3.3.3-rc.0     pre-release                  -> 3.3.3-rc.0 (PyPI normalizes it to 3.3.3rc0)
#   3.3.3.1        dependency-only fix release  -> NuGet 3.3.3.1, PyPI 3.3.3.post1,
#                                                  npm not published (semver has no 4th part;
#                                                  npm dependency ranges pick up fixes anyway)
#
# Writes VERSION and SKIP_PUBLISH to $GITHUB_ENV (stdout when run locally).
set -euo pipefail

registry="${1:-}"
case "$registry" in
  npm | pypi | nuget) ;;
  *)
    echo "::error::Usage: $0 npm|pypi|nuget" >&2
    exit 1
    ;;
esac

v="${VERSION_INPUT:-${GITHUB_REF_NAME:-}}"
v="${v#v}"

release_re='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
fix_re='^([0-9]+\.[0-9]+\.[0-9]+)\.([1-9][0-9]*)$'

skip=false
if [[ "$v" =~ $release_re ]]; then
  version="$v"
elif [[ "$v" =~ $fix_re ]]; then
  base="${BASH_REMATCH[1]}"
  fix="${BASH_REMATCH[2]}"
  case "$registry" in
    nuget) version="$v" ;;
    pypi) version="$base.post$fix" ;;
    npm)
      version="$v"
      skip=true
      ;;
  esac
else
  echo "::error::Invalid version '$v'. Expected x.y.z, x.y.z-prerelease or x.y.z.N (N >= 1)." >&2
  exit 1
fi

if [[ "$skip" == true ]]; then
  message="Version $v is a dependency-only fix release: not published to $registry."
  echo "::notice::$message"
else
  message="Publishing $registry version $version."
  echo "$message"
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "$message" >> "$GITHUB_STEP_SUMMARY"
fi

{
  echo "VERSION=$version"
  echo "SKIP_PUBLISH=$skip"
} >> "${GITHUB_ENV:-/dev/stdout}"
