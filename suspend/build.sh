#!/bin/sh
# Build the stand-in and the Claude reporter by hand:
#   sh suspend/build.sh [stand-in output [reporter output]]
# With no argument: ./herdr-standin and ./herdr-agent-report. With only the
# stand-in output, the reporter is not built (install.sh until it installs
# the reporter too).
# Bun's small ahead-of-time compile when this Bun has it, otherwise the
# standard compile. It prints which one first (install.sh shows that line).
# Check the footprint of a running copy (10 MB or less):
#   macOS: footprint <pid>      Linux: grep VmRSS /proc/<pid>/status
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ $# -eq 0 ]; then set -- herdr-standin herdr-agent-report; fi
if bun compile --help >/dev/null 2>&1; then
  echo 'ahead-of-time compile'
  build() { bun compile --trim-locales en --no-compile-function-source --outfile "$1" "$here/$2"; }
else
  echo 'standard compile'
  build() { bun build --compile --minify --outfile "$1" "$here/$2"; }
fi
build "$1" main.ts
if [ $# -ge 2 ]; then build "$2" report-main.ts; fi
