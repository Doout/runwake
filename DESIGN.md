---
name: Runwake
description: A fixed operator instrument panel for live runtime evidence.
colors:
  canvas-night: "#0c0f13"
  navigation-night: "#0f1318"
  instrument-surface: "#12171d"
  raised-surface: "#171d24"
  active-surface: "#1c232c"
  instrument-header: "#101419"
  menu-surface: "#151b22"
  divider-steel: "#29323d"
  strong-steel: "#3b4857"
  soft-divider: "#242c35"
  primary-text: "#f4f6f8"
  secondary-text: "#98a3af"
  quiet-text: "#7f8a96"
  softened-data: "#cbd3db"
  signal-blue: "#75aaf5"
  action-blue: "#3579d2"
  action-boundary: "#426a99"
  selected-text: "#d5e7ff"
  text-on-accent: "#ffffff"
  healthy-green: "#61cc98"
  success-border: "#28543f"
  success-text: "#afe5ca"
  caution-amber: "#e4b55e"
  warning-border: "#5b4725"
  warning-surface: "#211a0f"
  warning-text: "#efce8e"
  failure-red: "#ed7e85"
  failure-border: "#713a43"
  failure-surface: "#411f25"
  failure-surface-hover: "#52262e"
  failure-text: "#f0b0b5"
  info-border: "#3b597b"
  info-surface: "#172237"
  info-text: "#b7d4fa"
  evidence-canvas: "#0b0f13"
  evidence-surface: "#0d1116"
  evidence-hover: "#141a21"
  evidence-text: "#dce2e8"
  evidence-muted: "#b7c0ca"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 680
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 670
    lineHeight: 1.35
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "0.04em"
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "7px"
  surface: "10px"
  overlay: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  page: "36px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.raised-surface}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "36px"
  field:
    backgroundColor: "{colors.instrument-surface}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
    height: "38px"
  panel:
    backgroundColor: "{colors.instrument-surface}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.surface}"
    padding: "16px"
---

# Design System: Runwake

## Overview

**Creative North Star: "The Fixed Operator Instrument Panel"**

Runwake is designed for an operator working under pressure, usually in a dim desktop environment with several technical tools open. The interface is quiet, dense, and stable: important controls hold their position while runtime state, logs, and metrics update in place. Expression comes from precision, not decoration.

The system uses one cool dark material family, a restrained blue action signal, and semantic green, amber, and red only when state requires them. Pages should feel like parts of one instrument rack rather than separate dashboards.

**Key Characteristics:**

- Stable control positions and in-place state changes.
- Dense evidence with clear hierarchy and progressive disclosure.
- Monospace reserved for runtime data, paths, commands, and measurements.
- Blue for action or selection; semantic colors for operational state.
- Borders and tonal layers establish structure without decorative chrome.

## Colors

The palette is a cool near-black instrument housing with steel dividers, ice-blue controls, and sparse operational signals.

### Primary

- **Signal Blue:** Current selection, focus, and live informational state.
- **Action Blue:** Primary actions that commit a deliberate operator choice.

### Secondary

- **Healthy Green:** Confirmed success and available runtime state.
- **Caution Amber:** Degraded, delayed, or attention-needed state.
- **Failure Red:** Errors and destructive actions.

### Neutral

- **Canvas Night:** Page background behind every instrument.
- **Navigation Night:** Persistent navigation housing.
- **Instrument Surface:** Default working panels, fields, and log canvas.
- **Raised Surface:** Toolbars and controls that sit above evidence.
- **Active Surface:** Hovered or selected neutral state.
- **Divider Steel / Strong Steel:** Structural boundaries and emphasized focus boundaries.
- **Primary / Secondary / Quiet Text:** Three deliberate evidence levels.

**The Signal Economy Rule.** Accent and semantic colors indicate action, selection, or operational state; they are never background decoration.

## Typography

**Display Font:** Native system sans stack  
**Body Font:** Native system sans stack  
**Label/Mono Font:** Native platform monospace stack

