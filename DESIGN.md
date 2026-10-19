# Daily_CS v2 Design System

## 1. Atmosphere & Identity

Daily_CS v2 feels like a private Korean study desk with an owner-only control drawer. The signature is paper-first reading paired with quiet administrative density: the learner sees no lesson titles until signed in, while the owner gets compact tools that still feel like maintained notes.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface/page | --surface-page | #F6F3EC | #111512 | Browser canvas |
| Surface/paper | --surface-paper | #FFFCF6 | #181C18 | Main reading and editor sheets |
| Surface/soft | --surface-soft | #F0EADF | #20261F | Filters, previews, empty states |
| Surface/raised | --surface-raised | #FFFFFF | #1D231D | Inputs, selected rows, dialogs |
| Text/primary | --text-primary | #1E241F | #F4F0E8 | Main Korean text |
| Text/secondary | --text-secondary | #667064 | #BEC8BB | Captions and summaries |
| Text/muted | --text-muted | #8A9286 | #8E9B8D | Disabled and helper text |
| Border/default | --border-default | #DDD5C7 | #374034 | Cards, controls, dividers |
| Border/subtle | --border-subtle | #ECE4D8 | #293128 | Soft interior separators |
| Accent/primary | --accent-primary | #1F5B3F | #7FC89D | Links, active tabs, focus |
| Accent/hover | --accent-hover | #174A32 | #A7DDB9 | Hover states |
| Accent/soft | --accent-soft | #E3EFE5 | #233B2D | Selected rows and chips |
| Status/error | --status-error | #9B2D20 | #F0A090 | Errors and destructive actions |
| Status/warning | --status-warning | #7C5718 | #E3C078 | Conflicts and schedule notices |
| Status/info | --status-info | #315C74 | #9BC9DC | Neutral notices |

### Rules

- Deep green is reserved for interactive state, current-day identity, and focus indication.
- The anonymous shell shows no lesson metadata, titles, or counts.
- Do not use decorative imagery, gradients, or external visual assets.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Display | 40px / 2.5rem | 700 | 1.18 | 0 | Product title |
| H1 | 32px / 2rem | 700 | 1.28 | 0 | Lesson/admin page title |
| H2 | 24px / 1.5rem | 700 | 1.35 | 0 | Section titles |
| H3 | 19px / 1.1875rem | 700 | 1.45 | 0 | Compact headings |
| Body/lg | 18px / 1.125rem | 400 | 1.8 | 0 | Lead summary |
| Body | 16px / 1rem | 400 | 1.75 | 0 | Default Korean reading text |
| Body/sm | 14px / 0.875rem | 400 | 1.6 | 0 | Meta text and controls |
| Caption | 12px / 0.75rem | 600 | 1.45 | 0.02em | Labels |
| Overline | 11px / 0.6875rem | 700 | 1.35 | 0.08em | Uppercase metadata |

### Font Stack

- Primary: system-ui, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif
- Mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace

### Rules

- Korean prose uses Body or Body/lg with generous line height.
- Article measure is 760px maximum.
- Button text stays on one line at desktop and may wrap only on narrow mobile.

## 4. Spacing & Layout

### Base Unit

All spacing derives from a base of 4px.

| Token | Value | Usage |
|-------|-------|-------|
| --space-1 | 4px | Hairline offset |
| --space-2 | 8px | Inline gaps |
| --space-3 | 12px | Compact control padding |
| --space-4 | 16px | Default control rhythm |
| --space-5 | 20px | Compact section spacing |
| --space-6 | 24px | Article block spacing |
| --space-8 | 32px | Group spacing |
| --space-10 | 40px | Major content spacing |
| --space-12 | 48px | Page section spacing |
| --space-16 | 64px | Desktop page breathing room |

### Grid

- Max reading width: 760px.
- Max admin width: 1240px.
- Breakpoints: mobile 375px, tablet 768px, desktop 1280px.

### Rules

- Reader stays centered and calm.
- Admin screens may be dense, but all controls keep 44px minimum touch target.
- Section spacing uses declared tokens only.

## 5. Components

### Public Shell
- **Structure**: header, private auth panel, session status.
- **Variants**: anonymous, signing-in, authenticated, error.
- **States**: hover, active, focus, loading, error.
- **Accessibility**: landmarks, visible labels, live status.

### Reader
- **Structure**: today/history/category/search controls, lesson article, list.
- **Variants**: loading, empty, selected, error.
- **Accessibility**: semantic article, native details, safe links.

### Admin Workbench
- **Structure**: catalog rail, editor, preview, operations panels.
- **Variants**: draft, published, conflict, trash, schedule, backup.
- **Accessibility**: forms use labels, bulk actions require explicit confirmation.

### Lesson Visual
- **Structure**: caption, explanatory step, responsive node boxes, named directional arrows, metrics, and text alternative. Web controls select precomputed scenarios and steps, with no autoplay.
- **Tokens**: existing paper/raised surfaces, borders, status colors, Body text, H3 title, and 4px spacing rhythm. Active and success nodes use the green accent and soft accent surface.
- **Email**: the same canonical frame reflows into a single column at360 logical pixels and renders at2x for a720px PNG. All rasterized text is at least Body16px, so it remains readable at375px email width. Logical height is capped at1024px, PNG height at2048px, and size at256KiB; shorten canonical copy when needed.
- **Accessibility**: native labeled controls, visible keyboard focus, no forced motion, explicit arrow labels, readable metrics, and descriptive image alt plus plain text fallback.

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 120ms | ease-out | Button and link response |
| Standard | 220ms | ease-in-out | State and surface changes |
| Emphasis | 420ms | cubic-bezier(0.16, 1, 0.3, 1) | Initial content entry |

### Rules

- Only animate transform and opacity; color and border transitions may use standard timing.
- Every interactive element has a visible focus style.
- Respect prefers-reduced-motion.

## 7. Depth & Surface

### Strategy

Borders-only. Surfaces are separated by color tokens and one-pixel borders, without shadows.

| Type | Value | Usage |
|------|-------|-------|
| Default | 1px solid var(--border-default) | Cards, controls, dialogs |
| Subtle | 1px solid var(--border-subtle) | Interior dividers |
