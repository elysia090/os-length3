#!/usr/bin/env bash

# Declarative input to publish-apk.sh.  The caller defines package_recipe and
# sources sources.env/profile.env before reading this file.  Fields are:
# name, version, description, URL, SPDX/license expression, origin, depends,
# provides, replaces, effects.  `none` means the signed standard package has
# neither an install script nor a trigger; derived immutable files are built
# into their explicit owner package before publication.
# Packaging revision 1 replaces the earlier local-test r0 population after the
# producer and boot/config repairs. A changed payload at the same upstream
# version must advance its rN here before another signed publication; changed
# post-link policy for the whole population advances every affected provider.

package_recipe acl "$ACL_VERSION-r1" 'POSIX access control list tools' "$ACL_URL" 'LGPL-2.1-or-later AND GPL-2.0-or-later' acl 'attr' '' '' none
package_recipe apk-tools "$APK_TOOLS_VERSION-r1" 'apk package manager' "$APK_TOOLS_URL" 'GPL-2.0-only' apk-tools '' '' '' none
package_recipe attr "$ATTR_VERSION-r1" 'extended attribute tools' "$ATTR_URL" 'LGPL-2.1-or-later AND GPL-2.0-or-later' attr '' '' '' none
package_recipe base-services "$DISTRIBUTION_RELEASE_VERSION-r3" 'compiled standard service graph' 'https://github.com/elysia090/libqm-prototype' 'LicenseRef-libqm-prototype' base-services 'busybox s6-rc mdevd' '' '' none
package_recipe binutils "$BINUTILS_VERSION-r1" 'GNU binary utilities' "$BINUTILS_URL" 'GPL-3.0-or-later' binutils 'zlib' '' '' none
package_recipe busybox "$BUSYBOX_VERSION-r1" 'small POSIX/Linux userland and rescue init' "$BUSYBOX_URL" 'GPL-2.0-only' busybox '' 'cmd:sh cmd:cpio' '' none
package_recipe bzip2 "$BZIP2_VERSION-r1" 'bzip2 compressor' "$BZIP2_URL" 'bzip2-1.0.6' bzip2 '' '' '' none
package_recipe ca-certificates "${CA_CERTIFICATES_DATE//-/}-r1" 'Mozilla CA certificate bundle' "$CA_CERTIFICATES_URL" 'MPL-2.0' ca-certificates '' '' '' none
package_recipe chrony "$CHRONY_VERSION-r1" 'network time synchronization' "$CHRONY_URL" 'GPL-2.0-only' chrony '' '' '' none
package_recipe curl "$CURL_VERSION-r1" 'HTTP transfer client with TLS' "$CURL_URL" 'curl' curl 'ca-certificates' '' '' none
package_recipe dhcpcd "$DHCPCD_VERSION-r1" 'DHCP client daemon' "$DHCPCD_URL" 'BSD-2-Clause' dhcpcd '' '' '' none
package_recipe e2fsprogs "$E2FSPROGS_VERSION-r1" 'ext filesystem maintenance tools' "$E2FSPROGS_URL" 'GPL-2.0-or-later AND LGPL-2.0-or-later AND BSD-3-Clause AND MIT' e2fsprogs '' '' '' none
package_recipe execline "$EXECLINE_VERSION-r1" 'small non-interactive scripting language' "$EXECLINE_URL" 'ISC' execline 'skalibs' '' '' none
package_recipe file "$FILE_VERSION-r1" 'file type identification' "$FILE_URL" 'BSD-2-Clause' file '' '' '' none
package_recipe gcc "$GCC_VERSION-r1" 'GNU C compiler' "$GCC_URL" 'GPL-3.0-or-later WITH GCC-exception-3.1' gcc 'binutils musl linux-headers' 'cmd:cc' '' none
package_recipe git "$GIT_VERSION-r1" 'distributed version control with HTTPS and SSH transports' "$GIT_URL" 'GPL-2.0-only' git 'busybox curl openssh-client ca-certificates tar gzip' '' '' none
package_recipe gzip "$GZIP_VERSION-r1" 'GNU gzip compressor' "$GZIP_URL" 'GPL-3.0-or-later' gzip '' '' '' none
package_recipe iproute2 "$IPROUTE2_VERSION-r1" 'Linux routing and network configuration tools' "$IPROUTE2_URL" 'GPL-2.0-or-later' iproute2 '' '' '' none
package_recipe kmod "$KMOD_VERSION-r1" 'Linux kernel module tools' "$KMOD_URL" 'LGPL-2.1-or-later' kmod '' '' '' none
package_recipe libcap "$LIBCAP_VERSION-r1" 'Linux capability tools' "$LIBCAP_URL" 'BSD-3-Clause OR GPL-2.0-only' libcap '' '' '' none
package_recipe linux-boot "$LINUX_VERSION-r1" 'Linux kernel and deterministic rescue initramfs' "$LINUX_URL" 'GPL-2.0-only' linux 'busybox base-services' '' '' none
package_recipe linux-headers "$LINUX_VERSION-r1" 'Linux userspace API headers' "$LINUX_URL" 'GPL-2.0-only WITH Linux-syscall-note' linux '' '' '' none
package_recipe make "$MAKE_VERSION-r1" 'GNU make' "$MAKE_URL" 'GPL-3.0-or-later' make 'busybox' '' '' none
package_recipe mdevd "$MDEVD_VERSION-r1" 'small device event manager' "$MDEVD_URL" 'ISC' mdevd 'skalibs' '' '' none
package_recipe musl "$MUSL_VERSION-r1" 'musl C library and development files' "$MUSL_URL" 'MIT' musl '' '' '' none
package_recipe nano "$NANO_VERSION-r1" 'small text editor' "$NANO_URL" 'GPL-3.0-or-later' nano 'ncurses' '' '' none
package_recipe ncurses "$NCURSES_VERSION-r1" 'terminal capability database' "$NCURSES_URL" 'X11' ncurses '' '' '' none
package_recipe nftables "$NFTABLES_VERSION-r1" 'Linux packet filtering administration' "$NFTABLES_URL" 'GPL-2.0-only' nftables '' '' '' none
package_recipe openssh-client "${OPENSSH_VERSION/p/_p}-r1" 'OpenSSH client programs' "$OPENSSH_URL" 'BSD-2-Clause AND ISC' openssh 'busybox' '' '' none
package_recipe openssl "$OPENSSL_VERSION-r1" 'OpenSSL command and development files' "$OPENSSL_URL" 'Apache-2.0' openssl '' '' '' none
package_recipe package-trust "$DISTRIBUTION_RELEASE_VERSION-r1" 'release package verification key' 'https://github.com/elysia090/libqm-prototype' 'LicenseRef-libqm-prototype' package-trust '' '' '' none
package_recipe patch "$PATCH_VERSION-r1" 'GNU patch' "$PATCH_URL" 'GPL-3.0-or-later' patch '' '' '' none
package_recipe pkgconf "$PKGCONF_VERSION-r1" 'compiler and linker metadata query tool' "$PKGCONF_URL" 'ISC' pkgconf '' 'cmd:pkg-config' '' none
package_recipe release-metadata "$DISTRIBUTION_RELEASE_VERSION-r1" 'reproducible source, profile, and runtime closure locks' 'https://github.com/elysia090/libqm-prototype' 'LicenseRef-libqm-prototype' release-metadata '' '' '' none
package_recipe s6 "$S6_VERSION-r1" 'process supervision suite' "$S6_URL" 'ISC' s6 'skalibs execline' '' '' none
package_recipe s6-rc "$S6_RC_VERSION-r1" 'compiled service dependency manager' "$S6_RC_URL" 'ISC' s6-rc 'skalibs execline s6' '' '' none
package_recipe shadow "$SHADOW_VERSION-r1" 'account and password administration' "$SHADOW_URL" 'BSD-3-Clause' shadow '' '' '' none
package_recipe skalibs "$SKALIBS_VERSION-r1" 'small systems programming libraries' "$SKALIBS_URL" 'ISC' skalibs '' '' '' none
package_recipe system-config "$DISTRIBUTION_RELEASE_VERSION-r1" 'system accounts and immutable network and client configuration baselines' 'https://github.com/elysia090/libqm-prototype' 'LicenseRef-libqm-prototype' system-config 'nftables openssh-client' '' '' none
package_recipe tar "$TAR_VERSION-r1" 'GNU tar archiver' "$TAR_URL" 'GPL-3.0-or-later' tar '' '' '' none
package_recipe tzdata "$TZDATA_VERSION-r1" 'IANA timezone database' "$TZDATA_URL" 'LicenseRef-Public-Domain' tzdata '' '' '' none
package_recipe util-linux "$UTIL_LINUX_VERSION-r1" 'essential Linux system utilities' "$UTIL_LINUX_URL" 'GPL-2.0-only AND GPL-2.0-or-later AND LGPL-2.1-or-later AND BSD-3-Clause' util-linux '' '' '' none
package_recipe xz "$XZ_VERSION-r1" 'XZ compression utilities' "$XZ_URL" '0BSD AND LGPL-2.1-or-later AND GPL-2.0-or-later' xz '' '' '' none
package_recipe zlib "$ZLIB_VERSION-r1" 'zlib compression development files' "$ZLIB_URL" 'Zlib' zlib '' '' '' none
package_recipe zstd "$ZSTD_VERSION-r1" 'Zstandard compression utility' "$ZSTD_URL" 'BSD-3-Clause OR GPL-2.0-only' zstd '' '' '' none
