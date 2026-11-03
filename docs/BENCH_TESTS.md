# Bench tests

Every test below is **not executed**. The Modbus adapter and the write gate have run only against the simulated Modbus TCP device in `src/modbusSimulator.ts`; no register of a real PLC has been written. Write a result only after a person ran the step.

## What the software already covers (no PLC needed)

- The tests run the whole write path against the simulator: function codes, scaling, word order, exceptions, a device that ignores writes, a cell that is not safe, the two-step confirmation and the signed audit chain.

## Setup

- A test PLC or a Modbus TCP slave on its own network with nothing connected to its outputs, a map file that lists one writable register with a narrow `min` and `max`, a token with the scopes `modbus:write` and `modbus:write_commit`, and a key file for the audit chain outside the repository.

## Steps

| # | Step | Expected result | Result |
|---|------|-----------------|--------|
| 1 | Read the registers of the map with writes off. | Values and scaling agree with a reference tool. | not executed |
| 2 | Try a write with `GATEWAY_WRITES` off. | Refused. | not executed |
| 3 | Turn writes on and write a value inside the range, then outside, then to a register not marked writable. | Only the first is accepted. | not executed |
| 4 | Make the state of the cell not safe between `write` and `write_commit`. | The commit is refused. | not executed |
| 5 | Wait longer than the confirmation time, then reuse an id and use another caller's id. | Each is refused. | not executed |
| 6 | Use a PLC that ignores writes. | The result is `write_unverified` and the write is not repeated. | not executed |
| 7 | Read `GET /command/write-audit`, restart the gateway and cut the file short. | The chain verifies; a cut or changed file is refused at start. | not executed |

## What this bench cannot show

The word order and scaling of each vendor and the behaviour of a PLC program that overwrites the register; Siemens S7 is not built.
