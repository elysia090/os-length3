__attribute__((visibility("default"), noinline))
int postlink_shared_value(void)
{
    int value = 0;
    value = 41;
    value = 42;
    return value;
}
