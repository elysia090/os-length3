# The root's own settings, as root/etc has them: its accounts (root, who works in it; nobody, for what runs as no
# one), with no password either, its hosts, git's (a new repository starts on main), OpenSSH's client's with the
# keys of the forges it knows from the start, and the Prompt's shell (/etc/profile, /etc/length3/shrc). The shadow
# files are root's alone.
version=1
tools="openssh-keygen"
inputs="etc/passwd etc/group etc/shadow etc/gshadow etc/hosts etc/gitconfig etc/ssh/ssh_config etc/ssh/ssh_known_hosts
  etc/profile etc/length3/shrc"
build() {
  for f in $inputs; do
    case $f in etc/shadow|etc/gshadow) m=0600 ;; *) m=0644 ;; esac
    install -D -m "$m" "$here/$f" "$dest/$f"
  done
}
check() {
  grep -q '^root:x:0:0:' "$dest/etc/passwd" && grep -q '^root:x:0:' "$dest/etc/group"
  # The forges' keys are the ones their makers publish, by fingerprint.
  ssh-keygen -lf "$dest/etc/ssh/ssh_known_hosts" | awk '{print $2, $3}' | sort > fingerprints
  printf '%s\n' \
    'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU github.com' \
    'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM github.com' \
    'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s github.com' \
    'SHA256:HbW3g8zUjNSksFbqTiUWPWg2Bq1x8xdGUrliXFzSnUw gitlab.com' \
    'SHA256:ROQFvPThGrW4RuWLoL9tq9I9zJ42fK4XywyRtbOz/EQ gitlab.com' \
    'SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8 gitlab.com' | sort > published
  diff published fingerprints
}