**Character:** Compact and neutral for controls, with tabular and monospaced data where exact alignment helps scanning. A single UI family keeps the tool familiar; hierarchy comes from weight, size, and position.

### Hierarchy

- **Headline:** Page identity only; compact and slightly tightened.
- **Title:** Panels, dialogs, and primary subregions.
- **Body:** Instructions and descriptions, normally kept under 75 characters per line.
- **Label:** Compact control and table labels; uppercase is reserved for short measurement headers.
- **Data:** Logs, paths, commands, identifiers, and live measurements.

**The Data Earns Mono Rule.** Use monospace only where character alignment, exact copying, or machine syntax matters.

## Layout

The desktop shell uses a fixed navigation rail and a bounded content canvas. Operate surfaces use a stable instrument layout: a compact header, a persistent command or filter strip, and a dominant evidence region. Settings groups follow user frequency rather than backend ownership. Connections use registry rows so names, routes, state, and actions align vertically.

Spacing follows a compact 4/8/12/16/24 rhythm. Responsive behavior is structural: navigation collapses, action strips wrap, registries become stacked records, and secondary inspectors move below the main evidence. Controls do not resize merely because their state changes. On phone layouts, primary controls and navigation use 44–48px touch targets while compact secondary evidence tools never fall below 36px.

**The Fixed Position Rule.** State changes update content and signals in place; they do not move the operator's next action.

## Elevation & Depth

Runwake is flat by default. Depth comes from tonal layering and one-pixel boundaries. Wide shadows are reserved for overlays such as dialogs, tooltips, and toasts that genuinely leave the page plane.

### Shadow Vocabulary

- **Overlay Shadow:** A downward, soft ambient shadow used only for modals, tooltips, and toasts.

**The Evidence Stays Flat Rule.** Logs, tables, settings rows, and connection registries do not use shadows.

## Shapes

Controls use compact 7px corners, working surfaces use 10px corners, and protected overlays use 12px corners. Pills are reserved for small status or filter chips. Structural panels are never nested as rounded cards inside rounded cards.

## Components

### Buttons

- **Shape:** Compact curved controls with a 7px radius and 36px default height.
- **Primary:** Action blue, white text, used once per decision region.
- **Hover / Focus:** Tonal lift on hover and a two-pixel signal-blue focus outline.
- **Secondary / Ghost:** Steel-bordered raised surface or transparent text action.
- **Phone geometry:** Primary and modal actions expand to a 44px minimum target without changing their label or visual priority.

### Chips

- **Style:** Small bordered status or filter controls with tabular counts when useful.
- **State:** Selected filters use a neutral active surface plus a blue signal; semantic chips use only their matching state color.

### Cards / Containers

- **Corner Style:** 10px working surfaces.
- **Background:** Instrument surface on canvas night.
- **Shadow Strategy:** Flat; use a divider, not a shadow.
- **Border:** One-pixel steel boundary only where it clarifies grouping.
- **Internal Padding:** 12–20px according to density.

### Inputs / Fields

- **Style:** Dark instrument surface, steel border, 7px radius.
- **Focus:** Signal-blue outline with no layout shift.
- **Error / Disabled:** Error copy states recovery; disabled controls remain legible and explain their gate.
- **Placeholder:** Quiet Text is the minimum placeholder tone so instructional text remains at least 4.5:1 against the instrument surface.

### Protected Overlays

Dialogs have an accessible name, trap keyboard focus, make the application background inert, close with Escape, and return focus to the invoking control. Dialog content scrolls within the protected overlay while the page behind it remains fixed.

### Searchable Dropdowns / Comboboxes

