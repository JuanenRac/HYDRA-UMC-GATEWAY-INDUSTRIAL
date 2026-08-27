# Contributing to HYDRA-UMC-GATEWAY-INDUSTRIAL 🦾

We welcome contributions to the industrial interoperability bridge of the HYDRA-UMC platform.

## Technology Stack
- **Languages**: C++20, Node.js 20+.
- **Protocols**: OPC-UA, MQTT v5, MTConnect, mTLS.
- **Standards**: Industry 4.0, ISA-95 Mapping.
- **Environment**: Linux (Ubuntu 22.04 / Raspberry Pi OS).

## Guidelines
1. **Security-First Interoperability**: All external industrial connections must use encrypted protocols (TLS 1.3 / mTLS).
2. **Standard Compliance**: Ensure that state mappings adhere to the official specifications of OPC-UA and MTConnect.
3. **Low Jitter**: The protocol translation layer should maintain a deterministic update cycle for real-time SCADA synchronization.
4. **Certificate Management**: Any changes to the security module must ensure that private keys are never exposed in logs or telemetry.
