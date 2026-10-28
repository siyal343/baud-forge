//! A header plus a golden frame is the whole dissector contract (F3.2).

use bforge_dissect::cheader;
use bforge_dissect::exec;

const HEADER: &str = include_str!("fixtures/imu_packet.h");

/// Build the frame the way the firmware would put it on the wire.
fn golden_frame() -> Vec<u8> {
    let mut frame = Vec::new();
    frame.extend_from_slice(&0xAA55u16.to_le_bytes()); // sync
    frame.push(3); // version
    let flags: u8 = 5; // 0b101
    let channel: u8 = 18; // 0b10010
    frame.push(flags | (channel << 3)); // bitfields share one byte
    frame.extend_from_slice(&123_456u32.to_le_bytes()); // timestamp_us, little endian
    frame.extend_from_slice(&8_190u16.to_be_bytes()); // v_batt_mv, big endian
    frame.extend_from_slice(&(-0.042f32).to_le_bytes()); // gyro_z
    frame.extend_from_slice(&[1, 2, 3, 4]); // samples
    frame.push(1); // mode = MODE_RUN
    frame
}

fn decode() -> Vec<bforge_dissect::DecodedField> {
    let header = cheader::parse(HEADER).expect("header parses");
    let ir = cheader::compile(&header, "ImuPacket", "imu_packet.h").expect("compiles");
    exec::execute(&ir, &golden_frame()).expect("executes")
}

#[test]
fn the_frame_holds_nineteen_bytes() {
    assert_eq!(golden_frame().len(), 19);
    let header = cheader::parse(HEADER).unwrap();
    let packet = header
        .structs
        .iter()
        .find(|item| item.name == "ImuPacket")
        .unwrap();
    assert_eq!(packet.size, 19);
}

#[test]
fn every_field_decodes_to_the_value_the_firmware_wrote() {
    let fields = decode();
    let value = |name: &str| {
        fields
            .iter()
            .find(|field| field.name == name)
            .unwrap_or_else(|| panic!("no field {name}"))
            .value
            .clone()
    };

    assert_eq!(value("sync"), "43605");
    assert_eq!(value("version"), "3");
    assert_eq!(value("flags"), "5");
    assert_eq!(value("channel"), "18");
    assert_eq!(value("timestamp_us"), "123456");
    assert_eq!(value("v_batt_mv"), "8190");
    let gyro: f64 = fields
        .iter()
        .find(|field| field.name == "gyro_z")
        .and_then(|field| field.value_num)
        .unwrap();
    assert!((gyro + 0.042).abs() < 1e-6, "gyro_z {gyro}");
    assert_eq!(value("mode"), "1");
}

#[test]
fn an_array_field_keeps_its_elements() {
    let fields = decode();
    let samples = fields
        .iter()
        .find(|field| field.name == "samples")
        .expect("samples");
    let values: Vec<&str> = samples
        .children
        .iter()
        .map(|child| child.value.as_str())
        .collect();
    assert_eq!(values, vec!["1", "2", "3", "4"]);
}

#[test]
fn field_offsets_point_at_the_bytes_in_the_frame() {
    let frame = golden_frame();
    let fields = decode();
    // This is what the hex pane uses: a field must name the bytes it came from.
    for field in &fields {
        let start = field.byte_offset as usize;
        let end = start + field.byte_len as usize;
        assert!(end <= frame.len(), "{} runs past the frame", field.name);
    }
    let gyro = fields.iter().find(|field| field.name == "gyro_z").unwrap();
    let bytes = &frame[gyro.byte_offset as usize..][..gyro.byte_len as usize];
    assert_eq!(bytes, (-0.042f32).to_le_bytes());
}

#[test]
fn a_truncated_frame_names_the_first_field_that_does_not_fit() {
    let header = cheader::parse(HEADER).unwrap();
    let ir = cheader::compile(&header, "ImuPacket", "imu_packet.h").unwrap();
    let error = exec::execute(&ir, &golden_frame()[..12]).unwrap_err();
    let text = error.to_string();
    assert!(
        text.contains("gyro_z") || text.contains("samples"),
        "{text}"
    );
}

#[test]
fn a_second_struct_in_the_same_header_compiles() {
    let header = cheader::parse(HEADER).unwrap();
    let ir = cheader::compile(&header, "EpsCommand", "imu_packet.h").unwrap();
    let frame = [0x55u8, 0xAA, 0x09, 0x2C, 0x01, 0x00, 0x00];
    let fields = exec::execute(&ir, &frame).unwrap();
    let opcode = fields.iter().find(|field| field.name == "opcode").unwrap();
    assert_eq!(opcode.value, "9");
    let hold = fields
        .iter()
        .find(|field| field.name == "hold_time_s")
        .unwrap();
    assert_eq!(hold.value, "300");
}
