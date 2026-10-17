#include <dlfcn.h>

typedef int (*value_function)(void);

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    void *image = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!image) return 3;
    value_function value = (value_function)dlsym(
        image, "postlink_shared_value");
    int status = !value || value() != 42;
    if (dlclose(image)) return 4;
    return status;
}
