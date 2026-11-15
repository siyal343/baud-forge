//! The HIL script runtime (ADR-004, FR-SCR-01).
//!
//! One sandboxed Lua 5.4 VM per armed script. Supports legacy `bforge.on_frame(fn)`
//! alongside scoped lifecycle, packet, MITM, raw-chunk, timer, alert, dissector, and
//! command hooks.
//!
//! The sandbox has no file system, no OS process/clock, and no package loader; each hook
//! call executes under a memory cap and an instruction watchdog so a misbehaving script
//! cannot stall or crash the host session.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use bforge_dissect::{DecodedField, DissectorIr, SchemaSource, exec};
use mlua::{HookTriggers, Lua, RegistryKey, Value, VmState};

use crate::frame::{
    CustomFieldEntry, FrameState, LuaFrame, crc_width_and_compute, parse_lua_bytes,
};

/// Default VM heap memory cap (4 MiB).
pub const DEFAULT_MEMORY_LIMIT_BYTES: usize = 4 * 1024 * 1024;

/// Maximum configurable VM heap memory cap (16 MiB).
pub const MAX_MEMORY_LIMIT_BYTES: usize = 16 * 1024 * 1024;

/// Minimum configurable VM heap memory cap so base Lua structures fit cleanly.
const MIN_MEMORY_LIMIT_BYTES: usize = 64 * 1024;

/// Instructions one hook call may spend before it is aborted.
const INSTRUCTION_BUDGET: u32 = 200_000;

/// Instruction hook tick interval.
const HOOK_TICK: u32 = 500;
const HOOK_TICKS: u32 = INSTRUCTION_BUDGET / HOOK_TICK;

/// Maximum `bforge.send(...)` emissions allowed within a single hook invocation.
const MAX_SENDS_PER_CALL: usize = 16;

/// Maximum number of `bforge.on_timer(...)` callbacks per VM.
const MAX_TIMERS: usize = 8;

/// Minimum timer interval in milliseconds.
const MIN_TIMER_INTERVAL_MS: u64 = 10;

/// Rate-limiter parameters for script logging (`50 msgs/sec`, burst `20`).
const LOG_BURST: f64 = 20.0;
const LOG_RATE_PER_SEC: f64 = 50.0;

/// Default non-zero seed for the deterministic xorshift64* PRNG.
const DEFAULT_RNG_SEED: u64 = 0x5EED_BA0D_F09E_0001;

/// What a script decided to do with one frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameVerdict {
    /// Forward immediately, possibly mutated.
    Send(Vec<u8>),
    /// Schedule delivery after `delay_ms` milliseconds.
    Delay { bytes: Vec<u8>, delay_ms: u16 },
    /// Drop the frame.
    Drop,
    /// Emit zero, one, or multiple timed frames `(bytes, delay_ms)`.
    Burst(Vec<(Vec<u8>, u16)>),
}

impl FrameVerdict {
    /// Borrow the primary payload bytes when the verdict is not `Drop` or empty `Burst`.
    pub fn bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Send(bytes) | Self::Delay { bytes, .. } => Some(bytes),
            Self::Burst(frames) => frames.first().map(|(bytes, _)| bytes.as_slice()),
            Self::Drop => None,
        }
    }

    /// True if the frame was dropped.
    pub fn is_drop(&self) -> bool {
        matches!(self, Self::Drop)
    }
}

/// How the runtime handles a script failure or budget exhaustion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FaultPolicy {
    /// Forward original bytes untouched when a script faults.
    #[default]
    FailOpen,
    /// Drop the frame when a script faults.
    FailClosed,
}

/// Which pipeline hook point invoked the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HookKind {
    Tx,
    Rx,
    Mitm,
    RawChunk,
}

/// Metadata attached to one frame passed into a script hook.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FrameMeta {
    pub port: String,
    pub direction: String,
    pub seq_id: u64,
    pub timestamp_us: u64,
    pub bridge: Option<String>,
}

/// Side-effect emitted by a script through `bforge.*` host functions.
#[derive(Debug, Clone, PartialEq)]
pub enum ScriptAction {
    Send {
        port: String,
        bytes: Vec<u8>,
        delay_ms: u16,
        run_tx_hooks: bool,
    },
    SetPins {
        port: String,
        dtr: bool,
        rts: bool,
    },
    PulsePin {
        port: String,
        pin: String,
        duration_ms: u16,
    },
    Plot {
        series: String,
        value: f64,
        timestamp_us: Option<u64>,
    },
    Log {
        level: String,
        message: String,
    },
}

/// Accumulated pass/fail counts for one named `bforge.assert(cond, label)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssertionRecord {
    pub name: String,
    pub passed: u64,
    pub failed: u64,
    pub last_error: Option<String>,
}

/// Typed watch scalar stored via `bforge.metric(key, value)`.
#[derive(Debug, Clone, PartialEq)]
pub enum ScriptMetricValue {
    Number(f64),
    Text(String),
}

impl ScriptMetricValue {
    fn display_string(&self) -> String {
        match self {
            Self::Number(value) => {
                if *value == 0.0 {
                    "0".to_string()
                } else {
                    value.to_string()
                }
            }
            Self::Text(text) => text.clone(),
        }
    }
}

/// Before/after decoded field change captured by [`ScriptRuntime::dry_run`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldDiffRecord {
    pub name: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// Structured result of running a script against one test packet in isolation.
#[derive(Debug, Clone, PartialEq)]
pub struct DryRunReport {
    pub verdict: String,
    pub mutated: bool,
    pub output_bytes: Vec<u8>,
    pub delay_ms: u16,
    pub burst_frames: Vec<(Vec<u8>, u16)>,
    pub field_diffs: Vec<FieldDiffRecord>,
    pub instructions: u32,
    pub exec_us: u64,
    pub memory_bytes: usize,
    pub actions: Vec<ScriptAction>,
    pub metrics: BTreeMap<String, String>,
    pub assertions: Vec<AssertionRecord>,
    pub error: Option<String>,
}

/// Live health, counter, and telemetry snapshot for an armed [`ScriptRuntime`].
#[derive(Debug, Clone, PartialEq)]
pub struct ScriptSnapshot {
    pub path: String,
    pub policy: FaultPolicy,
    pub hooks: Vec<String>,
    pub invocations: u64,
    pub changed: u64,
    pub dropped: u64,
    pub delayed: u64,
    pub injected_tx: u64,
    pub failures: u64,
    pub logs_suppressed: u64,
    pub assertions_passed: u64,
    pub assertions_failed: u64,
    pub memory_bytes: usize,
    pub memory_limit_bytes: usize,
    pub last_instructions: u32,
    pub last_exec_us: u64,
    pub max_exec_us: u64,
    pub last_error: Option<String>,
    pub metrics: BTreeMap<String, String>,
    pub assertions: Vec<AssertionRecord>,
}

struct ScopedHook {
    target: String,
    key: RegistryKey,
}

struct TimerHook {
    interval_ms: u64,
    next_due_ms: u64,
    key: RegistryKey,
}

struct RuntimeShared {
    policy: FaultPolicy,
    memory_limit_bytes: usize,
    session_start: Instant,
    rng_state: u64,
    sends_this_call: usize,
    actions: Vec<ScriptAction>,
    metrics: BTreeMap<String, ScriptMetricValue>,
    assertions: BTreeMap<String, AssertionRecord>,
    assertions_passed: u64,
    assertions_failed: u64,
    injected_tx: u64,
    logs_suppressed: u64,
    log_tokens: f64,
    log_last_refill: Instant,
    hook_names: Vec<String>,
    on_frame: Option<RegistryKey>,
    on_init: Option<RegistryKey>,
    on_rx_frame: Vec<ScopedHook>,
    on_tx_frame: Vec<ScopedHook>,
    on_mitm_frame: Vec<ScopedHook>,
    on_raw_chunk: Vec<ScopedHook>,
    on_dissect: Vec<ScopedHook>,
    on_timer: Vec<TimerHook>,
    on_alert: Vec<ScopedHook>,
    on_command: BTreeMap<String, RegistryKey>,
}

impl RuntimeShared {
    fn new(policy: FaultPolicy, memory_limit_bytes: usize, seed: Option<u64>) -> Self {
        let now = Instant::now();
        Self {
            policy,
            memory_limit_bytes,
            session_start: now,
            rng_state: normalize_seed(seed.unwrap_or(DEFAULT_RNG_SEED)),
            sends_this_call: 0,
            actions: Vec::new(),
            metrics: BTreeMap::new(),
            assertions: BTreeMap::new(),
            assertions_passed: 0,
            assertions_failed: 0,
            injected_tx: 0,
            logs_suppressed: 0,
            log_tokens: LOG_BURST,
            log_last_refill: now,
            hook_names: Vec::new(),
            on_frame: None,
            on_init: None,
            on_rx_frame: Vec::new(),
            on_tx_frame: Vec::new(),
            on_mitm_frame: Vec::new(),
            on_raw_chunk: Vec::new(),
            on_dissect: Vec::new(),
            on_timer: Vec::new(),
            on_alert: Vec::new(),
            on_command: BTreeMap::new(),
        }
    }

    fn has_any_hook(&self) -> bool {
        self.on_frame.is_some()
            || self.on_init.is_some()
            || !self.on_rx_frame.is_empty()
            || !self.on_tx_frame.is_empty()
            || !self.on_mitm_frame.is_empty()
            || !self.on_raw_chunk.is_empty()
            || !self.on_dissect.is_empty()
            || !self.on_timer.is_empty()
            || !self.on_alert.is_empty()
            || !self.on_command.is_empty()
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.rng_state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng_state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn push_log(&mut self, level: &str, message: String) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.log_last_refill).as_secs_f64();
        self.log_tokens = (self.log_tokens + elapsed * LOG_RATE_PER_SEC).min(LOG_BURST);
        self.log_last_refill = now;
        if self.log_tokens >= 1.0 {
            self.log_tokens -= 1.0;
            self.actions.push(ScriptAction::Log {
                level: level.to_string(),
                message,
            });
        } else {
            self.logs_suppressed += 1;
        }
    }

    fn metrics_display(&self) -> BTreeMap<String, String> {
        self.metrics
            .iter()
            .map(|(k, v)| (k.clone(), v.display_string()))
            .collect()
    }
}

fn normalize_seed(seed: u64) -> u64 {
    if seed == 0 {
        0x9E37_79B9_7F4A_7C15
    } else {
        seed
    }
}

/// A loaded Lua 5.4 HIL/protocol script, ready to run on RX, TX, MITM, or timer hooks.
pub struct ScriptRuntime {
    lua: Lua,
    path: String,
    ticks: Arc<AtomicU32>,
    shared: Arc<Mutex<RuntimeShared>>,
    /// Frames processed across all hook invocations.
    pub invocations: u64,
    /// Frames the script changed.
    pub changed: u64,
    /// Frames the script dropped.
    pub dropped: u64,
    /// Frames the script delayed.
    pub delayed: u64,
    /// Calls that failed, including spent instruction budgets and memory errors.
    pub failures: u64,
    /// The last failure, for the UI and the log.
    pub last_error: Option<String>,
    last_instructions: u32,
    last_exec_us: u64,
    max_exec_us: u64,
    /// Default port schema, when bound via [`ScriptRuntime::with_schema`].
    ir: Option<DissectorIr>,
    /// Multi-port / multi-struct schema registry for `frame:dissect(tag)` and auto-binding.
    schemas: Arc<BTreeMap<String, DissectorIr>>,
}

impl std::fmt::Debug for ScriptRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ScriptRuntime")
            .field("path", &self.path)
            .field("invocations", &self.invocations)
            .field("changed", &self.changed)
            .field("dropped", &self.dropped)
            .field("delayed", &self.delayed)
            .field("failures", &self.failures)
            .finish()
    }
}

impl ScriptRuntime {
    /// Load a script from a file and compile it.
    pub fn load(path: impl AsRef<std::path::Path>) -> Result<Self, ScriptError> {
        let path = path.as_ref();
        let source = std::fs::read_to_string(path).map_err(|error| ScriptError {
            message: format!("{}: {error}", path.display()),
        })?;
        Self::compile(&source, &path.display().to_string())
    }

    /// Compile a script from source text with default fault policy and memory cap.
    pub fn compile(source: &str, name: &str) -> Result<Self, ScriptError> {
        Self::compile_with_options(
            source,
            name,
            FaultPolicy::default(),
            DEFAULT_MEMORY_LIMIT_BYTES,
            None,
        )
    }

    /// Compile a script with explicit fault policy, memory limit, and PRNG seed.
    pub fn compile_with_options(
        source: &str,
        name: &str,
        policy: FaultPolicy,
        memory_limit_bytes: usize,
        seed: Option<u64>,
    ) -> Result<Self, ScriptError> {
        let lua = Lua::new_with(
            mlua::StdLib::TABLE | mlua::StdLib::STRING | mlua::StdLib::MATH | mlua::StdLib::UTF8,
            mlua::LuaOptions::default(),
        )
        .map_err(|error| ScriptError {
            message: format!("cannot start Lua: {error}"),
        })?;

        let clamped_limit =
            memory_limit_bytes.clamp(MIN_MEMORY_LIMIT_BYTES, MAX_MEMORY_LIMIT_BYTES);
        let shared = Arc::new(Mutex::new(RuntimeShared::new(policy, clamped_limit, seed)));
        install_api(&lua, Arc::clone(&shared))?;

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

        lua.set_memory_limit(clamped_limit)
            .map_err(|error| ScriptError {
                message: format!("{name}: cannot set memory limit: {error}"),
            })?;

        ticks.store(0, Ordering::Relaxed);
        lua.load(source)
            .set_name(name)
            .exec()
            .map_err(|error| ScriptError {
                message: format!("{name}: {error}"),
            })?;

        let has_hook = shared.lock().unwrap().has_any_hook();
        if !has_hook {
            return Err(ScriptError {
                message: format!(
                    "{name}: the script must call `bforge.on_frame(fn)` or register a hook"
                ),
            });
        }

        let init_key = {
            let mut guard = shared.lock().unwrap();
            guard.on_init.take()
        };
        if let Some(key) = init_key {
            ticks.store(0, Ordering::Relaxed);
            let function: mlua::Function =
                lua.registry_value(&key).map_err(|error| ScriptError {
                    message: format!("{name}: {error}"),
                })?;
            let ctx = lua.create_table().map_err(script_error)?;
            ctx.set("script", name).map_err(script_error)?;
            function.call::<()>(ctx).map_err(|error| ScriptError {
                message: format!("{name}: on_init failed: {error}"),
            })?;
            shared.lock().unwrap().on_init = Some(key);
        }

        Ok(Self {
            lua,
            path: name.to_string(),
            ticks,
            shared,
            invocations: 0,
            changed: 0,
            dropped: 0,
            delayed: 0,
            failures: 0,
            last_error: None,
            last_instructions: 0,
            last_exec_us: 0,
            max_exec_us: 0,
            ir: None,
            schemas: Arc::default(),
        })
    }

