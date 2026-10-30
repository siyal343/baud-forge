/* A packet whose mode field is an enum, so a label can round-trip.
 *
 * The field is spelled `enum mode_e`, not through a typedef: the parser resolves a
 * field type through `enum_for`, and a `typedef enum … mode_t;` alias is not one of
 * the types it resolves (D-88). */
#include <stdint.h>

enum mode_e {
    MODE_IDLE  = 0,
    MODE_RUN   = 1,
    MODE_FAULT = 2,
};

struct __attribute__((packed)) ModePacket {
    uint16_t  sync;   /* 0..2 */
    enum mode_e mode; /* 2..6  the enum, so the decoder prints its label */
    uint8_t   flags;  /* 6..7 */
};
