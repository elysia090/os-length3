# What a recipe's `lifts` take, in the source in the current directory, before it is built (build.sh) and before it is
# asked of the advisories (advisories.sh): the one account of it both take. SPEC=VERSION is a crate in Cargo.lock
# (cargo's package spec: its name, or name@version where the lock holds more than one) or a module in go.mod, taken to
# VERSION, as its makers fixed what upstream's lockfile is still open to.
lift() {
  if [ -f Cargo.lock ]; then cargo update -q -p "${1%=*}" --precise "${1#*=}"
  else GOFLAGS= go get "${1%=*}@${1#*=}"; fi
}