    /// Give the runtime a default schema so a script can read and write fields by name.
    pub fn with_schema(mut self, ir: DissectorIr) -> Self {
        let name = schema_name(&ir.schema).to_string();
        let map = Arc::make_mut(&mut self.schemas);
        map.entry(name.clone()).or_insert_with(|| ir.clone());
        map.entry(format!("schema:{name}"))
            .or_insert_with(|| ir.clone());
        map.entry(format!("C_STRUCT:{name}"))
            .or_insert_with(|| ir.clone());
        self.ir = Some(ir);
        self
    }

    /// Provide a multi-port / multi-struct schema map for `frame:dissect` and auto-binding.
    pub fn with_schemas(mut self, schemas: Arc<BTreeMap<String, DissectorIr>>) -> Self {
        self.schemas = schemas;
        self
    }

    /// Configure the runtime's fault policy (`FailOpen` or `FailClosed`).
    pub fn with_policy(self, policy: FaultPolicy) -> Self {
        self.shared.lock().unwrap().policy = policy;
        self
    }

    /// Configure the VM heap limit (clamped to `[64 KiB, 16 MiB]`).
    pub fn with_memory_limit(self, limit_bytes: usize) -> Self {
        let clamped = limit_bytes.clamp(MIN_MEMORY_LIMIT_BYTES, MAX_MEMORY_LIMIT_BYTES);
        let _ = self.lua.set_memory_limit(clamped);
        self.shared.lock().unwrap().memory_limit_bytes = clamped;
        self
    }

