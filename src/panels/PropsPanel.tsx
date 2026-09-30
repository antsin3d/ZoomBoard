import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { useBoardStore } from "../whiteboard/store";
import { pickImageFile } from "../whiteboard/fileIO";
import {
  BASE_KEYFRAME_ID,
  DEFAULT_STATE,
  FONT_OPTIONS,
  normalizeConnectorStyle,
  presentationState,
  type ConnectorAnchorSide,
  type ConnectorEndpointType,
  type ConnectorLineDash,
  type ElementState,
  type BoardElement,
  type TextAlign,
  type TextVAlign,
} from "../whiteboard/model";
import type { ArrangeMode } from "../whiteboard/geometry";
import "./region-properties.css";

const PROPERTY_LABELS: Partial<Record<keyof ElementState, string>> = {
  x: "X", y: "Y", width: "Width", height: "Height", rotation: "Rotation",
  opacity: "Opacity", visible: "Visibility", fill: "Fill", stroke: "Stroke",
  strokeWidth: "Stroke width", fillTextureSrc: "Fill texture", imageSrc: "Image source",
  strokeTextureSrc: "Stroke texture", connectorStyle: "Route", connectorDash: "Line style",
  connectorStartType: "Start type", connectorEndType: "End type",
  connectorStartSize: "Start size", connectorEndSize: "End size",
  connectorLabelPosition: "Label position", connectorLabelOffsetX: "Label X offset",
  connectorLabelOffsetY: "Label Y offset", content: "Content", fontFamily: "Font",
  fontSize: "Font size", textColor: "Text color", fontStyle: "Font style",
  textDecoration: "Underline", lineHeight: "Line height",
  textAlign: "Horizontal alignment", textVAlign: "Vertical alignment",
};

