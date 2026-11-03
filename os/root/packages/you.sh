# you (z): the places a person has been, and back to one by a part of its name: what the Prompt's shell learns at
# every cd and z finds a place by (/etc/length3/shrc). Made from this repository's own source (tool/you, one C file
# with no C library, its own build and checks): a program of a few pages that starts, does five calls, and ends.
version=1
inputs="../../tool/you/you.c ../../tool/you/build.sh ../../tool/you/test.sh"
build() {
  sh "$here/../../tool/you/build.sh" "$dest/usr/bin/you"
}
check() {
  sh "$here/../../tool/you/test.sh" "$dest/usr/bin/you"
}