    /// Reseed the deterministic PRNG.
    pub fn with_seed(self, seed: u64) -> Self {
        self.shared.lock().unwrap().rng_state = normalize_seed(seed);
        self
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn policy(&self) -> FaultPolicy {
        self.shared.lock().unwrap().policy
    }

    /// Run the legacy TX hook on one frame.
    ///
    /// Preserves legacy `bforge.on_frame(fn)` behavior: passes spaced hex when no schema
    /// is bound, or `LuaFrame` userdata when a schema is bound.
    pub fn run(&mut self, bytes: &[u8]) -> FrameVerdict {
        self.run_with_meta(HookKind::Tx, &FrameMeta::default(), bytes)
    }

    /// Run the appropriate hook(s) for `hook_kind` and `meta` on one frame.
    pub fn run_with_meta(
        &mut self,
        hook_kind: HookKind,
        meta: &FrameMeta,
        bytes: &[u8],
    ) -> FrameVerdict {
        self.run_with_meta_inner(hook_kind, meta, bytes).0
    }

    fn run_with_meta_inner(
        &mut self,
        hook_kind: HookKind,
        meta: &FrameMeta,
        bytes: &[u8],
    ) -> (FrameVerdict, Option<DissectorIr>, Vec<CustomFieldEntry>) {
        self.invocations += 1;
        self.ticks.store(0, Ordering::Relaxed);
        self.shared.lock().unwrap().sends_this_call = 0;
        let start = Instant::now();

        let active_ir = self.resolve_ir_for_meta(meta);
        let target = match hook_kind {
            HookKind::Mitm => meta.bridge.as_deref().unwrap_or(&meta.port),
            _ => meta.port.as_str(),
        };

        let (scoped_funcs, dissect_funcs, legacy_func) = match self.collect_hooks(hook_kind, target)
        {
            Ok(found) => found,
            Err(error) => {
                self.record_exec_stats(start);
                self.fail(error.to_string());
                return (self.error_verdict(bytes), active_ir, Vec::new());
            }
        };

        if scoped_funcs.is_empty() && dissect_funcs.is_empty() {
            let Some(function) = legacy_func else {
                self.record_exec_stats(start);
                return (FrameVerdict::Send(bytes.to_vec()), active_ir, Vec::new());
            };
            if active_ir.is_none() {
                let answer = function.call::<mlua::MultiValue>(hex_of(bytes));
                self.record_exec_stats(start);
                let verdict = self.judge_legacy_hex(answer, bytes);
                return (verdict, None, Vec::new());
            }
            return self.execute_lua_frame_hooks(
                vec![function],
                Vec::new(),
                active_ir,
                meta,
                bytes,
                start,
            );
        }

        self.execute_lua_frame_hooks(scoped_funcs, dissect_funcs, active_ir, meta, bytes, start)
    }

    fn execute_lua_frame_hooks(
        &mut self,
        hooks: Vec<mlua::Function>,
        dissect_hooks: Vec<mlua::Function>,
        active_ir: Option<DissectorIr>,
        meta: &FrameMeta,
        bytes: &[u8],
        start: Instant,
    ) -> (FrameVerdict, Option<DissectorIr>, Vec<CustomFieldEntry>) {
        let state = Arc::new(Mutex::new(FrameState::with_context(
            active_ir.clone(),
            Arc::clone(&self.schemas),
            meta.clone(),
            bytes,
        )));
        let ud = match self.lua.create_userdata(LuaFrame(Arc::clone(&state))) {
            Ok(ud) => ud,
            Err(error) => {
                self.record_exec_stats(start);
                self.fail(error.to_string());
                return (self.error_verdict(bytes), active_ir, Vec::new());
            }
        };

        let mut burst_override: Option<Vec<(Vec<u8>, u16)>> = None;
        for function in hooks.into_iter().chain(dissect_hooks) {
            let answer = function.call::<mlua::MultiValue>((ud.clone(), meta.direction.as_str()));
            match answer {
                Err(error) => {
                    self.record_exec_stats(start);
                    self.fail(error.to_string());
                    let final_ir = state.lock().unwrap().active_ir().cloned();
                    return (self.error_verdict(bytes), final_ir, Vec::new());
                }
                Ok(mv) => {
                    if mv.is_empty() || matches!(mv.front(), Some(Value::Boolean(true))) {
                        if state.lock().unwrap().drop_requested() {
                            break;
                        }
                        continue;
                    }
                    let first = mv.into_iter().next().unwrap();
                    match first {
                        Value::Nil => {
                            self.record_exec_stats(start);
                            self.dropped += 1;
                            let guard = state.lock().unwrap();
                            return (
                                FrameVerdict::Drop,
                                guard.active_ir().cloned(),
                                guard.custom_fields().to_vec(),
                            );
                        }
                        Value::UserData(returned_ud) => {
                            if returned_ud.borrow::<LuaFrame>().is_err() {
                                self.record_exec_stats(start);
                                self.fail("hook returned unexpected userdata".to_string());
                                let final_ir = state.lock().unwrap().active_ir().cloned();
                                return (self.error_verdict(bytes), final_ir, Vec::new());
                            }
                            if state.lock().unwrap().drop_requested() {
                                break;
                            }
                        }
                        Value::String(text) => match text.to_str().map(|s| parse_hex(&s)) {
                            Ok(Ok(next)) => {
                                state.lock().unwrap().replace_bytes(next);
                            }
                            _ => {
                                self.record_exec_stats(start);
                                self.fail(
                                    "the hook returned something that is not spaced hex"
                                        .to_string(),
                                );
                                let final_ir = state.lock().unwrap().active_ir().cloned();
                                return (self.error_verdict(bytes), final_ir, Vec::new());
                            }
                        },
                        Value::Table(tbl) => match parse_burst_table(&tbl) {
                            Ok(frames) => {
                                burst_override = Some(frames);
                                break;
                            }
                            Err(msg) => {
                                self.record_exec_stats(start);
                                self.fail(msg);
                                let final_ir = state.lock().unwrap().active_ir().cloned();
                                return (self.error_verdict(bytes), final_ir, Vec::new());
                            }
                        },
                        _ => {
                            self.record_exec_stats(start);
                            self.fail(
                                "the hook must return frame, spaced hex, burst table, true, or nil"
                                    .to_string(),
                            );
                            let final_ir = state.lock().unwrap().active_ir().cloned();
                            return (self.error_verdict(bytes), final_ir, Vec::new());
                        }
                    }
                }
            }
        }

        self.record_exec_stats(start);
        let mut guard = state.lock().unwrap();
        let final_ir = guard.active_ir().cloned();
        let custom_fields = guard.custom_fields().to_vec();

        if let Some(frames) = burst_override {
            let mutated = frames.len() != 1
                || frames
                    .first()
                    .is_some_and(|(frame_bytes, _)| frame_bytes.as_slice() != bytes);
            if mutated {
                self.changed += 1;
            }
            if frames.iter().any(|(_, delay)| *delay > 0) {
                self.delayed += 1;
            }
            return (FrameVerdict::Burst(frames), final_ir, custom_fields);
        }

        if guard.drop_requested() {
            self.dropped += 1;
            return (FrameVerdict::Drop, final_ir, custom_fields);
        }

        let delay_ms = guard.delay_ms();
        let (next, patch_error) = guard.patched_bytes();
        drop(guard);

        if let Some(error) = patch_error {
            self.fail(format!("frame patch failed: {error}"));
            if self.policy() == FaultPolicy::FailClosed {
                self.dropped += 1;
                return (FrameVerdict::Drop, final_ir, custom_fields);
            }
            return (FrameVerdict::Send(next), final_ir, custom_fields);
        }

        if next != bytes {
            self.changed += 1;
        }
        if let Some(ms) = delay_ms {
            self.delayed += 1;
            return (
                FrameVerdict::Delay {
                    bytes: next,
                    delay_ms: ms,
                },
                final_ir,
                custom_fields,
            );
        }
        (FrameVerdict::Send(next), final_ir, custom_fields)
    }

    fn judge_legacy_hex(
        &mut self,
        answer: Result<mlua::MultiValue, mlua::Error>,
        bytes: &[u8],
    ) -> FrameVerdict {
        match answer {
            Ok(mv) => {
                if mv.is_empty() || matches!(mv.front(), Some(Value::Boolean(true))) {
                    return FrameVerdict::Send(bytes.to_vec());
                }
                let first = mv.into_iter().next().unwrap();
                match first {
                    Value::Nil => {
                        self.dropped += 1;
                        FrameVerdict::Drop
                    }
                    Value::String(text) => match text.to_str().map(|text| parse_hex(&text)) {
                        Ok(Ok(next)) => {
                            if next != bytes {
                                self.changed += 1;
                            }
                            FrameVerdict::Send(next)
                        }
                        _ => {
                            self.fail(
                                "the hook returned something that is not spaced hex".to_string(),
                            );
                            self.error_verdict(bytes)
                        }
                    },
                    Value::Table(tbl) => match parse_burst_table(&tbl) {
                        Ok(frames) => {
                            self.changed += 1;
                            if frames.iter().any(|(_, delay)| *delay > 0) {
                                self.delayed += 1;
                            }
                            FrameVerdict::Burst(frames)
                        }
                        Err(msg) => {
                            self.fail(msg);
                            self.error_verdict(bytes)
                        }
                    },
                    _ => {
                        self.fail("the hook must return spaced hex or nil".to_string());
                        self.error_verdict(bytes)
                    }
                }
            }
            Err(error) => {
                self.fail(error.to_string());
                self.error_verdict(bytes)
            }
        }
    }

    fn resolve_ir_for_meta(&self, meta: &FrameMeta) -> Option<DissectorIr> {
        if let Some(ir) = &self.ir {
            return Some(ir.clone());
        }
        if meta.port.is_empty() {
            return None;
        }
        self.schemas
            .get(&meta.port)
            .or_else(|| self.schemas.get(&format!("port:{}", meta.port)))
            .cloned()
    }

    fn collect_hooks(
        &self,
        hook_kind: HookKind,
        target: &str,
    ) -> mlua::Result<(
        Vec<mlua::Function>,
        Vec<mlua::Function>,
        Option<mlua::Function>,
    )> {
        let guard = self.shared.lock().unwrap();
        let resolve_matching = |list: &[ScopedHook]| -> mlua::Result<Vec<mlua::Function>> {
            let mut out = Vec::new();
            for entry in list {
                if entry.target == "*" || (!target.is_empty() && entry.target == target) {
                    out.push(self.lua.registry_value(&entry.key)?);
                }
            }
            Ok(out)
        };

        let (scoped, use_legacy, dissect) = match hook_kind {
            HookKind::Rx => {
                let rx = resolve_matching(&guard.on_rx_frame)?;
                let ds = resolve_matching(&guard.on_dissect)?;
                let use_legacy = guard.on_rx_frame.is_empty() && guard.on_dissect.is_empty();
                (rx, use_legacy, ds)
            }
            HookKind::Tx => {
                let tx = resolve_matching(&guard.on_tx_frame)?;
                let use_legacy = guard.on_tx_frame.is_empty();
                (tx, use_legacy, Vec::new())
            }
            HookKind::Mitm => (resolve_matching(&guard.on_mitm_frame)?, false, Vec::new()),
            HookKind::RawChunk => (resolve_matching(&guard.on_raw_chunk)?, false, Vec::new()),
        };

        let legacy = if use_legacy {
            match &guard.on_frame {
                Some(key) => Some(self.lua.registry_value(key)?),
                None => None,
            }
        } else {
            None
        };
        Ok((scoped, dissect, legacy))
    }

    /// Fire any `bforge.on_timer` callbacks whose interval is due at `now_ms`.
    pub fn tick_timers(&mut self, now_ms: u64) -> Result<Vec<ScriptAction>, ScriptError> {
        let due_functions: Vec<(u64, mlua::Function)> = {
            let mut guard = self.shared.lock().unwrap();
            let mut out = Vec::new();
            for timer in &mut guard.on_timer {
                if now_ms >= timer.next_due_ms {
                    timer.next_due_ms = now_ms.saturating_add(timer.interval_ms);
                    let func: mlua::Function =
                        self.lua.registry_value(&timer.key).map_err(script_error)?;
                    out.push((timer.interval_ms, func));
                }
            }
            out
        };

        for (interval_ms, func) in due_functions {
            self.ticks.store(0, Ordering::Relaxed);
            self.shared.lock().unwrap().sends_this_call = 0;
            let start = Instant::now();
            let ctx = self.lua.create_table().map_err(script_error)?;
            ctx.set("now_ms", now_ms).map_err(script_error)?;
            ctx.set("interval_ms", interval_ms).map_err(script_error)?;
            let res = func.call::<()>(ctx);
            self.record_exec_stats(start);
            if let Err(error) = res {
                let msg = error.to_string();
                self.fail(msg.clone());
                return Err(ScriptError { message: msg });
            }
        }
        Ok(self.drain_actions())
    }

    /// Invoke any `bforge.on_alert` handlers matching `name` (or `"*"`).
    pub fn trigger_alert(
        &mut self,
        name: &str,
        detail: &str,
    ) -> Result<Vec<ScriptAction>, ScriptError> {
        let funcs: Vec<mlua::Function> = {
            let guard = self.shared.lock().unwrap();
            let mut out = Vec::new();
            for entry in &guard.on_alert {
                if entry.target == "*" || entry.target == name {
                    out.push(self.lua.registry_value(&entry.key).map_err(script_error)?);
                }
            }
            out
        };

        for func in funcs {
            self.ticks.store(0, Ordering::Relaxed);
            self.shared.lock().unwrap().sends_this_call = 0;
            let start = Instant::now();
            let alert = self.lua.create_table().map_err(script_error)?;
            alert.set("name", name).map_err(script_error)?;
            alert.set("detail", detail).map_err(script_error)?;
            let now_us = self
                .shared
                .lock()
                .unwrap()
                .session_start
                .elapsed()
                .as_micros() as u64;
            alert.set("timestamp_us", now_us).map_err(script_error)?;
            let res = func.call::<()>(alert);
            self.record_exec_stats(start);
            if let Err(error) = res {
                let msg = error.to_string();
                self.fail(msg.clone());
                return Err(ScriptError { message: msg });
            }
        }
        Ok(self.drain_actions())
    }

    /// Invoke a named `bforge.on_command` payload generator.
    pub fn invoke_command(
        &mut self,
        name: &str,
        args: &BTreeMap<String, String>,
    ) -> Result<Vec<u8>, ScriptError> {
        let key_opt = self
            .shared
            .lock()
            .unwrap()
            .on_command
            .get(name)
            .map(|key| self.lua.registry_value::<mlua::Function>(key));
        let func = match key_opt {
            Some(Ok(f)) => f,
            Some(Err(e)) => return Err(script_error(e)),
            None => {
                return Err(ScriptError {
                    message: format!("no on_command handler registered for `{name}`"),
                });
            }
        };

        self.ticks.store(0, Ordering::Relaxed);
        self.shared.lock().unwrap().sends_this_call = 0;
        let start = Instant::now();
        let arg_tbl = self.lua.create_table().map_err(script_error)?;
        for (k, v) in args {
            arg_tbl.set(k.as_str(), v.as_str()).map_err(script_error)?;
        }
        let result = func.call::<Value>(arg_tbl);
        self.record_exec_stats(start);
        match result {
            Ok(val) => parse_lua_bytes(val).map_err(script_error),
            Err(error) => {
                let msg = error.to_string();
                self.fail(msg.clone());
                Err(ScriptError { message: msg })
            }
        }
    }

    /// Drain buffered side-effect actions (`send`, `set_pins`, `pulse_pin`, `plot`, `log`).
    pub fn drain_actions(&mut self) -> Vec<ScriptAction> {
        std::mem::take(&mut self.shared.lock().unwrap().actions)
    }

    /// Capture a live snapshot of counters, memory usage, metrics, and assertions.
    pub fn snapshot(&self) -> ScriptSnapshot {
        let guard = self.shared.lock().unwrap();
        ScriptSnapshot {
            path: self.path.clone(),
            policy: guard.policy,
            hooks: guard.hook_names.clone(),
            invocations: self.invocations,
            changed: self.changed,
            dropped: self.dropped,
            delayed: self.delayed,
            injected_tx: guard.injected_tx,
            failures: self.failures,
            logs_suppressed: guard.logs_suppressed,
            assertions_passed: guard.assertions_passed,
            assertions_failed: guard.assertions_failed,
            memory_bytes: self.lua.used_memory(),
            memory_limit_bytes: guard.memory_limit_bytes,
            last_instructions: self.last_instructions,
            last_exec_us: self.last_exec_us,
            max_exec_us: self.max_exec_us,
            last_error: self.last_error.clone(),
            metrics: guard.metrics_display(),
            assertions: guard.assertions.values().cloned().collect(),
        }
    }

    /// Run `source` in an isolated VM against one test packet and return a full diff report.
    #[allow(clippy::too_many_arguments)]
    pub fn dry_run(
        source: &str,
        name: &str,
        policy: FaultPolicy,
        seed: Option<u64>,
        schemas: Arc<BTreeMap<String, DissectorIr>>,
        port_ir: Option<DissectorIr>,
        meta: &FrameMeta,
        hook_kind: HookKind,
        bytes: &[u8],
    ) -> Result<DryRunReport, ScriptError> {
        let mut runtime =
            Self::compile_with_options(source, name, policy, DEFAULT_MEMORY_LIMIT_BYTES, seed)?
                .with_schemas(schemas);
        if let Some(ir) = port_ir {
            runtime = runtime.with_schema(ir);
        }

        let (verdict, final_ir, custom_fields) =
            runtime.run_with_meta_inner(hook_kind, meta, bytes);
        let snap = runtime.snapshot();
        let actions = runtime.drain_actions();

        let (verdict_label, mutated, output_bytes, delay_ms, burst_frames) = match verdict {
            FrameVerdict::Send(out) => {
                let mutated = out != bytes;
                let label = if mutated { "send" } else { "pass" };
                (label.to_string(), mutated, out, 0, Vec::new())
            }
            FrameVerdict::Delay {
                bytes: out,
                delay_ms,
            } => {
                let mutated = out != bytes;
                ("delay".to_string(), mutated, out, delay_ms, Vec::new())
            }
            FrameVerdict::Drop => ("drop".to_string(), false, Vec::new(), 0, Vec::new()),
            FrameVerdict::Burst(frames) => {
                let out = frames.first().map(|(b, _)| b.clone()).unwrap_or_default();
                let delay = frames.first().map(|(_, d)| *d).unwrap_or(0);
                let mutated =
                    frames.len() != 1 || frames.first().is_some_and(|(b, _)| b.as_slice() != bytes);
                ("burst".to_string(), mutated, out, delay, frames)
            }
        };

        let mut field_diffs = Vec::new();
        if verdict_label != "drop" {
            let mut before_map = BTreeMap::new();
            let mut after_map = BTreeMap::new();
            if let Some(ir) = &final_ir {
                if let Ok(before_fields) = exec::execute(ir, bytes) {
                    flatten_decoded(&before_fields, &mut before_map);
                }
                if let Ok(after_fields) = exec::execute(ir, &output_bytes) {
                    flatten_decoded(&after_fields, &mut after_map);
                }
            }
            for (name, _, _, display, _) in custom_fields {
                after_map.entry(name).or_insert(display);
            }
            let mut all_names = BTreeMap::<String, ()>::new();
            for k in before_map.keys().chain(after_map.keys()) {
                all_names.insert(k.clone(), ());
            }
            for field_name in all_names.keys() {
                let before = before_map.get(field_name).cloned();
                let after = after_map.get(field_name).cloned();
                if before != after {
                    field_diffs.push(FieldDiffRecord {
                        name: field_name.clone(),
                        before,
                        after,
                    });
                }
            }
        }

        Ok(DryRunReport {
            verdict: verdict_label,
            mutated,
            output_bytes,
            delay_ms,
            burst_frames,
            field_diffs,
            instructions: snap.last_instructions,
            exec_us: snap.last_exec_us,
            memory_bytes: snap.memory_bytes,
            actions,
            metrics: snap.metrics,
            assertions: snap.assertions,
            error: snap.last_error,
        })
    }

    fn record_exec_stats(&mut self, start: Instant) {
        let ticks = self.ticks.load(Ordering::Relaxed);
        self.last_instructions = ticks.saturating_mul(HOOK_TICK);
        let exec_us = start.elapsed().as_micros() as u64;
        self.last_exec_us = exec_us;
        self.max_exec_us = self.max_exec_us.max(exec_us);
    }

    fn error_verdict(&mut self, bytes: &[u8]) -> FrameVerdict {
        match self.policy() {
            FaultPolicy::FailOpen => FrameVerdict::Send(bytes.to_vec()),
            FaultPolicy::FailClosed => {
                self.dropped += 1;
                FrameVerdict::Drop
            }
        }
    }

    fn fail(&mut self, message: String) {
        self.failures += 1;
        self.last_error = Some(message);
        let _ = self.lua.gc_collect();
    }
}

fn schema_name(source: &SchemaSource) -> &str {
    match source {
        SchemaSource::CHeader { root_struct, .. } => root_struct,
        SchemaSource::Protobuf { message, .. } => message,
        SchemaSource::Kaitai { type_name, .. } => type_name,
    }
}

fn flatten_decoded(fields: &[DecodedField], out: &mut BTreeMap<String, String>) {
    for field in fields {
        if field.children.is_empty() {
            out.insert(field.name.clone(), field.value.clone());
        } else {
            for (idx, child) in field.children.iter().enumerate() {
                if child.children.is_empty() {
                    out.insert(format!("{}.{idx}", field.name), child.value.clone());
                } else {
                    flatten_decoded(std::slice::from_ref(child), out);
                }
            }
        }
    }
}

fn parse_burst_table(table: &mlua::Table) -> Result<Vec<(Vec<u8>, u16)>, String> {
    let mut frames = Vec::new();
    for pair in table.clone().sequence_values::<Value>() {
        let item = pair.map_err(|e| format!("invalid burst entry: {e}"))?;
        let Value::Table(entry) = item else {
            return Err(
                "burst return must be a sequence of `{ payload, delay_ms }` tables".to_string(),
            );
        };
        let payload_val: Value = entry
            .get(1)
            .map_err(|e| format!("burst entry missing payload: {e}"))?;
        let bytes =
            parse_lua_bytes(payload_val).map_err(|e| format!("invalid burst payload: {e}"))?;
        let delay_ms: u16 = entry
            .get::<Option<u16>>(2)
            .map_err(|e| format!("invalid burst delay_ms: {e}"))?
            .unwrap_or(0);
        frames.push((bytes, delay_ms));
    }
    Ok(frames)
}

fn parse_scoped_hook_args(
    arg1: Value,
    arg2: Option<Value>,
    hook_name: &str,
) -> mlua::Result<(String, mlua::Function)> {
    match (arg1, arg2) {
        (Value::Function(func), None) => Ok(("*".to_string(), func)),
        (Value::String(target), Some(Value::Function(func))) => {
            Ok((target.to_str()?.to_string(), func))
        }
        _ => Err(mlua::Error::runtime(format!(
            "`bforge.{hook_name}` expects `(fn)` or `(target, fn)`"
        ))),
    }
}

fn parse_trigger_spec(port: String, spec: &str) -> mlua::Result<ScriptAction> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err(mlua::Error::runtime("trigger_pin spec cannot be empty"));
    }
    let upper = trimmed.to_ascii_uppercase();
    let pin = if upper.contains("DTR") { "DTR" } else { "RTS" }.to_string();

    if let Some(ms) = extract_duration_ms(&upper) {
        return Ok(ScriptAction::PulsePin {
            port,
            pin,
            duration_ms: ms,
        });
    }
    if upper.contains("PULSE") {
        return Ok(ScriptAction::PulsePin {
            port,
            pin,
            duration_ms: 1,
        });
    }
    if upper.ends_with("_HIGH") || upper == "HIGH" {
        return Ok(ScriptAction::SetPins {
            port,
            dtr: pin == "DTR",
            rts: pin == "RTS",
        });
    }
    if upper.ends_with("_LOW") || upper == "LOW" {
        return Ok(ScriptAction::SetPins {
            port,
            dtr: false,
            rts: false,
        });
    }

    Err(mlua::Error::runtime(format!(
        "unrecognized trigger_pin spec `{spec}`"
    )))
}

fn extract_duration_ms(upper: &str) -> Option<u16> {
    let bytes = upper.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let num: u64 = upper[start..i].parse().ok()?;
            let rest = &upper[i..];
            if rest.starts_with("MS") {
                return Some(num.clamp(1, u64::from(u16::MAX)) as u16);
            }
            if rest.starts_with("US") {
                return Some(num.div_ceil(1000).clamp(1, u64::from(u16::MAX)) as u16);
            }
        } else {
            i += 1;
        }
    }
    None
}