- **Trigger:** Match the field geometry and remain the same size while opening, searching, or changing selection. The selected value truncates in place and a restrained chevron communicates the overlay.
- **Overlay:** Use a detached, same-width instrument overlay with a 10px radius, steel boundary, and the system overlay shadow. It opens above when there is not enough room below.
- **Search:** Keep search pinned at the top with a leading search icon, immediate filtering, and an inline clear action. Typing while the closed trigger is focused opens the menu and starts filtering.
- **Results:** Show a result count while filtering. Use labeled groups only when the grouping is meaningful to the operator; never invent categories for visual structure.
- **Selection:** Use one quiet active row with a checkmark aligned on the right. Hover and keyboard focus use the same neutral active surface rather than an accent-colored block.
- **Multiple selection:** Use multi-select only when comparing or narrowing across several scopes is useful. Keep draft choices inside the overlay with explicit `Apply` and `Clear` actions; closing or pressing Escape discards the draft. Summarize several committed values as a count in the trigger, expose their full labels through the accessible name and tooltip, and let option labels wrap instead of clipping. Single-select menus continue to commit immediately.
- **Empty state:** Replace the result list with a compact search icon, `No results`, and one recovery sentence. The trigger and overlay do not resize.
- **Keyboard and semantics:** Support type-ahead, Arrow keys, Home, End, Enter, and Escape with visible focus and an associated listbox. Search and scrolling stay inside the overlay.
- **The No Native Dropdown Rule:** Every new or modified user-facing dropdown uses Runwake's trigger-and-overlay pattern; do not ship a browser or operating-system `<select>` popup on a touched surface. Existing native controls migrate when their surface is revisited. A short fixed enum may omit the search row, but keeps the same trigger, overlay, option, selected-state treatment, and keyboard behavior.

### Context Menus

Topology context menus use a compact node header with the same `P/S/C/N/V/H` mark as the canvas and a human-readable resource type. Actions use restrained line icons, 34px rows, and only commands that apply to the selected node. Keep navigation actions together and separate clipboard or destructive utilities with one divider. Right-click is an enhancement, not the only path: `Shift+F10` opens the same menu, arrow keys move through it, and Escape returns focus to the node.

### Runtime Actions

Docker connections expose a clear **Docker permissions** choice and default to **View only**. **Manage containers** is labeled in the connection registry before actions appear. Container restart/delete actions live in the fixed workload action column and the matching topology context menu; Compose restart is visible in the project header. Restart and deletion always open protected confirmation overlays that name the target, state the operational consequence, disable duplicate submission, and keep errors in the decision region. Destructive deletion uses failure red; restart remains a neutral or primary deliberate action.

### Navigation

The fixed left rail uses muted labels at rest, a tonal active surface, and restrained symbols. On small screens it becomes a bottom navigation bar without changing labels or order.

### Evidence Workbench

The log workbench combines a stable command strip, a scrollable evidence canvas, a position rail, and a reversible result navigator. Search, format, and context operations never destroy or persist the underlying stream.

### Large Inventories

Workload discovery remains progressive even for five-figure inventories. Large inventories open as a browse hierarchy instead of an individual workload table: connections when several are present, then Kubernetes namespaces or Docker Compose projects, then workloads only after the operator narrows the scope. Search jumps directly to matching workloads, and an explicit `Show workloads` action keeps the ungrouped virtual list available. Show one exact count at the active level, preserve scroll position while new items arrive, and batch visual updates so live discovery never rebuilds the full evidence surface. Do not automatically start a second cluster-wide metrics pass for a large inventory; expose it only in the workload list. A refresh merges into the current inventory in place; future background polling can use the same keyed merge without changing this interaction model.

## Do's and Don'ts

### Do:

- **Do** make common actions visible and keep advanced controls one deliberate reveal away.
- **Do** preserve the user's place when live data arrives or a filter changes.
- **Do** show exact counts, active filters, and recovery paths.
- **Do** make every state and action reachable by keyboard.
- **Do** honor reduced-motion preferences by removing repeated pulses and shortening non-essential transitions.
- **Do** give every generated button an explicit type and every protected overlay a complete focus lifecycle.

### Don't:

- **Don't** structure a page as a gallery of equal-weight cards.
- **Don't** use accent colors as decoration or monospace as a technical costume.
- **Don't** replace evidence with invented diagnoses or persist browser-only log workbench state.
- **Don't** move, resize, or blank a working region during an in-place refresh.