function CustomizationDot({
  property, state, base, onReset,
}: {
  property: keyof ElementState;
  state: ElementState;
  base: ElementState;
  onReset: (key: keyof ElementState) => void;
}) {
  const value = state[property] ?? DEFAULT_STATE[property];
  const original = base[property] ?? DEFAULT_STATE[property];
  const differs = property === "connectorStyle"
    ? normalizeConnectorStyle(state.connectorStyle ?? DEFAULT_STATE.connectorStyle)
      !== normalizeConnectorStyle(base.connectorStyle ?? DEFAULT_STATE.connectorStyle)
    : !Object.is(value, original);
  if (!differs) return <span className="region-customization-placeholder" aria-hidden="true" />;
  const label = PROPERTY_LABELS[property] ?? property;
  return (
    <button
      type="button"
      className="region-customization-dot"
      aria-label={`Reset ${label} customization`}
      title={`${label} customized in this region. Reset to original value.`}
      onClick={() => onReset(property)}
    />
  );
}

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
        <button type="button" className="region-property-btn" disabled={busy} onClick={() => void choose()}>
          {value ? "Replace" : "Choose image"}
        </button>
        {value && (
          <button type="button" className="region-property-btn region-property-btn-danger" onClick={() => onChange(undefined)}>
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

const ENDPOINT_OPTIONS: { label: string; value: ConnectorEndpointType }[] = [
  { label: "None", value: "none" },
  { label: "Arrow", value: "arrow" },
  { label: "Triangle", value: "triangle" },
  { label: "Diamond", value: "diamond" },
  { label: "Circle", value: "circle" },
  { label: "Square", value: "square" },
  { label: "Bar", value: "bar" },
];

const ANCHOR_SIDE_OPTIONS: { label: string; value: ConnectorAnchorSide }[] = [
  { label: "Auto", value: "auto" },
  { label: "Top", value: "top" },
  { label: "Bottom", value: "bottom" },
  { label: "Left", value: "left" },
  { label: "Right", value: "right" },
];

function ConnectorEndpointsEditor({
  el, state, change, customizationDot,
}: {
  el: BoardElement;
  state: ElementState;
  change: (patch: Partial<ElementState>) => void;
  customizationDot: (key: keyof ElementState) => ReactNode;
}) {
  const board = useBoardStore((s) => s.board);
  const attachConnectorEnd = useBoardStore((s) => s.attachConnectorEnd);
  const startName = el.connectorStartId
    ? board.elements.find((c) => c.id === el.connectorStartId)?.name ?? "Shape"
    : null;
  const endName = el.connectorEndId
    ? board.elements.find((c) => c.id === el.connectorEndId)?.name ?? "Shape"
    : null;

  const endpointRow = (
    end: "start" | "end",
    type: ConnectorEndpointType | undefined,
    typeKey: "connectorStartType" | "connectorEndType",
    size: number,
    sizeKey: "connectorStartSize" | "connectorEndSize",
  ) => (
    <div className="prop-row">
      {customizationDot(typeKey)}
      <SelectField
        label={end === "start" ? "Start" : "End"}
        value={type ?? "none"}
        options={ENDPOINT_OPTIONS}
        onChange={(v) => change({ [typeKey]: v } as Partial<ElementState>)}
      />
      {customizationDot(sizeKey)}
      <NumField
        label="Size"
        value={size ?? 12}
        onChange={(v) => change({ [sizeKey]: Math.max(4, v) } as Partial<ElementState>)}
        min={4} max={48}
      />
    </div>
  );

  const attachRow = (
    end: "start" | "end",
    attachedName: string | null,
    anchorSide: ConnectorAnchorSide,
    targetId: string | undefined,
  ) => (
    <div className="prop-row">
      <div className="prop-field">
        <span className="prop-label">{end === "start" ? "Start link" : "End link"}</span>
        <div className="texture-actions">
          <span className="prop-color-text">{attachedName ?? "Floating"}</span>
          {targetId && (
            <button
              type="button"
              className="region-property-btn region-property-btn-danger"
              title="Detach into empty space (keeps its position)"
              onClick={() => attachConnectorEnd(el.id, end, null)}
            >
              Detach
            </button>
          )}
        </div>
      </div>
      {targetId && (
        <label className="prop-field">
          <span className="prop-label">Edge</span>
          <select
            className="prop-input prop-select"
            value={anchorSide}
            onChange={(e) => attachConnectorEnd(
              el.id,
              end,
              targetId,
              { side: e.target.value as ConnectorAnchorSide, offset: 0.5 },
            )}
          >
            {ANCHOR_SIDE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );

  return (
    <>
      {endpointRow("start", state.connectorStartType, "connectorStartType", state.connectorStartSize, "connectorStartSize")}
      {attachRow("start", startName, el.connectorStartAnchor?.side ?? "auto", el.connectorStartId)}
      {endpointRow("end", state.connectorEndType, "connectorEndType", state.connectorEndSize, "connectorEndSize")}
      {attachRow("end", endName, el.connectorEndAnchor?.side ?? "auto", el.connectorEndId)}
    </>
  );
}

interface StateEditorProps {
  el: BoardElement;
  state: ElementState;
  presentationKey: string;
  onChangeKeyframe: (bpId: string, patch: Partial<ElementState>) => void;
  onResetKey: (key: keyof ElementState) => void;
  autoFocusText?: boolean;
  onTextAutoFocused?: () => void;
}

function StateEditor({
  el, state, presentationKey, onChangeKeyframe, onResetKey,
  autoFocusText, onTextAutoFocused,
}: StateEditorProps) {
  const change = (patch: Partial<ElementState>) => {
    onChangeKeyframe(presentationKey, patch);
  };

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
    return <CustomizationDot property={k} state={state} base={el.base} onReset={onResetKey} />;
  }

  return (
    <div className="state-editor">
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
            <ColorField
              label={el.type === "connector" ? "Label bg" : "Fill"}
              value={state.fill}
              onChange={(v) => change({ fill: v })}
            />
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
            {el.type === "image" && <OverrideDot k="imageSrc" />}
            <TextureField
              label="Fill texture"
              value={state.fillTextureSrc ?? (el.type === "image" ? state.imageSrc : undefined)}
              onChange={(value) => change(
                el.type === "image"
                  ? { fillTextureSrc: value ?? "", imageSrc: value ?? "" }
                  : { fillTextureSrc: value ?? "" },
              )}
            />
          </div>
          <div className="prop-row texture-row">
            <OverrideDot k="strokeTextureSrc" />
            <TextureField
              label="Stroke texture"
              value={state.strokeTextureSrc}
              onChange={(value) => change({ strokeTextureSrc: value ?? "" })}
            />
          </div>
        </>
      )}
      {el.type === "connector" && (
        <>
          <div className="prop-section-title">Line</div>
          <div className="prop-row">
            <OverrideDot k="connectorStyle" />
            <SelectField
              label="Route"
              value={normalizeConnectorStyle(state.connectorStyle)}
              options={[
                { label: "Straight", value: "straight" },
                { label: "Stepped", value: "stepped" },
                { label: "Curved", value: "curved" },
              ]}
              onChange={(value) => change({ connectorStyle: value as ElementState["connectorStyle"] })}
            />
            <OverrideDot k="connectorDash" />
            <SelectField
              label="Style"
              value={state.connectorDash ?? "solid"}
              options={[
                { label: "Solid", value: "solid" },
                { label: "Dashed", value: "dashed" },
                { label: "Dotted", value: "dotted" },
              ]}
              onChange={(value) => change({ connectorDash: value as ConnectorLineDash })}
            />
          </div>
          <div className="prop-row">
            <div className="prop-field">
              <span className="prop-label">Direction</span>
              <div className="texture-actions">
                <button
                  type="button"
                  className="region-property-btn"
                  title="Swap start and end (attachments, anchors and arrowheads)"
                  onClick={() => useBoardStore.getState().flipConnector(el.id)}
                >
                  ⇄ Flip ends
                </button>
              </div>
            </div>
          </div>
          <div className="prop-section-title">Endpoints</div>
          <ConnectorEndpointsEditor
            el={el}
            state={state}
            change={change}
            customizationDot={(key) => <OverrideDot k={key} />}
          />
          <div className="prop-section-title">Label position</div>
          <div className="prop-row">
            <OverrideDot k="connectorLabelPosition" />
            <NumField
              label="Along %"
              value={Math.round((state.connectorLabelPosition ?? 0.5) * 100)}
              onChange={(v) => change({ connectorLabelPosition: Math.max(0, Math.min(100, v)) / 100 })}
              min={0} max={100}
            />
            <OverrideDot k="connectorLabelOffsetX" />
            <NumField
              label="DX"
              value={state.connectorLabelOffsetX ?? 0}
              onChange={(v) => change({ connectorLabelOffsetX: v })}
              step={1}
            />
            <OverrideDot k="connectorLabelOffsetY" />
            <NumField
              label="DY"
              value={state.connectorLabelOffsetY ?? 0}
              onChange={(v) => change({ connectorLabelOffsetY: v })}
              step={1}
            />
          </div>
          <div className="region-property-hint">
            Drag the white handles to attach each end to any shape edge or drop it into empty space. Drag the label to slide it along the line. Type label text below — Fill controls its background (transparent = text only).
          </div>
        </>
      )}

      <div className="prop-section-title">Text{el.type === "connector" ? " label" : ""}</div>
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
      {el.type !== "connector" && (
      <div className="prop-row align-row">
        <OverrideDot k="textAlign" />
        <OverrideDot k="textVAlign" />
        <div className="prop-field">
          <span className="prop-label">Position</span>
          <AlignGrid
            hAlign={state.textAlign}
            vAlign={state.textVAlign}
            onChange={(patch) => change(patch)}
          />
        </div>
      </div>
      )}
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

function RegionSettingsBar() {
  const board = useBoardStore((s) => s.board);
  const selectedIds = useBoardStore((s) => s.selectedIds);
  const activeBreakpointId = useBoardStore((s) => s.activeBreakpointId);
  const clipboard = useBoardStore((s) => s.regionSettingsClipboard);
  const copy = useBoardStore((s) => s.copyRegionSettings);
  const paste = useBoardStore((s) => s.pasteRegionSettings);
  const regionName = (id: string | undefined) =>
    board.breakpoints.find((bp) => bp.id === id)?.name ?? "All zoom levels";
  const copiedIds = clipboard
    ? Object.keys(clipboard.states).filter((id) => board.elements.some((el) => el.id === id))
    : [];
  const selectedCopied = selectedIds.filter((id) => copiedIds.includes(id));
  const pasteCount = selectedCopied.length || copiedIds.length;
  return (
    <div className="region-property-context">
      <div>Editing <strong>{regionName(activeBreakpointId)}</strong></div>
      <div className="texture-actions region-settings-actions">
        <button
          type="button"
          className="region-property-btn"
          disabled={!selectedIds.length}
          title="Copy the selected objects' settings in this region (Ctrl+Alt+C)"
          onClick={copy}
        >
          Copy settings
        </button>
        <button
          type="button"
          className="region-property-btn"
          disabled={!pasteCount}
          title={`Paste copied settings into this region${pasteCount ? ` for ${pasteCount} object${pasteCount === 1 ? "" : "s"}` : ""} (Ctrl+Alt+V)`}
          onClick={paste}
        >
          Paste settings
        </button>
      </div>
      {clipboard && copiedIds.length > 0 && (
        <div className="region-property-hint">
          {copiedIds.length} object{copiedIds.length === 1 ? "" : "s"} copied from {regionName(clipboard.sourceRegionId)}
        </div>
      )}
    </div>
  );
}

export default function PropsPanel() {
  const {
    board, selectedIds, activeBreakpointId,
    setKeyframe, clearKeyframeKey, alignSelected,
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
      (selectedElement?.type === "text" || selectedElement?.type === "sticky")
      && !knownElementIds.current.has(selectedElement.id)
    ) {
      setTextFocusId(selectedElement.id);
    }
    for (const element of board.elements) knownElementIds.current.add(element.id);
  }, [board.elements, selectedIds]);

  const textEditRequest = useBoardStore((s) => s.textEditRequest);
  useEffect(() => {
    if (textEditRequest) setTextFocusId(textEditRequest.id);
  }, [textEditRequest]);

  if (!el) {
    const multi = selectedIds.length > 1;
    return (
      <div className="props-panel">
        <div className="panel-header"><span>Properties</span></div>
        {multi && <RegionSettingsBar />}
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
            <div className="region-property-hint">Ctrl+G to create an invisible frame.</div>
          </div>
        ) : (
          <div className="props-empty">Select an element to edit its properties.</div>
        )}
      </div>
    );
  }

  const regionKey = activeBreakpointId ?? BASE_KEYFRAME_ID;
  // Resolve the current region directly; canvas interpolation is not editable state.
  const editorState = presentationState(el, regionKey);

  return (
    <div className="props-panel">
      <div className="panel-header">
        <span>Properties</span>
        <span className="panel-el-name">{el.name}</span>
      </div>

      <RegionSettingsBar />

      <div className="props-scroll">
        <StateEditor
          el={el}
          state={editorState}
          presentationKey={regionKey}
          onChangeKeyframe={(bpId, patch) => setKeyframe(el.id, bpId, patch)}
          onResetKey={(key) => clearKeyframeKey(el.id, regionKey, key)}
          autoFocusText={textFocusId === el.id}
          onTextAutoFocused={() => setTextFocusId(null)}
        />
      </div>
    </div>
  );
}
