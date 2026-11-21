#include "edit_distance.h"
#include <cstdio>
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  std::printf("%d\n", EditDistance(argv[1], argv[2], true, 0));
  return 0;
}