fn install_scoped_hook(
    lua: &Lua,
    bforge: &mlua::Table,
    shared: &Arc<Mutex<RuntimeShared>>,
    name: &'static str,
    select: fn(&mut RuntimeShared) -> &mut Vec<ScopedHook>,
) -> Result<(), ScriptError> {
    let shared_ref = Arc::clone(shared);
    let func = lua
        .create_function(move |lua, (arg1, arg2): (Value, Option<Value>)| {
            let (target, handler) = parse_scoped_hook_args(arg1, arg2, name)?;
            let key = lua.create_registry_value(handler)?;
            let mut guard = shared_ref.lock().unwrap();
            guard.hook_names.push(format!("{name}:{target}"));
            select(&mut guard).push(ScopedHook { target, key });
            Ok(())
        })
        .map_err(script_error)?;
    bforge.set(name, func).map_err(script_error)
}

/// Install the sandbox API into `bforge.*`.
fn install_api(lua: &Lua, shared: Arc<Mutex<RuntimeShared>>) -> Result<(), ScriptError> {
    let bforge = lua.create_table().map_err(script_error)?;

    // --- Hook registration ---
    {
        let shared_ref = Arc::clone(&shared);
        let on_frame = lua
            .create_function(move |lua, function: mlua::Function| {
                let key = lua.create_registry_value(function)?;
                let mut guard = shared_ref.lock().unwrap();
                if guard.on_frame.is_none() {
                    guard.hook_names.push("on_frame".to_string());
                }
                guard.on_frame = Some(key);
                Ok(())
            })
            .map_err(script_error)?;
        bforge.set("on_frame", on_frame).map_err(script_error)?;
    }
    {
        let shared_ref = Arc::clone(&shared);
        let on_init = lua
            .create_function(move |lua, function: mlua::Function| {
                let key = lua.create_registry_value(function)?;
                let mut guard = shared_ref.lock().unwrap();
                if guard.on_init.is_none() {
                    guard.hook_names.push("on_init".to_string());
                }
                guard.on_init = Some(key);
                Ok(())
            })
            .map_err(script_error)?;
        bforge.set("on_init", on_init).map_err(script_error)?;
    }

    install_scoped_hook(lua, &bforge, &shared, "on_rx_frame", |s| &mut s.on_rx_frame)?;
    install_scoped_hook(lua, &bforge, &shared, "on_tx_frame", |s| &mut s.on_tx_frame)?;
    install_scoped_hook(lua, &bforge, &shared, "on_mitm_frame", |s| {
        &mut s.on_mitm_frame
    })?;
    install_scoped_hook(lua, &bforge, &shared, "on_raw_chunk", |s| {
        &mut s.on_raw_chunk
    })?;
    install_scoped_hook(lua, &bforge, &shared, "on_dissect", |s| &mut s.on_dissect)?;
    install_scoped_hook(lua, &bforge, &shared, "on_alert", |s| &mut s.on_alert)?;

    {
        let shared_ref = Arc::clone(&shared);
        let on_timer = lua
            .create_function(move |lua, (interval_ms, function): (u64, mlua::Function)| {
                let mut guard = shared_ref.lock().unwrap();
                if guard.on_timer.len() >= MAX_TIMERS {
                    return Err(mlua::Error::runtime(format!(
                        "maximum of {MAX_TIMERS} timers per script exceeded"
                    )));
                }
                let interval = interval_ms.max(MIN_TIMER_INTERVAL_MS);
                let now_ms = guard.session_start.elapsed().as_millis() as u64;
                let key = lua.create_registry_value(function)?;
                guard.hook_names.push(format!("on_timer:{interval}ms"));
                guard.on_timer.push(TimerHook {
                    interval_ms: interval,
                    next_due_ms: now_ms.saturating_add(interval),
                    key,
                });
                Ok(())
            })
            .map_err(script_error)?;
        bforge.set("on_timer", on_timer).map_err(script_error)?;
    }

    {
        let shared_ref = Arc::clone(&shared);
        let on_command = lua
            .create_function(move |lua, (name, function): (String, mlua::Function)| {
                let key = lua.create_registry_value(function)?;
                let mut guard = shared_ref.lock().unwrap();
                if !guard.on_command.contains_key(&name) {
                    guard.hook_names.push(format!("on_command:{name}"));
                }
                guard.on_command.insert(name, key);
                Ok(())
            })
            .map_err(script_error)?;
        bforge.set("on_command", on_command).map_err(script_error)?;
    }

    // --- Active I/O & Hardware Pins ---
    {
        let shared_ref = Arc::clone(&shared);
        let send = lua
            .create_function(
                move |lua, (port, data, opts): (String, Value, Option<Value>)| {
                    let bytes = parse_lua_bytes(data)?;
                    let (delay_ms, run_tx_hooks) = match opts {
                        None | Some(Value::Nil) => (0, false),
                        Some(Value::Table(tbl)) => (
                            tbl.get::<Option<u16>>("delay_ms")?.unwrap_or(0),
                            tbl.get::<Option<bool>>("run_tx_hooks")?.unwrap_or(false),
                        ),
                        Some(val @ (Value::Integer(_) | Value::Number(_))) => {
                            (mlua::FromLua::from_lua(val, lua)?, false)
                        }
                        Some(other) => {
                            return Err(mlua::Error::runtime(format!(
                                "bforge.send opts must be a table or delay_ms number, not {}",
                                other.type_name()
                            )));
                        }
                    };
                    let mut guard = shared_ref.lock().unwrap();
                    if guard.sends_this_call >= MAX_SENDS_PER_CALL {
                        return Err(mlua::Error::runtime(format!(
                            "bforge.send limit exceeded (max {MAX_SENDS_PER_CALL} per call)"
                        )));
                    }
                    guard.sends_this_call += 1;
                    guard.injected_tx += 1;
                    guard.actions.push(ScriptAction::Send {
                        port,
                        bytes,
                        delay_ms,
                        run_tx_hooks,
                    });
                    Ok(())
                },
            )
            .map_err(script_error)?;
        bforge.set("send", send).map_err(script_error)?;
    }

    {
        let shared_ref = Arc::clone(&shared);
        let set_pins = lua
            .create_function(move |_, (arg1, arg2, arg3): (Value, Value, Option<bool>)| {
                let (port, dtr, rts) = match (arg1, arg2, arg3) {
                    (Value::Boolean(dtr), Value::Boolean(rts), None) => ("*".to_string(), dtr, rts),
                    (Value::String(port), Value::Boolean(dtr), Some(rts)) => {
                        (port.to_str()?.to_string(), dtr, rts)
                    }
                    _ => {
                        return Err(mlua::Error::runtime(
                            "bforge.set_pins expects `(port, dtr, rts)` or `(dtr, rts)`",
                        ));
                    }
                };
                shared_ref
                    .lock()
                    .unwrap()
                    .actions
                    .push(ScriptAction::SetPins { port, dtr, rts });
                Ok(())
            })
            .map_err(script_error)?;
        bforge.set("set_pins", set_pins).map_err(script_error)?;
    }

    {
        let shared_ref = Arc::clone(&shared);
        let pulse_pin = lua
            .create_function(
                move |lua, (arg1, arg2, arg3): (String, Value, Option<u16>)| {
                    let (port, pin, ms) = match (arg2, arg3) {
                        (Value::String(pin_str), Some(ms)) => {
                            (arg1, pin_str.to_str()?.to_string(), ms)
                        }
                        (val @ (Value::Integer(_) | Value::Number(_)), None) => {
                            let ms: u16 = mlua::FromLua::from_lua(val, lua)?;
                            ("*".to_string(), arg1, ms)
                        }
                        _ => {
                            return Err(mlua::Error::runtime(
                                "bforge.pulse_pin expects `(port, pin, ms)` or `(pin, ms)`",
                            ));
                        }
                    };
                    let normalized = match pin.to_ascii_uppercase().as_str() {
                        "DTR" => "DTR".to_string(),
                        "RTS" => "RTS".to_string(),
                        _ => {
                            return Err(mlua::Error::runtime(format!(
                                "unknown hardware pin `{pin}`; expected DTR or RTS"
                            )));
                        }
                    };
                    shared_ref
                        .lock()
                        .unwrap()
                        .actions
                        .push(ScriptAction::PulsePin {
                            port,
                            pin: normalized,
                            duration_ms: ms,
                        });
                    Ok(())
                },
            )
            .map_err(script_error)?;
        bforge.set("pulse_pin", pulse_pin).map_err(script_error)?;
    }

    {
        let shared_ref = Arc::clone(&shared);
        let trigger_pin = lua
            .create_function(move |_, (port, spec): (String, String)| {
                let action = parse_trigger_spec(port, &spec)?;
                shared_ref.lock().unwrap().actions.push(action);
                Ok(())
            })
            .map_err(script_error)?;
        bforge
            .set("trigger_pin", trigger_pin)
            .map_err(script_error)?;
    }

    // --- Telemetry & Assertions ---
    {
        let shared_ref = Arc::clone(&shared);
        let plot = lua
            .create_function(
                move |_, (series, value, ts_us): (String, f64, Option<u64>)| {
                    shared_ref.lock().unwrap().actions.push(ScriptAction::Plot {
                        series,
                        value,
                        timestamp_us: ts_us,
                    });
                    Ok(())
                },
            )
            .map_err(script_error)?;
        bforge.set("plot", plot).map_err(script_error)?;
    }

    {
        let shared_ref = Arc::clone(&shared);
        let metric = lua
            .create_function(move |lua, (key, value): (String, Option<Value>)| {
                let mut guard = shared_ref.lock().unwrap();
                match value {
                    None | Some(Value::Nil) => match guard.metrics.get(&key) {
                        Some(ScriptMetricValue::Number(n)) => Ok(Value::Number(*n)),
                        Some(ScriptMetricValue::Text(s)) => {
                            Ok(Value::String(lua.create_string(s)?))
                        }
                        None => Ok(Value::Nil),
                    },
                    Some(val) => {
                        let stored = match val {
                            Value::Integer(n) => ScriptMetricValue::Number(n as f64),
                            Value::Number(n) => ScriptMetricValue::Number(n),
                            Value::String(s) => ScriptMetricValue::Text(s.to_str()?.to_string()),
                            Value::Boolean(b) => ScriptMetricValue::Text(b.to_string()),
                            other => {
                                return Err(mlua::Error::runtime(format!(
                                    "metric `{key}` cannot store a {}",
                                    other.type_name()
                                )));
                            }
                        };
                        guard.metrics.insert(key, stored);
                        Ok(Value::Nil)
                    }
                }
            })
            .map_err(script_error)?;
        bforge.set("metric", metric).map_err(script_error)?;
    }

    {
        let shared_ref = Arc::clone(&shared);
        let assert_fn = lua
            .create_function(move |_, args: mlua::MultiValue| {
                let mut iter = args.into_iter();
                let arg1 = iter.next().unwrap_or(Value::Nil);
                let arg2 = iter.next();
                let arg3 = match iter.next() {
                    None | Some(Value::Nil) => None,
                    Some(Value::String(s)) => Some(s.to_str()?.to_string()),
                    Some(Value::Integer(n)) => Some(n.to_string()),
                    Some(Value::Number(n)) => Some(n.to_string()),
                    Some(Value::Boolean(b)) => Some(b.to_string()),
                    Some(other) => Some(other.type_name().to_string()),
                };

                let (cond, label, custom_msg) = match (&arg1, &arg2, &arg3) {
                    (Value::String(s), _, _)
                        if arg3.is_some()
                            || matches!(arg2, Some(Value::Boolean(_) | Value::Nil)) =>
                    {
                        (arg2.unwrap_or(Value::Nil), s.to_str()?.to_string(), arg3)
                    }
                    _ => {
                        let label = match arg2 {
                            None | Some(Value::Nil) => "assertion".to_string(),
                            Some(Value::String(s)) => s.to_str()?.to_string(),
                            Some(Value::Integer(n)) => n.to_string(),
                            Some(Value::Number(n)) => n.to_string(),
                            Some(Value::Boolean(b)) => b.to_string(),
                            Some(other) => other.type_name().to_string(),
                        };
                        (arg1, label, arg3)
                    }
                };
                let passed = !matches!(cond, Value::Nil | Value::Boolean(false));
                let mut guard = shared_ref.lock().unwrap();
                if passed {
                    guard.assertions_passed += 1;
                } else {
                    guard.assertions_failed += 1;
                }
                let entry =
                    guard
                        .assertions
                        .entry(label.clone())
                        .or_insert_with(|| AssertionRecord {
                            name: label.clone(),
                            passed: 0,
                            failed: 0,
                            last_error: None,
                        });
                if passed {
                    entry.passed += 1;
                } else {
                    entry.failed += 1;
                    entry.last_error =
                        Some(custom_msg.unwrap_or_else(|| format!("assertion `{label}` failed")));
                }
                Ok(passed)
            })
            .map_err(script_error)?;
        bforge.set("assert", assert_fn).map_err(script_error)?;
    }

    // --- Rate-limited Logging ---
    {
        let shared_ref = Arc::clone(&shared);
        let log_fn = lua
            .create_function(move |_, (arg1, arg2): (String, Option<String>)| {
                let (level, message) = match arg2 {
                    Some(msg) => {
                        let level = match arg1.to_ascii_lowercase().as_str() {
                            "info" => "info",
                            "warn" => "warn",
                            "error" => "error",
                            "debug" => "debug",
                            _ => "info",
                        };
                        (level, msg)
                    }
                    None => ("info", arg1),
                };
                shared_ref.lock().unwrap().push_log(level, message);
                Ok(())
            })
            .map_err(script_error)?;
        bforge.set("log", log_fn).map_err(script_error)?;
    }
    for (fn_name, level) in [
        ("log_info", "info"),
        ("log_warn", "warn"),
        ("log_error", "error"),
    ] {
        let shared_ref = Arc::clone(&shared);
        let log_fn = lua
            .create_function(move |_, message: String| {
                shared_ref.lock().unwrap().push_log(level, message);
                Ok(())
            })
            .map_err(script_error)?;
        bforge.set(fn_name, log_fn).map_err(script_error)?;
    }

    // --- Monotonic Clock & Deterministic PRNG ---
    {
        let shared_ref = Arc::clone(&shared);
        let now_us = lua
            .create_function(move |_, ()| {
                let elapsed = shared_ref
                    .lock()
                    .unwrap()
                    .session_start
                    .elapsed()
                    .as_micros() as u64;
                Ok(elapsed)
            })
            .map_err(script_error)?;
        bforge.set("now_us", now_us).map_err(script_error)?;
    }
    {
        let shared_ref = Arc::clone(&shared);
        let now_ms = lua
            .create_function(move |_, ()| {
                let elapsed = shared_ref
                    .lock()
                    .unwrap()
                    .session_start
                    .elapsed()
                    .as_millis() as u64;
                Ok(elapsed)
            })
            .map_err(script_error)?;
        bforge.set("now_ms", now_ms).map_err(script_error)?;
    }
    {
        let shared_ref = Arc::clone(&shared);
        let seed_fn = lua
            .create_function(move |_, seed: u64| {
                shared_ref.lock().unwrap().rng_state = normalize_seed(seed);
                Ok(())
            })
            .map_err(script_error)?;
        bforge.set("seed", seed_fn).map_err(script_error)?;
    }
    {
        let shared_ref = Arc::clone(&shared);
        let rand_fn = lua
            .create_function(move |lua, (a, b): (Option<i64>, Option<i64>)| {
                let mut guard = shared_ref.lock().unwrap();
                match (a, b) {
                    (None, None) => {
                        let unit = (guard.next_u64() >> 11) as f64 * (1.0 / ((1u64 << 53) as f64));
                        Ok(Value::Number(unit))
                    }
                    (Some(upper), None) => {
                        if upper < 1 {
                            return Err(mlua::Error::runtime(
                                "bforge.rand(n) requires upper bound >= 1",
                            ));
                        }
                        let span = upper as u128;
                        let draw = ((u128::from(guard.next_u64()) * span) >> 64) as i64 + 1;
                        Ok(Value::Integer(draw))
                    }
                    (Some(min), Some(max)) => {
                        if min > max {
                            return Err(mlua::Error::runtime(
                                "bforge.rand(min, max) requires min <= max",
                            ));
                        }
                        let span = (i128::from(max) - i128::from(min)) as u128 + 1;
                        let offset = if span <= u128::from(u64::MAX) {
                            ((u128::from(guard.next_u64()) * span) >> 64) as i128
                        } else {
                            let hi = u128::from(guard.next_u64()) << 64;
                            let lo = u128::from(guard.next_u64());
                            ((hi | lo) % span) as i128
                        };
                        let val = (i128::from(min) + offset) as i64;
                        Ok(Value::Integer(val))
                    }
                    (None, Some(_)) => {
                        let _ = lua;
                        Err(mlua::Error::runtime("invalid bforge.rand arguments"))
                    }
                }
            })
            .map_err(script_error)?;
        bforge.set("rand", rand_fn).map_err(script_error)?;
    }

    // --- Codecs, CRC & Burst Helper ---
    let unhex = lua
        .create_function(|lua, value: Value| {
            let bytes = match value {
                Value::String(s) => parse_hex(&s.to_str()?)
                    .map_err(|_| mlua::Error::runtime("expected spaced hex"))?,
                Value::UserData(ud) => {
                    let frame = ud.borrow::<LuaFrame>()?;
                    frame.0.lock().unwrap().preview_bytes()
                }
                Value::Table(tbl) => {
                    let hex: String = tbl
                        .get("hex")
                        .map_err(|_| mlua::Error::runtime("expected spaced hex or frame"))?;
                    parse_hex(&hex).map_err(|_| mlua::Error::runtime("expected spaced hex"))?
                }
                _ => return Err(mlua::Error::runtime("expected spaced hex or frame")),
            };
            let table = lua.create_table_with_capacity(bytes.len(), 0)?;
            for (index, byte) in bytes.iter().enumerate() {
                table.set(index + 1, *byte)?;
            }
            Ok(table)
        })
        .map_err(script_error)?;
    bforge.set("unhex", unhex).map_err(script_error)?;

    let hex = lua
        .create_function(|_lua, value: Value| match value {
            Value::Table(table) => {
                let mut bytes = Vec::with_capacity(table.raw_len());
                for item in table.sequence_values::<u8>() {
                    bytes.push(item?);
                }
                Ok(hex_of(&bytes))
            }
            Value::String(s) => Ok(hex_of(&s.as_bytes())),
            Value::UserData(ud) => {
                let frame = ud.borrow::<LuaFrame>()?;
                let bytes = frame.0.lock().unwrap().preview_bytes();
                Ok(hex_of(&bytes))
            }
            other => Err(mlua::Error::runtime(format!(
                "bforge.hex expects a byte table, string, or frame, not {}",
                other.type_name()
            ))),
        })
        .map_err(script_error)?;
    bforge.set("hex", hex).map_err(script_error)?;

    let crc = lua
        .create_function(|_, (algo, data): (String, Value)| {
            let bytes = parse_lua_bytes(data)?;
            let Some((_, value)) = crc_width_and_compute(&algo, &bytes) else {
                return Err(mlua::Error::runtime(format!(
                    "`{algo}` is not a supported checksum"
                )));
            };
            Ok(value)
        })
        .map_err(script_error)?;
    bforge.set("crc", crc).map_err(script_error)?;

    let burst = lua
        .create_function(|_, entries: mlua::Table| Ok(entries))
        .map_err(script_error)?;
    bforge.set("burst", burst).map_err(script_error)?;

    lua.globals().set("bforge", &bforge).map_err(script_error)?;
    Ok(())
}

