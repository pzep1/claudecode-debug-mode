# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

### How to Report

1. **Do NOT open a public GitHub issue** for security vulnerabilities
2. Use [GitHub Security Advisories](https://github.com/pzep1/claudecode-debug-mode/security/advisories/new) to privately report the vulnerability
3. Alternatively, contact the maintainer directly

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Resolution Target**: Within 30 days for critical issues

### After Reporting

1. You'll receive acknowledgment of your report
2. We'll investigate and keep you updated on progress
3. Once fixed, we'll coordinate disclosure timing with you
4. Contributors who report valid vulnerabilities will be credited (unless they prefer anonymity)

## Security Best Practices

When using this plugin:

- Run the debug server only on localhost (default: `localhost:3333`)
- Don't expose the debug server to external networks
- Remove debug instrumentation before deploying to production
- Review captured debug logs for sensitive data before sharing
