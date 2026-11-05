#!/usr/bin/env python3
"""Re-apply all uncommitted Step-3 session.rs wiring (xfer field, methods,
pump hook, snapshot)."""
import io

p = "crates/bforge-core/src/session.rs"
s = io.open(p, encoding="utf-8").read()

# 1. Struct field
anchor = """    /// The decode configs `enable_decode` saw, so an uploaded schema can
    /// rebuild a port's stream with the same framing (spec 2.2).
    port_configs: Vec<crate::PortConfig>,"""
add = anchor + """
    /// One armed X/YMODEM transfer (spec 2.7), on the port it runs against.
    xfer: Option<crate::xmodem::XferSession>,"""
assert anchor in s, "field anchor"
s = s.replace(anchor, add, 1)

# 2. Both constructor inits
count = s.count("            port_configs: Vec::new(),")
assert count == 2, f"inits: {count}"
s = s.replace(
    "            port_configs: Vec::new(),",
    "            port_configs: Vec::new(),\n            xfer: None,",
)

# 3. Methods after apply_schema_text
anchor = """        let decoder = crate::tail::decoder_from_text(kind, text, root)
            .map_err(|error| SessionError::Settings(error.to_string()))?;
        self.streams[index] = Some(Stream::new(port_id, crate::tail::TailConfig { machine, dissector: Some(decoder) }));
        Ok(())
    }"""
methods = anchor + '''

    /// Arm an X/YMODEM transfer on a port (spec 2.7). While armed, the port's
    /// raw bytes feed the state machine instead of the vault and streams.
    #[allow(clippy::too_many_arguments)]
    pub fn start_transfer(
        &mut self,
        port_id: &str,
        direction: crate::xmodem::XferDirection,
        mode: crate::xmodem::XferMode,
        name: String,
        data: Vec<u8>,
        expected_len: Option<usize>,
    ) -> Result<(), SessionError> {
        if self.xfer.is_some() {
            return Err(SessionError::Settings(
                "a transfer is already armed; cancel it first".into(),
            ));
        }
        if !self.ports.iter().any(|port| port.info.id == port_id) {
            return Err(SessionError::UnknownPort(port_id.to_string()));
        }
        let now = Instant::now();
        let mut session =
            crate::xmodem::XferSession::new(port_id, direction, mode, name, data, now);
        session.expected_len = expected_len;
        self.xfer = Some(session);
        Ok(())
    }

    /// Cancel the armed transfer, sending CAN CAN to the device.
    pub fn cancel_transfer(&mut self, port_id: &str) -> Result<(), SessionError> {
        match self.xfer.take() {
            Some(xfer) if xfer.port_id == port_id => {
                // CAN CAN aborts the device side of the protocol.
                let _ = self.send(port_id, vec![0x18, 0x18], Duration::from_secs(2));
                Ok(())
            }
            Some(xfer) => {
                self.xfer = Some(xfer);
                Err(SessionError::UnknownPort(port_id.to_string()))
            }
            None => Err(SessionError::Settings("no transfer armed".into())),
        }
    }

    /// The armed transfer's status, if any.
    pub fn transfer_status(&self, port_id: &str) -> Option<crate::contract::TransferView> {
        let xfer = self.xfer.as_ref()?;
        if xfer.port_id != port_id {
            return None;
        }
        let phase = match &xfer.phase {
            crate::xmodem::XferPhase::Handshake => "handshake".to_string(),
            crate::xmodem::XferPhase::Transferring => "transferring".to_string(),
            crate::xmodem::XferPhase::Finishing => "finishing".to_string(),
            crate::xmodem::XferPhase::Done => "done".to_string(),
            crate::xmodem::XferPhase::Failed(reason) => format!("failed:{reason}"),
        };
        Some(crate::contract::TransferView {
            port: xfer.port_id.clone(),
            name: xfer.name.clone(),
            direction: match xfer.direction {
                crate::xmodem::XferDirection::Send => "send".into(),
                crate::xmodem::XferDirection::Recv => "recv".into(),
            },
            phase,
            block: xfer.block,
            total_blocks: xfer.total_blocks(),
            bytes_done: xfer.bytes_done,
            total_bytes: xfer.data.len() as u64,
            retries: xfer.retries,
        })
    }

    /// The bytes a finished receive collected, draining them from the session.
    pub fn take_transfer_data(&mut self, port_id: &str) -> Result<Vec<u8>, SessionError> {
        match self.xfer.take() {
            Some(xfer)
                if xfer.port_id == port_id
                    && xfer.direction == crate::xmodem::XferDirection::Recv
                    && xfer.phase == crate::xmodem::XferPhase::Done =>
            {
                Ok(xfer.data)
            }
            Some(xfer) => {
                self.xfer = Some(xfer);
                Err(SessionError::Settings(
                    "transfer is not a finished receive".into(),
                ))
            }
            None => Err(SessionError::Settings("no transfer armed".into())),
        }
    }

    /// Feed the armed transfer one raw chunk and tick its timeouts. Returns
    /// the bytes the engine must transmit back to the device, if any.
    fn drive_transfer(&mut self, port_index: usize, chunk: &[u8]) -> Vec<u8> {
        let Some(xfer) = self.xfer.as_mut() else {
            return Vec::new();
        };
        if xfer.port_id != self.ports[port_index].info.id {
            return Vec::new();
        }
        let now = Instant::now();
        let mut out: Vec<u8> = Vec::new();
        if !chunk.is_empty() {
            xfer.on_chunk(chunk, now, &mut |bytes| out.extend_from_slice(&bytes));
        }
        xfer.tick(now, &mut |bytes| out.extend_from_slice(&bytes));
        if let Some(xfer) = self.xfer.as_ref()
            && xfer.phase == crate::xmodem::XferPhase::Done
        {
            self.bus.publish(UiEvent::Transfer {
                at_ms: self.started.elapsed().as_millis() as u64,
                port: xfer.port_id.clone(),
                name: xfer.name.clone(),
                phase: "done".into(),
                block: xfer.block,
                total_blocks: xfer.total_blocks(),
                bytes_done: xfer.bytes_done,
            });
        }
        out
    }'''
