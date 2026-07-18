# QinTopia PMS Operational Design System

## Product posture

QinTopia is a quiet, information-dense operations tool. The first screen is the live room-and-bed board, not a landing page. Use unframed page bands, compact tables, drawers, and focused dialogs. Avoid hero layouts, glass effects, decorative gradients, nested cards, oversized type, and marketing copy.

## Tokens

| Role | Value |
|---|---|
| Canvas | `#f4f6f3` |
| Surface | `#ffffff` |
| Primary text | `#17201b` |
| Muted text | `#536159` |
| Border | `#d9dfda` |
| Brand/action | `#176b4d` |
| Brand hover | `#10563d` |
| Secondary accent | `#315f78` |
| Warning | `#9a5b13` |
| Danger | `#a33636` |
| Success | `#287a4b` |

Use the system sans-serif stack. Letter spacing is `0`. Body text is 14-16px; compact panel headings are 18-22px. Border radii are 4-8px. Shadows are reserved for drawers, menus, and dialogs.

## Interaction

- Use Lucide icons for familiar actions and label unfamiliar icons with tooltips.
- Controls have stable dimensions; buttons and inputs are at least 40px high, mobile touch targets at least 44px.
- Hover transitions use color or border only and last 150-200ms. Never shift layout.
- Every interactive element has a visible `:focus-visible` treatment.
- Respect `prefers-reduced-motion`; do not rely on motion for meaning.
- Status is always text or icon plus color. Inventory tables use semantic row/column headers.
- Dialogs trap focus, close with Escape, and return focus to their trigger. Errors link labels, fields, and a focusable summary.

## Responsive behavior

- Validate 375px, 768px, 1024px, and 1440px, plus 200% zoom and 320 CSS px.
- Desktop uses a compact left navigation and fixed-header operational tables.
- Mobile shows Today Arrivals, In House, Today Departures, and Exceptions as tabs; primary actions remain reachable above the virtual keyboard.
- Tables may scroll inside their own labeled region; the page itself must not develop two-dimensional overflow.

## Pre-delivery checks

- WCAG 2.2 AA contrast and keyboard-only completion.
- No emoji icons, clipped text, overlapping controls, layout-shifting hover, or hidden focus.
- No external font dependency; the interface remains usable offline.
- Axe scan plus explicit keyboard assertions on the core journey.
