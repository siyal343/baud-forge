//! The HIL script runtime (ADR-004, FR-SCR-01).
//!
//! One sandboxed Lua 5.4 VM per armed script. A script gets one hook: it sees the
//! bytes the engine is about to send, and returns the bytes to send instead.
//! Returning `nil` drops the frame.
//!
//! The sandbox is the point. A rig runs someone's script next to a live link, so the
//! VM has no file system, no process, no clock and no package loader, and each call
//! has an instruction budget: an infinite loop in a script costs one frame, not the
//! session.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use bforge_dissect::DissectorIr;
use mlua::{HookTriggers, Lua, Value, VmState};

/// Instructions one frame may spend before the call is abandoned.
const INSTRUCTION_BUDGET: u32 = 200_000;

/// How many hook ticks that budget allows, when a tick is 10 000 instructions.
const HOOK_TICK: u32 = 10_000;
const HOOK_TICKS: u32 = INSTRUCTION_BUDGET / HOOK_TICK;

/// What a script did to one frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameVerdict {
    /// Forwarded, possibly changed.
    Send(Vec<u8>),
    /// The script returned nil.
    Drop,
}

/// A loaded script, ready to run on the transmit path.
pub struct ScriptRuntime {
    lua: Lua,
    hook: mlua::RegistryKey,
    path: String,
    ticks: Arc<AtomicU32>,
    /// Frames the script changed.
    pub changed: u64,
    /// Frames the script dropped.
    pub dropped: u64,
    /// Calls that failed, including a spent instruction budget.
    pub failures: u64,
    /// The last failure, for the UI and the log.
    pub last_error: Option<String>,
    /// The port's schema, when it has one: a script may then read and write fields.
    ir: Option<DissectorIr>,
}

impl std::fmt::Debug for ScriptRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ScriptRuntime")
            .field("path", &self.path)
            .field("changed", &self.changed)
            .field("dropped", &self.dropped)
            .field("failures", &self.failures)
            .finish()
    }
}

impl ScriptRuntime {
    /// Load a script from a file and take its hook.
    pub fn load(path: impl AsRef<std::path::Path>) -> Result<Self, ScriptError> {
        let path = path.as_ref();
        let source = std::fs::read_to_string(path).map_err(|error| ScriptError {
            message: format!("{}: {error}", path.display()),
        })?;
        Self::compile(&source, &path.display().to_string())
    }

    /// Compile a script from text. Tests use this; the engine uses `load`.
    pub fn compile(source: &str, name: &str) -> Result<Self, ScriptError> {
        let lua = Lua::new_with(
            mlua::StdLib::TABLE | mlua::StdLib::STRING | mlua::StdLib::MATH | mlua::StdLib::UTF8,
            mlua::LuaOptions::default(),
        )
        .map_err(|error| ScriptError {
            message: format!("cannot start Lua: {error}"),
        })?;

        install_api(&lua)?;
        lua.load(source)
            .set_name(name)
            .exec()
            .map_err(|error| ScriptError {
                message: format!("{name}: {error}"),
            })?;

        let hook = match lua.globals().get::<Value>("on_frame") {
            Ok(Value::Function(function)) => {
                lua.create_registry_value(function)
                    .map_err(|error| ScriptError {
                        message: format!("{name}: {error}"),
                    })?
            }
            Ok(_) => {
                return Err(ScriptError {
                    message: format!("{name}: the script must call `bforge.on_frame(fn)`"),
                });
            }
            Err(error) => {
                return Err(ScriptError {
                    message: format!("{name}: {error}"),
                });
            }
        };

        let ticks = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&ticks);
        lua.set_hook(
            HookTriggers::new().every_nth_instruction(HOOK_TICK),
            move |_lua, _debug| {
                let spent = counter.fetch_add(1, Ordering::Relaxed) + 1;
                if spent > HOOK_TICKS {
                    Err(mlua::Error::runtime("instruction budget exceeded"))
                } else {
                    Ok(VmState::Continue)
                }
            },
        );

