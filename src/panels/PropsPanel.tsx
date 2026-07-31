import { useState, useEffect, useRef, useMemo, type CSSProperties } from "react";
import { useBoardStore } from "../whiteboard/store";
import { pickImageFile } from "../whiteboard/fileIO";
import {
  BASE_KEYFRAME_ID,
  BASE_ZOOM,
  FONT_OPTIONS,
  VARIANT_PATCH_KEYS,
  activeVariant,
  breakpointColor,
  pickVariantPatch,
  resolveStateDirect,
  type ElementState,
  type BoardElement,
  type TextAlign,
  type TextVAlign,
  type Breakpoint,
} from "../whiteboard/model";
import type { ArrangeMode } from "../whiteboard/geometry";

const VARIANT_KEY_SET = new Set<keyof ElementState>(VARIANT_PATCH_KEYS);

// ─── Small form controls ──────────────────────────────────────────────────────

function NumField({
  label, value, onChange, min, max, step = 1,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number;
}) {
  return (
    <label className="prop-field">
      <span className="prop-label">{label}</span>
      <input
        type="number"
        className="prop-input"
        value={Math.round(value * 100) / 100}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function TextAreaField({
  label, value, onChange, autoFocus, onAutoFocused,
}: {
  label: string; value: string; onChange: (v: string) => void;
  autoFocus?: boolean;
  onAutoFocused?: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus || !inputRef.current) return;
    inputRef.current.focus();
    inputRef.current.select();
    onAutoFocused?.();
  }, [autoFocus, onAutoFocused]);

  return (
    <label className="prop-field">
      <span className="prop-label">{label}</span>
      <textarea
        ref={inputRef}
        className="prop-input prop-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ColorField({
  label, value, onChange,
}: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#e8edf2";
  return (
    <label className="prop-field prop-field-color">
      <span className="prop-label">{label}</span>
      <input
        type="color"
        className="prop-color"
        value={safeColor}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="prop-color-text">{value}</span>
    </label>
  );
}

function CheckField({
  label, value, onChange,
}: {
  label: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="prop-field prop-field-check">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="prop-label">{label}</span>
    </label>
  );
}

