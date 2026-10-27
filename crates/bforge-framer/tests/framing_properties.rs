//! Property tests (F1.4.7): a frame boundary must not depend on how the stream
//! was cut. Each machine is fed the same bytes once in one piece and then in
//! random pieces, and the frames must match exactly.

use bforge_framer::{
    ByteMachine, Cobs, Delimiter, HeaderLength, LengthWidth, Slip, cobs_encode, slip_encode,
};

/// Small deterministic generator, so a failure is reproducible from the seed.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn byte(&mut self) -> u8 {
        self.next() as u8
    }
}

fn whole(machine: &mut dyn ByteMachine, stream: &[u8]) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    machine.feed(stream, &mut frames);
    frames
}

fn in_pieces(machine: &mut dyn ByteMachine, stream: &[u8], rng: &mut Lcg) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut rest = stream;
    while !rest.is_empty() {
        let take = (rng.next() as usize % rest.len()) + 1;
        let (head, tail) = rest.split_at(take);
        machine.feed(head, &mut frames);
        rest = tail;
    }
    frames
}

#[test]
fn cobs_frames_do_not_depend_on_the_split() {
    let mut rng = Lcg(0x00C0_0001);
    for _ in 0..20 {
        let mut stream = Vec::new();
        let mut expected_frames = Vec::new();
        for _ in 0..50 {
            let len = (rng.next() as usize % 300) + 1;
            let mut frame: Vec<u8> = (0..len).map(|_| rng.byte()).collect();
            // Force a zero so the encoder has to insert a code byte.
            frame[len / 2] = 0;
            stream.extend(cobs_encode(&frame));
            stream.push(0);
            expected_frames.push(frame);
        }

        let mut one = Cobs::new(4096);
        assert_eq!(whole(&mut one, &stream), expected_frames);

        let mut split = Cobs::new(4096);
        assert_eq!(in_pieces(&mut split, &stream, &mut rng), expected_frames);
        assert_eq!(split.invalid_blocks(), 0);
    }
}

#[test]
fn slip_frames_do_not_depend_on_the_split() {
    let mut rng = Lcg(0x5110_0001);
    for _ in 0..20 {
        let mut stream = Vec::new();
        let mut expected_frames = Vec::new();
        for _ in 0..50 {
            let len = (rng.next() as usize % 200) + 1;
            let frame: Vec<u8> = (0..len).map(|_| rng.byte()).collect();
            stream.extend(slip_encode(&frame));
            expected_frames.push(frame);
        }

        let mut one = Slip::new(4096);
        assert_eq!(whole(&mut one, &stream), expected_frames);

        let mut split = Slip::new(4096);
        assert_eq!(in_pieces(&mut split, &stream, &mut rng), expected_frames);
    }
}

#[test]
fn header_length_frames_do_not_depend_on_the_split() {
    let mut rng = Lcg(0xA5_55);
    for _ in 0..20 {
        let mut stream = Vec::new();
        let mut expected_frames = Vec::new();
        for _ in 0..40 {
            // Sync AA 55, one length byte counting the payload, total = len + 3.
            let len = (rng.next() as usize % 64) + 1;
            let mut frame = vec![0xAA, 0x55, len as u8];
            frame.extend((0..len).map(|_| rng.byte()));
            stream.extend(&frame);
            expected_frames.push(frame);
        }

        let build = || HeaderLength::new(vec![0xAA, 0x55], 2, LengthWidth::U8, 3, 4096);
        assert_eq!(whole(&mut build(), &stream), expected_frames);
        assert_eq!(in_pieces(&mut build(), &stream, &mut rng), expected_frames);
    }
}

#[test]
fn delimiter_frames_do_not_depend_on_the_split() {
    let mut rng = Lcg(0xDE_11);
    for _ in 0..20 {
        let mut stream = Vec::new();
        let mut expected_frames = Vec::new();
        for _ in 0..50 {
            let len = (rng.next() as usize % 120) + 1;
            let mut frame: Vec<u8> = (0..len).map(|_| rng.byte()).collect();
            // A delimiter byte inside the payload would split the frame, so keep
            // the payload free of it.
            for byte in &mut frame {
                if *byte == b'\n' {
                    *byte = b'!';
                }
            }
            stream.extend_from_slice(&frame);
            stream.push(b'\n');
            expected_frames.push(frame);
        }

        let build = || Delimiter::new(b"\n".to_vec(), 4096);
        assert_eq!(whole(&mut build(), &stream), expected_frames);
        assert_eq!(in_pieces(&mut build(), &stream, &mut rng), expected_frames);
    }
}
