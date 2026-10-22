# Build-time package-set input binding. Source this file; no release authority.
package_content_here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
package_content_tool=$package_content_here/../../compiler/artifact/build/artifact-measure-namespace

package_content_identity() {
  local value
  if [[ ! -x $package_content_tool ]]; then
    printf 'build artifact-measure-namespace before package-set capture\n' >&2
    return 2
  fi
  value=$("$package_content_tool" --identity "$1") || return
  [[ $value =~ ^[0-9a-f]{64}$ ]] || return 2
  printf '%s\n' "$value"
}

package_content_snapshot() {
  [[ -d $1 && ! -e $2 && ! -L $2 ]] || return 2
  # Independent inodes: assembly may link only these private input copies.
  cp -a --reflink=auto -- "$1" "$2"
  [[ ! -e $2/.complete && ! -L $2/.complete ]]
}

package_content_read() {
  local manifest=$1 header name root extra i bound expected
  [[ -f $manifest && -f $manifest.content ]] || {
    printf 'package-set lacks content binding; retain it and use a new output coordinate: %s\n' "$manifest" >&2
    return 2
  }
  IFS= read -r header <"$manifest"
  [[ $header == package-root-set-v1 ]] || return 2
  mapfile -t package_content_rows < <(tail -n +2 -- "$manifest")
  [[ ${#package_content_rows[@]} -gt 0 ]] || return 2
  printf '%s\n' "${package_content_rows[@]}" | sort -t $'\t' -k1,1 -c -u || return 2
  mapfile -t package_content_bound <"$manifest.content"
  [[ ${#package_content_bound[@]} -eq $((${#package_content_rows[@]} + 2))
     && ${package_content_bound[0]} == package-root-content-v1 ]] || return 2
  package_content_manifest_sha=$(sha256sum "$manifest" | cut -d' ' -f1)
  [[ ${package_content_bound[1]} == "$package_content_manifest_sha" ]] || return 2
  package_content_sha=$(sha256sum "$manifest.content" | cut -d' ' -f1)
  package_content_names=(); package_content_roots=(); package_content_hashes=()
  for i in "${!package_content_rows[@]}"; do
    IFS=$'\t' read -r name root extra <<<"${package_content_rows[i]}"
    [[ $name =~ ^[a-z0-9][a-z0-9+_.-]*$ && $root == /* && -z $extra
       && ${package_content_rows[i]} == "$name"$'\t'"$root"
       && -d $root && $(realpath -e -- "$root") == "$root"
       && ! -e $root/.complete && ! -L $root/.complete ]] || return 2
    IFS=$'\t' read -r bound expected extra <<<"${package_content_bound[i+2]}"
    [[ $bound == "$name" && $expected =~ ^[0-9a-f]{64}$ && -z $extra
       && ${package_content_bound[i+2]} == "$name"$'\t'"$expected" ]] || return 2
    package_content_names+=("$name"); package_content_roots+=("$root")
    package_content_hashes+=("$expected")
  done
}
