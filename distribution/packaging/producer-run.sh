#!/usr/bin/env bash
# Optional qualified-build execution. Ordinary diagnostic builds stay explicit
# about their missing producer binding; supplying a cut requires a durable log.
producer_run() {
  local role=$1 executable=$2
  shift 2
  if [[ -n ${QM_PRODUCER_CUT:-} ]]; then
    : "${QM_PRODUCER_EXECUTION_LOG:?fixed producer execution log required}"
    python3 "$(dirname -- "${BASH_SOURCE[0]}")/producer-execution.py" run \
      "$QM_PRODUCER_CUT" "$QM_PRODUCER_EXECUTION_LOG" "$role" "$executable" "$@"
  else
    "$executable" "$@"
  fi
}
