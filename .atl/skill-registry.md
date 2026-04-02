# Skill Registry — Concilium

## Project Conventions
- `AGENTS.md` — Architecture guide, build commands, conventions
- `CLAUDE.md` (user-level) — Personality, philosophy, code review preferences

## User Skills (Trigger Table)

| Skill | Triggers On | Compact Rules |
|-------|-------------|---------------|
| vercel-react-best-practices | React/Next.js code | React performance patterns |
| tailwind-design-system | Tailwind CSS, component libraries | Design system patterns |
| supabase-postgres-best-practices | Postgres queries, schema design | DB optimization |
| frontend-design | Web components, pages, UI | Production-grade frontend |
| 3d-web-experience | Three.js, React Three Fiber | 3D web scenes |
| launch-strategy | Product launch, PH, go-to-market | Launch planning |
| copywriting | Marketing copy, landing pages | Copy improvement |
| competitor-alternatives | Competitor comparison pages | SEO/sales enablement |
| prd | Feature planning, requirements | PRD generation |
| skill-creator | Creating new AI skills | Skill authoring |

## Compact Rules

### TypeScript/React (applies to desktop/, packages/cli/)
- Strict mode, ESNext target
- React 19 with JSX transform
- Hexagonal architecture: domain in core, adapters per surface
- Ink v6 for CLI React components

### Electron (applies to desktop/)
- Context isolation enabled, nodeIntegration disabled
- IPC via preload bridge pattern
- ESLint configured

### Astro (applies to website/)
- Hybrid output with Vercel adapter
- React islands for interactive components
- Tailwind CSS v4
