#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT="${1:-${PROJECT_DIR}/app/build/contract-fixtures/android-production-v3.json}"

mkdir -p "$(dirname "${OUTPUT}")"
"${PROJECT_DIR}/gradlew" \
  -p "${PROJECT_DIR}" \
  :app:testDebugUnitTest \
  --tests com.datafordidi.mobilecollector.AndroidProductionV3PayloadFixtureTest \
  -PcontractFixtureOutput="${OUTPUT}" \
  --no-daemon

test -s "${OUTPUT}"
printf '%s\n' "${OUTPUT}"
