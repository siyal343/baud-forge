import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  DockviewReadyEvent,
  DockviewApi,
  IDockviewPanelProps,
  IDockviewHeaderActionsProps,
} from 'dockview-react';
import { Maximize2, Minimize2, ExternalLink } from 'lucide-react';
import { useWorkstationStore } from '../store/useWorkstationStore';
import { useLayoutLibraryStore, readLayoutLibrarySnapshot } from '../store/useLayoutLibraryStore';
import { useToastStore } from '../store/useToastStore';
import { PacketStreamView } from './PacketStreamView';
import { ProtocolDissector } from './ProtocolDissector';
import { HexInspector } from './HexInspector';
import { OscilloscopeView } from './OscilloscopeView';
import { CommandForge } from './CommandForge';
import { SessionDiffView } from './SessionDiffView';
import { PinSequencerView } from './PinSequencerView';
import { FaultRigView } from './FaultRigView';
import { BridgePanel } from './BridgePanel';
import { FileTransferView } from './FileTransferView';
import { ElfSymbolView } from './ElfSymbolView';
import { SchemaDialectView } from './SchemaDialectView';
import { ActivityLogView } from './ActivityLogView';

const StreamPanel = (_props: IDockviewPanelProps) => <PacketStreamView />;
const DissectorPanel = (_props: IDockviewPanelProps) => <ProtocolDissector />;
const HexPanel = (_props: IDockviewPanelProps) => <HexInspector />;
const ScopePanel = (_props: IDockviewPanelProps) => <OscilloscopeView />;
const CommandPanel = (_props: IDockviewPanelProps) => <CommandForge />;
const DiffPanel = (_props: IDockviewPanelProps) => <SessionDiffView />;
const PinsPanel = (_props: IDockviewPanelProps) => <PinSequencerView />;
const FaultPanel = (_props: IDockviewPanelProps) => <FaultRigView />;
const TransferPanel = (_props: IDockviewPanelProps) => <FileTransferView />;
const ElfPanel = (_props: IDockviewPanelProps) => <ElfSymbolView />;
const SchemaPanel = (_props: IDockviewPanelProps) => <SchemaDialectView />;
const BridgeMitmPanel = (_props: IDockviewPanelProps) => <BridgePanel />;
const ActivityPanel = (_props: IDockviewPanelProps) => <ActivityLogView />;

const components = {
  packetStream: StreamPanel,
  protocolDissector: DissectorPanel,
  hexInspector: HexPanel,
  oscilloscope: ScopePanel,
  commandForge: CommandPanel,
  sessionDiff: DiffPanel,
  pinSequencer: PinsPanel,
  faultRig: FaultPanel,
  fileTransfer: TransferPanel,
  elfSymbols: ElfPanel,
  schemaDialects: SchemaPanel,
  bridge: BridgeMitmPanel,
  activityLog: ActivityPanel,
};

// Memory of where detached panels originated so restoration docks back into their original deck and index slot
interface DetachedOrigin {
  siblingPanelId?: string;
  originalGroupId?: string;
  originalIndex?: number;
  siblingOrder?: string[];
}

const detachedOrigins = new Map<string, DetachedOrigin>();

const CANONICAL_DECK_ORDERS: Record<string, string[]> = {
  // Bottom Subdeck
  oscilloscope: ['oscilloscope', 'commandForge', 'pinSequencer', 'faultRig', 'fileTransfer', 'activityLog'],
  commandForge: ['oscilloscope', 'commandForge', 'pinSequencer', 'faultRig', 'fileTransfer', 'activityLog'],
  pinSequencer: ['oscilloscope', 'commandForge', 'pinSequencer', 'faultRig', 'fileTransfer', 'activityLog'],
  faultRig: ['oscilloscope', 'commandForge', 'pinSequencer', 'faultRig', 'fileTransfer', 'activityLog'],
  fileTransfer: ['oscilloscope', 'commandForge', 'pinSequencer', 'faultRig', 'fileTransfer', 'activityLog'],
  activityLog: ['oscilloscope', 'commandForge', 'pinSequencer', 'faultRig', 'fileTransfer', 'activityLog'],

  // Top-Right Dissector Deck
  protocolDissector: ['protocolDissector', 'elfSymbols', 'schemaDialects'],
  elfSymbols: ['protocolDissector', 'elfSymbols', 'schemaDialects'],
  schemaDialects: ['protocolDissector', 'elfSymbols', 'schemaDialects'],

  // Bottom-Right Hex & Diff Deck
  hexInspector: ['hexInspector', 'sessionDiff'],
  sessionDiff: ['hexInspector', 'sessionDiff'],

  // MITM bridge tabs alongside the HIL deck
  bridge: ['faultRig', 'pinSequencer', 'fileTransfer', 'bridge', 'oscilloscope', 'commandForge'],
};

