# Security Policy 🔒 (HYDRA-UMC-GATEWAY-INDUSTRIAL)

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x  | ✅ Yes             |

## Reporting a Vulnerability

**CRITICAL: Do not report safety-critical vulnerabilities through public GitHub issues.**

In an industrial gateway, a security flaw can expose the entire factory floor to external attacks. If you discover a vulnerability affecting the **mTLS authentication**, **OPC-UA node hijacking**, or **MQTT ACL bypasses**:

1. **Email**: Send a detailed report to `electrohobby3d@gmail.com`.
2. **Impact**: Describe if the bug allows unauthorized PLC access, spoofing of robotic state to external SCADAs, or triggering unauthorized emergency stops via the gateway.
3. **Response**: Initial acknowledgment within 48 hours.

We follow a coordinated disclosure policy to ensure hardware safety before public release.
