//! The `frame` a script receives: fields by name, and the bytes it came from.
//!
//! A script gets one object per call. `frame:get("v_batt_mv")` reads a decoded field,
//! `frame:set("v_batt_mv", 7400)` changes it, `frame:recalc_crc("crc32c")` fixes the
//! checksum after a change, and returning the frame sends the patched bytes. Fields the
//! script does not touch keep whatever the frame already carried.

use bforge_dissect::encoder::{self, Value as FieldValue};
use bforge_dissect::{DissectorIr, exec};
use mlua::{Lua, Table, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// What one call has read and changed.
pub struct FrameState {
    ir: DissectorIr,
    bytes: Vec<u8>,
    changed: BTreeMap<String, FieldValue>,
}

impl FrameState {
    pub fn new(ir: DissectorIr, bytes: &[u8]) -> Self {
        Self {
            ir,
            bytes: bytes.to_vec(),
            changed: BTreeMap::new(),
        }
    }

    /// The bytes after the script's changes, or the originals on a failed patch.
    ///
    /// Takes `&self` on purpose: the Lua closures hold their own reference to this
    /// state, so unwrapping it after the call is not possible and would silently drop
    /// every change.
    pub fn patched_bytes(&self) -> Vec<u8> {
        let mut bytes = self.bytes.clone();
        if !self.changed.is_empty() && encoder::patch(&self.ir, &mut bytes, &self.changed).is_err()
        {
            // The original is the honest answer; the caller counts the failure.
            return self.bytes.clone();
        }
        bytes
    }

    pub fn changed(&self) -> bool {
        !self.changed.is_empty()
    }
}

/// Build the `frame` table for one call.
pub fn frame_table(lua: &Lua, state: Arc<Mutex<FrameState>>) -> mlua::Result<Table> {
    let frame = lua.create_table()?;
    let original = {
        let state = state.lock().unwrap();
        crate::runtime::hex_of(&state.bytes)
    };
    frame.set("hex", original)?;
    let _ = &state;

    let get_state = Arc::clone(&state);
    frame.set(
        "get",
        lua.create_function(move |lua, (_this, name): (Table, String)| {
            let state = get_state.lock().unwrap();
            if let Some(changed) = state.changed.get(&name) {
                return match changed {
                    FieldValue::Number(number) => Ok(Value::Number(*number)),
                    FieldValue::Label(label) => Ok(Value::String(lua.create_string(label)?)),
                };
            }
            let fields = match exec::execute(&state.ir, &state.bytes) {
                Ok(fields) => fields,
                Err(_) => return Ok(Value::Nil),
            };
            let Some(field) = fields.iter().find(|field| field.name == name) else {
                return Ok(Value::Nil);
            };
            match field.value_num {
                Some(number) => Ok(Value::Number(number)),
                None => Ok(Value::String(lua.create_string(&field.value)?)),
            }
        })?,
    )?;

    let set_state = Arc::clone(&state);
    frame.set(
        "set",
        lua.create_function(move |_lua, (_this, name, value): (Table, String, Value)| {
            let mut state = set_state.lock().unwrap();
            let value = match value {
                Value::Integer(number) => FieldValue::Number(number as f64),
                Value::Number(number) => FieldValue::Number(number),
                Value::String(label) => FieldValue::Label(label.to_str()?.to_string()),
                other => {
                    return Err(mlua::Error::runtime(format!(
                        "`{name}` needs a number or a label, not a {}",
                        other.type_name()
                    )));
                }
            };
            state.changed.insert(name, value);
            Ok(())
        })?,
    )?;

    let crc_state = Arc::clone(&state);
    frame.set(
        "recalc_crc",
        lua.create_function(move |_lua, (_this, name): (Table, String)| {
            let Some(kind) = bforge_framer::Checksum::from_name(&name) else {
                return Err(mlua::Error::runtime(format!(
                    "`{name}` is not a checksum; use crc8, crc16_ccitt_false or crc32c"
                )));
            };
            let mut state = crc_state.lock().unwrap();
            let width = usize::from(kind.width() / 8);
            if state.bytes.len() < width {
                return Err(mlua::Error::runtime(
                    "the frame is shorter than its checksum",
                ));
            }
            // The checksum must cover the fields the script just changed, so the patch
            // is folded in before the bytes are summed.
            if !state.changed.is_empty() {
                let mut patched = state.bytes.clone();
                let _ = encoder::patch(&state.ir, &mut patched, &state.changed);
                state.bytes = patched;
                state.changed.clear();
            }
            let split = state.bytes.len() - width;
            let value = kind.compute(&state.bytes[..split]);
            match width {
                1 => state.bytes[split] = value as u8,
                2 => state.bytes[split..].copy_from_slice(&(value as u16).to_le_bytes()),
                _ => state.bytes[split..].copy_from_slice(&value.to_le_bytes()),
            }
            Ok(())
        })?,
    )?;

    let bytes_state = Arc::clone(&state);
    frame.set(
        "bytes",
        lua.create_function(move |lua, _this: Table| {
            let state = bytes_state.lock().unwrap();
            let mut bytes = state.bytes.clone();
            if state.changed() {
                let _ = encoder::patch(&state.ir, &mut bytes, &state.changed);
            }
            lua.create_string(crate::runtime::hex_of(&bytes))
        })?,
    )?;

    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bforge_dissect::cheader;

    fn imu() -> DissectorIr {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../bforge-dissect/tests/fixtures/imu_packet.h"
        );
        let text = std::fs::read_to_string(path).expect("fixture");
        let header = cheader::parse(&text).expect("parses");
        cheader::compile(&header, "ImuPacket", path).expect("compiles")
    }

    #[test]
    fn a_change_touches_one_field_and_leaves_the_rest() {
        let mut bytes = vec![0u8; 19];
        bytes[0] = 0x55;
        bytes[1] = 0xAA;
        let mut state = FrameState::new(imu(), &bytes);
        state
            .changed
            .insert("v_batt_mv".to_string(), FieldValue::Number(7400.0));
        let patched = state.patched_bytes();
        assert_eq!(&patched[0..2], &[0x55, 0xAA], "the sync word is untouched");
        assert_eq!(
            &patched[8..10],
            &[0x1C, 0xE8],
            "the field was written big endian"
        );
        assert_eq!(patched.len(), bytes.len());
    }

    #[test]
    fn a_name_the_schema_does_not_have_leaves_the_frame_alone() {
        let bytes = vec![1u8; 19];
        let mut state = FrameState::new(imu(), &bytes);
        state
            .changed
            .insert("nope".to_string(), FieldValue::Number(1.0));
        assert_eq!(state.patched_bytes(), bytes);
    }
}