function calculateInsertionIndex(
  panelId: string,
  targetGroup: any,
  origin?: DetachedOrigin
): number {
  const currentPanelIds: string[] = targetGroup.panels.map((p: any) => p.id);
  const preferredOrder = origin?.siblingOrder || CANONICAL_DECK_ORDERS[panelId];

  if (!preferredOrder || currentPanelIds.length === 0) {
    return typeof origin?.originalIndex === 'number'
      ? Math.min(origin.originalIndex, currentPanelIds.length)
      : currentPanelIds.length;
  }

  const myPosInOrder = preferredOrder.indexOf(panelId);
  if (myPosInOrder === -1) {
    return currentPanelIds.length;
  }

  // 1. Look for the first sibling that was AFTER panelId and is currently in targetGroup
  for (let i = myPosInOrder + 1; i < preferredOrder.length; i++) {
    const nextSiblingId = preferredOrder[i];
    const idxInCurrent = currentPanelIds.indexOf(nextSiblingId);
    if (idxInCurrent !== -1) {
      return idxInCurrent;
    }
  }

  // 2. If no following sibling is present, look for the closest preceding sibling that is in targetGroup
  for (let i = myPosInOrder - 1; i >= 0; i--) {
    const prevSiblingId = preferredOrder[i];
    const idxInCurrent = currentPanelIds.indexOf(prevSiblingId);
    if (idxInCurrent !== -1) {
      return idxInCurrent + 1;
    }
  }

  return 0;
}

const PANEL_ORIGIN_HOMES: Record<
  string,
  { refPanel: string; position: 'center' | 'bottom' | 'right' | 'left' | 'top' }
> = {
  // Top-Left (Stream Deck)
  packetStream: { refPanel: 'oscilloscope', position: 'top' },

  // Bottom-Left (Subdeck)
  oscilloscope: { refPanel: 'packetStream', position: 'bottom' },
  commandForge: { refPanel: 'oscilloscope', position: 'center' },
  pinSequencer: { refPanel: 'oscilloscope', position: 'center' },
  faultRig: { refPanel: 'oscilloscope', position: 'center' },
  fileTransfer: { refPanel: 'oscilloscope', position: 'center' },
  activityLog: { refPanel: 'fileTransfer', position: 'center' },

  // Top-Right (Dissector & Schemas)
  protocolDissector: { refPanel: 'packetStream', position: 'right' },
  elfSymbols: { refPanel: 'protocolDissector', position: 'center' },
  schemaDialects: { refPanel: 'protocolDissector', position: 'center' },

  // Bottom-Right (Hex & Diff)
  hexInspector: { refPanel: 'protocolDissector', position: 'bottom' },
  sessionDiff: { refPanel: 'hexInspector', position: 'center' },
};

