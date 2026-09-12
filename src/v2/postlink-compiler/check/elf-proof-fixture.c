static int square(int value)
{
    return value * value;
}

#ifdef RELEASE_SHARING_VARIANT
__asm__(".section .debug.release_variant,\"\",@progbits\n"
        ".byte 1,2,3,4,5,6,7\n"
        ".previous\n");
#endif

int main(void)
{
    return square(0);
}
