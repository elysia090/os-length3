// Extended attributes, as setfattr and getfattr use them: set, get (and its size), list, replace, remove, and
// the errors Linux gives (no such attribute, too small a buffer, an unknown namespace, a link, a pipe).
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/xattr.h>
#include <unistd.h>

static int by_name(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

static void list(const char *path) {
  char buf[256]; ssize_t n = listxattr(path, buf, sizeof buf);
  char *names[16]; int k = 0;
  for (ssize_t at = 0; at < n && k < 16; at += strlen(buf + at) + 1) names[k++] = buf + at;
  qsort(names, k, sizeof *names, by_name);
  printf("list (%zd):", n);
  for (int i = 0; i < k; i++) printf(" %s", names[i]);
  printf("\n");
}

static void said(const char *what, long r) { printf("%s: %ld %s\n", what, r, r < 0 ? strerror(errno) : "-"); }

int main(void) {
  setvbuf(stdout, 0, _IONBF, 0);
  const char *f = "/tmp/xlat-xattrs", *l = "/tmp/xlat-xattrs-link";
  unlink(f); unlink(l);
  FILE *o = fopen(f, "w"); fputs("x", o); fclose(o);
  said("set user.colour", setxattr(f, "user.colour", "blue", 4, 0));
  said("set user.size", setxattr(f, "user.size", "large!", 6, 0));
  char v[16] = {0};
  said("size of user.colour", getxattr(f, "user.colour", 0, 0));
  said("get user.colour", getxattr(f, "user.colour", v, sizeof v));
  printf("value: %s\n", v);
  said("get into too little", getxattr(f, "user.size", v, 2));
  said("get one not there", getxattr(f, "user.none", v, sizeof v));
  said("create one there", setxattr(f, "user.colour", "red", 3, XATTR_CREATE));
  said("replace one not there", setxattr(f, "user.none", "x", 1, XATTR_REPLACE));
  said("replace user.colour", setxattr(f, "user.colour", "red", 3, XATTR_REPLACE));
  memset(v, 0, sizeof v); getxattr(f, "user.colour", v, sizeof v);
  printf("value: %s\n", v);
  list(f);
  said("an unknown namespace", setxattr(f, "colour", "x", 1, 0));
  said("remove user.size", removexattr(f, "user.size"));
  said("remove it again", removexattr(f, "user.size"));
  list(f);
  symlink(f, l);
  said("user. on a link", lsetxattr(l, "user.k", "v", 1, 0));
  said("through the link", getxattr(l, "user.colour", v, sizeof v));
  int pp[2]; pipe(pp);
  said("a pipe's", fgetxattr(pp[0], "user.k", v, sizeof v));
  unlink(l); unlink(f);
  return 0;
}