        Ok(Self {
            lua,
            hook,
            path: name.to_string(),
            ticks,
            changed: 0,
            dropped: 0,
            failures: 0,
            last_error: None,
            ir: None,
        })
    }

    /// Give the runtime a schema, so a script can read and write fields by name.
    pub fn with_schema(mut self, ir: DissectorIr) -> Self {
        self.ir = Some(ir);
        self
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    /// Run the hook on one frame.
    ///
    /// A failing script leaves the frame as it was: a rig must not stop passing
    /// bytes because a script has a typo.
    pub fn run(&mut self, bytes: &[u8]) -> FrameVerdict {
        let function: mlua::Function = match self.lua.registry_value(&self.hook) {
            Ok(function) => function,
            Err(error) => {
                self.fail(error.to_string());
                return FrameVerdict::Send(bytes.to_vec());
            }
        };

        self.ticks.store(0, Ordering::Relaxed);
        // With a schema the hook gets a `frame` it can read and patch field by field;
        // without one it gets spaced hex, as before.
        let Some(ir) = self.ir.clone() else {
            return self.judge(function.call(hex_of(bytes)), bytes);
        };
        let state = std::sync::Arc::new(std::sync::Mutex::new(crate::frame::FrameState::new(
            ir, bytes,
        )));
        let frame = match crate::frame::frame_table(&self.lua, std::sync::Arc::clone(&state)) {
            Ok(frame) => frame,
            Err(error) => {
                self.fail(error.to_string());
                return FrameVerdict::Send(bytes.to_vec());
            }
        };
        let answer: Result<Value, mlua::Error> = function.call(frame);
        match answer {
            // Returning the frame sends the patched bytes.
            Ok(Value::Table(_)) => {
                let next = state
                    .lock()
                    .map(|state| state.patched_bytes())
                    .unwrap_or_else(|_| bytes.to_vec());
                if next != bytes {
                    self.changed += 1;
                }
                FrameVerdict::Send(next)
            }
            other => self.judge(other, bytes),
        }
    }

    /// Turn the hook's answer into a verdict, for the hex form and for errors.
    fn judge(&mut self, answer: Result<Value, mlua::Error>, bytes: &[u8]) -> FrameVerdict {
        match answer {
            Ok(Value::Nil) => {
                self.dropped += 1;
                FrameVerdict::Drop
            }
            Ok(Value::String(text)) => match text.to_str().map(|text| parse_hex(&text)) {
                Ok(Ok(next)) => {
                    if next != bytes {
                        self.changed += 1;
                    }
                    FrameVerdict::Send(next)
                }
                _ => {
                    self.fail("the hook returned something that is not spaced hex".to_string());
                    FrameVerdict::Send(bytes.to_vec())
                }
            },
            Ok(_) => {
                self.fail("the hook must return spaced hex or nil".to_string());
                FrameVerdict::Send(bytes.to_vec())
            }
            Err(error) => {
                self.fail(error.to_string());
                FrameVerdict::Send(bytes.to_vec())
            }
        }
    }

    fn fail(&mut self, message: String) {
        self.failures += 1;
        self.last_error = Some(message);
    }
}

/// Install the sandbox API: `bforge.on_frame`, `bforge.log`, `bforge.hex`, `bforge.unhex`.
fn install_api(lua: &Lua) -> Result<(), ScriptError> {
    let bforge = lua.create_table().map_err(script_error)?;

    // The hook is stored as a plain global, which is the only name the engine reads.
    let on_frame = lua
        .create_function(|lua, function: mlua::Function| lua.globals().set("on_frame", function))
        .map_err(script_error)?;
    bforge.set("on_frame", on_frame).map_err(script_error)?;

    let log = lua
        .create_function(|_lua, message: String| {
            eprintln!("script: {message}");
            Ok(())
        })
        .map_err(script_error)?;
    bforge.set("log", log).map_err(script_error)?;

    // Bytes as a Lua array of numbers, for scripts that think in numbers.
    let unhex = lua
        .create_function(|lua, text: String| {
            let bytes =
                parse_hex(&text).map_err(|_| mlua::Error::runtime("expected spaced hex"))?;
            let table = lua.create_table_with_capacity(bytes.len(), 0)?;
            for (index, byte) in bytes.iter().enumerate() {
                table.set(index + 1, *byte)?;
            }
            Ok(table)
        })
        .map_err(script_error)?;
    bforge.set("unhex", unhex).map_err(script_error)?;

    let hex = lua
        .create_function(|_lua, table: mlua::Table| {
            let mut bytes = Vec::new();
            for value in table.sequence_values::<u8>() {
                bytes.push(value?);
            }
            Ok(hex_of(&bytes))
        })
        .map_err(script_error)?;
    bforge.set("hex", hex).map_err(script_error)?;

    lua.globals().set("bforge", &bforge).map_err(script_error)?;
    Ok(())
}

/// The frame arrives as spaced hex, which a person can read and edit in a script.
pub fn hex_of(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Spaced hex back to bytes. Refuses anything that is not whole bytes.
pub fn parse_hex(text: &str) -> Result<Vec<u8>, ScriptError> {
    let mut bytes = Vec::new();
    for word in text.split_whitespace() {
        if word.len() != 2 {
            return Err(ScriptError {
                message: format!("`{word}` is not one byte of hex"),
            });
        }
        bytes.push(u8::from_str_radix(word, 16).map_err(|_| ScriptError {
            message: format!("`{word}` is not hex"),
        })?);
    }
    if bytes.is_empty() {
        return Err(ScriptError {
            message: "no bytes".to_string(),
        });
    }
    Ok(bytes)
}

fn script_error(error: mlua::Error) -> ScriptError {
    ScriptError {
        message: error.to_string(),
    }
}

/// A script that could not be loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptError {
    pub message: String,
}