function TextureField({
  label, value, onChange,
}: {
  label: string;
  value?: string;
  onChange: (value: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await pickImageFile();
      if (picked) onChange(picked.dataUrl);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="prop-field texture-field">
      <span className="prop-label">{label}</span>
      <div className="texture-actions">
        <button type="button" className="variant-btn" disabled={busy} onClick={() => void choose()}>
          {value ? "Replace" : "Choose image"}
        </button>
        {value && (
          <button type="button" className="variant-btn variant-btn-danger" onClick={() => onChange(undefined)}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function SelectField({
  label, value, options, onChange, previewFont = false,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
  previewFont?: boolean;
}) {
  return (
    <label className="prop-field">
      <span className="prop-label">{label}</span>
      <select
        className="prop-input prop-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={previewFont ? { fontFamily: value } : undefined}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} style={previewFont ? { fontFamily: o.value } : undefined}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// 3x3 text-position grid (top/mid/bottom × left/center/right + corners).
const VALIGNS: TextVAlign[] = ["top", "middle", "bottom"];
const HALIGNS: TextAlign[] = ["left", "center", "right"];

function AlignGrid({
  hAlign, vAlign, onChange,
}: {
  hAlign: TextAlign;
  vAlign: TextVAlign;
  onChange: (patch: { textAlign?: TextAlign; textVAlign?: TextVAlign }) => void;
}) {
  return (
    <div className="align-grid" role="group" aria-label="Text position">
      {VALIGNS.map((v) =>
        HALIGNS.map((h) => {
          const active = h === hAlign && v === vAlign;
          return (
            <button
              key={`${v}-${h}`}
              type="button"
              className={`align-cell${active ? " align-cell-active" : ""}`}
              title={`${v} ${h}`}
              onClick={() => onChange({ textAlign: h, textVAlign: v })}
            >
              <span className="align-dot" />
            </button>
          );
        }),
      )}
    </div>
  );
}

// ─── State editor ─────────────────────────────────────────────────────────────

interface StateEditorProps {
  el: BoardElement;
  state: ElementState;
  presentationKey: string;
  onChangeKeyframe: (bpId: string, patch: Partial<ElementState>) => void;
  onChangeVariant: (variantId: string, patch: Partial<ElementState>) => void;
  autoFocusText?: boolean;
  onTextAutoFocused?: () => void;
}

function StateEditor({
  el, state, presentationKey, onChangeKeyframe, onChangeVariant,
  autoFocusText, onTextAutoFocused,
}: StateEditorProps) {
  const assignedVariant = activeVariant(el, presentationKey);

  const change = (patch: Partial<ElementState>) => {
    // Spatial layout always writes to the presentation keyframe.
    // When a variant is assigned, representation props edit that variant
    // so the same representation can be reused across tiers.
    if (assignedVariant) {
      const variantPatch = pickVariantPatch(patch);
      const layoutPatch: Partial<ElementState> = {};
      for (const [key, value] of Object.entries(patch) as Array<[keyof ElementState, ElementState[keyof ElementState]]>) {
        if (!VARIANT_KEY_SET.has(key)) {
          (layoutPatch as Record<string, unknown>)[key] = value;
        }
      }
      if (Object.keys(variantPatch).length > 0) {
        onChangeVariant(assignedVariant.id, variantPatch);
      }
      if (Object.keys(layoutPatch).length > 0) {
        onChangeKeyframe(presentationKey, layoutPatch);
      }
      return;
    }
    // Base tab writes to the virtual __base__ keyframe (same as canvas edits).
    onChangeKeyframe(presentationKey, patch);
  };

  // Which keys have a keyframe override at this breakpoint?
  const overrides: Partial<ElementState> = el.keyframes[presentationKey] ?? {};
  const isOverridden = (key: keyof ElementState) => key in overrides;
  const isBold = state.fontStyle.includes("bold");
  const isItalic = state.fontStyle.includes("italic");

  const setFontEmphasis = (bold: boolean, italic: boolean) => {
    const fontStyle = [
      bold ? "bold" : "",
      italic ? "italic" : "",
    ].filter(Boolean).join(" ") || "normal";
    change({ fontStyle: fontStyle as ElementState["fontStyle"] });
  };

  function OverrideDot({ k }: { k: keyof ElementState }) {
    if (assignedVariant && VARIANT_KEY_SET.has(k) && k in assignedVariant.patch) {
      return <span className="override-dot variant-dot" title={`From variant “${assignedVariant.name}”`} />;
    }
    return isOverridden(k)
      ? <span className="override-dot" title="Overridden at this breakpoint" />
      : <span className="override-dot-placeholder" />;
  }

  return (
    <div
      className="state-editor"
      style={{
        "--keyframe-color": presentationKey === BASE_KEYFRAME_ID
          ? "var(--accent)"
          : breakpointColor(useBoardStore.getState().board.breakpoints, presentationKey),
      } as CSSProperties}
    >
      <div className="prop-section-title">Transform</div>
      <div className="prop-row">
        <OverrideDot k="x" />
        <NumField label="X" value={state.x} onChange={(v) => change({ x: v })} />
        <OverrideDot k="y" />
        <NumField label="Y" value={state.y} onChange={(v) => change({ y: v })} />
      </div>
      <div className="prop-row">
        <OverrideDot k="width" />
        <NumField label="W" value={state.width} onChange={(v) => change({ width: Math.max(1, v) })} min={1} />
        <OverrideDot k="height" />
        <NumField label="H" value={state.height} onChange={(v) => change({ height: Math.max(1, v) })} min={1} />
      </div>
      <div className="prop-row">
        <OverrideDot k="rotation" />
        <NumField label="Rotation" value={state.rotation} onChange={(v) => change({ rotation: v })} />
      </div>

      <div className="prop-section-title">Appearance</div>
      <div className="prop-row">
        <OverrideDot k="opacity" />
        <NumField
          label="Opacity %"
          value={Math.round(state.opacity * 100)}
          onChange={(v) => change({ opacity: Math.max(0, Math.min(100, v)) / 100 })}
          min={0} max={100}
        />
        <OverrideDot k="visible" />
        <CheckField label="Visible" value={state.visible} onChange={(v) => change({ visible: v })} />
      </div>
      {el.type !== "text" && (
        <>
          <div className="prop-row">
            <OverrideDot k="fill" />
            <ColorField label="Fill" value={state.fill} onChange={(v) => change({ fill: v })} />
          </div>
          <div className="prop-row">
            <OverrideDot k="stroke" />
            <ColorField label="Stroke" value={state.stroke} onChange={(v) => change({ stroke: v })} />
            <OverrideDot k="strokeWidth" />
            <NumField
              label="Stroke W"
              value={state.strokeWidth}
              onChange={(v) => change({ strokeWidth: Math.max(0, v) })}
              min={0} step={0.5}
            />
          </div>
        </>
      )}
      {!["text", "connector", "group"].includes(el.type) && (
        <>
          <div className="prop-row texture-row">
            <OverrideDot k="fillTextureSrc" />
            <TextureField
              label="Fill texture"
              value={state.fillTextureSrc ?? (el.type === "image" ? state.imageSrc : undefined)}
              onChange={(value) => change(
                el.type === "image"
                  ? { fillTextureSrc: value, imageSrc: value }
                  : { fillTextureSrc: value },
              )}
            />
          </div>
          <div className="prop-row texture-row">
            <OverrideDot k="strokeTextureSrc" />
            <TextureField
              label="Stroke texture"
              value={state.strokeTextureSrc}
              onChange={(value) => change({ strokeTextureSrc: value })}
            />
          </div>
        </>
      )}
      {el.type === "connector" && (
        <div className="prop-row">
          <OverrideDot k="connectorStyle" />
          <SelectField
            label="Route"
            value={state.connectorStyle}
            options={[
              { label: "Straight", value: "straight" },
              { label: "Stepped", value: "stepped" },
              { label: "Bezier spline", value: "bezier" },
            ]}
            onChange={(value) => change({ connectorStyle: value as ElementState["connectorStyle"] })}
          />
        </div>
      )}

      <div className="prop-section-title">Text</div>
      <div className="prop-row">
        <OverrideDot k="content" />
        <TextAreaField
          label="Content"
          value={state.content}
          onChange={(v) => change({ content: v })}
          autoFocus={autoFocusText}
          onAutoFocused={onTextAutoFocused}
        />
      </div>
      <div className="prop-row">
        <OverrideDot k="fontFamily" />
        <SelectField
          label="Font"
          value={state.fontFamily}
          options={FONT_OPTIONS}
          previewFont
          onChange={(v) => change({ fontFamily: v })}
        />
      </div>
      <div className="prop-row">
        <OverrideDot k="fontSize" />
        <NumField
          label="Font size"
          value={state.fontSize}
          onChange={(v) => change({ fontSize: Math.max(6, v) })}
          min={6}
        />
        <OverrideDot k="textColor" />
        <ColorField label="Color" value={state.textColor} onChange={(v) => change({ textColor: v })} />
      </div>
      <div className="prop-row text-format-row">
        <OverrideDot k="fontStyle" />
        <button
          type="button"
          className={`text-format-btn${isBold ? " text-format-active" : ""}`}
          title="Bold"
          onClick={() => setFontEmphasis(!isBold, isItalic)}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={`text-format-btn${isItalic ? " text-format-active" : ""}`}
          title="Italic"
          onClick={() => setFontEmphasis(isBold, !isItalic)}
        >
          <em>I</em>
        </button>
        <OverrideDot k="textDecoration" />
        <button
          type="button"
          className={`text-format-btn${state.textDecoration === "underline" ? " text-format-active" : ""}`}
          title="Underline"
          onClick={() => change({
            textDecoration: state.textDecoration === "underline" ? "none" : "underline",
          })}
        >
          <u>U</u>
        </button>
        <OverrideDot k="lineHeight" />
        <NumField
          label="Line"
          value={state.lineHeight}
          onChange={(value) => change({ lineHeight: Math.max(0.8, value) })}
          min={0.8}
          step={0.1}
        />
      </div>
      <div className="prop-row align-row">
        <OverrideDot k="textAlign" />
        <div className="prop-field">
          <span className="prop-label">
            Position
            {isOverridden("textVAlign") && !isOverridden("textAlign") && (
              <span className="override-dot inline-dot" />
            )}
          </span>
          <AlignGrid
            hAlign={state.textAlign}
            vAlign={state.textVAlign}
            onChange={(patch) => change(patch)}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Variant controls ─────────────────────────────────────────────────────────

function VariantControls({
  el,
  presentationKey,
  tierLabel,
}: {
  el: BoardElement;
  presentationKey: string;
  tierLabel: string;
}) {
  const {
    addVariant,
    removeVariant,
    renameVariant,
    setVariantAssignment,
    captureVariantFromPresentation,
  } = useBoardStore();
  const variants = el.variants ?? [];
  const assignedId = el.variantAssignments?.[presentationKey] ?? "";

  return (
    <div className="variant-controls">
      <div className="prop-section-title">Variants</div>
      <div className="variant-list" role="listbox" aria-label={`Variants for ${tierLabel}`}>
        <button
          type="button"
          role="option"
          aria-selected={!assignedId}
          className={`variant-row variant-choice${!assignedId ? " variant-row-active" : ""}`}
          onClick={() => setVariantAssignment(el.id, presentationKey, null)}
          title="Use this breakpoint's keyframe values without a reusable variant"
        >
          <span className="variant-choice-label">Use breakpoint styling</span>
        </button>
        {variants.map((variant) => (
          <VariantNameRow
            key={variant.id}
            name={variant.name}
            active={variant.id === assignedId}
            onSelect={() => setVariantAssignment(el.id, presentationKey, variant.id)}
            onRename={(name) => renameVariant(el.id, variant.id, name)}
            onRemove={() => removeVariant(el.id, variant.id)}
          />
        ))}
      </div>
      <div className="variant-actions">
        <button
          type="button"
          className="variant-btn"
          onClick={() => {
            const id = addVariant(el.id);
            if (id) setVariantAssignment(el.id, presentationKey, id);
          }}
        >
          + Variant
        </button>
        <button
          type="button"
          className="variant-btn"
          onClick={() => captureVariantFromPresentation(el.id, presentationKey)}
          title="Capture the current presentation as a new variant and assign it here"
        >
          Capture
        </button>
      </div>
    </div>
  );
}

function VariantNameRow({
  name, active, onSelect, onRename, onRemove,
}: {
  name: string;
  active: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => { setDraft(name); }, [name]);
  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) {
      setDraft(name);
      return;
    }
    onRename(trimmed);
  };
  return (
    <div
      role="option"
      aria-selected={active}
      className={`variant-row${active ? " variant-row-active" : ""}`}
      onClick={onSelect}
    >
      <input
        className="prop-input variant-name-input"
        value={draft}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onFocus={onSelect}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(name);
        }}
      />
      <button
        type="button"
        className="variant-btn variant-btn-danger"
        title="Delete variant"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
      >
        ×
      </button>
    </div>
  );
}

// ─── Transition range control ─────────────────────────────────────────────────

function TransitionControls({ bp, onUpdate }: { bp: Breakpoint; onUpdate: (r: number) => void }) {
  // Value is stored as a decimal zoom range (e.g. 0.05 = 5%).
  // The UI presents and accepts whole percentages for clarity.
  const pct = Math.round(bp.transitionRange * 100);
  const halfPct = Math.round((bp.transitionRange / 2) * 100 * 10) / 10;
  const centerPct = Math.round(bp.zoom * 100);
  const hint = bp.transitionRange > 0
    ? `Crossfade ±${halfPct}% of ${centerPct}% zoom`
    : "Snap (no transition)";
  return (
    <div className="transition-controls">
      <div className="prop-section-title">Transition</div>
      <div className="prop-row">
        <NumField
          label="Duration (%)"
          value={pct}
          onChange={(v) => onUpdate(Math.max(0, Math.round(v)) / 100)}
          min={0}
          max={200}
          step={1}
        />
      </div>
      <div className="transition-hint">{hint}</div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

const ARRANGE_ACTIONS: Array<{ mode: ArrangeMode; label: string; title: string; min: number }> = [
  { mode: "left", label: "┃←", title: "Align left edges", min: 2 },
  { mode: "center-h", label: "↔", title: "Align horizontal centers", min: 2 },
  { mode: "right", label: "→┃", title: "Align right edges", min: 2 },
  { mode: "top", label: "━↑", title: "Align top edges", min: 2 },
  { mode: "center-v", label: "↕", title: "Align vertical centers", min: 2 },
  { mode: "bottom", label: "↓━", title: "Align bottom edges", min: 2 },
  { mode: "distribute-h", label: "⇹", title: "Distribute horizontally", min: 3 },
  { mode: "distribute-v", label: "⇕", title: "Distribute vertically", min: 3 },
  { mode: "grid", label: "⊞", title: "Arrange in grid", min: 2 },
];

export default function PropsPanel() {
  const {
    board, selectedIds, activeBreakpointId,
    setKeyframe, updateBreakpoint, updateVariantPatch, alignSelected,
  } = useBoardStore();

  // Only show editor when exactly one element is selected.
  const el = useMemo(
    () => (selectedIds.length === 1 ? board.elements.find((e) => e.id === selectedIds[0]) ?? null : null),
    [board.elements, selectedIds],
  );
  const knownElementIds = useRef(new Set(board.elements.map((element) => element.id)));
  const [textFocusId, setTextFocusId] = useState<string | null>(null);
  useEffect(() => {
    const selectedId = selectedIds.length === 1 ? selectedIds[0] : undefined;
    const selectedElement = selectedId
      ? board.elements.find((element) => element.id === selectedId)
      : undefined;
    if (
      selectedElement?.type === "sticky"
      && !knownElementIds.current.has(selectedElement.id)
    ) {
      setTextFocusId(selectedElement.id);
    }
    for (const element of board.elements) knownElementIds.current.add(element.id);
  }, [board.elements, selectedIds]);

  // Tab order matches the timeline: below-base bps ascending, then Base, then above-base ascending.
  const { belowBps, aboveBps } = useMemo(() => {
    const sorted = [...board.breakpoints].sort((a, b) => a.zoom - b.zoom);
    return {
      belowBps: sorted.filter((bp) => bp.zoom < BASE_ZOOM),
      aboveBps: sorted.filter((bp) => bp.zoom > BASE_ZOOM),
    };
  }, [board.breakpoints]);

  const orderedBps = useMemo(() => [...belowBps, ...aboveBps], [belowBps, aboveBps]);

  // Active breakpoint at current zoom.
  const activeBp = useMemo(
    () => board.breakpoints.find((bp) => bp.id === activeBreakpointId),
    [activeBreakpointId, board.breakpoints],
  );

  // Tab = "base" or a breakpoint id. Follows the active breakpoint on zoom changes.
  const [tab, setTab] = useState<string>(activeBp?.id ?? "base");
  const prevActiveBpId = useRef(activeBp?.id);
  useEffect(() => {
    if (prevActiveBpId.current !== activeBp?.id) {
      prevActiveBpId.current = activeBp?.id;
      setTab(activeBp?.id ?? "base");
    }
  }, [activeBp]);

  // Reset tab when selected element changes.
  useEffect(() => {
    setTab(activeBp?.id ?? "base");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  if (!el) {
    const multi = selectedIds.length > 1;
    return (
      <div className="props-panel">
        <div className="panel-header"><span>Properties</span></div>
        {multi ? (
          <div className="props-scroll">
            <div className="prop-section-title">{selectedIds.length} elements selected</div>
            <div className="prop-section-title">Arrange</div>
            <div className="arrange-grid">
              {ARRANGE_ACTIONS.map((action) => (
                <button
                  key={action.mode}
                  type="button"
                  className="arrange-btn"
                  title={action.title}
                  disabled={selectedIds.length < action.min}
                  onClick={() => alignSelected(action.mode)}
                >
                  {action.label}
                </button>
              ))}
            </div>
            <div className="transition-hint">Ctrl+G to create an invisible frame.</div>
          </div>
        ) : (
          <div className="props-empty">Select an element to edit its properties.</div>
        )}
      </div>
    );
  }

  const tabBp = orderedBps.find((bp) => bp.id === tab);
  const editingBase = tab === "base";

  // State shown in the editor: use the non-interpolating resolver so the panel
  // always reflects the actual stored keyframe values, not the blended canvas
  // values that would be shown mid-transition. resolveState (with interpolation)
  // is only appropriate for canvas rendering.
  const editorState = editingBase
    ? resolveStateDirect(el, BASE_ZOOM, board.breakpoints)
    : resolveStateDirect(el, tabBp?.zoom ?? 1, board.breakpoints);

  return (
    <div className="props-panel">
      <div className="panel-header">
        <span>Properties</span>
        <span className="panel-el-name">{el.name}</span>
      </div>

      {/* Tabs in timeline order: below-base bps | Base | above-base bps */}
      <div className="props-tabs">
        {belowBps.map((bp) => {
          const hasKf = bp.id in el.keyframes || Boolean(el.variantAssignments?.[bp.id]);
          return (
            <button
              key={bp.id}
              className={`props-tab${tab === bp.id ? " props-tab-active" : ""}${hasKf ? " props-tab-has-kf" : ""}`}
              style={{ "--keyframe-color": breakpointColor(board.breakpoints, bp.id) } as CSSProperties}
              onClick={() => setTab(bp.id)}
              title={`${Math.round(bp.zoom * 100)}%`}
            >
              {bp.name}
            </button>
          );
        })}
        <button
          className={`props-tab${tab === "base" ? " props-tab-active" : ""}${el.variantAssignments?.[BASE_KEYFRAME_ID] ? " props-tab-has-kf" : ""}`}
          onClick={() => setTab("base")}
        >
          Base
        </button>
        {aboveBps.map((bp) => {
          const hasKf = bp.id in el.keyframes || Boolean(el.variantAssignments?.[bp.id]);
          return (
            <button
              key={bp.id}
              className={`props-tab${tab === bp.id ? " props-tab-active" : ""}${hasKf ? " props-tab-has-kf" : ""}`}
              style={{ "--keyframe-color": breakpointColor(board.breakpoints, bp.id) } as CSSProperties}
              onClick={() => setTab(bp.id)}
              title={`${Math.round(bp.zoom * 100)}%`}
            >
              {bp.name}
            </button>
          );
        })}
      </div>

      <div className="props-scroll">
        <VariantControls
          el={el}
          presentationKey={editingBase ? BASE_KEYFRAME_ID : tab}
          tierLabel={editingBase ? "Base" : (tabBp?.name ?? "this tier")}
        />

        <StateEditor
          el={el}
          state={editorState}
          presentationKey={editingBase ? BASE_KEYFRAME_ID : tab}
          onChangeKeyframe={(bpId, patch) => setKeyframe(el.id, bpId, patch)}
          onChangeVariant={(variantId, patch) => updateVariantPatch(el.id, variantId, patch)}
          autoFocusText={textFocusId === el.id}
          onTextAutoFocused={() => setTextFocusId(null)}
        />

        {/* Transition controls at the bottom of breakpoint tabs (not Base) */}
        {!editingBase && tabBp && (
          <TransitionControls
            bp={tabBp}
            onUpdate={(r) => updateBreakpoint(tabBp.id, { transitionRange: r })}
          />
        )}
      </div>
    </div>
  );
}
