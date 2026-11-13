# ricebox — the neutral distribution

As BusyBox is one, and as thin: the root, and the command line #80 lists, ordinary POSIX with no window. This
folder is all of it: its version (`RELEASE`), what it is made from (`pins/`), a folder per package with its recipe
and its patches (`packages/NAME/recipe.sh`), its own files (`etc/`, `usr/`), and what makes it (`make/`: each
package on one pinned Alpine, then the root and its package database).

It knows no service and nothing of why's. What runs it is muk (`../muk`): on Linux by namespaces, in a browser
by answering its system calls itself, over the code sods (`../sods`) makes of its programs. Its command line's own
programs are `../you` and `../otter`, each a package of it.
