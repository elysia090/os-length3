# The root's own settings: its one user and group (root), their shadow entries, its hosts, OpenSSH's client settings.
version=0.1.0
inputs="distribution/config/passwd distribution/config/group distribution/config/shadow distribution/config/gshadow distribution/config/hosts distribution/config/ssh_config"
build() {
  c="$top/distribution/config"
  install -D -m 0644 "$c/passwd" "$dest/etc/passwd"
  install -D -m 0644 "$c/group" "$dest/etc/group"
  install -D -m 0600 "$c/shadow" "$dest/etc/shadow"
  install -D -m 0600 "$c/gshadow" "$dest/etc/gshadow"
  install -D -m 0644 "$c/hosts" "$dest/etc/hosts"
  install -D -m 0644 "$c/ssh_config" "$dest/etc/ssh/ssh_config"
}
