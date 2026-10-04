# Security

OpenCode Connect is a single-user, self-hosted control surface. Treat the host
account, its private OpenCode runtime, deployment state, and ingress credentials
as one trust boundary.

Never commit environment files, OAuth or provider credentials, private keys,
cookies, durable databases, tunnel configuration, logs containing request data,
or machine-specific production state. The repository intentionally contains
only templates, source, deterministic fixtures, and documentation.

If you find a security issue, do not publish credentials, exploit details, or
live endpoint information in a public issue. Use GitHub's private vulnerability
reporting/security-advisory channel for this repository when available.
