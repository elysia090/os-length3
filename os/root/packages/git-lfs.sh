# Git LFS: large files kept by git as pointers, their contents fetched from the remote's LFS store; its filters set
# in the root's /etc/gitconfig, so a clone with LFS files has them.
pins="GIT_LFS"
tools="go"
build() {
  go build -ldflags "$golink -s -w -X 'github.com/git-lfs/git-lfs/v3/config.Vendor=OS Length3'" \
    -o "$dest/usr/bin/git-lfs" .
}
check() {
  "$dest/usr/bin/git-lfs" version | grep -q "^git-lfs/$GIT_LFS_VERSION (OS Length3; linux amd64; "
}
