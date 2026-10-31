# Claude Code On-Demand Skills

This directory contains on-demand skills that extend capabilities for specialized workflows in the AudioClamp project.

## What Are Skills?
Skills are modular directories containing instructions, reference implementations, and helper scripts that load only when a relevant task or workflow is triggered. They prevent context bloat by loading instructions on-demand rather than on every turn.

## Skill Folder Structure
Each skill lives in its own subdirectory under `.claude/skills/`:

```
.claude/skills/
└── <skill-name>/
    ├── SKILL.md                 # Required: Main instructions with YAML frontmatter
    ├── scripts/                 # Optional: Helper scripts (PowerShell, Python)
    ├── references/              # Optional: Deep reference documentation, specs
    └── examples/                # Optional: Example outputs, test fixtures
```

## Creating a New Skill

1. **Create the Directory**:
   ```powershell
   New-Item -ItemType Directory -Path ".claude\skills\<skill-name>"
   ```

2. **Create `SKILL.md`**:
   The `SKILL.md` file must start with YAML frontmatter specifying its name and a concise description of when it should activate:

   ```markdown
   ---
   name: audio-profile-calibrator
   description: Calibrate dynamic range and acoustic release parameters for new competitive game audio engines. Use when adding or fine-tuning game presets.
   ---

   # Audio Profile Calibrator

   ## Workflow
   1. Identify target game executable and audio middleware (Wwise, FMOD, Steam Audio).
   2. Measure baseline peak levels and ambient footstep decibels.
   3. Calculate optimal threshold, 4:1 soft-knee curve, and release timing.
   4. Register entry in `GAME_PROFILES` inside `core/config_manager.py`.
   ```

## Recommended Candidate Skills for AudioClamp
- `dsp-benchmarking`: Benchmarking WASAPI polling latency, CPU utilization under load, and buffer overrun prevention.
- `profile-calibrator`: Calibrating dynamic range, soft-knee curves, and release ms for new tactical shooters.
- `installer-builder`: Automating Inno Setup or PyInstaller distribution packaging and Windows code signing.
