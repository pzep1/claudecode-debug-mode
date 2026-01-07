# Contributing to Claude Debug Plugin

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Getting Started

### Prerequisites

- Node.js 18+
- Claude Code CLI

### Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/pzep1/claudecode-debug-mode.git
   cd claudecode-debug-mode
   ```

2. Test the debug server:
   ```bash
   node scripts/debug-server.js 3333
   ```

3. Install locally in Claude Code:
   ```bash
   /plugin install ./
   ```

## How to Contribute

### Reporting Bugs

1. Check existing issues to avoid duplicates
2. Use the bug report template
3. Include:
   - Clear description of the issue
   - Steps to reproduce
   - Expected vs actual behavior
   - Node.js version and OS

### Suggesting Features

1. Check existing issues/discussions
2. Use the feature request template
3. Explain the use case and benefits

### Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Test your changes thoroughly
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request

### Pull Request Guidelines

- Keep changes focused and atomic
- Update documentation if needed
- Follow existing code style
- Test with Claude Code before submitting

## Code Style

- Use clear, descriptive variable names
- Add comments for complex logic
- Keep functions small and focused
- No external dependencies (stdlib only)

## Project Structure

```
├── .claude-plugin/
│   └── plugin.json      # Plugin manifest
├── skills/
│   └── runtime-debugging/
│       └── SKILL.md     # Debug workflow skill
├── scripts/
│   └── debug-server.js  # HTTP debug server
├── commands/
│   └── debug.md         # /debug slash command
└── README.md
```

## Questions?

Feel free to open an issue for questions or discussions.
