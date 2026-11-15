//! The `frame` userdata a script receives: fields by name, metadata, and raw byte accessors.
//!
//! A script gets one [`LuaFrame`] handle per frame callback. Metadata properties (`frame.port`,
//! `frame.direction`, `frame.seq_id`, `frame.timestamp_us`, `frame.len`, `frame.bridge`) and
//! lazy `frame.hex` are exposed alongside zero-offset binary readers/writers, lazy single-pass
//! schema dissection (`frame:get`, `frame:set`, `frame:fields`, `frame:dissect`), checksum
//! calculation (`frame:recalc_crc`, `frame:corrupt_crc`), and verdict controls (`frame:delay_ms`,
//! `frame:drop`).

use crate::runtime::{FrameMeta, hex_of, parse_hex};
use bforge_dissect::encoder::{self, Value as FieldValue};
use bforge_dissect::{DecodedField, DissectorIr, exec};
use mlua::{AnyUserData, Lua, Table, UserData, UserDataFields, UserDataMethods, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// Custom dissected field `(name, offset, len, display, numeric_value)`.
pub type CustomFieldEntry = (String, usize, usize, String, Option<f64>);

/// Compute CRC-16/MODBUS (reflected poly `0xA001`, init `0xFFFF`).
pub fn crc16_modbus(data: &[u8]) -> u16 {
    let mut crc = 0xFFFFu16;
    for &byte in data {
        crc ^= u16::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xA001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

/// Resolve a supported checksum algorithm name and compute `(width_bytes, value)`.
pub fn crc_width_and_compute(name: &str, data: &[u8]) -> Option<(usize, u32)> {
    match name {
        "crc8" | "crc8_atm" => Some((1, u32::from(bforge_framer::checksum::crc8_atm(data)))),
        "crc16" | "crc16_ccitt_false" => Some((
            2,
            u32::from(bforge_framer::checksum::crc16_ccitt_false(data)),
        )),
        "crc16_modbus" => Some((2, u32::from(crc16_modbus(data)))),
        "crc16_xmodem" => Some((2, u32::from(crate::xymodem::crc16_xmodem(data)))),
        "crc32c" => Some((4, bforge_framer::checksum::crc32c(data))),
        _ => None,
    }
}

/// Parse a Lua value (`String`, byte array `Table`, or `LuaFrame` userdata) into raw bytes.
///
/// Strings containing ASCII whitespace whose tokens all parse as two-digit hex bytes are decoded
/// as spaced hex; all other Lua strings (including compact binary `string.pack` payloads) are
/// taken verbatim as raw bytes.
pub(crate) fn parse_lua_bytes(value: Value) -> mlua::Result<Vec<u8>> {
    match value {
        Value::String(s) => {
            let raw = s.as_bytes();
            if let Ok(text) = std::str::from_utf8(&raw)
                && text.chars().any(char::is_whitespace)
                && let Ok(parsed) = parse_hex(text)
            {
                return Ok(parsed);
            }
            Ok(raw.to_vec())
        }
        Value::Table(table) => {
            let mut bytes = Vec::with_capacity(table.raw_len());
            for item in table.sequence_values::<u8>() {
                bytes.push(item?);
            }
            Ok(bytes)
        }
        Value::UserData(ud) => {
            let frame = ud.borrow::<LuaFrame>()?;
            let state = frame.0.lock().unwrap();
            Ok(state.preview_bytes())
        }
        other => Err(mlua::Error::runtime(format!(
            "expected bytes (string, byte table, or frame), got {}",
            other.type_name()
        ))),
    }
}

/// What one script call has read, mutated, or requested for a frame.
pub struct FrameState {
    ir: Option<DissectorIr>,
    schemas: Arc<BTreeMap<String, DissectorIr>>,
    meta: FrameMeta,
    bytes: Vec<u8>,
    changed: BTreeMap<String, FieldValue>,
    raw_mutated: bool,
    decoded_cache: Option<Vec<DecodedField>>,
    custom_fields: Vec<CustomFieldEntry>,
    drop_requested: bool,
    delay_ms: Option<u16>,
}

impl FrameState {
    /// Create frame state bound to a dissector schema.
    pub fn new(ir: DissectorIr, bytes: &[u8]) -> Self {
        Self::with_context(Some(ir), Arc::default(), FrameMeta::default(), bytes)
    }

    /// Create frame state without an active dissector schema.
    pub fn new_raw(bytes: &[u8]) -> Self {
        Self::with_context(None, Arc::default(), FrameMeta::default(), bytes)
    }

    /// Create frame state with optional schema, schema registry, and frame metadata.
    pub fn with_context(
        ir: Option<DissectorIr>,
        schemas: Arc<BTreeMap<String, DissectorIr>>,
        meta: FrameMeta,
        bytes: &[u8],
    ) -> Self {
        Self {
            ir,
            schemas,
            meta,
            bytes: bytes.to_vec(),
            changed: BTreeMap::new(),
            raw_mutated: false,
            decoded_cache: None,
            custom_fields: Vec::new(),
            drop_requested: false,
            delay_ms: None,
        }
    }

    /// The bytes after the script's changes, plus the patch failure if any
    /// field could not be written.
    ///
    /// A failed patch returns the originals — never a half-patched frame — and
    /// the failure is the caller's to report, which the runtime does through
    /// its failure counter (F-38).
    pub fn patched_bytes(&mut self) -> (Vec<u8>, Option<String>) {
        if self.changed.is_empty() {
            return (self.bytes.clone(), None);
        }
        let Some(ir) = &self.ir else {
            return (
                self.bytes.clone(),
                Some("no schema attached to patch named fields".to_string()),
            );
        };
        let mut bytes = self.bytes.clone();
        if let Err(error) = encoder::patch(ir, &mut bytes, &self.changed) {
            return (self.bytes.clone(), Some(error.to_string()));
        }
        (bytes, None)
    }

    pub fn changed(&self) -> bool {
        !self.changed.is_empty() || self.raw_mutated
    }

    pub fn drop_requested(&self) -> bool {
        self.drop_requested
    }

    pub fn delay_ms(&self) -> Option<u16> {
        self.delay_ms
    }

    pub fn active_ir(&self) -> Option<&DissectorIr> {
        self.ir.as_ref()
    }

    pub fn custom_fields(&self) -> &[CustomFieldEntry] {
        &self.custom_fields
    }

    /// Apply raw replacement bytes directly (e.g. when a Lua hook returns spaced hex).
    pub(crate) fn replace_bytes(&mut self, next: Vec<u8>) {
        self.bytes = next;
        self.changed.clear();
        self.decoded_cache = None;
        self.raw_mutated = true;
    }

    /// Preview bytes incorporating pending field patches without losing error state on failure.
    pub(crate) fn preview_bytes(&self) -> Vec<u8> {
        if self.changed.is_empty() {
            return self.bytes.clone();
        }
        let Some(ir) = &self.ir else {
            return self.bytes.clone();
        };
        let mut bytes = self.bytes.clone();
        if encoder::patch(ir, &mut bytes, &self.changed).is_err() {
            return self.bytes.clone();
        }
        bytes
    }

    fn with_preview_slice<R>(&self, f: impl FnOnce(&[u8]) -> mlua::Result<R>) -> mlua::Result<R> {
        if self.changed.is_empty() {
            return f(&self.bytes);
        }
        let preview = self.preview_bytes();
        f(&preview)
    }

    /// Fold pending named field changes into `self.bytes` before raw byte mutation (F-38).
    fn flush_changed(&mut self) -> mlua::Result<()> {
        if self.changed.is_empty() {
            return Ok(());
        }
        let Some(ir) = &self.ir else {
            return Err(mlua::Error::runtime(
                "cannot flush field changes without an active schema",
            ));
        };
        let mut patched = self.bytes.clone();
        if let Err(error) = encoder::patch(ir, &mut patched, &self.changed) {
            return Err(mlua::Error::runtime(format!(
                "could not apply frame changes: {error}"
            )));
        }
        self.bytes = patched;
        self.changed.clear();
        self.decoded_cache = None;
        self.raw_mutated = true;
        Ok(())
    }

    fn mutate_bytes<R>(
        &mut self,
        f: impl FnOnce(&mut Vec<u8>) -> mlua::Result<R>,
    ) -> mlua::Result<R> {
        self.flush_changed()?;
        let out = f(&mut self.bytes)?;
        self.decoded_cache = None;
        self.raw_mutated = true;
        Ok(out)
    }

    fn ensure_decoded(&mut self) -> &[DecodedField] {
        if self.decoded_cache.is_none() {
            let decoded = match &self.ir {
                Some(ir) => exec::execute(ir, &self.bytes).unwrap_or_default(),
                None => Vec::new(),
            };
            self.decoded_cache = Some(decoded);
        }
        self.decoded_cache.as_deref().unwrap_or(&[])
    }

    fn lookup_schema(&self, tag: &str) -> Option<DissectorIr> {
        if let Some(ir) = self.schemas.get(tag) {
            return Some(ir.clone());
        }
        let port_key = format!("port:{tag}");
        if let Some(ir) = self.schemas.get(&port_key) {
            return Some(ir.clone());
        }
        let schema_key = format!("schema:{tag}");
        if let Some(ir) = self.schemas.get(&schema_key) {
            return Some(ir.clone());
        }
        if let Some(stripped) = tag.strip_prefix("C_STRUCT:") {
            if let Some(ir) = self.schemas.get(stripped) {
                return Some(ir.clone());
            }
            let stripped_schema_key = format!("schema:{stripped}");
            if let Some(ir) = self.schemas.get(&stripped_schema_key) {
                return Some(ir.clone());
            }
        }
        None
    }
}

fn read_arr<const N: usize>(bytes: &[u8], off: usize) -> mlua::Result<[u8; N]> {
    let end = off
        .checked_add(N)
        .ok_or_else(|| mlua::Error::runtime("offset overflow"))?;
    let slice = bytes.get(off..end).ok_or_else(|| {
        mlua::Error::runtime(format!(
            "read of {N} byte(s) at offset {off} out of bounds (len {})",
            bytes.len()
        ))
    })?;
    Ok(slice.try_into().expect("slice length matches N"))
}

fn write_arr<const N: usize>(bytes: &mut [u8], off: usize, src: [u8; N]) -> mlua::Result<()> {
    let end = off
        .checked_add(N)
        .ok_or_else(|| mlua::Error::runtime("offset overflow"))?;
    let len = bytes.len();
    let slice = bytes.get_mut(off..end).ok_or_else(|| {
        mlua::Error::runtime(format!(
            "write of {N} byte(s) at offset {off} out of bounds (len {len})"
        ))
    })?;
    slice.copy_from_slice(&src);
    Ok(())
}

fn find_decoded_field<'a>(fields: &'a [DecodedField], name: &str) -> Option<&'a DecodedField> {
    for field in fields {
        if field.name == name && field.children.is_empty() {
            return Some(field);
        }
        if !field.children.is_empty() {
            if let Some(rest) = name.strip_prefix(&field.name) {
                if let Some(idx_str) = rest.strip_prefix('.') {
                    if let Ok(idx) = idx_str.parse::<usize>()
                        && let Some(child) = field.children.get(idx)
                        && child.children.is_empty()
                    {
                        return Some(child);
                    }
                } else if let Ok(idx) = rest.parse::<usize>()
                    && let Some(child) = field.children.get(idx)
                    && child.children.is_empty()
                {
                    return Some(child);
                }
            }
            if let Some(found) = find_decoded_field(&field.children, name) {
                return Some(found);
            }
        }
        if field.name == name {
            return Some(field);
        }
    }
    None
}

fn populate_fields_table(lua: &Lua, table: &Table, fields: &[DecodedField]) -> mlua::Result<()> {
    for field in fields {
        if field.children.is_empty() {
            let val = match field.value_num {
                Some(number) => Value::Number(number),
                None => Value::String(lua.create_string(&field.value)?),
            };
            table.set(field.name.as_str(), val)?;
        } else {
            for (idx, child) in field.children.iter().enumerate() {
                if child.children.is_empty() {
                    let key = format!("{}.{idx}", field.name);
                    let val = match child.value_num {
                        Some(number) => Value::Number(number),
                        None => Value::String(lua.create_string(&child.value)?),
                    };
                    table.set(key, val)?;
                } else {
                    populate_fields_table(lua, table, std::slice::from_ref(child))?;
                }
            }
        }
    }
    Ok(())
}

/// Lua `UserData` handle wrapping a shared [`FrameState`].
#[derive(Clone)]
pub struct LuaFrame(pub Arc<Mutex<FrameState>>);

impl UserData for LuaFrame {
    fn add_fields<F: UserDataFields<Self>>(fields: &mut F) {
        fields.add_field_method_get("hex", |_, this| {
            let state = this.0.lock().unwrap();
            Ok(hex_of(&state.preview_bytes()))
        });
        fields.add_field_method_get("port", |_, this| {
            let state = this.0.lock().unwrap();
            Ok(state.meta.port.clone())
        });
        fields.add_field_method_get("direction", |_, this| {
            let state = this.0.lock().unwrap();
            Ok(state.meta.direction.clone())
        });
        fields.add_field_method_get("seq_id", |_, this| {
            let state = this.0.lock().unwrap();
            Ok(state.meta.seq_id)
        });
        fields.add_field_method_get("timestamp_us", |_, this| {
            let state = this.0.lock().unwrap();
            Ok(state.meta.timestamp_us)
        });
        fields.add_field_method_get("len", |_, this| {
            let state = this.0.lock().unwrap();
            Ok(state.bytes.len())
        });
        fields.add_field_method_get("bridge", |_, this| {
            let state = this.0.lock().unwrap();
            Ok(state.meta.bridge.clone())
        });
    }

    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        // --- Dissection & named field methods ---
        methods.add_method("get", |lua, this, name: String| {
            let mut state = this.0.lock().unwrap();
            if let Some(changed) = state.changed.get(&name) {
                return match changed {
                    FieldValue::Number(number) => Ok(Value::Number(*number)),
                    FieldValue::Label(label) => Ok(Value::String(lua.create_string(label)?)),
                };
            }
            if state.ir.is_some() {
                let decoded = state.ensure_decoded();
                if let Some(field) = find_decoded_field(decoded, &name) {
                    return match field.value_num {
                        Some(number) => Ok(Value::Number(number)),
                        None => Ok(Value::String(lua.create_string(&field.value)?)),
                    };
                }
            }
            if let Some((_, _, _, display, num)) = state
                .custom_fields
                .iter()
                .rev()
                .find(|(field_name, _, _, _, _)| field_name == &name)
            {
                return match num {
                    Some(number) => Ok(Value::Number(*number)),
                    None => Ok(Value::String(lua.create_string(display)?)),
                };
            }
            Ok(Value::Nil)
        });

        methods.add_method("set", |_, this, (name, value): (String, Value)| {
            let mut state = this.0.lock().unwrap();
            if state.ir.is_none() {
                return Err(mlua::Error::runtime(format!(
                    "cannot set `{name}`: no schema is attached to this frame"
                )));
            }
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
        });

        methods.add_method("fields", |lua, this, ()| {
            let mut state = this.0.lock().unwrap();
            let table = lua.create_table()?;
            if state.ir.is_some() {
                let decoded = state.ensure_decoded().to_vec();
                populate_fields_table(lua, &table, &decoded)?;
            }
            for (name, _, _, display, num) in &state.custom_fields {
                let val = match num {
                    Some(number) => Value::Number(*number),
                    None => Value::String(lua.create_string(display)?),
                };
                table.set(name.as_str(), val)?;
            }
            for (name, value) in &state.changed {
                let val = match value {
                    FieldValue::Number(number) => Value::Number(*number),
                    FieldValue::Label(label) => Value::String(lua.create_string(label)?),
                };
                table.set(name.as_str(), val)?;
            }
            Ok(table)
        });

        methods.add_function("dissect", |lua, (ud, tag): (AnyUserData, String)| {
            let frame = ud.borrow::<LuaFrame>()?;
            let found = {
                let state = frame.0.lock().unwrap();
                state.lookup_schema(&tag)
            };
            let Some(found) = found else {
                return Ok(Value::Nil);
            };
            {
                let mut state = frame.0.lock().unwrap();
                state.flush_changed()?;
                state.ir = Some(found);
                state.decoded_cache = None;
            }
            let handle = lua.create_userdata(LuaFrame(Arc::clone(&frame.0)))?;
            Ok(Value::UserData(handle))
        });

        methods.add_method(
            "add_field",
            |_, this, (name, offset, len, display, num): (String, usize, usize, String, Option<f64>)| {
                let mut state = this.0.lock().unwrap();
                state.custom_fields.push((name, offset, len, display, num));
                Ok(())
            },
        );

        // --- Zero-offset binary readers ---
        methods.add_method("u8", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(read_arr::<1>(b, off)?[0]))
        });
        methods.add_method("i8", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(read_arr::<1>(b, off)?[0] as i8))
        });
        methods.add_method("u16_le", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(u16::from_le_bytes(read_arr::<2>(b, off)?)))
        });
        methods.add_method("u16_be", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(u16::from_be_bytes(read_arr::<2>(b, off)?)))
        });
        methods.add_method("i16_le", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(i16::from_le_bytes(read_arr::<2>(b, off)?)))
        });
        methods.add_method("i16_be", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(i16::from_be_bytes(read_arr::<2>(b, off)?)))
        });
        methods.add_method("u32_le", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(u32::from_le_bytes(read_arr::<4>(b, off)?)))
        });
        methods.add_method("u32_be", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(u32::from_be_bytes(read_arr::<4>(b, off)?)))
        });
        methods.add_method("i32_le", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(i32::from_le_bytes(read_arr::<4>(b, off)?)))
        });
        methods.add_method("i32_be", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(i32::from_be_bytes(read_arr::<4>(b, off)?)))
        });
        methods.add_method("f32_le", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(f32::from_le_bytes(read_arr::<4>(b, off)?)))
        });
        methods.add_method("f32_be", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(f32::from_be_bytes(read_arr::<4>(b, off)?)))
        });
        methods.add_method("f64_le", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(f64::from_le_bytes(read_arr::<8>(b, off)?)))
        });
        methods.add_method("f64_be", |_, this, off: usize| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| Ok(f64::from_be_bytes(read_arr::<8>(b, off)?)))
        });

        methods.add_method("slice", |lua, this, (off, len): (usize, usize)| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| {
                let end = off
                    .checked_add(len)
                    .ok_or_else(|| mlua::Error::runtime("slice offset overflow"))?;
                let slice = b.get(off..end).ok_or_else(|| {
                    mlua::Error::runtime(format!(
                        "slice {off}..{end} out of bounds (len {})",
                        b.len()
                    ))
                })?;
                lua.create_string(slice)
            })
        });

        methods.add_method("raw", |lua, this, ()| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| lua.create_string(b))
        });

        methods.add_method("clone_bytes", |lua, this, ()| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| lua.create_string(b))
        });

        methods.add_method("bytes", |lua, this, ()| {
            let state = this.0.lock().unwrap();
            state.with_preview_slice(|b| lua.create_string(hex_of(b)))
        });

        // --- Zero-offset binary writers ---
        methods.add_method("set_u8", |_, this, (off, val): (usize, u8)| {
            let mut state = this.0.lock().unwrap();
            state.mutate_bytes(|b| write_arr(b, off, [val]))
        });
        methods.add_method("set_u16_le", |_, this, (off, val): (usize, u16)| {
            let mut state = this.0.lock().unwrap();
            state.mutate_bytes(|b| write_arr(b, off, val.to_le_bytes()))
        });
        methods.add_method("set_u16_be", |_, this, (off, val): (usize, u16)| {
            let mut state = this.0.lock().unwrap();
            state.mutate_bytes(|b| write_arr(b, off, val.to_be_bytes()))
        });
        methods.add_method("set_u32_le", |_, this, (off, val): (usize, u32)| {
            let mut state = this.0.lock().unwrap();
            state.mutate_bytes(|b| write_arr(b, off, val.to_le_bytes()))
        });
        methods.add_method("set_u32_be", |_, this, (off, val): (usize, u32)| {
            let mut state = this.0.lock().unwrap();
            state.mutate_bytes(|b| write_arr(b, off, val.to_be_bytes()))
        });
        methods.add_method("xor_u8", |_, this, (off, mask): (usize, u8)| {
            let mut state = this.0.lock().unwrap();
            state.mutate_bytes(|b| {
                let len = b.len();
                let byte = b.get_mut(off).ok_or_else(|| {
                    mlua::Error::runtime(format!("xor_u8 offset {off} out of bounds (len {len})"))
                })?;
                *byte ^= mask;
                Ok(())
            })
        });
        methods.add_method("xor_bit", |_, this, (off, bit): (usize, u8)| {
            if bit >= 8 {
                return Err(mlua::Error::runtime(format!(
                    "bit index {bit} out of range 0..8"
                )));
            }
            let mut state = this.0.lock().unwrap();
            state.mutate_bytes(|b| {
                let len = b.len();
                let byte = b.get_mut(off).ok_or_else(|| {
                    mlua::Error::runtime(format!("xor_bit offset {off} out of bounds (len {len})"))
                })?;
                *byte ^= 1u8 << bit;
                Ok(())
            })
        });
        methods.add_method("set_bytes", |_, this, val: Value| {
            let next = parse_lua_bytes(val)?;
            let mut state = this.0.lock().unwrap();
            state.mutate_bytes(|b| {
                *b = next;
                Ok(())
            })
        });
        methods.add_method("resize", |_, this, new_len: usize| {
            let mut state = this.0.lock().unwrap();
            state.mutate_bytes(|b| {
                b.resize(new_len, 0);
                Ok(())
            })
        });

        // --- Checksums ---
        methods.add_function(
            "recalc_crc",
            |_, (ud, name, start_off, end_off): (AnyUserData, String, Option<usize>, Option<usize>)| {
                let frame = ud.borrow::<LuaFrame>()?;
                let mut state = frame.0.lock().unwrap();
                state.mutate_bytes(|b| {
                    let Some((width, _)) = crc_width_and_compute(&name, &[]) else {
                        return Err(mlua::Error::runtime(format!(
                            "`{name}` is not a supported checksum; use crc8, crc16_ccitt_false, crc16_modbus, crc16_xmodem or crc32c"
                        )));
                    };
                    if b.len() < width {
                        return Err(mlua::Error::runtime(
                            "the frame is shorter than its checksum",
                        ));
                    }
                    let split = b.len() - width;
                    let start = start_off.unwrap_or(0);
                    let end = end_off.unwrap_or(split);
                    if start > end || end > split {
                        return Err(mlua::Error::runtime(format!(
                            "recalc_crc range {start}..{end} invalid for payload split {split}"
                        )));
                    }
                    let (_, value) = crc_width_and_compute(&name, &b[start..end])
                        .expect("validated checksum name");
                    match width {
                        1 => b[split] = value as u8,
                        2 => b[split..].copy_from_slice(&(value as u16).to_le_bytes()),
                        _ => b[split..].copy_from_slice(&value.to_le_bytes()),
                    }
                    Ok(())
                })?;
                drop(state);
                Ok(ud)
            },
        );

        methods.add_function(
            "corrupt_crc",
            |_, (ud, count): (AnyUserData, Option<usize>)| {
                let frame = ud.borrow::<LuaFrame>()?;
                let mut state = frame.0.lock().unwrap();
                let count = count.unwrap_or(1).clamp(1, 4);
                state.mutate_bytes(|b| {
                    if b.len() < count {
                        return Err(mlua::Error::runtime(format!(
                            "frame length {} is shorter than corrupt_crc count {count}",
                            b.len()
                        )));
                    }
                    let start = b.len() - count;
                    for byte in &mut b[start..] {
                        *byte ^= 0xFF;
                    }
                    Ok(())
                })?;
                drop(state);
                Ok(ud)
            },
        );

        // --- Verdict controls ---
        methods.add_function("delay_ms", |_, (ud, ms): (AnyUserData, u16)| {
            let frame = ud.borrow::<LuaFrame>()?;
            frame.0.lock().unwrap().delay_ms = Some(ms);
            Ok(ud)
        });
        methods.add_function("forward_after_ms", |_, (ud, ms): (AnyUserData, u16)| {
            let frame = ud.borrow::<LuaFrame>()?;
            frame.0.lock().unwrap().delay_ms = Some(ms);
            Ok(ud)
        });
        methods.add_function("drop", |_, ud: AnyUserData| {
            let frame = ud.borrow::<LuaFrame>()?;
            frame.0.lock().unwrap().drop_requested = true;
            Ok(ud)
        });
    }
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
        let (patched, error) = state.patched_bytes();
        assert_eq!(error, None);
        assert_eq!(&patched[0..2], &[0x55, 0xAA], "the sync word is untouched");
        assert_eq!(
            &patched[8..10],
            &[0x1C, 0xE8],
            "the field was written big endian"
        );
        assert_eq!(patched.len(), bytes.len());
    }

    #[test]
    fn a_name_the_schema_does_not_have_returns_the_originals_and_the_failure() {
        let bytes = vec![1u8; 19];
        let mut state = FrameState::new(imu(), &bytes);
        state
            .changed
            .insert("nope".to_string(), FieldValue::Number(1.0));
        let (patched, error) = state.patched_bytes();
        assert_eq!(patched, bytes);
        assert!(error.is_some(), "the patch failure must be reported (F-38)");
    }

    #[test]
    fn crc16_modbus_matches_standard_test_vector() {
        assert_eq!(crc16_modbus(b"123456789"), 0x4B37);
        assert_eq!(
            crc_width_and_compute("crc16_xmodem", b"123456789"),
            Some((2, 0x31C3))
        );
    }

    #[test]
    fn lazy_decode_cache_populates_once_and_invalidates_on_mutation() {
        let mut bytes = vec![0u8; 19];
        bytes[8] = 0x1C;
        bytes[9] = 0xE8;
        let mut state = FrameState::new(imu(), &bytes);
        assert!(state.decoded_cache.is_none());

        let first = state.ensure_decoded();
        assert!(
            first
                .iter()
                .any(|f| f.name == "v_batt_mv" && f.value_num == Some(7400.0))
        );
        assert!(state.decoded_cache.is_some());

        state
            .mutate_bytes(|b| {
                b[8] = 0x1D;
                b[9] = 0x4C; // 7500
                Ok(())
            })
            .unwrap();
        assert!(state.decoded_cache.is_none());

        let second = state.ensure_decoded();
        assert!(
            second
                .iter()
                .any(|f| f.name == "v_batt_mv" && f.value_num == Some(7500.0))
        );
    }
}
