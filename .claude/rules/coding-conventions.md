---
paths:
  - "*.py"
  - "core/**"
  - "ui/**"
  - "*.js"
  - "*.html"
  - "*.css"
---

# Coding Conventions

## Python Architecture & Style
- **PEP 8 Compliance**: Use 4 spaces indentation, snake_case for functions/variables, PascalCase for classes, and UPPER_CASE for module constants.
- **Type Annotations**: Provide explicit type hints for all public methods and function signatures using `typing` constructs (`Optional`, `Dict`, `List`, `Tuple`, `Callable`).
- **COM & Windows API Safety**:
  - Always guard COM worker operations with `try...finally` to ensure clean uninitialization.
  - Handle `COINIT_MULTITHREADED` gracefully with `try...except OSError: pass` when thread apartment is already established.
  - Wrap PyCAW endpoint queries with fallback logic so hardware changes or missing devices never crash the engine.
- **Thread Safety**: Access to shared variables between the limiter thread and GUI thread (e.g., target volume, profile data) must be guarded with `self.lock`.

## Frontend JavaScript Style
- **Modularity**: Keep visualizer rendering, audio telemetry parsing, and UI drawer controllers cleanly separated.
- **Naming Conventions**: camelCase for functions and state properties; kebab-case for HTML IDs, data attributes, and CSS class names.
- **IPC Safety**: Check for `window.pywebview && window.pywebview.api && window.pywebview.api.<method>` before calling native bridges to allow browser-mode testing.
- **User Feedback**: Every parameter update (profile switch, ceiling nudge, device toggle) must invoke `showToast(msg, variant)` to maintain clear operational feedback.

## CSS & Styling Design Tokens
- **Theme Variables**: Use design tokens defined in `:root` (`--accent-cyan`, `--accent-emerald`, `--accent-crimson`, `--bg-card`, `--border-subtle`).
- **Typography**: Interface text uses `Inter`, while telemetry decibels and milliseconds use `JetBrains Mono`.