function findPreferredTarget(
  containerApi: DockviewApi,
  panelId: string,
  excludeGroup: any
): { targetGroup: any; position: 'center' | 'bottom' | 'right' | 'left' | 'top'; index: number } | null {
  const origin = detachedOrigins.get(panelId);

  // 1. Dynamic origin sibling from before detachment
  if (origin?.siblingPanelId) {
    const sibling = containerApi.getPanel(origin.siblingPanelId);
    if (sibling && sibling.group.model.location.type === 'grid' && sibling.group !== excludeGroup) {
      const idx = calculateInsertionIndex(panelId, sibling.group, origin);
      return { targetGroup: sibling.group, position: 'center', index: idx };
    }
  }

  // 2. Primary deck home
  const home = PANEL_ORIGIN_HOMES[panelId];
  if (home) {
    const ref = containerApi.getPanel(home.refPanel);
    if (ref && ref.group.model.location.type === 'grid' && ref.group !== excludeGroup) {
      const idx = home.position === 'center' ? calculateInsertionIndex(panelId, ref.group, origin) : 0;
      return { targetGroup: ref.group, position: home.position, index: idx };
    }
  }

  // 3. Subdeck fallbacks if primary reference panel is closed or detached
  const fallbacks: Record<
    string,
    { refPanel: string; position: 'center' | 'bottom' | 'right' | 'left' | 'top' }
  > = {
    commandForge: { refPanel: 'packetStream', position: 'bottom' },
    pinSequencer: { refPanel: 'packetStream', position: 'bottom' },
    faultRig: { refPanel: 'packetStream', position: 'bottom' },
    fileTransfer: { refPanel: 'packetStream', position: 'bottom' },
    activityLog: { refPanel: 'packetStream', position: 'bottom' },
    elfSymbols: { refPanel: 'packetStream', position: 'right' },
    schemaDialects: { refPanel: 'packetStream', position: 'right' },
    sessionDiff: { refPanel: 'protocolDissector', position: 'bottom' },
  };

  const fb = fallbacks[panelId];
  if (fb) {
    const ref = containerApi.getPanel(fb.refPanel);
    if (ref && ref.group.model.location.type === 'grid' && ref.group !== excludeGroup) {
      const idx = fb.position === 'center' ? calculateInsertionIndex(panelId, ref.group, origin) : 0;
      return { targetGroup: ref.group, position: fb.position, index: idx };
    }
  }

  // 4. Fallback: Any available grid group
  const anyGrid = containerApi.groups.find(
    (g: any) => g.model.location.type === 'grid' && g !== excludeGroup
  );
  if (anyGrid) {
    const idx = calculateInsertionIndex(panelId, anyGrid, origin);
    return { targetGroup: anyGrid, position: 'center', index: idx };
  }

  return null;
}