impl std::fmt::Display for ScriptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for ScriptError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_script_can_flip_a_byte() {
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_frame(function(frame)
              local bytes = bforge.unhex(frame)
              bytes[1] = 255
              return bforge.hex(bytes)
            end)
            "#,
            "flip.lua",
        )
        .expect("loads");
        assert_eq!(
            runtime.run(&[0x01, 0x02, 0x03]),
            FrameVerdict::Send(vec![0xFF, 0x02, 0x03])
        );
        assert_eq!(runtime.changed, 1);
    }

    #[test]
    fn a_script_can_drop_a_frame() {
        let mut runtime = ScriptRuntime::compile(
            r#"bforge.on_frame(function(frame) return nil end)"#,
            "drop.lua",
        )
        .expect("loads");
        assert_eq!(runtime.run(&[1, 2]), FrameVerdict::Drop);
        assert_eq!(runtime.dropped, 1);
    }

    #[test]
    fn a_script_that_returns_nonsense_leaves_the_frame_alone() {
        let mut runtime = ScriptRuntime::compile(
            r#"bforge.on_frame(function(frame) return 42 end)"#,
            "bad.lua",
        )
        .expect("loads");
        assert_eq!(runtime.run(&[1, 2]), FrameVerdict::Send(vec![1, 2]));
        assert_eq!(runtime.failures, 1);
        assert!(runtime.last_error.is_some());
    }

    #[test]
    fn an_infinite_loop_costs_one_frame_not_the_session() {
        let mut runtime = ScriptRuntime::compile(
            r#"bforge.on_frame(function(frame) while true do end end)"#,
            "spin.lua",
        )
        .expect("loads");
        assert_eq!(
            runtime.run(&[9, 9]),
            FrameVerdict::Send(vec![9, 9]),
            "the frame still goes out"
        );
        assert_eq!(runtime.failures, 1);
    }

    #[test]
    fn a_script_reads_and_writes_a_field_by_name() {
        let ir = {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../bforge-dissect/tests/fixtures/imu_packet.h"
            );
            let text = std::fs::read_to_string(path).expect("fixture");
            let header = bforge_dissect::cheader::parse(&text).expect("parses");
            bforge_dissect::cheader::compile(&header, "ImuPacket", path).expect("compiles")
        };
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_frame(function(frame)
              -- The SRS example, in one line: change a field and keep the frame.
              frame:set("v_batt_mv", frame:get("v_batt_mv") + 100)
              return frame
            end)
            "#,
            "field.lua",
        )
        .expect("loads")
        .with_schema(ir);

        // A frame whose battery reads 0x1CE8 = 7400 mV.
        let mut bytes = vec![0u8; 19];
        bytes[8] = 0x1C;
        bytes[9] = 0xE8;
        match runtime.run(&bytes) {
            FrameVerdict::Send(next) => {
                assert_eq!(u16::from_be_bytes([next[8], next[9]]), 7500);
                assert_eq!(&next[0..8], &bytes[0..8], "the rest is untouched");
            }
            FrameVerdict::Drop => panic!("the frame was dropped"),
        }
        assert_eq!(runtime.changed, 1);
    }

    #[test]
    fn a_script_can_recalc_the_crc_after_a_change() {
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_frame(function(frame)
              frame:set("version", 4)
              frame:recalc_crc("crc32c")
              return frame
            end)
            "#,
            "crc.lua",
        )
        .expect("loads")
        .with_schema({
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../bforge-dissect/tests/fixtures/imu_packet.h"
            );
            let text = std::fs::read_to_string(path).expect("fixture");
            let header = bforge_dissect::cheader::parse(&text).expect("parses");
            bforge_dissect::cheader::compile(&header, "ImuPacket", path).expect("compiles")
        });

        // 19 bytes of packet plus 4 bytes of CRC, as the firmware sends them.
        let mut bytes = vec![0u8; 23];
        bytes[2] = 3;
        let next = match runtime.run(&bytes) {
            FrameVerdict::Send(next) => next,
            FrameVerdict::Drop => panic!("dropped"),
        };
        assert_eq!(next[2], 4, "the field changed");
        let expected = bforge_framer::checksum::crc32c(&next[..19]);
        assert_eq!(
            &next[19..23],
            &expected.to_le_bytes(),
            "the CRC was recomputed"
        );
    }

    #[test]
    fn the_sandbox_has_no_filesystem_or_process() {
        // The library is absent, so the call fails at run time rather than load
        // time, and the frame still goes out.
        let mut runtime = ScriptRuntime::compile(
            r#"bforge.on_frame(function(frame) return io.open("/etc/passwd") end)"#,
            "io.lua",
        )
        .expect("compiles: the hook is not run yet");
        assert_eq!(runtime.run(&[1, 2]), FrameVerdict::Send(vec![1, 2]));
        assert_eq!(runtime.failures, 1);
        assert!(
            runtime.last_error.as_deref().unwrap_or("").contains("io"),
            "{:?}",
            runtime.last_error
        );
    }

    #[test]
    fn a_script_must_take_the_hook() {
        let error =
            ScriptRuntime::compile("local x = 1", "quiet.lua").expect_err("no hook is an error");
        assert!(error.message.contains("on_frame"), "{error}");
    }
}
