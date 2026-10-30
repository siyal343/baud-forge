/* A packet whose mode field is an enum, in both spellings a header uses.
 *
 * `ModePacket` names the enum with the `enum` keyword, `TypedefPacket` through the
 * typedef, and both must decode and encode the same field. */
#include <stdint.h>

enum mode_e {
    MODE_IDLE  = 0,
    MODE_RUN   = 1,
    MODE_FAULT = 2,
};

typedef enum {
    STATE_OFF = 0,
    STATE_ON  = 1,
} state_t;

struct __attribute__((packed)) ModePacket {
    uint16_t    sync; /* 0..2 */
    enum mode_e mode; /* 2..6  the enum, so the decoder prints its label */
    uint8_t     flags; /* 6..7 */
};

struct __attribute__((packed)) TypedefPacket {
    uint16_t sync;  /* 0..2 */
    state_t  state; /* 2..6  through a typedef, which a real header usually writes */
    uint8_t  flags; /* 6..7 */
};
