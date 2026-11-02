# The root's own settings, as root/etc has them: its one user and group (root) and their shadow entries, its hosts,
# OpenSSH's client's, and the Prompt's shell (/etc/profile, /etc/length3/shrc). The shadow files are root's alone.
version=1
inputs="etc/passwd etc/group etc/shadow etc/gshadow etc/hosts etc/ssh/ssh_config etc/profile etc/length3/shrc"
build() {
  for f in $inputs; do
    case $f in etc/shadow|etc/gshadow) m=0600 ;; *) m=0644 ;; esac
    install -D -m "$m" "$here/$f" "$dest/$f"
  done
}
check() {
  grep -q '^root:x:0:0:' "$dest/etc/passwd" && grep -q '^root:x:0:' "$dest/etc/group"
}
