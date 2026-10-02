#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 4 || ( $1 != --inside && $1 != --mount ) \
      || ! -d $2 || ! -f $3 || ! $4 =~ ^[0-9]+$ ]]; then
  printf 'usage: %s --inside RELEASE_ROOT TEST_CA PORT\n' "$0" >&2
  exit 2
fi
root=$(realpath -e -- "$2")
cert=$(realpath -e -- "$3")
port=$4
if [[ $(id -u) != 0 ]]; then
  printf 'native HTTPS check requires root for its private mount namespace\n' >&2
  exit 2
fi

if [[ $1 == --inside ]]; then
  unshare --mount --propagation private bash "$0" --mount "$root" "$cert" "$port"
  exit
fi

mount --bind "$root" "$root"
mount -o remount,bind,ro "$root"
mount --bind /dev "$root/dev"
mount -t proc proc "$root/proc"
mount -t tmpfs -o size=128m,mode=1777 tmpfs "$root/tmp"
cp -- "$cert" "$root/tmp/test-ca.pem"
if [[ -n ${QM_NATIVE_LINKED_CURL:-} ]]; then
  cp -- "$(realpath -e -- "$QM_NATIVE_LINKED_CURL")" "$root/tmp/curl-linked"
fi
if [[ -n ${QM_NATIVE_FAULT_TRACER:-} ]]; then
  cp -- "$(realpath -e -- "$QM_NATIVE_FAULT_TRACER")" "$root/tmp/trace-native-fault"
fi
env -i PATH=/usr/bin:/usr/sbin:/bin:/sbin HOME=/tmp \
  NATIVE_HTTPS_PORT="$port" QM_NATIVE_TRACE="${QM_NATIVE_TRACE:-0}" \
  QM_NATIVE_STEP_TAIL="${QM_NATIVE_STEP_TAIL:-0}" \
  QM_NATIVE_TRACE_GIT="${QM_NATIVE_TRACE_GIT:-0}" \
  QM_NATIVE_GIT_BREAK="${QM_NATIVE_GIT_BREAK:-}" \
  QM_NATIVE_COMPARE_BREAK="${QM_NATIVE_COMPARE_BREAK:-}" \
  QM_NATIVE_COMPARE_WATCH="${QM_NATIVE_COMPARE_WATCH:-}" \
  QM_NATIVE_COMPARE_TRACE_HIT="${QM_NATIVE_COMPARE_TRACE_HIT:-}" \
  QM_NATIVE_BREAK="${QM_NATIVE_BREAK:-}" \
  QM_NATIVE_FIRST_ENTRY="${QM_NATIVE_FIRST_ENTRY:-}" \
  chroot "$root" /bin/sh -e -s <<'GUEST'
if [ "$QM_NATIVE_TRACE" = 1 ]; then set -x; fi
port=$NATIVE_HTTPS_PORT
if [ -x /tmp/curl-linked ]; then
  printf 'native HTTPS: comparison client certificate-verified GET\n'
  if [ -x /tmp/trace-native-fault ]; then
    if [ -n "$QM_NATIVE_COMPARE_BREAK" ]; then
      if [ -n "$QM_NATIVE_COMPARE_TRACE_HIT" ]; then
        /tmp/trace-native-fault --break "$QM_NATIVE_COMPARE_BREAK" \
          --trace-from-hit "$QM_NATIVE_COMPARE_TRACE_HIT" \
          /tmp/curl-linked --fail --silent --show-error --cacert /tmp/test-ca.pem \
          "https://localhost:$port/hello.txt" >/tmp/hello-linked.txt
      else
        /tmp/trace-native-fault --break "$QM_NATIVE_COMPARE_BREAK" \
          /tmp/curl-linked --fail --silent --show-error --cacert /tmp/test-ca.pem \
          "https://localhost:$port/hello.txt" >/tmp/hello-linked.txt
      fi
    elif [ -n "$QM_NATIVE_COMPARE_WATCH" ]; then
      /tmp/trace-native-fault --watch "$QM_NATIVE_COMPARE_WATCH" \
        /tmp/curl-linked --fail --silent --show-error --cacert /tmp/test-ca.pem \
        "https://localhost:$port/hello.txt" >/tmp/hello-linked.txt
    else
      /tmp/trace-native-fault /tmp/curl-linked \
        --fail --silent --show-error --cacert /tmp/test-ca.pem \
        "https://localhost:$port/hello.txt" >/tmp/hello-linked.txt
    fi
  else
    /tmp/curl-linked --fail --silent --show-error --cacert /tmp/test-ca.pem \
      "https://localhost:$port/hello.txt" >/tmp/hello-linked.txt
  fi
  test "$(cat /tmp/hello-linked.txt)" = native-https-ready
fi
if [ -x /tmp/trace-native-fault ]; then
  if [ -n "$QM_NATIVE_FIRST_ENTRY" ]; then
    begin=${QM_NATIVE_FIRST_ENTRY%:*}
    end=${QM_NATIVE_FIRST_ENTRY#*:}
    /tmp/trace-native-fault --first-entry "$begin" "$end" \
      /usr/bin/curl --fail --silent --show-error \
      --cacert /tmp/test-ca.pem \
      "https://localhost:$port/hello.txt"
    exit 42
  elif [ -n "$QM_NATIVE_BREAK" ]; then
    /tmp/trace-native-fault --break "$QM_NATIVE_BREAK" /usr/bin/curl \
      --fail --silent --show-error --cacert /tmp/test-ca.pem \
      "https://localhost:$port/hello.txt"
  elif [ "$QM_NATIVE_STEP_TAIL" = 1 ]; then
    /tmp/trace-native-fault --step-tail /usr/bin/curl \
      --fail --silent --show-error --cacert /tmp/test-ca.pem \
      "https://localhost:$port/hello.txt"
  else
    /tmp/trace-native-fault /usr/bin/curl \
      --fail --silent --show-error --cacert /tmp/test-ca.pem \
      "https://localhost:$port/hello.txt"
  fi
else
  printf 'native HTTPS: curl certificate-verified GET\n'
  curl --fail --silent --show-error --cacert /tmp/test-ca.pem \
    "https://localhost:$port/hello.txt" >/tmp/hello.txt
  test "$(cat /tmp/hello.txt)" = native-https-ready
fi
printf 'native HTTPS: Git clone\n'
if [ "$QM_NATIVE_TRACE_GIT" = 1 ]; then
  mkdir -p /tmp/git-exec
  test -x /tmp/trace-native-fault
  if [ -n "$QM_NATIVE_GIT_BREAK" ]; then
    printf '%s\n' '#!/bin/sh' \
      "exec /tmp/trace-native-fault --break $QM_NATIVE_GIT_BREAK /usr/libexec/git-core/git-remote-https \"\$@\"" \
      >/tmp/git-exec/git-remote-https
  else
    printf '%s\n' '#!/bin/sh' \
      'exec /tmp/trace-native-fault --step-tail /usr/libexec/git-core/git-remote-https "$@"' \
      >/tmp/git-exec/git-remote-https
  fi
  chmod 0755 /tmp/git-exec/git-remote-https
  export GIT_EXEC_PATH=/tmp/git-exec
fi
git -c http.sslCAInfo=/tmp/test-ca.pem clone -q \
  "https://localhost:$port/repository.git" /tmp/clone
test -f /tmp/clone/hello.c
cc /tmp/clone/hello.c -o /tmp/clone/hello
test "$(/tmp/clone/hello)" = https-git-ready
GUEST
