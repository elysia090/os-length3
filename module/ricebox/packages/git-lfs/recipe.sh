# Git LFS: large files kept by git as pointers, their contents fetched from the remote's LFS store; its filters set
# in the root's /etc/gitconfig, so a clone with LFS files has them.
pins="GIT_LFS"
tools="go"
# Past what its go.mod is still open to (module/ricebox/make/advisories.sh): golang.org/x/net's html and HTTP/2 (GO-2026-6603, -6610,
# -6611, -6612, -6617, -6860, -6866), whose v0.62.0 takes golang.org/x/crypto's ssh past GO-2026-6303, -6354 and -6355
# (to v0.58.0) and golang.org/x/text past GO-2026-6629 (to v0.43.0) with it. (A lift is a version, so naming those
# two at their own fixes as well would take them back below what x/net v0.62.0 needs, and x/net down with them.) And
# github.com/klauspost/compress past GO-2026-6865 (a panic on two-block frames in fse and huff0, which its zstd
# reads with; git-lfs imports zstd), to v1.20.2.
lifts="golang.org/x/net=v0.62.0 github.com/klauspost/compress=v1.20.2"
build() {
  go build -ldflags "$golink -s -w -X 'github.com/git-lfs/git-lfs/v3/config.Vendor=OS Length3'" \
    -o "$dest/usr/bin/git-lfs" .
}
check() {
  "$dest/usr/bin/git-lfs" version | grep -q "^git-lfs/$GIT_LFS_VERSION (OS Length3; linux amd64; "
}