assert anchor in s, "methods anchor"
s = s.replace(anchor, methods, 1)

# 4. Pump hook: slab feed
anchor = """            while taken < PUMP_BUDGET {
                let Ok(slab) = self.ports[index].logger.pop() else {
                    break;
                };
                taken += 1;
"""
add = anchor + """
                // An armed X/YMODEM transfer consumes the port's raw bytes
                // directly (spec 2.7): transfer traffic is protocol noise, not
                // session data, so it bypasses the vault and the decoders.
                if self
                    .xfer
                    .as_ref()
                    .is_some_and(|x| x.port_id == self.ports[index].info.id)
                {
                    let reply = self.drive_transfer(index, slab.bytes());
                    if !reply.is_empty() {
                        let port_id = self.ports[index].info.id.clone();
                        self.send(&port_id, reply, Duration::from_secs(2))?;
                    }
                    continue;
                }
"""
assert anchor in s, "slab anchor"
s = s.replace(anchor, add, 1)

# 5. Tick before forward
anchor = """        self.forward(&mut crossed)?;
        // A scrubber reads the vault from another thread, so what is appended must
        // reach the operating system now, not when the 64 KiB buffer fills."""
add = """        // Drive transfer timeouts/handshake polling once per pump cycle.
        let armed = self
            .xfer
            .as_ref()
            .map(|xfer| (xfer.port_id.clone(), xfer.phase.clone()))
            .filter(|(port_id, _)| self.ports.iter().any(|port| port.info.id == *port_id));
        if let Some((port_id, _)) = armed {
            let index = self
                .ports
                .iter()
                .position(|port| port.info.id == port_id)
                .unwrap();
            let reply = self.drive_transfer(index, &[]);
            if !reply.is_empty() {
                self.send(&port_id, reply, Duration::from_secs(2))?;
            }
        }
        self.forward(&mut crossed)?;
        // A scrubber reads the vault from another thread, so what is appended must
        // reach the operating system now, not when the 64 KiB buffer fills."""
assert anchor in s, "tick anchor"
s = s.replace(anchor, add, 1)

# 6. Snapshot transfers
anchor = """            bridges: self
                .bridges
                .iter()
                .map(|bridge| bridge.view.clone())
                .collect(),
        }
    }"""
add = """            bridges: self
                .bridges
                .iter()
                .map(|bridge| bridge.view.clone())
                .collect(),
            transfers: self
                .xfer
                .as_ref()
                .and_then(|x| self.transfer_status(&x.port_id))
                .into_iter()
                .collect(),
        }
    }"""
assert anchor in s, "snapshot anchor"
s = s.replace(anchor, add, 1)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("session.rs re-wired")