/// Format bytes as uppercase spaced hex (`"AA 55 01"`).
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

/// A script that could not be loaded or compiled.
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

    fn assert_send<T: Send>() {}

    fn imu_ir() -> DissectorIr {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../bforge-dissect/tests/fixtures/imu_packet.h"
        );
        let text = std::fs::read_to_string(path).expect("fixture");
        let header = bforge_dissect::cheader::parse(&text).expect("parses");
        bforge_dissect::cheader::compile(&header, "ImuPacket", path).expect("compiles")
    }

    fn eps_ir() -> DissectorIr {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../bforge-dissect/tests/fixtures/imu_packet.h"
        );
        let text = std::fs::read_to_string(path).expect("fixture");
        let header = bforge_dissect::cheader::parse(&text).expect("parses");
        bforge_dissect::cheader::compile(&header, "EpsCommand", path).expect("compiles")
    }

    #[test]
    fn runtime_is_send() {
        assert_send::<ScriptRuntime>();
    }

    // --- Existing 8 compatibility tests ---

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
        .with_schema(imu_ir());

        let mut bytes = vec![0u8; 19];
        bytes[8] = 0x1C;
        bytes[9] = 0xE8;
        match runtime.run(&bytes) {
            FrameVerdict::Send(next) => {
                assert_eq!(u16::from_be_bytes([next[8], next[9]]), 7500);
                assert_eq!(&next[0..8], &bytes[0..8], "the rest is untouched");
            }
            other => panic!("expected Send, got {other:?}"),
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
        .with_schema(imu_ir());

        let mut bytes = vec![0u8; 23];
        bytes[2] = 3;
        let next = match runtime.run(&bytes) {
            FrameVerdict::Send(next) => next,
            other => panic!("expected Send, got {other:?}"),
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

    // --- Wave 1 new tests ---

    #[test]
    fn memory_limit_oom_recovers_cleanly_for_subsequent_frames() {
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_rx_frame(function(frame)
              if frame:u8(0) == 0xEE then
                local junk = {}
                for i = 1, 100000 do
                  junk[i] = string.rep("x", 256)
                end
              end
              return frame
            end)
            "#,
            "oom.lua",
        )
        .expect("compiles")
        .with_memory_limit(512 * 1024);

        let verdict = runtime.run_with_meta(HookKind::Rx, &FrameMeta::default(), &[0xEE, 0x01]);
        assert_eq!(verdict, FrameVerdict::Send(vec![0xEE, 0x01]));
        assert_eq!(runtime.failures, 1);
        assert!(runtime.last_error.is_some());

        // Subsequent frame without allocation bomb must still run and mutate cleanly.
        let ok_verdict = runtime.run_with_meta(HookKind::Rx, &FrameMeta::default(), &[0x01, 0x02]);
        assert_eq!(ok_verdict, FrameVerdict::Send(vec![0x01, 0x02]));
        assert_eq!(runtime.failures, 1);
    }

    #[test]
    fn fail_closed_policy_drops_on_runtime_or_budget_error() {
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_mitm_frame(function(frame)
              while true do end
            end)
            "#,
            "closed.lua",
        )
        .expect("compiles")
        .with_policy(FaultPolicy::FailClosed);

        let verdict = runtime.run_with_meta(HookKind::Mitm, &FrameMeta::default(), &[0xAA, 0x55]);
        assert_eq!(verdict, FrameVerdict::Drop);
        assert_eq!(runtime.failures, 1);
        assert_eq!(runtime.dropped, 1);
    }

    #[test]
    fn scoped_hook_without_schema_passes_lua_frame_and_supports_unhex_and_binary_ops() {
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_rx_frame("fc_uart", function(frame)
              assert(frame.port == "fc_uart")
              assert(frame.direction == "rx")
              assert(frame.seq_id == 7)
              assert(frame.len == 12)
              assert(frame:u8(0) == 0xAA)
              assert(frame:i8(1) == -2)
              assert(frame:u16_be(2) == 0x1234)
              assert(frame:u32_le(4) == 0x78563412)
              assert(math.abs(frame:f32_le(8) - 1.5) < 1e-6)
              local tbl = bforge.unhex(frame)
              assert(#tbl == 12 and tbl[1] == 0xAA)
              frame:set_u16_be(2, 0xBEEF)
              frame:xor_bit(0, 0)
              return frame
            end)
            "#,
            "rx_bin.lua",
        )
        .expect("compiles");

        let mut payload = vec![
            0xAA, 0xFE, 0x12, 0x34, // u8, i8(-2), u16_be
            0x12, 0x34, 0x56, 0x78, // u32_le
        ];
        payload.extend_from_slice(&1.5f32.to_le_bytes());

        let meta = FrameMeta {
            port: "fc_uart".to_string(),
            direction: "rx".to_string(),
            seq_id: 7,
            timestamp_us: 1234,
            bridge: None,
        };
        let verdict = runtime.run_with_meta(HookKind::Rx, &meta, &payload);
        assert_eq!(runtime.failures, 0, "err={:?}", runtime.last_error);
        match verdict {
            FrameVerdict::Send(out) => {
                assert_eq!(out[0], 0xAB);
                assert_eq!(&out[2..4], &[0xBE, 0xEF]);
            }
            other => panic!("expected Send, got {other:?}"),
        }

        // Unmatched port passes untouched.
        let other_meta = FrameMeta {
            port: "other_uart".to_string(),
            ..meta
        };
        assert_eq!(
            runtime.run_with_meta(HookKind::Rx, &other_meta, &[1, 2, 3]),
            FrameVerdict::Send(vec![1, 2, 3])
        );
    }

    #[test]
    fn falloff_end_forwards_while_explicit_nil_drops() {
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_rx_frame(function(frame)
              if frame:u8(0) == 0xFF then
                return nil
              end
              bforge.metric("seen", (bforge.metric("seen") or 0) + 1)
            end)
            "#,
            "passthrough.lua",
        )
        .expect("compiles");

        assert_eq!(
            runtime.run_with_meta(HookKind::Rx, &FrameMeta::default(), &[0x01, 0x02]),
            FrameVerdict::Send(vec![0x01, 0x02])
        );
        assert_eq!(
            runtime.run_with_meta(HookKind::Rx, &FrameMeta::default(), &[0xFF, 0x02]),
            FrameVerdict::Drop
        );
        let snap = runtime.snapshot();
        assert_eq!(snap.metrics.get("seen").map(String::as_str), Some("1"));
        assert_eq!(snap.dropped, 1);
        assert_eq!(snap.changed, 0);
    }

    #[test]
    fn multi_schema_dissect_and_lazy_cache_set_get_recalc_crc() {
        let mut map = BTreeMap::new();
        map.insert("ImuPacket".to_string(), imu_ir());
        map.insert("EpsCommand".to_string(), eps_ir());
        let schemas = Arc::new(map);

        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_mitm_frame("obc_to_eps", function(frame)
              local pkt = frame:dissect("EpsCommand")
              if not pkt then return nil end
              local old_hold = pkt:get("hold_time_s")
              assert(old_hold == 10)
              pkt:set("hold_time_s", 42)
              assert(pkt:get("hold_time_s") == 42)
              local fields = pkt:fields()
              assert(fields.hold_time_s == 42 and fields.opcode == 0x04)
              pkt:recalc_crc("crc16_modbus")
              return pkt:delay_ms(12)
            end)
            "#,
            "mitm_dissect.lua",
        )
        .expect("compiles")
        .with_schemas(schemas);

        // EpsCommand (7 bytes) + 2 bytes Modbus CRC
        let mut frame = vec![0xAA, 0x55, 0x04, 10, 0, 0, 0, 0, 0];
        let crc0 = crate::frame::crc16_modbus(&frame[..7]);
        frame[7..9].copy_from_slice(&crc0.to_le_bytes());

        let meta = FrameMeta {
            port: "eps".to_string(),
            direction: "mitm_a_to_b".to_string(),
            seq_id: 1,
            timestamp_us: 500,
            bridge: Some("obc_to_eps".to_string()),
        };

        let verdict = runtime.run_with_meta(HookKind::Mitm, &meta, &frame);
        assert_eq!(runtime.failures, 0, "err={:?}", runtime.last_error);
        match verdict {
            FrameVerdict::Delay { bytes, delay_ms } => {
                assert_eq!(delay_ms, 12);
                assert_eq!(u32::from_le_bytes(bytes[3..7].try_into().unwrap()), 42);
                let expected_crc = crate::frame::crc16_modbus(&bytes[..7]);
                assert_eq!(&bytes[7..9], &expected_crc.to_le_bytes());
            }
            other => panic!("expected Delay, got {other:?}"),
        }
        assert_eq!(runtime.delayed, 1);
        assert_eq!(runtime.changed, 1);
    }

    #[test]
    fn burst_verdict_and_corrupt_crc_and_recalc_ranges_work() {
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_tx_frame(function(frame)
              if frame:u8(0) == 0x01 then
                local a = frame:raw()
                frame:corrupt_crc(2)
                local b = frame:raw()
                return bforge.burst({ { a, 0 }, { b, 5 } })
              end
              frame:recalc_crc("crc16_xmodem", 2, 6)
              return frame
            end)
            "#,
            "burst.lua",
        )
        .expect("compiles");

        let burst_verdict = runtime.run_with_meta(
            HookKind::Tx,
            &FrameMeta::default(),
            &[0x01, 0x02, 0x10, 0x20],
        );
        assert_eq!(
            burst_verdict,
            FrameVerdict::Burst(vec![
                (vec![0x01, 0x02, 0x10, 0x20], 0),
                (vec![0x01, 0x02, 0xEF, 0xDF], 5),
            ])
        );

        let range_verdict = runtime.run_with_meta(
            HookKind::Tx,
            &FrameMeta::default(),
            &[0xAA, 0x55, 0x11, 0x22, 0x33, 0x44, 0x00, 0x00],
        );
        let expected = crate::xymodem::crc16_xmodem(&[0x11, 0x22, 0x33, 0x44]);
        assert_eq!(
            range_verdict,
            FrameVerdict::Send(vec![
                0xAA,
                0x55,
                0x11,
                0x22,
                0x33,
                0x44,
                expected as u8,
                (expected >> 8) as u8,
            ])
        );
    }

    #[test]
    fn deterministic_prng_send_pins_plot_assert_and_log_rate_limit() {
        let script = r#"
            bforge.seed(42)
            local first_draw = nil
            bforge.on_init(function(ctx)
              first_draw = bforge.rand(1, 1000)
              bforge.metric("init_rand", first_draw)
            end)

            bforge.on_rx_frame("uart0", function(frame)
              local ack = string.pack("<BB", 0xAA, frame:u8(0))
              local c = bforge.crc("crc8", ack)
              bforge.send("uart0", ack .. string.pack("<B", c), { delay_ms = 3, run_tx_hooks = false })
              bforge.set_pins("aux", true, false)
              bforge.pulse_pin("aux", "RTS", 2)
              bforge.trigger_pin("aux", "PULSE_HIGH_100US")
              bforge.plot("power_w", 12.5, frame.timestamp_us)
              bforge.assert(frame:u8(0) == 0x10, "expected_opcode")
              for i = 1, 30 do
                bforge.log_info("spam " .. i)
              end
              assert(bforge.now_us() >= 0 and bforge.now_ms() >= 0)
            end)
        "#;

        let mut rt1 = ScriptRuntime::compile(script, "hil.lua").expect("compiles");
        let rt2 = ScriptRuntime::compile(script, "hil.lua").expect("compiles");
        assert_eq!(
            rt1.snapshot().metrics.get("init_rand"),
            rt2.snapshot().metrics.get("init_rand"),
            "same seed must yield identical initial rand"
        );

        let meta = FrameMeta {
            port: "uart0".to_string(),
            direction: "rx".to_string(),
            seq_id: 1,
            timestamp_us: 999,
            bridge: None,
        };
        let _ = rt1.run_with_meta(HookKind::Rx, &meta, &[0x10, 0x00]);
        assert_eq!(rt1.failures, 0, "err={:?}", rt1.last_error);

        let actions = rt1.drain_actions();
        assert!(matches!(
            &actions[0],
            ScriptAction::Send { port, delay_ms: 3, run_tx_hooks: false, bytes }
                if port == "uart0" && bytes.len() == 3
        ));
        assert_eq!(
            actions[1],
            ScriptAction::SetPins {
                port: "aux".to_string(),
                dtr: true,
                rts: false
            }
        );
        assert_eq!(
            actions[2],
            ScriptAction::PulsePin {
                port: "aux".to_string(),
                pin: "RTS".to_string(),
                duration_ms: 2
            }
        );
        assert_eq!(
            actions[3],
            ScriptAction::PulsePin {
                port: "aux".to_string(),
                pin: "RTS".to_string(),
                duration_ms: 1
            }
        );
        assert_eq!(
            actions[4],
            ScriptAction::Plot {
                series: "power_w".to_string(),
                value: 12.5,
                timestamp_us: Some(999)
            }
        );

        let log_count = actions
            .iter()
            .filter(|a| matches!(a, ScriptAction::Log { .. }))
            .count();
        assert_eq!(log_count, 20, "burst cap is 20 logs");
        let snap = rt1.snapshot();
        assert_eq!(snap.logs_suppressed, 10);
        assert_eq!(snap.assertions_passed, 1);
        assert_eq!(snap.assertions_failed, 0);
        assert_eq!(snap.injected_tx, 1);
    }

    #[test]
    fn send_cap_enforced_and_timer_alert_command_dissect_hooks_work() {
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_timer(5, function(ctx)
              bforge.metric("ticks", (bforge.metric("ticks") or 0) + 1)
              bforge.send("uart", "AA 55")
            end)
            bforge.on_alert("dead_man", function(alert)
              bforge.log_warn("alert: " .. alert.name .. " " .. alert.detail)
            end)
            bforge.on_command("ping", function(args)
              return string.pack("<BB", 0xAA, tonumber(args.seq) or 0)
            end)
            bforge.on_dissect("uart", function(frame)
              frame:add_field("custom_tag", 0, 1, "SYNC", 0xAA)
            end)
            "#,
            "multi_hooks.lua",
        )
        .expect("compiles");

        // Timer min interval clamped to 10 ms: t=5 does not fire, t=10 fires.
        assert!(runtime.tick_timers(5).unwrap().is_empty());
        let timer_actions = runtime.tick_timers(10).unwrap();
        assert_eq!(timer_actions.len(), 1);

        let alert_actions = runtime.trigger_alert("dead_man", "silence").unwrap();
        assert_eq!(
            alert_actions,
            vec![ScriptAction::Log {
                level: "warn".to_string(),
                message: "alert: dead_man silence".to_string(),
            }]
        );

        let mut args = BTreeMap::new();
        args.insert("seq".to_string(), "42".to_string());
        let cmd_bytes = runtime.invoke_command("ping", &args).unwrap();
        assert_eq!(cmd_bytes, vec![0xAA, 42]);

        // Send cap test
        let mut cap_rt = ScriptRuntime::compile(
            r#"
            bforge.on_rx_frame(function(frame)
              for i = 1, 20 do
                bforge.send("uart", { i })
              end
            end)
            "#,
            "cap.lua",
        )
        .expect("compiles");
        let _ = cap_rt.run_with_meta(HookKind::Rx, &FrameMeta::default(), &[1]);
        assert_eq!(cap_rt.failures, 1);
        assert!(
            cap_rt
                .last_error
                .as_deref()
                .unwrap_or("")
                .contains("limit exceeded")
        );
    }

    #[test]
    fn dry_run_produces_field_diffs_actions_and_metrics() {
        let mut schemas = BTreeMap::new();
        schemas.insert("ImuPacket".to_string(), imu_ir());

        let mut bytes = vec![0u8; 19];
        bytes[8] = 0x1C;
        bytes[9] = 0xE8; // 7400 mV

        let meta = FrameMeta {
            port: "imu_uart".to_string(),
            direction: "tx".to_string(),
            seq_id: 11,
            timestamp_us: 2048,
            bridge: None,
        };

        let report = ScriptRuntime::dry_run(
            r#"
            bforge.on_tx_frame("imu_uart", function(frame)
              frame:set("v_batt_mv", frame:get("v_batt_mv") + 100)
              bforge.plot("v_batt", frame:get("v_batt_mv"), frame.timestamp_us)
              bforge.assert(frame:get("v_batt_mv") == 7500, "batt_bumped")
              bforge.metric("last_batt", frame:get("v_batt_mv"))
              return frame:delay_ms(5)
            end)
            "#,
            "dry.lua",
            FaultPolicy::FailOpen,
            Some(99),
            Arc::new(schemas),
            Some(imu_ir()),
            &meta,
            HookKind::Tx,
            &bytes,
        )
        .expect("dry_run succeeds");

        assert_eq!(report.verdict, "delay");
        assert!(report.mutated);
        assert_eq!(report.delay_ms, 5);
        assert_eq!(report.error, None);
        assert_eq!(
            report.field_diffs,
            vec![FieldDiffRecord {
                name: "v_batt_mv".to_string(),
                before: Some("7400".to_string()),
                after: Some("7500".to_string()),
            }]
        );
        assert_eq!(
            report.metrics.get("last_batt").map(String::as_str),
            Some("7500")
        );
        assert_eq!(report.assertions.len(), 1);
        assert_eq!(report.assertions[0].passed, 1);
        assert!(report.memory_bytes > 0);
    }

    #[test]
    fn raw_chunk_and_legacy_rx_fallback_and_port_schema_autobinding_work() {
        let mut raw_rt = ScriptRuntime::compile(
            r#"
            bforge.on_raw_chunk("uart0", function(chunk)
              chunk:xor_u8(0, 0xFF)
              return chunk
            end)
            "#,
            "raw_chunk.lua",
        )
        .expect("compiles");
        let meta = FrameMeta {
            port: "uart0".to_string(),
            direction: "rx".to_string(),
            seq_id: 1,
            timestamp_us: 10,
            bridge: None,
        };
        assert_eq!(
            raw_rt.run_with_meta(HookKind::RawChunk, &meta, &[0xAA, 0x55]),
            FrameVerdict::Send(vec![0x55, 0x55])
        );

        // Legacy on_frame on Rx without schema gets spaced hex string.
        let mut legacy_rx = ScriptRuntime::compile(
            r#"
            bforge.on_frame(function(frame)
              assert(type(frame) == "string")
              local b = bforge.unhex(frame)
              b[1] = 0x42
              return bforge.hex(b)
            end)
            "#,
            "legacy_rx.lua",
        )
        .expect("compiles");
        assert_eq!(
            legacy_rx.run_with_meta(HookKind::Rx, &meta, &[0x01, 0x02]),
            FrameVerdict::Send(vec![0x42, 0x02])
        );

        // Legacy on_frame on Rx WITH port schema gets LuaFrame UserData.
        let mut map = BTreeMap::new();
        map.insert("port:uart0".to_string(), imu_ir());
        let mut port_schema_rx = ScriptRuntime::compile(
            r#"
            bforge.on_frame(function(frame)
              assert(type(frame) == "userdata")
              frame:set("version", 9)
              return frame
            end)
            "#,
            "port_schema_rx.lua",
        )
        .expect("compiles")
        .with_schemas(Arc::new(map));
        let res = port_schema_rx.run_with_meta(HookKind::Rx, &meta, &[0u8; 19]);
        assert_eq!(
            port_schema_rx.failures, 0,
            "err={:?}",
            port_schema_rx.last_error
        );
        match res {
            FrameVerdict::Send(out) => assert_eq!(out[2], 9),
            other => panic!("expected Send, got {other:?}"),
        }
    }

    #[test]
    fn compile_time_watchdog_on_init_errors_and_oob_checks_hold() {
        let spin_err = ScriptRuntime::compile("while true do end", "top_spin.lua")
            .expect_err("top-level infinite loop must abort");
        assert!(
            spin_err.message.contains("instruction budget"),
            "{spin_err}"
        );

        let init_err = ScriptRuntime::compile(
            r#"bforge.on_init(function() error("bad init") end)"#,
            "init_err.lua",
        )
        .expect_err("on_init error must fail compile");
        assert!(init_err.message.contains("bad init"), "{init_err}");

        let timer_limit_err = ScriptRuntime::compile(
            r#"
            for i = 1, 9 do
              bforge.on_timer(20, function() end)
            end
            "#,
            "timers.lua",
        )
        .expect_err("more than 8 timers must error");
        assert!(
            timer_limit_err.message.contains("8 timers"),
            "{timer_limit_err}"
        );

        // OOB binary reads & invalid xor_bit must fail cleanly without panicking.
        let mut oob_rt = ScriptRuntime::compile(
            r#"
            bforge.on_rx_frame(function(frame)
              if frame:u8(0) == 1 then
                return frame:u16_be(0)
              elseif frame:u8(0) == 2 then
                frame:xor_bit(0, 8)
              end
              return frame:slice(0, 10)
            end)
            "#,
            "oob.lua",
        )
        .expect("compiles");
        assert_eq!(
            oob_rt.run_with_meta(HookKind::Rx, &FrameMeta::default(), &[1]),
            FrameVerdict::Send(vec![1])
        );
        assert_eq!(oob_rt.failures, 1);
        assert_eq!(
            oob_rt.run_with_meta(HookKind::Rx, &FrameMeta::default(), &[2]),
            FrameVerdict::Send(vec![2])
        );
        assert_eq!(oob_rt.failures, 2);
        assert_eq!(
            oob_rt.run_with_meta(HookKind::Rx, &FrameMeta::default(), &[3]),
            FrameVerdict::Send(vec![3])
        );
        assert_eq!(oob_rt.failures, 3);
    }

    #[test]
    fn dry_run_captures_dynamic_dissect_field_diffs() {
        let mut schemas = BTreeMap::new();
        schemas.insert("C_STRUCT:EpsCommand".to_string(), eps_ir());
        let frame = vec![0xAA, 0x55, 0x04, 10, 0, 0, 0];

        let report = ScriptRuntime::dry_run(
            r#"
            bforge.on_mitm_frame("bridge0", function(frame)
              local pkt = frame:dissect("C_STRUCT:EpsCommand")
              pkt:set("hold_time_s", 77)
              return pkt
            end)
            "#,
            "dyn_diff.lua",
            FaultPolicy::FailOpen,
            None,
            Arc::new(schemas),
            None,
            &FrameMeta {
                port: "eps".to_string(),
                direction: "mitm_a_to_b".to_string(),
                seq_id: 1,
                timestamp_us: 0,
                bridge: Some("bridge0".to_string()),
            },
            HookKind::Mitm,
            &frame,
        )
        .expect("dry_run succeeds");

        assert_eq!(report.verdict, "send");
        assert!(report.mutated);
        assert_eq!(
            report.field_diffs,
            vec![FieldDiffRecord {
                name: "hold_time_s".to_string(),
                before: Some("10".to_string()),
                after: Some("77".to_string()),
            }]
        );
    }

    fn sample_imu_frame_with_crc8() -> Vec<u8> {
        let mut frame = vec![
            0xAA, 0x55, // sync (0..2)
            0x01, // version (2)
            0x13, // flags=3, channel=2 (3)
            0x40, 0xE2, 0x01, 0x00, // timestamp_us = 123456 LE (4..8)
            0x1F, 0xF4, // v_batt_mv = 8180 BE (8..10)
            0x00, 0x00, 0x00, 0x00, // gyro_z = 0.0 (10..14)
            0x80, 0x90, 0xA0, 0xB0, // samples[4] (14..18)
            0x01, // mode = 1 (18)
            0x00, // crc8 placeholder (19)
        ];
        frame[19] = bforge_framer::checksum::crc8_atm(&frame[..19]);
        frame
    }

    fn sample_eps_frame_with_crc16() -> Vec<u8> {
        let mut frame = vec![
            0xAA, 0x55, // sync
            0x04, // opcode
            10, 0, 0, 0, // hold_time_s = 10 LE
            0, 0, // crc16_ccitt_false placeholder
        ];
        let crc = bforge_framer::checksum::crc16_ccitt_false(&frame[..7]);
        frame[7..9].copy_from_slice(&crc.to_le_bytes());
        frame
    }

    #[test]
    fn multi_form_api_overloads_work() {
        let mut runtime = ScriptRuntime::compile(
            r#"
            bforge.on_rx_frame("*", function(frame, dir)
              bforge.metric("rx_dir_arg", dir)
              bforge.assert(true, "legacy_pass")
              bforge.assert(false, "legacy_fail")
              bforge.assert(true)
              bforge.assert("named_pass", true, "unused")
              bforge.assert("named_fail", false, "custom failure detail")
              bforge.assert("nil_fail", nil)
              bforge.assert("truthy_str", "ok_label")

              bforge.log("plain info message")
              bforge.log("warn", "explicit warn")
              bforge.log("ERROR", "upper error")
              bforge.log("debug", "debug trace")
              bforge.log("custom_lvl", "fallback to info")

              bforge.send("uart0", "AA 55", 7)
              bforge.send("*", "01 02", { delay_ms = 3, run_tx_hooks = true })
              bforge.send("uart0", "03 04")

              bforge.pulse_pin("RTS", 20)
              bforge.pulse_pin("aux", "dtr", 12)
              bforge.set_pins(true, false)
              bforge.set_pins("aux", false, true)
              return frame
            end)
            "#,
            "overloads.lua",
        )
        .expect("compiles");

        let meta = FrameMeta {
            port: "uart0".to_string(),
            direction: "rx".to_string(),
            seq_id: 1,
            timestamp_us: 100,
            bridge: None,
        };
        let verdict = runtime.run_with_meta(HookKind::Rx, &meta, &[0xAA, 0x55]);
        assert_eq!(verdict, FrameVerdict::Send(vec![0xAA, 0x55]));
        assert_eq!(runtime.failures, 0, "err={:?}", runtime.last_error);

        let snap = runtime.snapshot();
        assert_eq!(
            snap.metrics.get("rx_dir_arg").map(String::as_str),
            Some("rx")
        );
        assert_eq!(snap.assertions_passed, 4);
        assert_eq!(snap.assertions_failed, 3);

        let find_assert = |name: &str| {
            snap.assertions
                .iter()
                .find(|a| a.name == name)
                .unwrap_or_else(|| panic!("missing assertion {name}"))
        };
        assert_eq!(
            find_assert("legacy_fail").last_error.as_deref(),
            Some("assertion `legacy_fail` failed")
        );
        assert_eq!(
            find_assert("named_fail").last_error.as_deref(),
            Some("custom failure detail")
        );
        assert_eq!(
            find_assert("nil_fail").last_error.as_deref(),
            Some("assertion `nil_fail` failed")
        );
        assert_eq!(find_assert("assertion").passed, 1);
        assert_eq!(find_assert("ok_label").passed, 1);

        let actions = runtime.drain_actions();
        assert!(actions.contains(&ScriptAction::Log {
            level: "info".to_string(),
            message: "plain info message".to_string(),
        }));
        assert!(actions.contains(&ScriptAction::Log {
            level: "warn".to_string(),
            message: "explicit warn".to_string(),
        }));
        assert!(actions.contains(&ScriptAction::Log {
            level: "error".to_string(),
            message: "upper error".to_string(),
        }));
        assert!(actions.contains(&ScriptAction::Log {
            level: "debug".to_string(),
            message: "debug trace".to_string(),
        }));
        assert!(actions.contains(&ScriptAction::Log {
            level: "info".to_string(),
            message: "fallback to info".to_string(),
        }));
        assert!(actions.contains(&ScriptAction::Send {
            port: "uart0".to_string(),
            bytes: vec![0xAA, 0x55],
            delay_ms: 7,
            run_tx_hooks: false,
        }));
        assert!(actions.contains(&ScriptAction::Send {
            port: "*".to_string(),
            bytes: vec![0x01, 0x02],
            delay_ms: 3,
            run_tx_hooks: true,
        }));
        assert!(actions.contains(&ScriptAction::Send {
            port: "uart0".to_string(),
            bytes: vec![0x03, 0x04],
            delay_ms: 0,
            run_tx_hooks: false,
        }));
        assert!(actions.contains(&ScriptAction::PulsePin {
            port: "*".to_string(),
            pin: "RTS".to_string(),
            duration_ms: 20,
        }));
        assert!(actions.contains(&ScriptAction::PulsePin {
            port: "aux".to_string(),
            pin: "DTR".to_string(),
            duration_ms: 12,
        }));
        assert!(actions.contains(&ScriptAction::SetPins {
            port: "*".to_string(),
            dtr: true,
            rts: false,
        }));
        assert!(actions.contains(&ScriptAction::SetPins {
            port: "aux".to_string(),
            dtr: false,
            rts: true,
        }));
    }

    #[test]
    fn all_fifteen_tutorial_scripts_compile_and_execute_cleanly() {
        let tutorial_dir = std::path::PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/tutorials"
        ));
        let load = |file: &str| {
            let path = tutorial_dir.join(file);
            std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
        };

        let mut schema_map = BTreeMap::new();
        schema_map.insert("ImuPacket".to_string(), imu_ir());
        schema_map.insert("EpsCommand".to_string(), eps_ir());
        let schemas = Arc::new(schema_map);

        let imu_frame = sample_imu_frame_with_crc8();
        let eps_frame = sample_eps_frame_with_crc16();
        let rx_meta = FrameMeta {
            port: "uart0".to_string(),
            direction: "rx".to_string(),
            seq_id: 42,
            timestamp_us: 10_000,
            bridge: None,
        };
        let tx_meta = FrameMeta {
            port: "uart0".to_string(),
            direction: "tx".to_string(),
            seq_id: 43,
            timestamp_us: 20_000,
            bridge: None,
        };

        // 01: Packet filter & metadata
        {
            let src = load("01_packet_filter_and_metadata.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "01",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                Some(imu_ir()),
                &rx_meta,
                HookKind::Rx,
                &imu_frame,
            )
            .expect("01 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "pass");
            assert_eq!(dry.metrics.get("rx_passed").map(String::as_str), Some("1"));
            assert_eq!(
                dry.metrics.get("last_port").map(String::as_str),
                Some("uart0")
            );
            assert_eq!(
                dry.metrics.get("last_direction").map(String::as_str),
                Some("rx")
            );
            assert_eq!(
                dry.metrics.get("last_seq_id").map(String::as_str),
                Some("42")
            );
            assert_eq!(dry.metrics.get("last_len").map(String::as_str), Some("20"));

            let mut rt = ScriptRuntime::compile(&src, "01").expect("01 compiles");
            assert_eq!(
                rt.run_with_meta(HookKind::Rx, &rx_meta, &[0xFF, 0x01, 0x02]),
                FrameVerdict::Drop
            );
            assert_eq!(rt.failures, 0);
            let snap = rt.snapshot();
            assert_eq!(
                snap.metrics.get("rx_dropped").map(String::as_str),
                Some("1")
            );
            assert_eq!(
                snap.metrics.get("last_dropped_hex").map(String::as_str),
                Some("FF 01 02")
            );
            assert!(
                rt.drain_actions()
                    .iter()
                    .any(|a| matches!(a, ScriptAction::Log { level, .. } if level == "warn"))
            );
        }

        // 02: Schema assertions & logging
        {
            let src = load("02_schema_assertions_and_logging.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "02",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                Some(imu_ir()),
                &rx_meta,
                HookKind::Rx,
                &imu_frame,
            )
            .expect("02 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "pass");
            assert_eq!(dry.assertions.len(), 3);
            assert!(
                dry.assertions
                    .iter()
                    .all(|a| a.passed == 1 && a.failed == 0)
            );
            assert!(
                dry.actions
                    .iter()
                    .any(|a| matches!(a, ScriptAction::Log { level, .. } if level == "info"))
            );

            let mut rt = ScriptRuntime::compile(&src, "02")
                .expect("02 compiles")
                .with_schema(imu_ir());
            let mut critical = imu_frame.clone();
            critical[8..10].copy_from_slice(&5500u16.to_be_bytes());
            let _ = rt.run_with_meta(HookKind::Rx, &rx_meta, &critical);
            assert_eq!(rt.failures, 0);
            assert_eq!(rt.snapshot().assertions_failed, 1);
            assert!(
                rt.drain_actions()
                    .iter()
                    .any(|a| matches!(a, ScriptAction::Log { level, .. } if level == "error"))
            );
        }

        // 03: Derived telemetry plotting (EMA & P2P)
        {
            let src = load("03_derived_telemetry_plotting.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "03",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                Some(imu_ir()),
                &rx_meta,
                HookKind::Rx,
                &imu_frame,
            )
            .expect("03 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "pass");

            let mut rt = ScriptRuntime::compile(&src, "03")
                .expect("03 compiles")
                .with_schema(imu_ir());
            for (idx, mv) in [8000u16, 8400, 8200].into_iter().enumerate() {
                let mut f = imu_frame.clone();
                f[8..10].copy_from_slice(&mv.to_be_bytes());
                let meta = FrameMeta {
                    timestamp_us: (idx as u64 + 1) * 1_000,
                    ..rx_meta.clone()
                };
                let _ = rt.run_with_meta(HookKind::Rx, &meta, &f);
            }
            assert_eq!(rt.failures, 0);
            let snap = rt.snapshot();
            assert_eq!(snap.metrics.get("samples").map(String::as_str), Some("3"));
            assert_eq!(
                snap.metrics.get("v_batt_p2p_mv").map(String::as_str),
                Some("400")
            );
            let actions = rt.drain_actions();
            assert_eq!(
                actions
                    .iter()
                    .filter(|a| matches!(a, ScriptAction::Plot { .. }))
                    .count(),
                9
            );
        }

        // 04: Named field patching & CRC-8
        {
            let src = load("04_field_patching_and_crc8.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "04",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                Some(imu_ir()),
                &tx_meta,
                HookKind::Tx,
                &imu_frame,
            )
            .expect("04 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "send");
            assert!(dry.mutated);
            assert!(dry.field_diffs.iter().any(|d| d.name == "v_batt_mv"
                && d.before.as_deref() == Some("8180")
                && d.after.as_deref() == Some("8280")));
            assert_eq!(
                dry.output_bytes[19],
                bforge_framer::checksum::crc8_atm(&dry.output_bytes[..19])
            );
        }

        // 05: Zero-offset binary surgery
        {
            let src = load("05_zero_offset_binary_surgery.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "05",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                None,
                &tx_meta,
                HookKind::Tx,
                &imu_frame,
            )
            .expect("05 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "send");
            assert!(dry.mutated);
            assert_eq!(dry.output_bytes[2], 2);
            assert_eq!(
                u32::from_le_bytes(dry.output_bytes[4..8].try_into().unwrap()),
                124_456
            );
            assert_eq!(
                u16::from_be_bytes([dry.output_bytes[8], dry.output_bytes[9]]),
                8130
            );
            assert_eq!(
                dry.output_bytes[19],
                bforge_framer::checksum::crc8_atm(&dry.output_bytes[..19])
            );
            assert_eq!(
                dry.metrics.get("samples_hex").map(String::as_str),
                Some("80 90 A0 B0")
            );
        }

        // 06: Deterministic SEU bit-flip fuzzer
        {
            let src = load("06_deterministic_seu_bitflip_fuzzer.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "06",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                Some(imu_ir()),
                &rx_meta,
                HookKind::Rx,
                &imu_frame,
            )
            .expect("06 dry_run");
            assert_eq!(dry.error, None);
            assert!(dry.mutated);

            let mut rt_a = ScriptRuntime::compile(&src, "06a").expect("06a compiles");
            let mut rt_b = ScriptRuntime::compile(&src, "06b").expect("06b compiles");
            let va = rt_a.run_with_meta(HookKind::Rx, &rx_meta, &imu_frame);
            let vb = rt_b.run_with_meta(HookKind::Rx, &rx_meta, &imu_frame);
            assert_eq!(va, vb, "seed(42) must guarantee identical SEU output");
            assert_eq!(rt_a.failures, 0);
            assert_ne!(va.bytes().unwrap(), imu_frame.as_slice());
        }

        // 07: MITM directional latency & glitch
        {
            let src = load("07_mitm_directional_latency_glitch.lua");
            let a_to_b = FrameMeta {
                port: "a".to_string(),
                direction: "mitm_a_to_b".to_string(),
                seq_id: 1,
                timestamp_us: 500,
                bridge: Some("obc_eps".to_string()),
            };
            let dry = ScriptRuntime::dry_run(
                &src,
                "07",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                Some(imu_ir()),
                &a_to_b,
                HookKind::Mitm,
                &imu_frame,
            )
            .expect("07 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "delay");
            assert_eq!(dry.delay_ms, 45);
            assert_eq!(
                u16::from_be_bytes([dry.output_bytes[8], dry.output_bytes[9]]),
                7930
            );
            assert_eq!(
                dry.output_bytes[19],
                bforge_framer::checksum::crc8_atm(&dry.output_bytes[..19])
            );
            assert_eq!(
                dry.metrics.get("last_bridge").map(String::as_str),
                Some("obc_eps")
            );

            let mut rt = ScriptRuntime::compile(&src, "07")
                .expect("07 compiles")
                .with_schema(imu_ir());
            let b_to_a = FrameMeta {
                direction: "mitm_b_to_a".to_string(),
                ..a_to_b
            };
            assert_eq!(
                rt.run_with_meta(HookKind::Mitm, &b_to_a, &imu_frame),
                FrameVerdict::Send(imu_frame.clone())
            );
            assert_eq!(
                rt.snapshot()
                    .metrics
                    .get("b_to_a_forwarded")
                    .map(String::as_str),
                Some("1")
            );
        }

        // 08: Multi-schema dynamic dissect
        {
            let src = load("08_multi_schema_dynamic_dissect.lua");
            let mitm_meta = FrameMeta {
                port: "link".to_string(),
                direction: "mitm_a_to_b".to_string(),
                seq_id: 1,
                timestamp_us: 100,
                bridge: Some("main_bridge".to_string()),
            };
            let dry_imu = ScriptRuntime::dry_run(
                &src,
                "08_imu",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                None,
                &mitm_meta,
                HookKind::Mitm,
                &imu_frame,
            )
            .expect("08 imu dry_run");
            assert_eq!(dry_imu.error, None);
            assert_eq!(
                dry_imu.metrics.get("active_schema").map(String::as_str),
                Some("ImuPacket")
            );
            assert!(dry_imu.field_diffs.iter().any(|d| d.name == "version"
                && d.before.as_deref() == Some("1")
                && d.after.as_deref() == Some("2")));
            assert_eq!(
                dry_imu.output_bytes[19],
                bforge_framer::checksum::crc8_atm(&dry_imu.output_bytes[..19])
            );

            let dry_eps = ScriptRuntime::dry_run(
                &src,
                "08_eps",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                None,
                &mitm_meta,
                HookKind::Mitm,
                &eps_frame,
            )
            .expect("08 eps dry_run");
            assert_eq!(dry_eps.error, None);
            assert_eq!(
                dry_eps.metrics.get("active_schema").map(String::as_str),
                Some("EpsCommand")
            );
            assert!(dry_eps.field_diffs.iter().any(|d| d.name == "hold_time_s"
                && d.before.as_deref() == Some("10")
                && d.after.as_deref() == Some("25")));
            let expected_crc =
                bforge_framer::checksum::crc16_ccitt_false(&dry_eps.output_bytes[..7]);
            assert_eq!(&dry_eps.output_bytes[7..9], &expected_crc.to_le_bytes());
        }

        // 09: Packet burst duplication & split
        {
            let src = load("09_packet_burst_duplication_and_split.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "09",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                None,
                &tx_meta,
                HookKind::Tx,
                &imu_frame,
            )
            .expect("09 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "burst");
            assert_eq!(dry.burst_frames.len(), 4);
            assert_eq!(dry.burst_frames[0], (imu_frame.clone(), 0));
            assert_eq!(dry.burst_frames[1].1, 10);
            assert_eq!(
                dry.burst_frames[1].0.last().copied(),
                Some(imu_frame.last().unwrap() ^ 0xFF)
            );
            let mut reassembled = dry.burst_frames[2].0.clone();
            reassembled.extend_from_slice(&dry.burst_frames[3].0);
            assert_eq!(reassembled, imu_frame);
            assert_eq!(
                dry.metrics.get("burst_count").map(String::as_str),
                Some("4")
            );
        }

        // 10: Virtual device auto-responder
        {
            let src = load("10_virtual_device_auto_responder.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "10",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                None,
                &rx_meta,
                HookKind::Rx,
                &imu_frame,
            )
            .expect("10 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "pass");
            assert_eq!(dry.metrics.get("rx_flags").map(String::as_str), Some("3"));
            assert_eq!(dry.metrics.get("rx_channel").map(String::as_str), Some("2"));
            let send = dry
                .actions
                .iter()
                .find_map(|a| match a {
                    ScriptAction::Send {
                        port,
                        bytes,
                        delay_ms,
                        run_tx_hooks,
                    } => Some((port, bytes, *delay_ms, *run_tx_hooks)),
                    _ => None,
                })
                .expect("send action");
            assert_eq!(send.0, "uart0");
            assert_eq!(send.2, 4);
            assert!(!send.3);
            assert_eq!(send.1.len(), 6);
            assert_eq!(send.1[2], 0x81);
            assert_eq!(send.1[3], 0x13);
            let expected_crc = crate::frame::crc16_modbus(&send.1[..4]);
            assert_eq!(&send.1[4..6], &expected_crc.to_le_bytes());
        }

        // 11: Raw chunk pre-framer corruptor
        {
            let src = load("11_raw_chunk_pre_framer_corruptor.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "11",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                None,
                &rx_meta,
                HookKind::RawChunk,
                &imu_frame,
            )
            .expect("11 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "send");
            assert_eq!(dry.output_bytes.len(), imu_frame.len() + 2);
            assert_eq!(&dry.output_bytes[..2], &[0x00, 0xFF]);

            let mut rt = ScriptRuntime::compile(&src, "11").expect("11 compiles");
            let v1 = rt.run_with_meta(HookKind::RawChunk, &rx_meta, &imu_frame);
            assert_eq!(v1.bytes().unwrap().len(), imu_frame.len() + 2);
            let v2 = rt.run_with_meta(HookKind::RawChunk, &rx_meta, &imu_frame);
            assert_eq!(v2.bytes().unwrap().len(), imu_frame.len() / 2);
            assert_eq!(rt.failures, 0);
        }

        // 12: Custom dissector & command builder
        {
            let src = load("12_custom_dissector_and_command_builder.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "12",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                None,
                &rx_meta,
                HookKind::Rx,
                &imu_frame,
            )
            .expect("12 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(
                dry.metrics.get("custom_dissected").map(String::as_str),
                Some("1")
            );
            assert!(
                dry.field_diffs
                    .iter()
                    .any(|d| d.name == "wire_sync" && d.after.as_deref() == Some("0xAA55"))
            );
            assert!(
                dry.field_diffs
                    .iter()
                    .any(|d| d.name == "tail_crc8" && d.after.as_deref() == Some("CRC_OK"))
            );

            let mut rt = ScriptRuntime::compile(&src, "12").expect("12 compiles");
            let mut args = BTreeMap::new();
            args.insert("zone".to_string(), "2".to_string());
            args.insert("duty".to_string(), "75".to_string());
            args.insert("enable".to_string(), "1".to_string());
            let cmd = rt.invoke_command("set_heater", &args).expect("set_heater");
            assert_eq!(cmd.len(), 8);
            assert_eq!(&cmd[..6], &[0xAA, 0x55, 0x31, 2, 1, 75]);
            let expected_crc = crate::xymodem::crc16_xmodem(&cmd[..6]);
            assert_eq!(&cmd[6..8], &expected_crc.to_le_bytes());
        }

        // 13: Periodic timer poller & jitter plotter
        {
            let src = load("13_periodic_timer_poller_and_jitter.lua");
            let mut rt = ScriptRuntime::compile(&src, "13").expect("13 compiles");
            assert!(rt.tick_timers(50).unwrap().is_empty());
            let timer_actions = rt.tick_timers(100).unwrap();
            assert_eq!(timer_actions.len(), 1);
            match &timer_actions[0] {
                ScriptAction::Send { port, bytes, .. } => {
                    assert_eq!(port, "*");
                    assert_eq!(bytes.len(), 5);
                    assert_eq!(bytes[4], bforge_framer::checksum::crc8_atm(&bytes[..4]));
                }
                other => panic!("expected Send, got {other:?}"),
            }

            for ts in [10_000u64, 20_500, 30_000] {
                let meta = FrameMeta {
                    timestamp_us: ts,
                    ..rx_meta.clone()
                };
                assert_eq!(
                    rt.run_with_meta(HookKind::Rx, &meta, &imu_frame),
                    FrameVerdict::Send(imu_frame.clone())
                );
            }
            assert_eq!(rt.failures, 0);
            assert_eq!(
                rt.snapshot()
                    .metrics
                    .get("last_jitter_us")
                    .map(String::as_str),
                Some("1000")
            );
            let rx_actions = rt.drain_actions();
            assert!(rx_actions.iter().any(|a| matches!(
                a,
                ScriptAction::Plot { series, value, .. }
                    if series == "rx_jitter_us" && (*value - 1000.0).abs() < 1e-6
            )));
        }

        // 14: Hardware pin reset & alert handler
        {
            let src = load("14_hardware_pin_reset_and_alert_handler.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "14",
                FaultPolicy::FailOpen,
                None,
                Arc::clone(&schemas),
                None,
                &rx_meta,
                HookKind::Rx,
                &imu_frame,
            )
            .expect("14 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(
                dry.metrics.get("last_rx_seq").map(String::as_str),
                Some("42")
            );

            let mut rt = ScriptRuntime::compile(&src, "14").expect("14 compiles");
            let alert_actions = rt
                .trigger_alert("dead_man_timer", "silence > 2000ms")
                .expect("alert");
            assert_eq!(rt.failures, 0);
            assert_eq!(
                rt.snapshot().metrics.get("mcu_resets").map(String::as_str),
                Some("1")
            );
            assert!(
                alert_actions
                    .iter()
                    .any(|a| matches!(a, ScriptAction::Log { level, .. } if level == "warn"))
            );
            assert!(alert_actions.contains(&ScriptAction::SetPins {
                port: "*".to_string(),
                dtr: true,
                rts: false,
            }));
            assert!(alert_actions.contains(&ScriptAction::PulsePin {
                port: "*".to_string(),
                pin: "RTS".to_string(),
                duration_ms: 25,
            }));
            assert!(alert_actions.contains(&ScriptAction::SetPins {
                port: "*".to_string(),
                dtr: false,
                rts: false,
            }));
        }

        // 15: Fail-closed safety interlock & resource budget guard
        {
            let src = load("15_fail_closed_safety_interlock_and_budget.lua");
            let dry = ScriptRuntime::dry_run(
                &src,
                "15",
                FaultPolicy::FailClosed,
                None,
                Arc::clone(&schemas),
                Some(imu_ir()),
                &tx_meta,
                HookKind::Tx,
                &imu_frame,
            )
            .expect("15 dry_run");
            assert_eq!(dry.error, None);
            assert_eq!(dry.verdict, "pass");
            assert_eq!(
                dry.metrics.get("interlock_state").map(String::as_str),
                Some("OK")
            );
            assert!(dry.memory_bytes < DEFAULT_MEMORY_LIMIT_BYTES);
            assert!(dry.instructions < INSTRUCTION_BUDGET);

            let mut rt = ScriptRuntime::compile(&src, "15")
                .expect("15 compiles")
                .with_policy(FaultPolicy::FailClosed)
                .with_schema(imu_ir());
            for _ in 0..20 {
                assert_eq!(
                    rt.run_with_meta(HookKind::Tx, &tx_meta, &imu_frame),
                    FrameVerdict::Send(imu_frame.clone())
                );
            }
            assert_eq!(
                rt.snapshot().metrics.get("ring_fill").map(String::as_str),
                Some("16")
            );

            let mut unsafe_frame = imu_frame.clone();
            unsafe_frame[8..10].copy_from_slice(&12_000u16.to_be_bytes());
            assert_eq!(
                rt.run_with_meta(HookKind::Tx, &tx_meta, &unsafe_frame),
                FrameVerdict::Drop
            );
            assert_eq!(rt.failures, 0);
            assert_eq!(
                rt.snapshot()
                    .metrics
                    .get("interlock_state")
                    .map(String::as_str),
                Some("TRIPPED")
            );
        }
    }
}
