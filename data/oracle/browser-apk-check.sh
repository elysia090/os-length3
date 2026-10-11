#!/bin/sh
# Isolated test-only trust root and package database; never alter release keys.
set -eu
umask 022
work=${1:-$(mktemp -d /workspace/apk-check.XXXXXXXX)}
mkdir -p "$work"
cd "$work"
work=$(pwd)
mkdir -p candidate/etc/apk/keys dependency/usr/share/browser-apk app/usr/bin repository
printf 'dependency-present\n' >dependency/usr/share/browser-apk/value
printf '%s\n' '#!/bin/sh' 'test "$(cat "$1/usr/share/browser-apk/value")" = dependency-present' 'echo signed-apk-application' >app/usr/bin/browser-apk-app
chmod 755 app/usr/bin/browser-apk-app
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out test-key.pem 2>keygen.log
openssl pkey -in test-key.pem -pubout -out candidate/etc/apk/keys/test-key.pub
apk mkpkg --sign-key test-key.pem --files dependency --info name:browser-apk-dependency --info version:1.0-r0 --info arch:x86_64 --info license:MIT --output repository/browser-apk-dependency-1.0-r0.apk
apk mkpkg --sign-key test-key.pem --files app --info name:browser-apk-app --info version:1.0-r0 --info arch:x86_64 --info license:MIT --info depends:browser-apk-dependency=1.0-r0 --output repository/browser-apk-app-1.0-r0.apk
apk --root "$work/candidate" mkndx --sign-key test-key.pem --output repository/Packages.adb repository/*.apk
apk --root "$work/candidate" verify repository/*.apk repository/Packages.adb
apk --root "$work/candidate" --no-network --no-commit-hooks --repository "$work/repository/Packages.adb" add --initdb browser-apk-app=1.0-r0
test "$(candidate/usr/bin/browser-apk-app "$work/candidate")" = signed-apk-application
grep -qx P:browser-apk-dependency candidate/lib/apk/db/installed
grep -qx P:browser-apk-app candidate/lib/apk/db/installed
printf 'browser-apk-check:PASS:signed-install-and-dependency\n'
apk --root "$work/candidate" --no-network del browser-apk-app
test ! -e candidate/usr/bin/browser-apk-app
test ! -e candidate/usr/share/browser-apk/value
if grep -q '^P:browser-apk-' candidate/lib/apk/db/installed; then exit 1; fi
printf 'browser-apk-check:PASS:remove\n'
# Valid signed objects with a different trusted key must be rejected, not just
# malformed archives. The release trust directory is never used or weakened.
mkdir -p wrong-root/etc/apk/keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out wrong-key.pem 2>wrong-keygen.log
openssl pkey -in wrong-key.pem -pubout -out wrong-root/etc/apk/keys/wrong-key.pub
if apk --root "$work/wrong-root" verify repository/browser-apk-app-1.0-r0.apk >wrong-signature.log 2>&1; then
    printf 'browser-apk-check:FAIL:wrong-signature-accepted\n' >&2
    exit 1
fi
grep -Ei 'signature|trust' wrong-signature.log
test ! -e wrong-root/usr/bin/browser-apk-app
printf 'browser-apk-check:PASS:signature-rejected\n'
sync
printf 'browser-apk-check:WORKSPACE:%s\n' "$work"
