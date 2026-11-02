# Git LFS: large files kept by git as pointers, their contents fetched from the remote's LFS store; its filters set
# in the root's /etc/gitconfig, so a clone with LFS files has them.
pins="GIT_LFS"
tools="go"
# Past what its go.mod is still open to (root/advisories.sh): golang.org/x/crypto's ssh (GO-2026-6303, -6354, -6355),
# golang.org/x/net's html and HTTP/2 (GO-2026-6603, -6610, -6611, -6612, -6617, -6860, -6866) and golang.org/x/text
# (GO-2026-6629).
lifts="golang.org/x/crypto=v0.56.0 golang.org/x/net=v0.62.0 golang.org/x/text=v0.41.0"
build() {
  go build -ldflags "$golink -s -w -X 'github.com/git-lfs/git-lfs/v3/config.Vendor=OS Length3'" \
    -o "$dest/usr/bin/git-lfs" .
}
check() {
  "$dest/usr/bin/git-lfs" version | grep -q "^git-lfs/$GIT_LFS_VERSION (OS Length3; linux amd64; "
}
