# Modbus TCP adapter

The adapter lets `POST /command` read, and under strict conditions write, the registers of a legacy PLC that speaks Modbus TCP. It does not exist until `GATEWAY_MODBUS_MAP_FILE` names the map; the map format and the commands are in [`API.md`](API.md#modbus-tcp-protocol-modbus).

## Why writing is held to more

A register can move a machine. A write therefore needs all of this, and the gateway refuses at the first thing missing:

1. `GATEWAY_WRITES=1`, which is off by default, and a source of the safety state of the cell (`GATEWAY_CELL_STATE_URL`).
2. A register that the map lists as `writable`, with its own `min` and `max`. Nothing else in the map, and nothing outside it, can be written.
3. A token whose `role` (or `roles`) holds `admin`, with the scopes `modbus:write` and `modbus:write_commit`.
4. The two steps of the write gate: `write` checks everything and hands out a confirmation id that expires and can be used once, by the same caller; `write_commit` asks the state of the cell again and only then releases the write.
5. After the write the register is read back and compared with the value written. A value that does not come back is reported as `write_unverified`, and the write is not repeated.

Every decision is recorded in the signed hash chain of the gate (`GET /command/write-audit`, `GATEWAY_WRITE_AUDIT_FILE`, `GATEWAY_WRITE_AUDIT_KEY_FILE`); the change journal (`GATEWAY_JOURNAL_URL`) keeps a queryable timeline of the orders in HYDRA-UMC-DATALAKE next to it.

## What has been tried

The tests run the whole path against a simulated Modbus TCP device (`src/modbusSimulator.ts`): the six function codes, scaling, word order, exceptions, a device that ignores writes, a cell that is not READY, a caller that is not an administrator. Nothing has been tried against a real PLC.
