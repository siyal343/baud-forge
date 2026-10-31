/* A packet with a struct inside it, which the parser flattens into `inner.field`. */
#include <stdint.h>

struct __attribute__((packed)) Gains {
    uint16_t proportional;
    uint16_t integral;
};

struct __attribute__((packed)) NestedPacket {
    uint16_t sync;        /* 0..2 */
    struct Gains gains;   /* 2..6  a struct member */
    uint8_t  mode;        /* 6..7 */
};
