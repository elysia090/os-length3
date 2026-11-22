static int initialized;

__attribute__((constructor)) static void init(void) {
    initialized = 19;
}

int fixture_value(void) {
    return initialized + 23;
}
