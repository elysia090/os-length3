#!/bin/sh
# Real signed APK transaction and negative layout gates in a disposable CPU
# oracle. The bootstrap apk is a test tool, not a distribution replacement.
set -eu
command -v apk
# Package-set capture uses the canonical namespace measurement tools.
make -j4 -C compiler/artifact all
scratch=$(mktemp -d /tmp/runtime-publication.XXXXXXXX)
openssl_tool=$(command -v openssl || true)
if test -z "$openssl_tool"; then
    # The pinned CPU oracle has OpenSSL development libraries, not its CLI.
    # Build the official CLI rather than inventing a signing/identity shim.
    . distribution/sources.env
    archive=distribution/upstream/openssl-$OPENSSL_VERSION.tar.gz
    printf '%s  %s\n' "$OPENSSL_SHA256" "$archive" | sha256sum -c -
    tar -xzf "$archive" -C "$scratch"
    source=$scratch/openssl-$OPENSSL_VERSION
    (cd "$source"; ./Configure linux-x86_64 no-shared no-tests; make -j4 build_sw)
    openssl_tool=$source/apps/openssl
fi
mkdir -p "$scratch/apk/usr/bin"
cp "$(command -v apk)" "$scratch/apk/usr/bin/apk"
"$openssl_tool" genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
    -out "$scratch/test-only.pem"
"$openssl_tool" pkey -in "$scratch/test-only.pem" -pubout \
    -out "$scratch/test-only.pub"
QM_APK_OPENSSL="$openssl_tool" bash distribution/packaging/check-publish-apk.sh "$scratch/apk" \
    "$scratch/fixture" "$scratch/test-only.pem" "$scratch/test-only.pub" \
    "$scratch/publication"
printf 'runtime-publication:PASS:signed-ownership-and-layout-negatives\n'