const PanelHeaderActions: React.FC<IDockviewHeaderActionsProps> = (props) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const isFloating = props.group.model.location.type === 'floating';
  const isPopout = props.group.model.location.type === 'popout';

  useEffect(() => {
    const disposable = props.containerApi.onDidMaximizedGroupChange((event) => {
      setIsMaximized(event.isMaximized && event.group === props.group);
    });
    return () => disposable.dispose();
  }, [props.containerApi, props.group]);

  const targetPanel = props.activePanel || props.panels[0];

  const toggleMaximize = () => {
    if (isMaximized) {
      props.containerApi.exitMaximizedGroup();
    } else if (targetPanel) {
      props.containerApi.maximizeGroup(targetPanel);
    }
  };

  const handleDetachOrRedock = async () => {
    if (!targetPanel) return;

    const comp = (props.containerApi as any).component;

    if ((isFloating || isPopout) && comp) {
      // Re-dock back into the main grid
      if (isMaximized) {
        try {
          props.containerApi.exitMaximizedGroup();
        } catch (_) {}
      }

      // Find references before moving
      const floatingGroup = comp._floatingGroupService?.findByGroup(props.group);
      const popoutEntry = comp._popoutWindowService?.findByGroup(props.group);

      // Look for preferred deck target in the main grid
      const preferred = findPreferredTarget(props.containerApi, targetPanel.id, props.group);

      if (preferred && comp.moveGroupOrPanel) {
        try {
          comp.moveGroupOrPanel({
            from: { groupId: props.group.id, panelId: targetPanel.id },
            to: {
              group: preferred.targetGroup,
              position: preferred.position,
              index: preferred.index,
            },
          });
        } catch (_) {
          try {
            comp.redockGroupToMainGrid?.(props.group);
          } catch (_) {}
        }
      } else {
        try {
          comp.redockGroupToMainGrid?.(props.group);
        } catch (_) {}
      }

      detachedOrigins.delete(targetPanel.id);

      // Explicitly dispose floating overlay container to prevent ghost/empty floating window
      try {
        floatingGroup?.dispose?.();
      } catch (_) {}

      // Close detached popout browser window if applicable
      try {
        popoutEntry?.window?.close?.();
        popoutEntry?.dispose?.();
      } catch (_) {}

      return;
    }

    // Record current panel index and sibling order so restoration returns to exact place
    const panelsInGroup = props.group.panels;
    const currentIdx = panelsInGroup.indexOf(targetPanel);
    const sibling = panelsInGroup.find((p) => p !== targetPanel);

    detachedOrigins.set(targetPanel.id, {
      siblingPanelId: sibling?.id,
      originalGroupId: props.group.id,
      originalIndex: currentIdx !== -1 ? currentIdx : 0,
      siblingOrder: panelsInGroup.map((p) => p.id),
    });

    // 1. Try native Dockview popout window
    try {
      const ok = await props.containerApi.addPopoutGroup(targetPanel, {
        popoutUrl: 'popout.html',
        position: {
          left: 60,
          top: 60,
          width: Math.min(window.innerWidth - 80, 960),
          height: Math.min(window.innerHeight - 80, 620),
        },
      });
      if (ok) return;
    } catch (_) {}

    // 2. Detach to Floating Window inside viewport
    try {
      props.containerApi.addFloatingGroup(targetPanel, {
        width: Math.min(window.innerWidth - 80, 880),
        height: Math.min(window.innerHeight - 80, 560),
        x: 40,
        y: 40,
      });
    } catch (_) {
      toggleMaximize();
    }
  };

  return (
    <div className="flex items-center gap-0.5 px-1 h-full select-none">
      <button
        onClick={handleDetachOrRedock}
        data-tooltip={
          isFloating
            ? 'Dock panel back into workbench grid'
            : 'Detach panel (popout or floating window)'
        }
        className={`p-0.5 rounded transition-colors ${
          isFloating
            ? 'text-bf-cyan bg-bf-cyan/10 hover:bg-bf-cyan/20'
            : 'text-bf-faint hover:text-bf-cyan hover:bg-bf-subpanel'
        }`}
      >
        <ExternalLink className="w-3 h-3" />
      </button>
      <button
        onClick={toggleMaximize}
        data-tooltip={
          isMaximized
            ? 'Restore panel to previous layout position'
            : 'Expand panel to full viewport'
        }
        className="p-0.5 text-bf-faint hover:text-bf-cyan hover:bg-bf-subpanel rounded transition-colors"
      >
        {isMaximized ? (
          <Minimize2 className="w-3 h-3 text-bf-cyan" />
        ) : (
          <Maximize2 className="w-3 h-3" />
        )}
      </button>
    </div>
  );
};

