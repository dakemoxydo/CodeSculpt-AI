# Project-local instructions

These are the only repository-specific defaults for CodeSculptAi.

- Start every user-facing response by addressing the user as `dakemo`.
- Prefer `rtk` before noisy shell commands when it is available; fall back to the normal command if `rtk` is unavailable or a tool requires the raw command.
- Do not automatically apply or activate unrelated global project workflows, skills, plugins, or architectural conventions in this repository. Use them only when the user explicitly asks for them or when a higher-priority system/developer instruction requires them.

System, developer, safety, and tool instructions remain authoritative.
