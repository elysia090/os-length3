#include <stdint.h>

/* The low byte is the current state and the high byte is the next input.
 * Keeping the transition pure makes it useful on its own and inside main. */
uint8_t accumulator_step(uint16_t state_and_input)
{
    uint8_t state = (uint8_t)state_and_input;
    uint8_t input = (uint8_t)(state_and_input >> 8);
    return (uint8_t)(state + input);
}

int main(void)
{
    uint8_t state = 0;
    int input;
    while ((input = getchar()) >= 0) {
        uint16_t packed = (uint16_t)state | ((uint16_t)(uint8_t)input << 8);
        state = accumulator_step(packed);
        putchar(state);
    }
    return 0;
}
