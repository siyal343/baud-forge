/*
 * Telemetry packet from the flight controller.
 * This header is the schema: no dissector code refers to these fields by name.
 */
#include <stdint.h>

typedef enum {
    MODE_IDLE  = 0,
    MODE_RUN   = 1,
    MODE_FAULT = 2,
} mode_t;

typedef uint16_t le_word;

struct __attribute__((packed)) ImuPacket {
    uint16_t sync;          /* 0..2   frame marker */
    uint8_t  version;       /* 2..3   schema version */
    uint8_t  flags   : 3;   /* byte 3, bits 0..3 */
    uint8_t  channel : 5;   /* byte 3, bits 3..8 */
    __le32   timestamp_us;  /* 4..8   microseconds since boot */
    __be16   v_batt_mv;     /* 8..10  battery millivolts, big endian on the wire */
    float    gyro_z;        /* 10..14 rad/s */
    uint8_t  samples[4];    /* 14..18 */
    uint8_t  mode;          /* 18..19 see mode_t */
};

struct __attribute__((packed)) EpsCommand {
    le_word  sync;          /* 0..2 */
    uint8_t  opcode;        /* 2..3 */
    uint32_t hold_time_s;   /* 3..7 */
};