export const WorkstationDock: React.FC = () => {
  const {
    activePreset,
    openPanelId,
    resetLayoutTrigger,
    requestOpenPanel,
  } = useWorkstationStore();
  const saveRequest = useLayoutLibraryStore((s) => s.saveRequest);
  const loadRequest = useLayoutLibraryStore((s) => s.loadRequest);
  const commitSaveLayout = useLayoutLibraryStore((s) => s.commitSaveLayout);
  const pushToast = useToastStore((s) => s.pushToast);
  const apiRef = useRef<DockviewApi | null>(null);

  // Helper: Setup Default CAD Layout
  const buildDefaultLayout = useCallback((api: DockviewApi) => {
    api.clear();
    const totalWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const totalHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
    const streamWidth = Math.round(totalWidth * 0.62);
    const dissectorWidth = Math.round(totalWidth * 0.38);
    const topHeight = Math.round(totalHeight * 0.68);
    const bottomHeight = Math.round(totalHeight * 0.32);

    const stream = api.addPanel({
      id: 'packetStream',
      component: 'packetStream',
      title: 'PACKET STREAM (COBS)',
      initialWidth: streamWidth,
      initialHeight: topHeight,
      minimumWidth: 280,
      minimumHeight: 140,
    });

    const dissector = api.addPanel({
      id: 'protocolDissector',
      component: 'protocolDissector',
      title: 'PROTOCOL DISSECTOR',
      initialWidth: dissectorWidth,
      initialHeight: Math.round(topHeight * 0.5),
      minimumWidth: 260,
      minimumHeight: 120,
      position: { referencePanel: stream, direction: 'right' },
    });

    api.addPanel({
      id: 'elfSymbols',
      component: 'elfSymbols',
      title: 'ELF SYMBOLS & CRASH TRACE',
      position: { referencePanel: dissector, direction: 'within' },
    });

    api.addPanel({
      id: 'schemaDialects',
      component: 'schemaDialects',
      title: 'SCHEMA DIALECTS (PROTO/MAVLINK)',
      position: { referencePanel: dissector, direction: 'within' },
    });

    const hex = api.addPanel({
      id: 'hexInspector',
      component: 'hexInspector',
      title: 'CANONICAL HEX & ASCII',
      initialWidth: dissectorWidth,
      initialHeight: Math.round(topHeight * 0.5),
      minimumWidth: 260,
      minimumHeight: 120,
      position: { referencePanel: dissector, direction: 'below' },
    });

    api.addPanel({
      id: 'sessionDiff',
      component: 'sessionDiff',
      title: 'SESSION DIFF',
      position: { referencePanel: hex, direction: 'within' },
    });

    const scope = api.addPanel({
      id: 'oscilloscope',
      component: 'oscilloscope',
      title: 'TELEMETRY OSCILLOSCOPE',
      initialWidth: streamWidth,
      initialHeight: bottomHeight,
      minimumWidth: 280,
      minimumHeight: 120,
      position: { referencePanel: stream, direction: 'below' },
    });

    api.addPanel({
      id: 'commandForge',
      component: 'commandForge',
      title: 'COMMAND FORGE',
      position: { referencePanel: scope, direction: 'within' },
    });

    api.addPanel({
      id: 'pinSequencer',
      component: 'pinSequencer',
      title: 'PIN SEQUENCER',
      position: { referencePanel: scope, direction: 'within' },
    });

    api.addPanel({
      id: 'faultRig',
      component: 'faultRig',
      title: 'HIL FAULT RIG',
      position: { referencePanel: scope, direction: 'within' },
    });

    api.addPanel({
      id: 'fileTransfer',
      component: 'fileTransfer',
      title: 'X/YMODEM FILE TRANSFER',
      position: { referencePanel: scope, direction: 'within' },
    });
  }, []);

  // Helper: Setup Dissector & Schemas Focus
  const buildDissectorLayout = useCallback((api: DockviewApi) => {
    api.clear();
    const totalWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const halfWidth = Math.round(totalWidth * 0.5);

    const stream = api.addPanel({
      id: 'packetStream',
      component: 'packetStream',
      title: 'PACKET STREAM (COBS)',
      initialWidth: halfWidth,
      minimumWidth: 280,
    });

    const dissector = api.addPanel({
      id: 'protocolDissector',
      component: 'protocolDissector',
      title: 'PROTOCOL DISSECTOR',
      initialWidth: halfWidth,
      position: { referencePanel: stream, direction: 'right' },
    });

    api.addPanel({
      id: 'schemaDialects',
      component: 'schemaDialects',
      title: 'SCHEMA DIALECTS (PROTO/MAVLINK)',
      position: { referencePanel: dissector, direction: 'within' },
    });

    api.addPanel({
      id: 'elfSymbols',
      component: 'elfSymbols',
      title: 'ELF SYMBOLS & CRASH TRACE',
      position: { referencePanel: dissector, direction: 'within' },
    });

    const hex = api.addPanel({
      id: 'hexInspector',
      component: 'hexInspector',
      title: 'CANONICAL HEX & ASCII',
      initialWidth: halfWidth,
      position: { referencePanel: dissector, direction: 'below' },
    });

    api.addPanel({
      id: 'sessionDiff',
      component: 'sessionDiff',
      title: 'SESSION DIFF',
      position: { referencePanel: hex, direction: 'within' },
    });
  }, []);

  // Helper: Setup Scope & Telemetry Focus
  const buildScopeLayout = useCallback((api: DockviewApi) => {
    api.clear();
    const totalHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
    const topHeight = Math.round(totalHeight * 0.38);
    const bottomHeight = Math.round(totalHeight * 0.62);

    const stream = api.addPanel({
      id: 'packetStream',
      component: 'packetStream',
      title: 'PACKET STREAM (COBS)',
      initialHeight: topHeight,
      minimumHeight: 120,
    });

    api.addPanel({
      id: 'protocolDissector',
      component: 'protocolDissector',
      title: 'PROTOCOL DISSECTOR',
      initialHeight: topHeight,
      position: { referencePanel: stream, direction: 'right' },
    });

    const scope = api.addPanel({
      id: 'oscilloscope',
      component: 'oscilloscope',
      title: 'TELEMETRY OSCILLOSCOPE',
      initialHeight: bottomHeight,
      minimumHeight: 200,
      position: { referencePanel: stream, direction: 'below' },
    });

    api.addPanel({
      id: 'faultRig',
      component: 'faultRig',
      title: 'HIL FAULT RIG',
      position: { referencePanel: scope, direction: 'within' },
    });

    api.addPanel({
      id: 'pinSequencer',
      component: 'pinSequencer',
      title: 'PIN SEQUENCER',
      position: { referencePanel: scope, direction: 'within' },
    });
  }, []);

  // Helper: Setup HIL & Hardware Rig Focus
  const buildHilLayout = useCallback((api: DockviewApi) => {
    api.clear();
    const totalWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const halfWidth = Math.round(totalWidth * 0.5);

    const stream = api.addPanel({
      id: 'packetStream',
      component: 'packetStream',
      title: 'PACKET STREAM (COBS)',
      initialWidth: halfWidth,
      minimumWidth: 280,
    });

    const fault = api.addPanel({
      id: 'faultRig',
      component: 'faultRig',
      title: 'HIL FAULT RIG',
      initialWidth: halfWidth,
      position: { referencePanel: stream, direction: 'right' },
    });

    api.addPanel({
      id: 'bridge',
      component: 'bridge',
      title: 'MITM BRIDGE',
      position: { referencePanel: fault, direction: 'within' },
    });

    api.addPanel({
      id: 'pinSequencer',
      component: 'pinSequencer',
      title: 'PIN SEQUENCER',
      position: { referencePanel: fault, direction: 'within' },
    });

    api.addPanel({
      id: 'fileTransfer',
      component: 'fileTransfer',
      title: 'X/YMODEM FILE TRANSFER',
      position: { referencePanel: fault, direction: 'within' },
    });

    api.addPanel({
      id: 'oscilloscope',
      component: 'oscilloscope',
      title: 'TELEMETRY OSCILLOSCOPE',
      initialWidth: halfWidth,
      position: { referencePanel: fault, direction: 'below' },
    });
  }, []);

  // Apply layout preset
  const applyPreset = useCallback(
    (preset: string, api: DockviewApi) => {
      switch (preset) {
        case 'dissector':
          buildDissectorLayout(api);
          break;
        case 'scope':
          buildScopeLayout(api);
          break;
        case 'hil':
          buildHilLayout(api);
          break;
        case 'default':
        default:
          buildDefaultLayout(api);
          break;
      }
    },
    [buildDefaultLayout, buildDissectorLayout, buildScopeLayout, buildHilLayout]
  );

  // Ready handler
  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      (window as any).__bforgeDockApi = event.api;

      // Listen for layout changes and save to localStorage
      event.api.onDidLayoutChange(() => {
        try {
          const layout = event.api.toJSON();
          localStorage.setItem('bforge_dock_layout', JSON.stringify(layout));
        } catch (_) {}
      });

      // Startup precedence: starred default layout > last-session auto-save
      // > active preset. The default must beat the auto-save or the star
      // would be meaningless — the auto-save rewrites on every panel move.
      const lib = readLayoutLibrarySnapshot();
      const starred = lib.defaultLayout ? lib.layouts[lib.defaultLayout] : null;
      if (starred) {
        try {
          event.api.fromJSON(starred.data as any);
          return;
        } catch (_) {
          // Corrupt/incompatible default: fall through to the auto-save.
        }
      }

      // Restore layout from localStorage if exists
      const savedLayout = localStorage.getItem('bforge_dock_layout');
      if (savedLayout) {
        try {
          event.api.fromJSON(JSON.parse(savedLayout));
          return;
        } catch (_) {
          // If corrupted, fallback to preset
        }
      }

      applyPreset(activePreset, event.api);
    },
    [activePreset, applyPreset]
  );

  // Listen to preset changes
  useEffect(() => {
    const api = apiRef.current;
    if (api) {
      localStorage.removeItem('bforge_dock_layout');
      applyPreset(activePreset, api);
    }
  }, [activePreset, applyPreset]);

  // Named layout save: the menu asks via saveRequest, the dock (which owns
  // the DockviewApi) serializes and commits to the library.
  useEffect(() => {
    if (!saveRequest || !apiRef.current) return;
    try {
      commitSaveLayout(saveRequest.name, apiRef.current.toJSON());
      pushToast('success', 'Layout saved', `“${saveRequest.name}” captured the panel arrangement.`);
    } catch (_) {
      pushToast('error', 'Layout save failed', 'The dock refused to serialize the current arrangement.');
    }
  }, [saveRequest, commitSaveLayout, pushToast]);

  // Named layout load.
  useEffect(() => {
    if (!loadRequest || !apiRef.current) return;
    const entry = useLayoutLibraryStore.getState().layouts[loadRequest.name];
    if (!entry) {
      pushToast('error', 'Layout missing', `No saved layout named “${loadRequest.name}”.`);
      return;
    }
    try {
      apiRef.current.fromJSON(entry.data as any);
      pushToast('success', 'Layout loaded', `“${loadRequest.name}” applied to the workbench.`);
    } catch (_) {
      pushToast('error', 'Layout load failed', 'The saved layout is corrupt or incompatible.');
    }
  }, [loadRequest, pushToast]);

  // Listen to reset layout triggers (factory reset — saved layouts survive)
  useEffect(() => {
    if (resetLayoutTrigger > 0 && apiRef.current) {
      try {
        localStorage.removeItem('bforge_dock_layout');
      } catch (_) {}
      buildDefaultLayout(apiRef.current);
    }
  }, [resetLayoutTrigger, buildDefaultLayout]);

  // Listen to open panel requests
  useEffect(() => {
    if (!openPanelId || !apiRef.current) return;
    const api = apiRef.current;
    const existing = api.getPanel(openPanelId);

    if (existing) {
      existing.api.setActive();
    } else {
      // Re-add closed panel to active dock
      const panels = api.panels;
      const refPanel = panels[0];
      const titles: Record<string, string> = {
        packetStream: 'PACKET STREAM (COBS)',
        protocolDissector: 'PROTOCOL DISSECTOR',
        hexInspector: 'CANONICAL HEX & ASCII',
        sessionDiff: 'SESSION DIFF',
        oscilloscope: 'TELEMETRY OSCILLOSCOPE',
        commandForge: 'COMMAND FORGE',
        pinSequencer: 'PIN SEQUENCER',
        faultRig: 'HIL FAULT RIG',
        fileTransfer: 'X/YMODEM FILE TRANSFER',
        elfSymbols: 'ELF SYMBOLS & CRASH TRACE',
        schemaDialects: 'SCHEMA DIALECTS (PROTO/MAVLINK)',
        activityLog: 'ACTIVITY LOG',
      };

      api.addPanel({
        id: openPanelId,
        component: openPanelId,
        title: titles[openPanelId] || openPanelId.toUpperCase(),
        position: refPanel ? { referencePanel: refPanel, direction: 'within' } : undefined,
      });
    }

    requestOpenPanel('');
  }, [openPanelId, requestOpenPanel]);

  return (
    <div className="flex-1 w-full h-full overflow-hidden">
      <DockviewReact
        components={components}
        onReady={onReady}
        closeEmptyGroups={true}
        rightHeaderActionsComponent={PanelHeaderActions}
        className="w-full h-full dockview-theme-dark dockview-theme-baudforge"
      />
    </div>
  );
};
