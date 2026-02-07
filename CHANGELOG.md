# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Interactive Before/After section on website showing workflow comparison
- Standardized container widths (`max-w-7xl`) across all sections
- Standardized vertical spacing (`py-24 md:py-32`) across all sections
- MIT License file
- Comprehensive README.md
- This CHANGELOG.md

### Changed
- Hero copy now leads with workflow pain point: "Every model gives you a different answer. Get the right one."
- Updated WhyItMatters to focus on concrete time savings (25 min → 3 min)
- Updated HowItWorks descriptions to emphasize what users don't have to do
- Navigation labels changed to be more user-friendly
- Demo section copy updated

### Removed
- Architecture "Under the Hood" section from website (too technical for landing page)
- "v1.0 Available Now" badge from hero
- Thematic/roleplay language ("Protocol", "Council is in Session", etc.)

## [1.0.0] - 2025-02-07

### Added
- Initial release of Concilium desktop application
- Multi-agent parallel execution (Claude, OpenAI, OpenCode)
- Three-stage consensus protocol (Execute → Review → Synthesize)
- Anonymous peer review system
- Synthesis engine for combining best responses
- Local-first architecture with Electron
- React-based UI with Tailwind CSS v4
- Marketing website built with Astro
- 3D animated hero section
- Interactive pipeline demo
- Open source release under MIT license

### Features
- Run multiple LLM agents simultaneously
- Watch responses stream in real-time
- Automatic blind peer review by juror models
- Consensus-based ranking system
- Final synthesis by Chairman model
- Persistent run history
- Agent management interface
- Dark theme UI with glassmorphism effects

### Technical
- Electron Forge for packaging
- Vite for fast development
- TypeScript throughout
- Three.js for 3D visuals
- React Three Fiber for React integration
- OpenRouter API integration
- Local JSON storage for runs and preferences
