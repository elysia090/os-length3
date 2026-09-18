#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

here=$(cd -- "$(dirname -- "$0")" && pwd)
. "$here/profile.env"

root=${1:?usage: check-root.sh ROOT [POSTLINK_VERIFY]}
verify=${2:-$here/../../src/v2/optimized-x86/build/postlink-verify}
if [[ ! -d $root ]]; then
  printf 'distribution root does not exist: %s\n' "$root" >&2
  exit 2
fi
root=$(cd -- "$root" && pwd)

path_present() {
  local logical=$1 candidate target resolved
  [[ $logical == /* ]] || return 1
  candidate=$root$logical
  for _ in 1 2 3 4 5 6 7 8; do
    if [[ ! -L $candidate ]]; then
      [[ -e $candidate ]]
      return
    fi
    target=$(readlink -- "$candidate")
    if [[ $target == /* ]]; then
      candidate=$root$target
    else
      resolved=$(realpath -m -- "$(dirname -- "$candidate")/$target")
      case $resolved in
        "$root"|"$root"/*) candidate=$resolved ;;
        *) return 1 ;;
      esac
    fi
  done
  return 1
}

command_path() {
  local command_name=$1 expected=${provider_path[$command_name]-}
  [[ -n $expected ]] && path_present "$expected" || return 1
  printf '%s\n' "$expected"
}

accepted_interpreter() {
  local interpreter=$1 accepted
  for accepted in "${DISTRIBUTION_ELF_INTERPRETERS[@]}"; do
    [[ $interpreter == "$accepted" ]] && return 0
  done
  return 1
}

missing=0
declare -A provider_path provider_package
previous=
for specification in "${DISTRIBUTION_COMMAND_PROVIDERS[@]}"; do
  IFS='|' read -r command_name expected_path package extra <<<"$specification"
  if [[ -n $extra || -z $command_name || $expected_path != /* || \
        -z $package || -n ${provider_path[$command_name]+present} || \
        ( -n $previous && $command_name < $previous ) ]]; then
    printf 'invalid command provider specification: %s\n' \
      "$specification" >&2
    missing=1
    continue
  fi
  provider_path[$command_name]=$expected_path
  provider_package[$command_name]=$package
  previous=$command_name
  if ! path_present "$expected_path"; then
    printf 'missing profile command: %s (%s from %s)\n' \
      "$command_name" "$expected_path" "$package" >&2
    missing=1
  fi
done

embedded_profile=$root/usr/share/qm/distribution-profile.env
if [[ -f $embedded_profile ]] && ! cmp -s "$here/profile.env" "$embedded_profile"; then
  printf 'embedded distribution profile differs from the build contract\n' >&2
  missing=1
fi
embedded_sources=$root/usr/share/qm/sources.env
if [[ -f $embedded_sources ]] && ! cmp -s "$here/../sources.env" "$embedded_sources"; then
  printf 'embedded distribution source lock differs from the build contract\n' >&2
  missing=1
fi
embedded_bootstrap_packages=$root/usr/share/qm/bootstrap-packages.sha256
embedded_bootstrap_lock=$root/usr/share/qm/bootstrap-installed.lock
if [[ -f $embedded_bootstrap_packages ]] && \
   ! cmp -s "$here/../bootstrap/packages.sha256" "$embedded_bootstrap_packages"; then
  printf 'embedded bootstrap package digests differs from the build contract\n' >&2
  missing=1
fi
if [[ -f $embedded_bootstrap_lock ]] && \
   ! cmp -s "$here/../bootstrap/installed.lock" "$embedded_bootstrap_lock"; then
  printf 'embedded bootstrap lock differs from the build contract\n' >&2
  missing=1
fi

for path in "${DISTRIBUTION_REQUIRED_PATHS[@]}"; do
  if ! path_present "/$path"; then
    printf 'missing profile path: /%s\n' "$path" >&2
    missing=1
  fi
done

runtime_manifest=$root$DISTRIBUTION_RUNTIME_CLOSURE_MANIFEST
declare -A declared_consumers
if [[ ! -f $runtime_manifest ]]; then
  printf 'runtime closure manifest is missing: %s\n' \
    "$DISTRIBUTION_RUNTIME_CLOSURE_MANIFEST" >&2
  missing=1
elif [[ $(LC_ALL=C head -n 1 -- "$runtime_manifest") \
        != runtime-closure-v1 ]]; then
  printf 'runtime closure manifest has an unknown schema\n' >&2
  missing=1
else
  manifest_rows=$(mktemp)
  trap 'rm -f -- "$manifest_rows"' EXIT HUP INT TERM
  LC_ALL=C tail -n +2 -- "$runtime_manifest" >"$manifest_rows"
  if [[ ! -s $manifest_rows ]] || ! LC_ALL=C sort -c -u "$manifest_rows"; then
    printf 'runtime closure rows must be nonempty, sorted and unique\n' >&2
    missing=1
  fi
  while IFS=$'\t' read -r consumer kind target extra; do
    if [[ -z $consumer && -z $kind && -z $target && -z $extra ]]; then
      continue
    fi
    case $kind in
      config|dlopen|exec|helper|provider|resource|service|trigger) ;;
      *)
        printf 'invalid runtime closure kind: %s\n' "$kind" >&2
        missing=1
        ;;
    esac
    if [[ -n $extra || $consumer != /* || $target != /* ]]; then
      printf 'invalid runtime closure row: %s %s %s\n' \
        "$consumer" "$kind" "$target" >&2
      missing=1
      continue
    fi
    if ! path_present "$consumer"; then
      printf 'runtime closure consumer is absent: %s\n' "$consumer" >&2
      missing=1
    fi
    if ! path_present "$target"; then
      printf 'runtime closure target is absent: %s -> %s\n' \
        "$consumer" "$target" >&2
      missing=1
    fi
    declared_consumers[$consumer]=1
  done <"$manifest_rows"
fi

for command_name in "${DISTRIBUTION_DECLARED_RUNTIME_COMMANDS[@]}"; do
  consumer=$(command_path "$command_name" || true)
  if [[ -n $consumer && -z ${declared_consumers[$consumer]+present} ]]; then
    printf 'runtime-discovered command has no closure declaration: %s\n' \
      "$consumer" >&2
    missing=1
  fi
done

# The root is a potentially large immutable population.  Fuse executable,
# ELF, forbidden-name and symlink validation into its one irreducible directory
# traversal.  Associative lookup replaces one full find per forbidden name,
# and the four-byte discriminator keeps readelf away from non-ELF payloads.
declare -A forbidden_name=()
for name in "${DISTRIBUTION_FORBIDDEN_NAMES[@]}"; do
  forbidden_name[$name]=1
done

while IFS= read -r -d '' kind \
    && IFS= read -r -d '' mode \
    && IFS= read -r -d '' path; do
  case $kind in
    l)
      logical=/${path#"$root"/}
      if ! path_present "$logical"; then
        printf 'escaping or dangling release symlink: %s -> %s\n' \
          "$logical" "$(readlink -- "$path")" >&2
        missing=1
      fi
      ;;
    f)
      name=${path##*/}
      if [[ -n ${forbidden_name[$name]+present} ]]; then
        printf 'forbidden standard-profile payload: %s\n' "$path" >&2
        missing=1
      fi

      magic=
      IFS= read -r -N 4 magic <"$path" || true
      if (( (8#$mode & 0111) != 0 )) && [[ ${magic:0:2} == '#!' ]]; then
        shebang=$(LC_ALL=C head -n 1 -- "$path")
        shebang=${shebang#'#!'}
        shebang=${shebang#"${shebang%%[![:space:]]*}"}
        interpreter=${shebang%%[[:space:]]*}
        if ! path_present "$interpreter"; then
          printf 'unresolved shebang interpreter: %s -> %s\n' \
            "${path#"$root"}" "$interpreter" >&2
          missing=1
        fi
      fi
      [[ $magic == $'\x7fELF' ]] || continue

      metadata=$(LC_ALL=C readelf -h -l -d -- "$path" 2>/dev/null) || {
        printf 'unreadable ELF payload: %s\n' "${path#"$root"}" >&2
        missing=1
        continue
      }
      if ! grep -q 'Class:[[:space:]]*ELF64' <<<"$metadata" || \
         ! grep -q 'Machine:[[:space:]]*Advanced Micro Devices X86-64' \
           <<<"$metadata"; then
        printf 'ELF outside release machine profile: %s\n' \
          "${path#"$root"}" >&2
        missing=1
        continue
      fi

      elf_type=$(sed -n \
        's/^[[:space:]]*Type:[[:space:]]*\([^[:space:]]*\).*/\1/p' \
        <<<"$metadata")
      interpreter=$(sed -n \
        's/.*Requesting program interpreter: \([^]]*\).*/\1/p' \
        <<<"$metadata")
      if [[ -n $interpreter ]] && \
         { ! accepted_interpreter "$interpreter" || \
           ! path_present "$interpreter"; }; then
        printf 'unaccepted ELF interpreter: %s -> %s\n' \
          "${path#"$root"}" "$interpreter" >&2
        missing=1
      fi

      while IFS= read -r needed; do
        if ! path_present "/lib/$needed" && \
           ! path_present "/usr/lib/$needed"; then
          printf 'unresolved DT_NEEDED: %s -> %s\n' \
            "${path#"$root"}" "$needed" >&2
          missing=1
        fi
      done < <(sed -n \
        's/.*Shared library: \[\([^]]*\)\].*/\1/p' <<<"$metadata")

      if [[ $elf_type == EXEC || $elf_type == DYN ]]; then
        if [[ ! -x $verify ]] || ! "$verify" "$path" >/dev/null; then
          printf 'unproved linked ELF: %s\n' "${path#"$root"}" >&2
          missing=1
        fi
      fi
      ;;
  esac
done < <(find "$root" -printf '%y\0%m\0%p\0')

if (( missing != 0 )); then
  exit 1
fi

printf 'distribution payload closure %s (%s): green\n' \
  "$DISTRIBUTION_PROFILE_ID" "$DISTRIBUTION_CPU_PROFILE"
